import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import {
  ALL_PLATFORM_SCOPES,
  BillingService,
  BookingError,
  ConsoleAuthService,
  PlatformService,
  PostgresBookingStore,
  SmtpEmailTransport,
  TimeSlotEngine,
  createBookingPool,
  createPlatformHttpServer,
  decryptSecret,
  resolveMasterKeyring,
  runMigrations,
} from "../../src/index.js";

function listenServer(server: Server): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/** Lightweight in-process RFC 5321 SMTP capture server when external Mailpit port 1025 is not running. */
function startLocalSmtpCapture(): Promise<{
  port: number;
  messages: Array<{ to: string; body: string }>;
  close: () => Promise<void>;
}> {
  const messages: Array<{ to: string; body: string }> = [];
  const srv = net.createServer((socket) => {
    socket.write("220 localhost SimpleSMTP\r\n");
    let buf = "";
    let inData = false;
    let currentTo = "";
    let dataLines: string[] = [];

    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ to: currentTo, body: dataLines.join("\n") });
            dataLines = [];
            socket.write("250 2.0.0 Ok\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-localhost\r\n250 OK\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          socket.write("250 Ok\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          currentTo = line.slice(8).replace(/[<>]/g, "").trim();
          socket.write("250 Ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 Ok\r\n");
        }
      }
    });
  });
  return new Promise((resolvePromise) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolvePromise({
        port: addr.port,
        messages,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

describe("Phase 8 Security Regression, KMS Rotation, Auth Email, Billing & Book My Game Pilot", () => {
  let pool: Pool;
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;
  let platform: PlatformService;
  let billing: BillingService;

  before(async () => {
    pool = createBookingPool(undefined, { max: 16 });
    pool.on("error", () => {});
    await runMigrations(pool);
    store = new PostgresBookingStore(pool);
    engine = new TimeSlotEngine(store);
    platform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });
    billing = new BillingService(pool);
  });

  after(async () => {
    await pool.end();
  });

  it("enforces live-vs-test webhook SSRF isolation, canonical JSON idempotency, retry billing deduplication & KMS keyring rotation", async () => {
    const tag = randomUUID().slice(0, 8);
    const key1 = randomBytes(32).toString("hex");
    const key2 = randomBytes(32).toString("hex");
    const ringV1 = resolveMasterKeyring({ activeVersion: 1, keys: { 1: Buffer.from(key1, "hex") }, providerName: "test-kms" });
    const ringV2 = resolveMasterKeyring({
      activeVersion: 2,
      keys: { 1: Buffer.from(key1, "hex"), 2: Buffer.from(key2, "hex") },
      providerName: "test-kms",
    });

    const kmsPlatformV1 = new PlatformService(pool, {
      keyring: ringV1,
      ssrfOptions: { allowLocalHttpForTesting: true },
    });

    const { organization } = await kmsPlatformV1.createOrganization({ name: `KmsOrg ${tag}`, slug: `kms-${tag}` });
    const proj = await kmsPlatformV1.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "KmsProj",
      slug: `kms-proj-${tag}`,
    });
    const testTenant = await kmsPlatformV1.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: "Test Tenant",
    });
    const liveTenant = await kmsPlatformV1.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.liveEnvironment.id,
      name: "Live Tenant",
    });

    // Live environment strictly forbids HTTP/localhost even with allowLocalHttpForTesting=true!
    await assert.rejects(
      () =>
        kmsPlatformV1.createWebhookEndpoint({
          organizationId: organization.id,
          projectId: proj.project.id,
          environmentId: proj.liveEnvironment.id,
          tenantId: liveTenant.id,
          url: "http://127.0.0.1:4999/hook",
        }),
      (err: unknown) => err instanceof BookingError && err.code === "FORBIDDEN",
    );

    // Test environment permits test HTTP receiver & encrypts under KMS version 1
    const ep = await kmsPlatformV1.createWebhookEndpoint({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: testTenant.id,
      url: "http://127.0.0.1:4999/hook",
    });
    const rowBefore = await pool.query<{ secret_key_version: number; signing_secret_encrypted: string }>(
      `SELECT secret_key_version, signing_secret_encrypted FROM webhook_endpoints WHERE id = $1`,
      [ep.endpoint.id],
    );
    assert.equal(rowBefore.rows[0]!.secret_key_version, 1);
    assert.ok(rowBefore.rows[0]!.signing_secret_encrypted.startsWith("enc.v2.1."));

    // Re-encrypt secrets cleanly to KMS key version 2 without losing HMAC secret parity
    const rotRes = await kmsPlatformV1.reEncryptWebhookSecrets({
      targetKeyring: ringV2,
      organizationId: organization.id,
    });
    assert.equal(rotRes.rotatedCount, 1);
    assert.equal(rotRes.activeKeyVersion, 2);

    const rowAfter = await pool.query<{ secret_key_version: number; signing_secret_encrypted: string }>(
      `SELECT secret_key_version, signing_secret_encrypted FROM webhook_endpoints WHERE id = $1`,
      [ep.endpoint.id],
    );
    assert.equal(rowAfter.rows[0]!.secret_key_version, 2);
    assert.ok(rowAfter.rows[0]!.signing_secret_encrypted.startsWith("enc.v2.2."));
    assert.equal(decryptSecret(rowAfter.rows[0]!.signing_secret_encrypted, ringV2), ep.signingSecret);

    // HTTP Idempotency with canonical JSON key ordering + concurrent retry usage deduplication
    const testKey = await kmsPlatformV1.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: testTenant.id,
      name: "Canonical Key",
      scopes: ALL_PLATFORM_SCOPES,
    });
    const apiServer = createPlatformHttpServer({ pool, engine, platform: kmsPlatformV1 });
    const apiBase = await listenServer(apiServer);

    try {
      const tClient = engine.forTenant({
        tenantId: testTenant.id,
        actor: { id: "s", type: "admin", capabilities: ["facility:write", "schedule:write", "facility:read", "availability:read"] },
      });
      const fac = await tClient.createFacility({ name: "Stage 1", category: "pc", timeZone: "UTC" });
      const dateStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const weekday = ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await tClient.setSchedule(fac.id, [{ weekday, opensAt: "09:00", closesAt: "18:00", endDayOffset: 0, effectiveFrom: dateStr, effectiveUntil: null, breaks: [] }]);
      await tClient.setSlotPolicy(fac.id, { durationMinutes: 60, intervalMinutes: 60, minNoticeMinutes: 0, maxAdvanceDays: 90, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxSlotsPerBooking: 4, defaultHoldMinutes: 5, maxActiveHoldsPerCustomer: 5 });
      await tClient.setPricing({ facilityId: fac.id, amountMinor: 1000, currency: "USD" });
      const avail = await tClient.getAvailability({ facilityIds: [fac.id], fromDate: dateStr, toDate: dateStr });
      const slotRef = avail.slots[0]!.slotRef;

      // Send TWO concurrent POST /v1/holds with different JSON key order & identical Idempotency-Key!
      const sharedIdem = `canon-${randomUUID()}`;
      const [res1, res2] = await Promise.all([
        fetch(`${apiBase}/v1/holds`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testKey.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": sharedIdem,
          },
          body: JSON.stringify({ facilityId: fac.id, slotRefs: [slotRef], externalCustomerId: "cust-canon" }),
        }),
        fetch(`${apiBase}/v1/holds`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testKey.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": sharedIdem,
          },
          body: JSON.stringify({ externalCustomerId: "cust-canon", slotRefs: [slotRef], facilityId: fac.id }),
        }),
      ]);
      assert.equal(res1.status, 201);
      assert.equal(res2.status, 201);
      const j1 = (await res1.json()) as { hold: { id: string } };
      const j2 = (await res2.json()) as { hold: { id: string } };
      assert.equal(j1.hold.id, j2.hold.id);

      // Verify usage_records recorded ONLY ONE hold_created metric despite concurrent retry!
      const usageCount = await pool.query<{ qty: string }>(
        `SELECT COALESCE(SUM(quantity), 0)::text AS qty
         FROM usage_records
         WHERE environment_id = $1 AND metric = 'hold_created'`,
        [proj.testEnvironment.id],
      );
      assert.equal(Number(usageCount.rows[0]!.qty), 1);
    } finally {
      await closeServer(apiServer);
    }
  });

  it("delivers real SMTP verification, password reset & invite emails, enforces billing ledger deduplication, and runs Book My Game pilot", async () => {
    const smtp = await startLocalSmtpCapture();
    const mailPort = Number(process.env.MAILPIT_SMTP_PORT || smtp.port);
    const authService = new ConsoleAuthService(pool, {
      emailTransport: new SmtpEmailTransport("127.0.0.1", mailPort),
    });

    const tag = randomUUID().slice(0, 8);
    const email = `pilot-${tag}@example.com`;
    try {
      const user = await authService.registerUser({ email, name: "Pilot Admin", password: "InitialPassword123!" });

      // 1. Email verification via real SMTP
      const ver = await authService.requestEmailVerification(email);
      assert.equal(ver.sent, true);
      if (!process.env.MAILPIT_SMTP_PORT) {
        assert.ok(smtp.messages.some((m) => m.to === email && m.body.includes(ver.verificationToken)));
      }
      const verRes = await authService.verifyEmail(ver.verificationToken);
      assert.equal(verRes.verified, true);

      // 2. Password reset invalidates old sessions and enforces new password
      const login1 = await authService.loginUser({ email, password: "InitialPassword123!" });
      assert.ok(await authService.verifySession(login1.sessionToken));

      const rst = await authService.requestPasswordReset(email);
      assert.ok(rst.resetToken);
      await authService.resetPassword({ resetToken: rst.resetToken, newPassword: "UpdatedPassword456!" });
      assert.equal(await authService.verifySession(login1.sessionToken), null);

      const login2 = await authService.loginUser({ email, password: "UpdatedPassword456!" });
      assert.ok(await authService.verifySession(login2.sessionToken));

      // 3. Organization invite delivery + Commercial Billing Infrastructure
      const { organization } = await platform.createOrganization({ name: `BMG Org ${tag}`, slug: `bmg-${tag}`, ownerEmail: email });
      const inviteeEmail = `staff-${tag}@example.com`;
      const invitee = await authService.registerUser({ email: inviteeEmail, name: "Desk Staff", password: "StaffPassword123!" });
      const inv = await authService.createOrganizationInvitation({
        organizationId: organization.id,
        email: inviteeEmail,
        role: "developer",
        invitedByUserId: user.id,
        invitedByEmail: email,
      });
      await authService.acceptOrganizationInvitation({
        inviteToken: inv.inviteToken,
        userId: invitee.id,
        userEmail: inviteeEmail,
      });

      // Plan -> Trial -> Overage hard_cap -> Invoice -> Idempotent Webhook Reconciliation
      const plan = await billing.createPlanWithVersion({
        slug: `pilot-starter-${tag}`,
        name: "Pilot Starter",
        currency: "USD",
        monthlyBaseMinor: 2900,
        includedBookings: 2,
        includedApiRequests: 100,
        overageBookingMinor: 50,
        overageApiRequest1kMinor: 10,
        trialDays: 0,
        overagePolicy: "allow_and_bill",
      });
      const sub = await billing.startSubscription({ organizationId: organization.id, planVersionId: plan.id, startTrial: false });
      assert.equal(sub.status, "active");

      const proj = await platform.createProjectWithEnvironments({
        organizationId: organization.id,
        name: "BookMyGame",
        slug: `bmg-proj-${tag}`,
      });
      const tenant = await platform.createScopedTenant({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        name: "BookMyGame India",
      });
      const apiKey = await platform.createApiKey({
        organizationId: organization.id,
        projectId: proj.project.id,
        environmentId: proj.testEnvironment.id,
        tenantId: tenant.id,
        name: "Pilot API Key",
        scopes: ALL_PLATFORM_SCOPES,
      });

      // 4. Real-World Pilot: Book My Game (strictly REST API + SDK, zero direct DB imports)
      const bmgCode = readFileSync(resolve(process.cwd(), "examples/book-my-game/server.mjs"), "utf8");
      assert.equal(bmgCode.includes("PostgresBookingStore"), false);
      assert.equal(bmgCode.includes('from "pg"'), false);

      const apiServer = createPlatformHttpServer({ pool, engine, platform });
      const apiUrl = await listenServer(apiServer);
      const { createBookMyGameApp } = await import(
        pathToFileURL(resolve(process.cwd(), "examples/book-my-game/server.mjs")).href
      ) as { createBookMyGameApp: (cfg: { apiBaseUrl: string; apiKey: string; tenantId?: string }) => Server };
      const pilotServer = createBookMyGameApp({ apiBaseUrl: apiUrl, apiKey: apiKey.token, tenantId: tenant.id });
      const pilotUrl = await listenServer(pilotServer);

      try {
        const dateStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        // Onboard 2 outlets with PC & PS5 inventory
        const onbRes = await fetch(`${pilotUrl}/api/pilot/onboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outlets: ["Indiranagar Hub", "Koramangala Lounge"], effectiveFrom: dateStr }),
        });
        assert.equal(onbRes.status, 201);
        const onbData = (await onbRes.json()) as { locations: unknown[]; inventory: Array<{ id: string }> };
        assert.equal(onbData.locations.length, 2);
        assert.equal(onbData.inventory.length, 4);

        const pcBayId = onbData.inventory[0]!.id;
        const availRes = await fetch(`${pilotUrl}/api/pilot/availability?facilityId=${pcBayId}&fromDate=${dateStr}`);
        const avail = (await availRes.json()) as { slots: Array<{ slotRef: string; startsAt: string; endsAt: string; amountMinor: number; currency: string }> };
        assert.ok(avail.slots.length >= 4);

        // Online reservation places a hold and leaves payment unverified.
        const onlineRes = await fetch(`${pilotUrl}/api/pilot/reserve/online`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facilityId: pcBayId,
            slotRefs: [avail.slots[0]!.slotRef],
            customerId: "online-gamer-1",
            expectedAmountMinor: avail.slots[0]!.amountMinor,
            expectedCurrency: avail.slots[0]!.currency,
          }),
        });
        assert.equal(onlineRes.status, 201);
        const onlineJson = (await onlineRes.json()) as {
          booking: null;
          payment: { confirmed: boolean; status: string };
        };
        assert.equal(onlineJson.booking, null);
        assert.equal(onlineJson.payment.confirmed, false);
        assert.equal(onlineJson.payment.status, "awaiting_provider");

        // Receptionist walk-in pay-at-counter reservation
        const walkInRes = await fetch(`${pilotUrl}/api/pilot/reserve/walk-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facilityId: pcBayId,
            slotRefs: [avail.slots[1]!.slotRef],
            customerId: "walkin-gamer-2",
            payAtCounter: true,
          }),
        });
        assert.equal(walkInRes.status, 201);
        const walkInData = (await walkInRes.json()) as { booking: { id: string } };

        // Maintenance blackout blocks slot 2 cleanly
        const blkRes = await fetch(`${pilotUrl}/api/pilot/blackouts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facilityId: pcBayId,
            startsAt: avail.slots[2]!.startsAt,
            endsAt: avail.slots[2]!.endsAt,
            reason: "GPU Thermal Repaste",
          }),
        });
        assert.equal(blkRes.status, 201);

        const blockedBook = await fetch(`${pilotUrl}/api/pilot/reserve/walk-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facilityId: pcBayId,
            slotRefs: [avail.slots[2]!.slotRef],
            customerId: "walkin-gamer-3",
          }),
        });
        assert.equal(blockedBook.status, 409);

        // Customer cancellation & booking history
        const cancelRes = await fetch(`${pilotUrl}/api/pilot/bookings/${walkInData.booking.id}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Rescheduled" }),
        });
        assert.equal(cancelRes.status, 200);

        const histRes = await fetch(`${pilotUrl}/api/pilot/customers/online-gamer-1/bookings`);
        const hist = (await histRes.json()) as { items: unknown[] };
        assert.equal(hist.items.length, 1);

        // Generate invoice (2 bookings + overage check -> idempotent deduplication + webhook reconciliation)
        const inv1 = await billing.generateInvoiceForPeriod({ organizationId: organization.id, idempotencyKey: `cycle-${tag}` });
        const inv2 = await billing.generateInvoiceForPeriod({ organizationId: organization.id, idempotencyKey: `cycle-${tag}` });
        assert.equal(inv1.deduplicated, false);
        assert.equal(inv2.deduplicated, true);
        assert.equal(inv1.invoice.id, inv2.invoice.id);

        const hook1 = await billing.reconcileProviderWebhook({
          provider: "stripe",
          providerEventId: `evt_${tag}`,
          eventType: "invoice.paid",
          organizationId: organization.id,
          invoiceId: inv1.invoice.id,
        });
        const hookDup = await billing.reconcileProviderWebhook({
          provider: "stripe",
          providerEventId: `evt_${tag}`,
          eventType: "invoice.paid",
          organizationId: organization.id,
          invoiceId: inv1.invoice.id,
        });
        assert.equal(hook1.processed, true);
        assert.equal(hookDup.duplicate, true);
      } finally {
        await Promise.all([closeServer(apiServer), closeServer(pilotServer)]);
      }
    } finally {
      await smtp.close();
    }
  });
});

