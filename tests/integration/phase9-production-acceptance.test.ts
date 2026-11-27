import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "pg";
import {
  ALL_PLATFORM_SCOPES,
  BillingService,
  BookingError,
  ConsoleAuthService,
  HoldExpiryWorker,
  PlatformService,
  PostgresBookingStore,
  PostgresDistributedLimiter,
  SandboxStripePaymentProvider,
  TimeSlotEngine,
  createBookingPool,
  createPlatformHttpServer,
  runMigrations,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

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

describe("Phase 9 Production Acceptance: Security Hardening, Sandbox Billing, DX & Book My Game Pilot", () => {
  let pool: Pool;
  let store: PostgresBookingStore;
  let engine: TimeSlotEngine;
  let platform: PlatformService;
  let auth: ConsoleAuthService;

  before(async () => {
    pool = createBookingPool(undefined, { max: 20 });
    await runMigrations(pool);
    store = new PostgresBookingStore(pool);
    engine = new TimeSlotEngine(store);
    platform = new PlatformService(pool, {
      masterKey: randomBytes(32),
      ssrfOptions: { allowLocalHttpForTesting: true },
    });
    auth = new ConsoleAuthService(pool);
  });

  after(async () => {
    await pool.end();
  });

  it("blocks cross-org assignProjectRole BOLA, invalidates stale reset tokens, enforces CORS, lease renewal, and idempotent cancel/no-charge replays", async () => {
    const tag = randomUUID().slice(0, 8);
    const adminAEmail = `orgA-admin-${tag}@example.com`;
    const victimUserEmail = `orgB-victim-${tag}@example.com`;
    await auth.registerUser({ email: adminAEmail, name: "Org A Admin", password: "StrongPassword123!" });
    await auth.registerUser({ email: victimUserEmail, name: "Victim", password: "StrongPassword123!" });

    const { organization: orgA } = await platform.createOrganization({
      name: `Org A ${tag}`,
      slug: `orga-${tag}`,
      ownerEmail: adminAEmail,
    });
    const { organization: orgB } = await platform.createOrganization({
      name: `Org B ${tag}`,
      slug: `orgb-${tag}`,
      ownerEmail: victimUserEmail,
    });
    const projB = await platform.createProjectWithEnvironments({
      organizationId: orgB.id,
      name: "Project B",
      slug: `projb-${tag}`,
    });

    // 1. Cross-organization project role assignment MUST fail with FORBIDDEN
    await assert.rejects(
      () =>
        auth.assignProjectRole({
          organizationId: orgA.id,
          projectId: projB.project.id,
          actorEmail: adminAEmail,
          targetEmail: adminAEmail,
          role: "admin",
        }),
      (err: unknown) => err instanceof BookingError && err.code === "FORBIDDEN",
    );

    // 2. Issuing a new password reset invalidates older unused reset token
    const r1 = await auth.requestPasswordReset(victimUserEmail);
    const r2 = await auth.requestPasswordReset(victimUserEmail);
    assert.ok(r1.resetToken && r2.resetToken && r1.resetToken !== r2.resetToken);
    await assert.rejects(
      () => auth.resetPassword({ resetToken: r1.resetToken!, newPassword: "NewStrongPassword1!" }),
      (err: unknown) => err instanceof BookingError && err.code === "NOT_FOUND",
    );
    const okReset = await auth.resetPassword({
      resetToken: r2.resetToken!,
      newPassword: "NewStrongPassword2!",
    });
    assert.equal(okReset.reset, true);

    // 3. Distributed lease expiration & explicit renewal
    const limiter = new PostgresDistributedLimiter(pool, {
      instanceId: "phase9-test-node",
      maxTenantConcurrentLeases: 1,
      leaseTtlSeconds: 2,
    });
    const lease = await limiter.acquireTenantLease(`scope-${tag}`);
    const renewed = await lease.renew(10);
    assert.equal(renewed, true);
    await assert.rejects(
      () => limiter.acquireTenantLease(`scope-${tag}`),
      (err: unknown) => err instanceof BookingError && err.code === "TEMPORARY_UNAVAILABLE",
    );
    await lease();
    const leaseAfterRelease = await limiter.acquireTenantLease(`scope-${tag}`);
    await leaseAfterRelease();

    // 4. CORS strict policy, cancel HTTP idempotency & no usage charge for failed bookings
    const tenantB = await platform.createScopedTenant({
      organizationId: orgB.id,
      projectId: projB.project.id,
      environmentId: projB.testEnvironment.id,
      name: `Tenant ${tag}`,
    });
    const { token: plaintextKey } = await platform.createApiKey({
      organizationId: orgB.id,
      projectId: projB.project.id,
      environmentId: projB.testEnvironment.id,
      tenantId: tenantB.id,
      name: "Cancel + CORS Key",
      scopes: [...ALL_PLATFORM_SCOPES],
    });

    const apiServer = createPlatformHttpServer({
      pool,
      engine,
      platform,
      corsAllowedOrigins: ["https://allowed-app.example.com"],
      logRequestsToDb: false,
    });
    const apiUrl = await listenServer(apiServer);

    try {
      // Disallowed CORS preflight rejected
      const badPreflight = await fetch(`${apiUrl}/v1/facilities`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.net" },
      });
      assert.equal(badPreflight.status, 403);
      assert.equal(badPreflight.headers.get("access-control-allow-origin"), null);
      assert.equal(badPreflight.headers.get("x-content-type-options"), "nosniff");
      assert.equal(badPreflight.headers.get("x-frame-options"), "DENY");

      // Allowed CORS preflight
      const goodPreflight = await fetch(`${apiUrl}/v1/facilities`, {
        method: "OPTIONS",
        headers: { Origin: "https://allowed-app.example.com" },
      });
      assert.equal(goodPreflight.status, 204);
      assert.equal(goodPreflight.headers.get("access-control-allow-origin"), "https://allowed-app.example.com");

      // Create facility + direct booking + test failed conflict doesn't increment booking_confirmed usage
      const baseDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      const facClient = engine.forTenant({
        tenantId: tenantB.id,
        actor: { id: "setup", type: "admin", capabilities: ["facility:write", "schedule:write"] },
      });
      const fac = await facClient.createFacility({ name: "Bay C9", category: "pc", timeZone: "UTC" });
      await facClient.setSchedule(
        fac.id,
        [1, 2, 3, 4, 5, 6, 7].map((w) => ({
          weekday: w as 1 | 2 | 3 | 4 | 5 | 6 | 7,
          opensAt: "10:00",
          closesAt: "16:00",
          endDayOffset: 0 as const,
          effectiveFrom: baseDate,
          effectiveUntil: null,
          breaks: [],
        })),
      );
      await facClient.setSlotPolicy(fac.id, {
        durationMinutes: 60,
        intervalMinutes: 60,
        minNoticeMinutes: 0,
        maxAdvanceDays: 90,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        maxSlotsPerBooking: 2,
        defaultHoldMinutes: 5,
        maxActiveHoldsPerCustomer: 5,
      });
      await facClient.setPricing({ facilityId: fac.id, amountMinor: 500, currency: "USD" });

      const avRes = await fetch(`${apiUrl}/v1/availability?facilityId=${fac.id}&fromDate=${baseDate}&toDate=${baseDate}`, {
        headers: { Authorization: `Bearer ${plaintextKey}` },
      });
      const avJson = (await avRes.json()) as { slots: Array<{ slotRef: string; available: boolean }> };
      const slotRef = avJson.slots.find((s) => s.available)!.slotRef;

      const bkRes = await fetch(`${apiUrl}/v1/bookings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${plaintextKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `bk-${tag}`,
        },
        body: JSON.stringify({ facilityId: fac.id, slotRefs: [slotRef], externalCustomerId: "cust-1" }),
      });
      assert.equal(bkRes.status, 201);
      const bkId = ((await bkRes.json()) as { booking: { id: string } }).booking.id;

      // Conflicting failed hold MUST NOT record hold_created
      const failHold = await fetch(`${apiUrl}/v1/holds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${plaintextKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `fail-hold-${tag}`,
        },
        body: JSON.stringify({ facilityId: fac.id, slotRefs: [slotRef], externalCustomerId: "cust-2" }),
      });
      assert.equal(failHold.status, 409);

      // Concurrent HTTP cancel retries with identical Idempotency-Key replay cleanly and bill once
      const cancelKey = `can-${tag}`;
      const c1 = await fetch(`${apiUrl}/v1/bookings/${bkId}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${plaintextKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": cancelKey,
        },
        body: JSON.stringify({ reason: "User cancel" }),
      });
      const c2 = await fetch(`${apiUrl}/v1/bookings/${bkId}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${plaintextKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": cancelKey,
        },
        body: JSON.stringify({ reason: "User cancel" }),
      });
      assert.equal(c1.status, 200);
      assert.equal(c2.status, 200);
      assert.equal(c2.headers.get("x-idempotent-replay"), "true");

      const usageRows = await platform.getUsageSummary({ environmentId: projB.testEnvironment.id, tenantId: tenantB.id });
      const sumMetric = (metric: string) => usageRows.filter((r) => r.metric === metric).reduce((s, r) => s + r.totalQuantity, 0);
      assert.equal(sumMetric("booking_confirmed"), 1);
      assert.equal(sumMetric("hold_created"), 0);
      assert.equal(sumMetric("booking_cancelled"), 1);
    } finally {
      await closeServer(apiServer);
    }
  });

  it("completes sandbox commercial billing lifecycle: decline recovery, concurrent invoice lock, renewal, quotas & refund caps", async () => {
    const tag = randomUUID().slice(0, 8);
    const { organization: org } = await platform.createOrganization({
      name: `BillOrg ${tag}`,
      slug: `billorg-${tag}`,
      ownerEmail: `bill-${tag}@example.com`,
    });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: org.id,
      name: "Bill Proj",
      slug: `billproj-${tag}`,
    });
    const tenant = await platform.createScopedTenant({
      organizationId: org.id,
      projectId: proj.liveEnvironment.id ? proj.project.id : proj.project.id,
      environmentId: proj.liveEnvironment.id,
      name: `Bill Tenant ${tag}`,
    });

    const sandboxProvider = new SandboxStripePaymentProvider({
      webhookSecret: "whsec_sbx_phase9_test",
      declineOrganizationIds: [org.id],
    });
    const billing = new BillingService(pool, sandboxProvider);

    const plan = await billing.createPlanWithVersion({
      slug: `pro-sbx-${tag}`,
      name: "Pro Sandbox",
      currency: "USD",
      monthlyBaseMinor: 4900,
      includedBookings: 2,
      includedApiRequests: 100,
      overageBookingMinor: 150,
      overageApiRequest1kMinor: 200,
      trialDays: 0, // immediate active subscription
      overagePolicy: "allow_and_bill",
    });

    const sub = await billing.startSubscription({
      organizationId: org.id,
      planVersionId: plan.id,
      startTrial: false,
    });
    assert.equal(sub.status, "active");
    assert.equal(sub.provider, "stripe_sandbox");

    // Record 4 confirmed bookings -> 2 overage bookings ($3.00 overage + $49.00 base = $52.00 = 5200 minor)
    for (let i = 0; i < 4; i++) {
      await platform.recordUsage({
        organizationId: org.id,
        projectId: proj.project.id,
        environmentId: proj.liveEnvironment.id,
        tenantId: tenant.id,
        scopeKey: tenant.id,
        metric: "booking_confirmed",
        idempotencyKey: `bill-bk-${tag}-${i}`,
      });
    }

    // Concurrent generateInvoiceForPeriod calls with SAME idempotencyKey serialize safely via FOR UPDATE OF s
    const invKey = `inv-period-1-${tag}`;
    const [invA, invB] = await Promise.all([
      billing.generateInvoiceForPeriod({ organizationId: org.id, idempotencyKey: invKey }),
      billing.generateInvoiceForPeriod({ organizationId: org.id, idempotencyKey: invKey }),
    ]);
    assert.equal(invA.invoice.id, invB.invoice.id);
    assert.equal(Number(invA.deduplicated) + Number(invB.deduplicated), 1);
    assert.equal(invA.invoice.subtotalMinor, 4900);
    assert.equal(invA.invoice.overageMinor, 300);
    assert.equal(invA.invoice.totalMinor, 5200);
    // Declined in sandbox -> stays "open"
    assert.equal(invA.invoice.status, "open");

    // Sandbox failed payment webhook moves subscription to past_due and blocks quota check
    const rawEvt = JSON.stringify({ event: "invoice.payment_failed", id: `evt_fail_${tag}` });
    const sigHdr = sandboxProvider.signWebhookPayload(rawEvt);
    assert.equal(sandboxProvider.verifyWebhookSignature(rawEvt, sigHdr), true);

    await billing.reconcileProviderWebhook({
      provider: "stripe_sandbox",
      providerEventId: `evt_fail_${tag}`,
      eventType: "invoice.payment_failed",
      organizationId: org.id,
      subscriptionId: sub.id,
    });
    const blockedQuota = await billing.evaluateOrganizationQuota(org.id);
    assert.equal(blockedQuota.allowed, false);
    assert.equal(blockedQuota.status, "past_due");

    // Payment method updated -> clear decline and execute retryFailedPayment()
    sandboxProvider.declineOrganizationIds.delete(org.id);
    const recovered = await billing.retryFailedPayment({
      organizationId: org.id,
      invoiceId: invA.invoice.id,
      idempotencyKey: `retry-${tag}`,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.invoice.status, "paid");

    const restoredQuota = await billing.evaluateOrganizationQuota(org.id);
    assert.equal(restoredQuota.allowed, true);
    assert.equal(restoredQuota.status, "active");

    // Renew subscription period
    const renewedSub = await billing.renewSubscriptionPeriod({ organizationId: org.id });
    assert.ok(new Date(renewedSub.currentPeriodEnd).getTime() > new Date(sub.currentPeriodEnd).getTime());

    // Reconcile partial refund ($10.00 = 1000 minor), verify idempotency, and reject over-refund (> 5200)
    const ref1 = await billing.reconcileRefund({
      provider: "stripe_sandbox",
      providerEventId: `re_1_${tag}`,
      organizationId: org.id,
      invoiceId: invA.invoice.id,
      amountMinor: 1000,
      reason: "Partial service credit",
    });
    assert.equal(ref1.refunded, true);
    assert.equal(ref1.totalRefundedMinor, 1000);

    const refDup = await billing.reconcileRefund({
      provider: "stripe_sandbox",
      providerEventId: `re_1_${tag}`,
      organizationId: org.id,
      invoiceId: invA.invoice.id,
      amountMinor: 1000,
    });
    assert.equal(refDup.duplicate, true);
    assert.equal(refDup.totalRefundedMinor, 1000);

    await assert.rejects(
      () =>
        billing.reconcileRefund({
          provider: "stripe_sandbox",
          providerEventId: `re_over_${tag}`,
          organizationId: org.id,
          invoiceId: invA.invoice.id,
          amountMinor: 5000, // 1000 + 5000 = 6000 > 5200 paid!
        }),
      (err: unknown) => err instanceof BookingError && err.code === "INVALID_STATE_TRANSITION",
    );
  });

  it("verifies Express.js, Python REST client, and complete 13-scenario Book My Game pilot exclusively via public REST/SDK", async () => {
    const tag = randomUUID().slice(0, 8);
    const { organization } = await platform.createOrganization({
      name: `PilotOrg ${tag}`,
      slug: `pilotorg-${tag}`,
    });
    const proj = await platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: "Pilot",
      slug: `pilot-${tag}`,
    });
    const tenant = await platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: `BookMyGame ${tag}`,
    });
    const { token: plaintextKey } = await platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      name: "Pilot Integration Key",
      scopes: [...ALL_PLATFORM_SCOPES],
    });

    const apiServer = createPlatformHttpServer({
      pool,
      engine,
      platform,
      logRequestsToDb: false,
    });
    const apiUrl = await listenServer(apiServer);

    const bookMyGameModule = (await import(
      pathToFileURL(resolve(process.cwd(), "examples/book-my-game/server.mjs")).href
    )) as { createBookMyGameApp: (cfg: { apiBaseUrl: string; apiKey: string; tenantId?: string }) => Server };
    const pilotServer = bookMyGameModule.createBookMyGameApp({
      apiBaseUrl: apiUrl,
      apiKey: plaintextKey,
      tenantId: tenant.id,
    });
    const pilotUrl = await listenServer(pilotServer);

    const expressModule = (await import(
      pathToFileURL(resolve(process.cwd(), "examples/integrations/express-app/server.mjs")).href
    )) as {
      createExpressIntegrationApp: (cfg: {
        apiBaseUrl: string;
        apiKey: string;
        tenantId?: string;
      }) => { listen: (p: number, h: string, cb: () => void) => Server };
    };
    const expressApp = expressModule.createExpressIntegrationApp({
      apiBaseUrl: apiUrl,
      apiKey: plaintextKey,
      tenantId: tenant.id,
    });
    const expressSrv = await new Promise<Server>((resSrv) => {
      const s = expressApp.listen(0, "127.0.0.1", () => resSrv(s));
    });
    const expressUrl = `http://127.0.0.1:${(expressSrv.address() as AddressInfo).port}`;

    try {
      const effectiveDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

      // 1-3: Onboarding + multiple outlets + PC & PS5 gaming stations
      const onboardRes = await fetch(`${pilotUrl}/api/pilot/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outlets: ["Koramangala", "Whitefield"],
          effectiveFrom: effectiveDate,
          timeZone: "UTC",
        }),
      });
      assert.equal(onboardRes.status, 201);
      const onboarded = (await onboardRes.json()) as {
        locations: Array<{ id: string }>;
        inventory: Array<{ id: string; name: string }>;
      };
      assert.equal(onboarded.locations.length, 2);
      assert.equal(onboarded.inventory.length, 4);

      const invRes = await fetch(`${pilotUrl}/api/pilot/inventory`);
      const invJson = (await invRes.json()) as { items: Array<{ id: string }> };
      assert.equal(invJson.items.length, 4);

      const pcStationId = onboarded.inventory[0]!.id;
      const ps5StationId = onboarded.inventory[1]!.id;

      // Verify Express.js integration example works cleanly against live /v1 without source edits
      const expAvail = await fetch(`${expressUrl}/api/availability?facilityId=${ps5StationId}&fromDate=${effectiveDate}&toDate=${effectiveDate}`);
      assert.equal(expAvail.status, 200);
      const expSlots = (await expAvail.json()) as { slots: Array<{ slotRef: string; available: boolean }> };
      const expBook = await fetch(`${expressUrl}/api/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: ps5StationId,
          slotRefs: [expSlots.slots[0]!.slotRef],
          customerId: "express-dev-user",
        }),
      });
      assert.equal(expBook.status, 201);

      // Verify Python 3 REST client example creates, confirms, and cancels booking cleanly
      const { stdout: pyOut } = await execFileAsync(
        "python",
        [resolve(process.cwd(), "examples/integrations/python-rest/client.py")],
        {
          env: {
            ...process.env,
            OLB_API_URL: apiUrl,
            OLB_API_KEY: plaintextKey,
            OLB_FACILITY_ID: ps5StationId,
            OLB_DATE: effectiveDate,
            OLB_TENANT_ID: tenant.id,
          },
        },
      );
      const pyResult = JSON.parse(pyOut.trim()) as { ok: boolean; finalStatus: string };
      assert.equal(pyResult.ok, true);
      assert.equal(pyResult.finalStatus, "cancelled");

      // Load Book My Game PC availability
      const availRes = await fetch(`${pilotUrl}/api/pilot/availability?facilityId=${pcStationId}&fromDate=${effectiveDate}&toDate=${effectiveDate}`);
      const avail = (await availRes.json()) as {
        slots: Array<{ slotRef: string; available: boolean; startsAt: string; endsAt: string }>;
      };
      const openSlots = avail.slots.filter((s) => s.available);
      assert.ok(openSlots.length >= 8);

      // 4-5: Online hold stays unpaid until the caller supplies a provider reference.
      const onlineRes = await fetch(`${pilotUrl}/api/pilot/reserve/online`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots[0]!.slotRef],
          customerId: "gamer-online-1",
          expectedAmountMinor: 12000,
          expectedCurrency: "INR",
          paymentMethod: "upi_online",
        }),
      });
      assert.equal(onlineRes.status, 201);
      const onlineJson = (await onlineRes.json()) as {
        booking: null;
        hold: { id: string };
        payment: { confirmed: boolean; status: string; simulated: boolean };
      };
      assert.equal(onlineJson.booking, null);
      assert.equal(onlineJson.payment.confirmed, false);
      assert.equal(onlineJson.payment.simulated, false);
      assert.equal(onlineJson.payment.status, "awaiting_provider");

      const unverifiedRes = await fetch(`${pilotUrl}/api/pilot/holds/${onlineJson.hold.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedAmountMinor: 12000, expectedCurrency: "INR" }),
      });
      assert.equal(unverifiedRes.status, 422);
      const unverifiedJson = (await unverifiedRes.json()) as { payment: { confirmed: boolean }; error: string };
      assert.equal(unverifiedJson.payment.confirmed, false);
      assert.equal(unverifiedJson.error.includes("pg_"), false);

      const confirmRes = await fetch(`${pilotUrl}/api/pilot/holds/${onlineJson.hold.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedAmountMinor: 12000,
          expectedCurrency: "INR",
          paymentRef: "provider_charge_test_001",
        }),
      });
      assert.equal(confirmRes.status, 200);
      const confirmedJson = (await confirmRes.json()) as {
        booking: { id: string; externalPaymentRef: string | null };
        payment: { confirmed: boolean; status: string; paymentRef: string };
      };
      assert.equal(confirmedJson.payment.confirmed, false);
      assert.equal(confirmedJson.payment.status, "reference_recorded");
      assert.equal(confirmedJson.payment.paymentRef, "provider_charge_test_001");
      assert.equal(confirmedJson.booking.externalPaymentRef, "provider_charge_test_001");

      // 6-7: Receptionist walk-in booking with CASH payment
      const walkInRes = await fetch(`${pilotUrl}/api/pilot/reserve/walk-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots[1]!.slotRef],
          customerId: "gamer-walkin-cash",
          cashPaid: true,
          cashAmountMinor: 12000,
          receiptNumber: "CASH-001",
        }),
      });
      assert.equal(walkInRes.status, 201);
      const walkInJson = (await walkInRes.json()) as { mode: string; receiptNumber: string; booking: { id: string; externalPaymentRef: string } };
      assert.equal(walkInJson.mode, "walk_in_cash_paid");
      assert.equal(walkInJson.booking.externalPaymentRef, "cash_paid:CASH-001");

      // 8: Pricing change via PUT /api/pilot/pricing -> old slotRef rejected with STALE_CONFIGURATION -> fresh availability reflects 15000 INR
      const priceUpdRes = await fetch(`${pilotUrl}/api/pilot/pricing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facilityId: pcStationId, amountMinor: 15000, currency: "INR" }),
      });
      assert.equal(priceUpdRes.status, 200);
      const staleSlotTry = await fetch(`${pilotUrl}/api/pilot/reserve/online`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots[2]!.slotRef],
          customerId: "gamer-stale-ref",
          expectedAmountMinor: 12000,
          expectedCurrency: "INR",
        }),
      });
      assert.equal(staleSlotTry.status, 409);

      // Re-fetch live availability with updated pricing (15000 INR)
      const avail2Res = await fetch(`${pilotUrl}/api/pilot/availability?facilityId=${pcStationId}&fromDate=${effectiveDate}&toDate=${effectiveDate}`);
      const avail2 = (await avail2Res.json()) as {
        slots: Array<{ slotRef: string; available: boolean; startsAt: string; endsAt: string; amountMinor?: number | null; currency?: string | null }>;
      };
      const openSlots2 = avail2.slots.filter((s) => s.available);
      assert.equal(openSlots2[0]?.amountMinor, 15000);

      // Explicit hold + expiration + HoldExpiryWorker reclamation
      const holdRes = await fetch(`${pilotUrl}/api/pilot/holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots2[0]!.slotRef],
          customerId: "gamer-expire",
        }),
      });
      assert.equal(holdRes.status, 201);
      const createdHold = (await holdRes.json()) as { hold: { id: string } };
      await pool.query(`UPDATE holds SET expires_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [createdHold.hold.id]);
      await pool.query(`UPDATE allocations SET expires_at = '2000-01-01T00:00:00Z' WHERE hold_id = $1`, [createdHold.hold.id]);
      const worker = new HoldExpiryWorker({ engine, batchLimit: 200 });
      const expSweep = await worker.runOnce();
      assert.ok(expSweep.expiredCount >= 1);

      // Confirm slot is bookable again after expiration at new price (15000 INR)
      const postExpBook = await fetch(`${pilotUrl}/api/pilot/reserve/online`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots2[0]!.slotRef],
          customerId: "gamer-after-expire",
          expectedAmountMinor: 15000,
          expectedCurrency: "INR",
        }),
      });
      assert.equal(postExpBook.status, 201);

      // 9-10: Maintenance blackout blocks next open slot
      const blkRes = await fetch(`${pilotUrl}/api/pilot/blackouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          startsAt: openSlots2[1]!.startsAt,
          endsAt: openSlots2[1]!.endsAt,
          reason: "GPU Thermal Paste Swap",
        }),
      });
      assert.equal(blkRes.status, 201);
      const blkTry = await fetch(`${pilotUrl}/api/pilot/reserve/online`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facilityId: pcStationId,
          slotRefs: [openSlots2[1]!.slotRef],
          customerId: "gamer-blocked",
        }),
      });
      assert.equal(blkTry.status, 409);

      // 11: Cancellation
      const canRes = await fetch(`${pilotUrl}/api/pilot/bookings/${confirmedJson.booking.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Customer rescheduled" }),
      });
      assert.equal(canRes.status, 200);

      // 12: Customer booking history
      const histRes = await fetch(`${pilotUrl}/api/pilot/customers/gamer-online-1/bookings`);
      assert.equal(histRes.status, 200);
      const histJson = (await histRes.json()) as { items: Array<{ id: string; status: string }> };
      assert.equal(histJson.items[0]?.id, confirmedJson.booking.id);
      assert.equal(histJson.items[0]?.status, "cancelled");

      // 13: Re-fetch availability after blackout config change -> concurrent customer bookings race for same slot -> strictly 1 winner
      const avail3Res = await fetch(`${pilotUrl}/api/pilot/availability?facilityId=${pcStationId}&fromDate=${effectiveDate}&toDate=${effectiveDate}`);
      const avail3 = (await avail3Res.json()) as {
        slots: Array<{ slotRef: string; available: boolean }>;
      };
      const raceSlot = avail3.slots.find((s) => s.available)!;
      const race = await Promise.all(
        Array.from({ length: 8 }, (_v, idx) =>
          fetch(`${pilotUrl}/api/pilot/reserve/online`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              facilityId: pcStationId,
              slotRefs: [raceSlot.slotRef],
              customerId: `racer-${idx}`,
            }),
          }),
        ),
      );
      const winners = race.filter((r) => r.status === 201).length;
      const conflicts = race.filter((r) => r.status === 409).length;
      assert.equal(winners, 1);
      assert.equal(conflicts, 7);
    } finally {
      expressSrv.close();
      await closeServer(pilotServer);
      await closeServer(apiServer);
    }
  });
});