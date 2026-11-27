import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ALL_PLATFORM_SCOPES,
  HoldExpiryWorker,
  OneLineBookingApiError,
  OneLineBookingClient,
  OutboxWebhookWorker,
  PlatformService,
  PostgresBookingStore,
  RuntimeTrafficLimiter,
  TimeSlotEngine,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  createBookingPool,
  createPlatformHttpServer,
  runMigrations,
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

function nextWeekdayDate(offsetDays = 7): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("Phase 6 Integration Tests: Multi-Tenant Platform, REST API, Webhooks & SDK", () => {
  let pool: Pool;
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;
  let platform: PlatformService;

  before(async () => {
    pool = createBookingPool(undefined, { max: 10 });
    pool.on("error", () => { });
    await runMigrations(pool);
    store = new PostgresBookingStore(pool);
    engine = new TimeSlotEngine(store);
    platform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });
  });

  after(async () => {
    await pool.end();
  });

  it("enforces project/environment isolation, tenant-bound attacks, scopes, and key rotation/revocation", async () => {
    const slugSuffix = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({
      name: `Org ${slugSuffix}`,
      slug: `org-${slugSuffix}`,
      ownerEmail: `owner-${slugSuffix}@example.com`,
    });

    const projectA = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "Project A",
      slug: `proj-a-${slugSuffix}`,
    });
    const projectB = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "Project B",
      slug: `proj-b-${slugSuffix}`,
    });

    const tenantATest1 = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.testEnvironment.id,
      name: "Tenant A-Test-1",
    });
    const tenantATest2 = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.testEnvironment.id,
      name: "Tenant A-Test-2",
    });
    const tenantALive = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.liveEnvironment.id,
      name: "Tenant A-Live-1",
    });

    // Issue environment key (Project A test), tenant-bound key (Tenant A-Test-1), readonly key, and Project B test key
    const envTestKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.testEnvironment.id,
      name: "Env Test Key",
      scopes: ALL_PLATFORM_SCOPES,
    });
    const boundKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.testEnvironment.id,
      tenantId: tenantATest1.id,
      name: "Bound Tenant Key",
      scopes: ALL_PLATFORM_SCOPES,
    });
    const readonlyKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.testEnvironment.id,
      tenantId: tenantATest1.id,
      name: "Readonly Key",
      scopes: ["availability:read", "holds:read"],
    });
    const projectBKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: projectB.project.id,
      environmentId: projectB.testEnvironment.id,
      name: "Project B Test Key",
      scopes: ALL_PLATFORM_SCOPES,
    });
    const liveKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: projectA.project.id,
      environmentId: projectA.liveEnvironment.id,
      name: "Project A Live Key",
      scopes: ALL_PLATFORM_SCOPES,
    });

    assert.ok(envTestKey.token.startsWith("olb_test_"));
    assert.ok(liveKey.token.startsWith("olb_live_"));

    const server = createPlatformHttpServer({ pool, engine, platform });
    const baseUrl = await listenServer(server);

    try {
      // 1. Project & Environment Isolation
      const envTestSdk = new OneLineBookingClient({ baseUrl, apiKey: envTestKey.token });
      const projectBSdk = new OneLineBookingClient({ baseUrl, apiKey: projectBKey.token });
      const liveSdk = new OneLineBookingClient({ baseUrl, apiKey: liveKey.token });

      const listedATest = await envTestSdk.tenants.list();
      assert.equal(listedATest.items.length, 2);
      assert.equal(listedATest.items.some((t) => t.id === tenantALive.id), false);

      // Project B cannot access Project A test tenant even by supplying X-Tenant-Id
      await assert.rejects(
        () => projectBSdk.facilities.list({}, { tenantId: tenantATest1.id }),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 403,
      );

      // Live key in Project A cannot access Test tenant in Project A
      await assert.rejects(
        () => liveSdk.facilities.list({}, { tenantId: tenantATest1.id }),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 403,
      );

      // 2. Tenant-bound API key rejects cross-tenant spoofing attempt
      const boundSdk = new OneLineBookingClient({ baseUrl, apiKey: boundKey.token });
      await assert.rejects(
        () => boundSdk.facilities.list({}, { tenantId: tenantATest2.id }),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 403,
      );

      // Provision facility & location through bound key
      const location = await boundSdk.facilities.createLocation({
        name: "Downtown Arcade",
        timeZone: "UTC",
        city: "Austin",
        country: "US",
      });
      const facility = await boundSdk.facilities.create({
        name: "VR Bay 1",
        category: "vr_pod",
        timeZone: "UTC",
      });
      await boundSdk.facilities.attachLocation(facility.id, {
        locationId: location.id,
        resourceKind: "pod",
      });

      // 3. Scope enforcement
      const roSdk = new OneLineBookingClient({ baseUrl, apiKey: readonlyKey.token });
      const facListFromBound = await boundSdk.facilities.list();
      assert.equal(facListFromBound.items.length, 1);

      await assert.rejects(
        () =>
          roSdk.facilities.create({
            name: "Blocked Fac",
            category: "pc",
            timeZone: "UTC",
          }),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 403,
      );

      // 4. Key rotation + immediate invalidation + audit trail without raw token leaks
      const rotated = await platform.rotateApiKey({
        organizationId: organization.id,
        keyId: boundKey.apiKey.id,
        revokePrevious: true,
        actorId: "security-test",
      });
      assert.notEqual(rotated.token, boundKey.token);

      // Previous key fails with 401
      await assert.rejects(
        () => boundSdk.facilities.list(),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 401,
      );

      // New key works and tracks lastUsedAt
      const rotatedSdk = new OneLineBookingClient({ baseUrl, apiKey: rotated.token });
      const listOk = await rotatedSdk.facilities.list();
      assert.equal(listOk.items.length, 1);

      const keys = await platform.listApiKeys(organization.id, projectA.testEnvironment.id);
      const oldSummary = keys.find((k) => k.id === boundKey.apiKey.id)!;
      const newSummary = keys.find((k) => k.id === rotated.apiKey.id)!;
      assert.equal(oldSummary.status, "rotated");
      assert.ok(oldSummary.lastUsedAt !== null);
      assert.ok(newSummary.lastUsedAt !== null);

      // Revocation immediately blocks rotated key
      await platform.revokeApiKey({
        organizationId: organization.id,
        keyId: rotated.apiKey.id,
        actorId: "security-test",
      });
      await assert.rejects(
        () => rotatedSdk.facilities.list(),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 401,
      );

      const auditLogs = await platform.listAuditLogs(organization.id, 50);
      const serializedLogs = JSON.stringify(auditLogs);
      assert.ok(auditLogs.some((a) => a.action === "api_key.rotated"));
      assert.ok(auditLogs.some((a) => a.action === "api_key.revoked"));
      assert.equal(serializedLogs.includes(boundKey.token), false);
      assert.equal(serializedLogs.includes(rotated.token), false);
    } finally {
      await closeServer(server);
    }
  });

  it("supports end-to-end API idempotency, multi-instance consistency, rate limiting, webhooks, hold expiry & usage metering", async () => {
    const slugSuffix = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({
      name: `Prod Org ${slugSuffix}`,
      slug: `prod-org-${slugSuffix}`,
    });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "Core",
      slug: `core-${slugSuffix}`,
    });
    const tenant = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.liveEnvironment.id,
      name: "Arena Live",
    });
    const apiKey = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.liveEnvironment.id,
      tenantId: tenant.id,
      name: "Live Server Key",
      scopes: ALL_PLATFORM_SCOPES,
    });

    // Spin up 2 budgeted API instances sharing the database cleanly
    const budget = computeConnectionBudget({
      postgresMaxConnections: 40,
      apiInstanceCount: 2,
      reservedAdminConnections: 5,
      reservedWorkerConnections: 8,
      reservedMigrationConnections: 3,
    });
    const poolA = createBookingPool(undefined, buildBudgetedPoolConfig(budget, "api"));
    const poolB = createBookingPool(undefined, buildBudgetedPoolConfig(budget, "api"));
    poolA.on("error", () => { });
    poolB.on("error", () => { });

    const serverA = createPlatformHttpServer({
      pool: poolA,
      engine: new TimeSlotEngine(new PostgresBookingStore(poolA)),
      platform: new PlatformService(poolA, { ssrfOptions: { allowLocalHttpForTesting: true } }),
    });
    const serverB = createPlatformHttpServer({
      pool: poolB,
      engine: new TimeSlotEngine(new PostgresBookingStore(poolB)),
      platform: new PlatformService(poolB, { ssrfOptions: { allowLocalHttpForTesting: true } }),
    });

    // Dedicated rate-limited server instance
    const rlServer = createPlatformHttpServer({
      pool,
      engine,
      platform,
      limiter: new RuntimeTrafficLimiter({
        maxConcurrentRequests: 8,
        maxQueueDepth: 8,
        rateLimitWindowMs: 60_000,
        rateLimitMaxRequests: 3,
      }),
    });

    // Webhook receiver server supporting toggleable 500 failure + HMAC verification
    const receivedWebhooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    let webhookFailMode = false;
    const webhookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (webhookFailMode) {
          res.statusCode = 500;
          res.end("down");
          return;
        }
        receivedWebhooks.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.end("ok");
      });
    });

    const [urlA, urlB, urlRl, webhookUrl] = await Promise.all([
      listenServer(serverA),
      listenServer(serverB),
      listenServer(rlServer),
      listenServer(webhookServer),
    ]);

    try {
      const sdkA = new OneLineBookingClient({ baseUrl: urlA, apiKey: apiKey.token });
      const sdkB = new OneLineBookingClient({ baseUrl: urlB, apiKey: apiKey.token });

      // Setup facility + schedule + policy + pricing via API
      const facility = await sdkA.facilities.create({
        name: "Rig 1",
        category: "pc",
        timeZone: "UTC",
      });
      const dateStr = nextWeekdayDate(10);
      const dayOfWeek = ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await sdkA.facilities.setSchedule(facility.id, [
        {
          weekday: dayOfWeek,
          opensAt: "09:00",
          closesAt: "18:00",
          endDayOffset: 0,
          effectiveFrom: dateStr,
          effectiveUntil: null,
          breaks: [],
        },
      ]);
      await sdkA.facilities.setSlotPolicy(facility.id, {
        durationMinutes: 60,
        intervalMinutes: 60,
        minNoticeMinutes: 0,
        maxAdvanceDays: 90,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        maxSlotsPerBooking: 4,
        defaultHoldMinutes: 5,
        maxActiveHoldsPerCustomer: 3,
      });
      await sdkA.facilities.setPricing(facility.id, { amountMinor: 1500, currency: "USD" });

      // Register webhook endpoint cleanly and confirm list omits signingSecret
      const createdWebhook = await sdkA.webhooks.createEndpoint({
        url: `${webhookUrl}/hook`,
        description: "Test receiver",
      });
      assert.ok(createdWebhook.signingSecret.startsWith("whsec_"));
      const listedEndpoints = await sdkB.webhooks.listEndpoints();
      assert.equal(listedEndpoints.length, 1);
      assert.equal("signingSecret" in listedEndpoints[0]!, false);

      // Fetch slots through Instance B
      const avail = await sdkB.availability.get({
        facilityId: facility.id,
        fromDate: dateStr,
        toDate: dateStr,
      });
      assert.ok(avail.slots.length >= 3);
      const slot0 = avail.slots[0]!;
      const slot1 = avail.slots[1]!;

      // API Idempotency check (same key + same payload replays; same key + different payload => 409)
      const idemKey = `hold-${randomUUID()}`;
      const hold1 = await sdkA.holds.create(
        { facilityId: facility.id, externalCustomerId: "cust-1", slotRefs: [slot0.slotRef] },
        { idempotencyKey: idemKey },
      );
      const holdReplay = await sdkB.holds.create(
        { facilityId: facility.id, externalCustomerId: "cust-1", slotRefs: [slot0.slotRef] },
        { idempotencyKey: idemKey },
      );
      assert.equal(holdReplay.id, hold1.id);

      await assert.rejects(
        () =>
          sdkA.holds.create(
            { facilityId: facility.id, externalCustomerId: "cust-2", slotRefs: [slot0.slotRef] },
            { idempotencyKey: idemKey },
          ),
        (err: unknown) => err instanceof OneLineBookingApiError && err.code === "IDEMPOTENCY_KEY_CONFLICT",
      );

      // Convert hold on Instance B
      const booking = await sdkB.holds.convert(hold1.id, {
        expectedAmountMinor: 1500,
        expectedCurrency: "USD",
      });
      assert.equal(booking.status, "confirmed");

      // Multi-instance race on slot1 via Instance A and Instance B simultaneously: strictly 1 wins
      const raceResults = await Promise.allSettled([
        sdkA.bookings.create({
          facilityId: facility.id,
          externalCustomerId: "racer-a",
          slotRefs: [slot1.slotRef],
        }),
        sdkB.bookings.create({
          facilityId: facility.id,
          externalCustomerId: "racer-b",
          slotRefs: [slot1.slotRef],
        }),
      ]);
      const raceFulfilled = raceResults.filter((r) => r.status === "fulfilled");
      const raceRejected = raceResults.filter((r) => r.status === "rejected");
      assert.equal(raceFulfilled.length, 1);
      assert.equal(raceRejected.length, 1);

      // Managed HoldExpiryWorker test on slot2
      const slot2 = avail.slots[2]!;
      const shortHold = await sdkA.holds.create({
        facilityId: facility.id,
        externalCustomerId: "cust-expire",
        slotRefs: [slot2.slotRef],
      });
      await pool.query(`UPDATE holds SET expires_at = now() - interval '2 minutes' WHERE id = $1`, [
        shortHold.id,
      ]);
      await pool.query(`UPDATE allocations SET expires_at = now() - interval '2 minutes' WHERE hold_id = $1`, [
        shortHold.id,
      ]);
      const expiryWorker = new HoldExpiryWorker({ engine, batchLimit: 50 });
      const sweep = await expiryWorker.runOnce();
      assert.ok(sweep.expiredCount >= 1);

      // Confirm slot2 can now be booked after hold expiration
      const postExpiryBooking = await sdkB.bookings.create({
        facilityId: facility.id,
        externalCustomerId: "cust-after-expiry",
        slotRefs: [slot2.slotRef],
      });
      assert.equal(postExpiryBooking.status, "confirmed");

      // Webhook dispatch & HMAC verification (scoped to this tenant)
      const webhookWorker = new OutboxWebhookWorker({
        pool,
        engine,
        platform,
        maxAttempts: 2,
        baseRetryDelaySeconds: 0,
        tenantFilter: [tenant.id],
        ssrfOptions: { allowLocalHttpForTesting: true },
      });
      const dispatch1 = await webhookWorker.runOnce();
      assert.ok(dispatch1.delivered >= 2);
      assert.ok(receivedWebhooks.length >= 2);
      for (const wh of receivedWebhooks) {
        const sigHeader = String(wh.headers["x-oneline-signature"]);
        assert.ok(
          verifyWebhookSignature({
            secret: createdWebhook.signingSecret,
            payloadJson: wh.body,
            signatureHeader: sigHeader,
          }),
        );
      }

      // Webhook retry + dead-letter + replay verification
      webhookFailMode = true;
      const slot3 = avail.slots[3]!;
      await sdkA.bookings.create({
        facilityId: facility.id,
        externalCustomerId: "cust-dlq",
        slotRefs: [slot3.slotRef],
      });
      await webhookWorker.runOnce(); // attempt 1 -> retrying
      await pool.query(
        `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'retrying'`,
        [tenant.id],
      );
      await webhookWorker.deliverPendingWebhooks(); // attempt 2 -> dead_letter
      const dlq = await sdkA.webhooks.listDeliveries({ status: "dead_letter" });
      assert.equal(dlq.length, 1);

      // Restore webhook receiver & replay
      webhookFailMode = false;
      const replayed = await sdkA.webhooks.replayDelivery(dlq[0]!.id);
      assert.equal(replayed.status, "pending");
      assert.equal(replayed.replayedCount, 1);
      await webhookWorker.deliverPendingWebhooks();
      const afterReplay = await sdkA.webhooks.listDeliveries({ status: "dead_letter" });
      assert.equal(afterReplay.length, 0);

      // Rate limit enforcement verification
      const rlSdk = new OneLineBookingClient({
        baseUrl: urlRl,
        apiKey: apiKey.token,
        maxRetries: 0,
      });
      await rlSdk.facilities.list();
      await rlSdk.facilities.list();
      await rlSdk.facilities.list();
      await assert.rejects(
        () => rlSdk.facilities.list(),
        (err: unknown) => err instanceof OneLineBookingApiError && err.status === 429 && err.code === "RATE_LIMITED",
      );

      // Usage metering deduplication check
      const dupKey = `dedup-${randomUUID()}`;
      const u1 = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.liveEnvironment.id,
        tenantId: tenant.id,
        metric: "api_request",
        quantity: 5,
        idempotencyKey: dupKey,
      });
      const u2 = await platform.recordUsage({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.liveEnvironment.id,
        tenantId: tenant.id,
        metric: "api_request",
        quantity: 5,
        idempotencyKey: dupKey,
      });
      assert.equal(u1.recorded, true);
      assert.equal(u2.recorded, false);

      const usage = await sdkA.usage.getSummary();
      assert.ok(usage.metrics.some((m) => m.metric === "booking_confirmed" && m.totalQuantity >= 3));
      assert.ok(usage.metrics.some((m) => m.metric === "webhook_delivered" && m.totalQuantity >= 3));
    } finally {
      await Promise.all([
        closeServer(serverA),
        closeServer(serverB),
        closeServer(rlServer),
        closeServer(webhookServer),
        poolA.end(),
        poolB.end(),
      ]);
    }
  });
});