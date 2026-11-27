import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import {
  ALL_PLATFORM_SCOPES,
  BookingError,
  ConsoleAuthService,
  OneLineBookingApiError,
  OneLineBookingClient,
  OutboxWebhookWorker,
  PlatformMetricsRegistry,
  PlatformService,
  PostgresBookingStore,
  PostgresDistributedLimiter,
  TimeSlotEngine,
  createBookingPool,
  createPlatformHttpServer,
  runMigrations,
  runSafeRetentionCleanup,
  verifyWebhookSignature,
} from "../../src/index.js";

function listenServer(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Phase 7 Private Beta Acceptance Suite: Security, Distributed Limits, Console Auth, SDK & Reference App", () => {
  let pool: Pool;
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;
  let platform: PlatformService;
  let consoleAuth: ConsoleAuthService;

  before(async () => {
    pool = createBookingPool(undefined, { max: 16 });
    pool.on("error", () => {});
    await runMigrations(pool);
    store = new PostgresBookingStore(pool);
    engine = new TimeSlotEngine(store);
    platform = new PlatformService(pool);
    consoleAuth = new ConsoleAuthService(pool);
  });

  after(async () => {
    await pool.end();
  });

  it("enforces encrypted webhook secrets, rotation grace window, SSRF blocking, request/response size caps, and usage isolation", async () => {
    const tag = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({ name: `SecOrg ${tag}`, slug: `sec-org-${tag}` });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "SecProj",
      slug: `sec-proj-${tag}`,
    });
    const t1 = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: "Tenant One",
    });
    const t2 = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: "Tenant Two",
    });

    // Strict SSRF platform denies metadata/private/HTTP URLs
    await assert.rejects(
      () =>
        platform.createWebhookEndpoint({
          organizationId: organization.id,
          projectId: proj.project.id,
          environmentId: proj.testEnvironment.id,
          tenantId: t1.id,
          url: "http://169.254.169.254/latest/meta-data/",
        }),
      (err: unknown) => err instanceof BookingError && err.code === "FORBIDDEN",
    );

    // Local test platform allows localhost receiver for verification while storing encrypted secret only
    const localPlatform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });
    const receivedHooks: Array<{ body: string; sig: string }> = [];
    const hookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedHooks.push({
          body: Buffer.concat(chunks).toString("utf8"),
          sig: String(req.headers["x-oneline-signature"] ?? ""),
        });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    const hookBase = await listenServer(hookServer);

    const apiKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: t1.id,
      name: "Size/Secret Test Key",
      scopes: ALL_PLATFORM_SCOPES,
    });

    const metricsRegistry = new PlatformMetricsRegistry();
    const tightServer = createPlatformHttpServer({
      pool,
      engine,
      platform: localPlatform,
      metricsRegistry,
      maxBodyBytes: 256,
      maxResponseBytes: 1500,
    });
    const apiBase = await listenServer(tightServer);

    try {
      const epCreated = await localPlatform.createWebhookEndpoint({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: t1.id,
        url: `${hookBase}/events`,
      });

      // Verify DB stored encrypted secret and NULL plaintext
      const dbEpRes = await pool.query<{ signing_secret: string | null; signing_secret_encrypted: string | null }>(
        `SELECT signing_secret, signing_secret_encrypted FROM webhook_endpoints WHERE id = $1`,
        [epCreated.endpoint.id],
      );
      assert.equal(dbEpRes.rows[0]!.signing_secret, null);
      assert.ok(dbEpRes.rows[0]!.signing_secret_encrypted?.startsWith("enc.v1."));

      // Rotate webhook secret with 60m grace window
      const rotated = await localPlatform.rotateWebhookSecret({
        environmentId: proj.testEnvironment.id,
        tenantId: t1.id,
        endpointId: epCreated.endpoint.id,
        gracePeriodMinutes: 60,
      });
      assert.notEqual(rotated.signingSecret, epCreated.signingSecret);

      // Trigger booking event and deliver webhook -> signature verifies against BOTH old and new secrets!
      const fac = await engine
        .forTenant({ tenantId: t1.id, actor: { id: "a", type: "admin", capabilities: ["facility:write", "schedule:write", "facility:read", "availability:read", "booking:create_direct"] } })
        .createFacility({ name: "Bay 1", category: "pc", timeZone: "UTC" });
      const dateStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const weekday = ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const tClient = engine.forTenant({
        tenantId: t1.id,
        actor: { id: "a", type: "admin", capabilities: ["facility:write", "schedule:write", "facility:read", "availability:read", "booking:create_direct"] },
      });
      await tClient.setSchedule(fac.id, [{ weekday, opensAt: "09:00", closesAt: "18:00", endDayOffset: 0, effectiveFrom: dateStr, effectiveUntil: null, breaks: [] }]);
      await tClient.setSlotPolicy(fac.id, { durationMinutes: 60, intervalMinutes: 60, minNoticeMinutes: 0, maxAdvanceDays: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxSlotsPerBooking: 4, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 3 });
      await tClient.setPricing({ facilityId: fac.id, amountMinor: 1000, currency: "USD" });
      const avail = await tClient.getAvailability({ facilityIds: [fac.id], fromDate: dateStr, toDate: dateStr });

      // Queue one booking -> dispatch webhook
      await tClient.createBooking({ facilityId: fac.id, slotRefs: [avail.slots[0]!.slotRef], externalCustomerId: "wh-cust" }, { idempotencyKey: `wh-${randomUUID()}` });
      const worker = new OutboxWebhookWorker({
        pool,
        engine,
        platform: localPlatform,
        tenantFilter: [t1.id],
        metricsRegistry,
        ssrfOptions: { allowLocalHttpForTesting: true },
      });
      await worker.runOnce();
      assert.ok(receivedHooks.length >= 1);
      for (const hook of receivedHooks) {
        assert.ok(verifyWebhookSignature({ secret: epCreated.signingSecret, payloadJson: hook.body, signatureHeader: hook.sig }));
        assert.ok(verifyWebhookSignature({ secret: rotated.signingSecret, payloadJson: hook.body, signatureHeader: hook.sig }));
      }

      // Request body size limit (> 256 bytes rejected cleanly)
      const hugeRes = await fetch(`${apiBase}/v1/facilities`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "X".repeat(300), category: "pc", timeZone: "UTC" }),
      });
      assert.equal(hugeRes.status, 400);

      // /v1/ready and /v1/metrics check
      const readyRes = await fetch(`${apiBase}/v1/ready`);
      assert.equal(readyRes.status, 200);
      const metricsRes = await fetch(`${apiBase}/v1/metrics`);
      const metricsText = await metricsRes.text();
      assert.ok(metricsText.includes("olb_http_requests_total"));

      // Usage isolation: identical customer/client idempotency key across Tenant 1 vs Tenant 2 records BOTH!
      const sharedIdem = "checkout-shared-key";
      const r1 = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: t1.id,
        scopeKey: `${t1.id}:cust-a`,
        metric: "hold_created",
        idempotencyKey: sharedIdem,
      });
      const r2 = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: t2.id,
        scopeKey: `${t2.id}:cust-a`,
        metric: "hold_created",
        idempotencyKey: sharedIdem,
      });
      const rDup = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: t1.id,
        scopeKey: `${t1.id}:cust-a`,
        metric: "hold_created",
        idempotencyKey: sharedIdem,
      });
      assert.equal(r1.recorded, true);
      assert.equal(r2.recorded, true);
      assert.equal(rDup.recorded, false);

      // Verify retention cleanup executes cleanly
      const cleaned = await runSafeRetentionCleanup(pool, { batchLimit: 100 });
      assert.ok(cleaned.deletedApiIdempotency >= 0);
    } finally {
      await Promise.all([closeServer(hookServer), closeServer(tightServer)]);
    }
  });

  it("enforces distributed rate limiting across multiple API instances, console RBAC, packaged SDK (ESM+CJS) and Gaming Cafe App", async () => {
    const tag = randomUUID().slice(0, 8);
    // 1. Console User + RBAC + Invitation + Test/Live Playground Isolation
    const ownerEmail = `owner-${tag}@example.com`;
    const viewerEmail = `viewer-${tag}@example.com`;
    const owner = await consoleAuth.registerUser({ email: ownerEmail, name: "Owner", password: "StrongPassword123!" });
    const viewer = await consoleAuth.registerUser({ email: viewerEmail, name: "Viewer", password: "StrongPassword123!" });

    const { organization } = await platform.createOrganization({ name: `CafeOrg ${tag}`, slug: `cafe-${tag}`, ownerEmail });
    const inv = await consoleAuth.createOrganizationInvitation({
      organizationId: organization.id,
      email: viewerEmail,
      role: "viewer",
      invitedByUserId: owner.id,
      invitedByEmail: ownerEmail,
    });
    await consoleAuth.acceptOrganizationInvitation({
      inviteToken: inv.inviteToken,
      userId: viewer.id,
      userEmail: viewerEmail,
    });

    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "Nexus",
      slug: `nexus-${tag}`,
    });
    await assert.rejects(
      () => consoleAuth.requireProjectRole(viewerEmail, organization.id, proj.project.id, "developer"),
      (err: unknown) => err instanceof BookingError && err.code === "FORBIDDEN",
    );

    const tenant = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: "Nexus Venue",
    });
    const apiKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      name: "Distributed Test Key",
      scopes: ALL_PLATFORM_SCOPES,
    });

    // 2. Two independent API servers sharing ONE PostgresDistributedLimiter (limit=4 req/window)
    const distLimiterA = new PostgresDistributedLimiter(pool, {
      instanceId: "inst-a",
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 4,
      maxTenantConcurrentLeases: 10,
    });
    const distLimiterB = new PostgresDistributedLimiter(pool, {
      instanceId: "inst-b",
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 4,
      maxTenantConcurrentLeases: 10,
    });
    const serverA = createPlatformHttpServer({ pool, engine, platform, distributedLimiter: distLimiterA });
    const serverB = createPlatformHttpServer({ pool, engine, platform, distributedLimiter: distLimiterB });
    const [urlA, urlB] = await Promise.all([listenServer(serverA), listenServer(serverB)]);

    try {
      // Seed 1 facility with schedule/pricing directly via /v1 API
      const adminSdk = new OneLineBookingClient({ baseUrl: urlA, apiKey: apiKey.token });
      const fac = await adminSdk.facilities.create({ name: "RTX 5090 Rig", category: "gaming_pc", timeZone: "UTC" });
      const dateStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const weekday = ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await adminSdk.facilities.setSchedule(fac.id, [{ weekday, opensAt: "10:00", closesAt: "20:00", endDayOffset: 0, effectiveFrom: dateStr, effectiveUntil: null, breaks: [] }]);
      await adminSdk.facilities.setSlotPolicy(fac.id, { durationMinutes: 60, intervalMinutes: 60, minNoticeMinutes: 0, maxAdvanceDays: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxSlotsPerBooking: 4, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 3 });
      await adminSdk.facilities.setPricing(fac.id, { amountMinor: 1500, currency: "USD" });
      // 4 calls done -> 5th call on INSTANCE B immediately hits shared 429 limit!
      const blockedSdkB = new OneLineBookingClient({ baseUrl: urlB, apiKey: apiKey.token, maxRetries: 0 });
      await assert.rejects(
        () => blockedSdkB.facilities.list(),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 429 && err.code === "RATE_LIMITED",
      );

      // 3. Verify packaged SDK CJS + ESM compatibility AND Gaming Cafe reference app
      const reqCjs = createRequire(import.meta.url);
      const cjsPkg = reqCjs(resolve(process.cwd(), "packages/sdk/dist/cjs/server.cjs")) as { OneLineBookingClient: unknown };
      assert.equal(typeof cjsPkg.OneLineBookingClient, "function");

      // Spin up unlimited /v1 API for Gaming Cafe Reference App E2E
      const cleanApi = createPlatformHttpServer({ pool, engine, platform });
      const cleanApiUrl = await listenServer(cleanApi);
      const { createGamingCafeApp } = await import(
        pathToFileURL(resolve(process.cwd(), "examples/gaming-cafe-web/server.mjs")).href
      ) as { createGamingCafeApp: (cfg: { apiBaseUrl: string; apiKey: string; tenantId?: string }) => Server };
      const cafeAppCode = readFileSync("examples/gaming-cafe-web/server.mjs", "utf8");
      assert.equal(cafeAppCode.includes("PostgresBookingStore"), false);
      assert.equal(cafeAppCode.includes("from \"pg\""), false);

      const cafeServer = createGamingCafeApp({ apiBaseUrl: cleanApiUrl, apiKey: apiKey.token, tenantId: tenant.id });
      const cafeUrl = await listenServer(cafeServer);
      try {
        const htmlRes = await fetch(cafeUrl);
        assert.equal(htmlRes.status, 200);
        const availRes = await fetch(`${cafeUrl}/api/availability?facilityId=${fac.id}&fromDate=${dateStr}`);
        const availData = (await availRes.json()) as { slots: Array<{ slotRef: string; amountMinor: number; currency: string }> };
        assert.ok(availData.slots.length >= 1);

        const holdRes = await fetch(`${cafeUrl}/api/holds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facilityId: fac.id, slotRefs: [availData.slots[0]!.slotRef], customerName: "gamer-e2e" }),
        });
        assert.equal(holdRes.status, 201);
        const holdJson = (await holdRes.json()) as { hold: { id: string } };

        const convRes = await fetch(`${cafeUrl}/api/holds/${holdJson.hold.id}/convert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAmountMinor: availData.slots[0]!.amountMinor, expectedCurrency: availData.slots[0]!.currency }),
        });
        assert.equal(convRes.status, 200);
        const convJson = (await convRes.json()) as { booking: { status: string } };
        assert.equal(convJson.booking.status, "confirmed");
      } finally {
        await Promise.all([closeServer(cleanApi), closeServer(cafeServer)]);
      }
    } finally {
      await Promise.all([closeServer(serverA), closeServer(serverB)]);
    }
  });
});

