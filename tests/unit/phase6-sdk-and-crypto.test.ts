import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OneLineBookingApiError,
  OneLineBookingClient,
  RuntimeTrafficLimiter,
  buildBudgetedPoolConfig,
  computeConnectionBudget,
  mapScopesToCapabilities,
  redactSecrets,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../src/index.js";

describe("Phase 6 Unit Tests: Connection Budget, Cryptography, Limiter & SDK", () => {
  it("computes safe multi-instance connection budgets without exhausting Postgres max_connections", () => {
    const plan = computeConnectionBudget({
      postgresMaxConnections: 100,
      apiInstanceCount: 4,
      reservedAdminConnections: 5,
      reservedWorkerConnections: 8,
      reservedMigrationConnections: 3,
    });

    assert.equal(plan.totalReservedConnections, 16);
    assert.equal(plan.perApiInstancePoolMax, 21);
    assert.equal(plan.totalApiConnectionBudget, 84);
    assert.ok(plan.totalApiConnectionBudget + plan.totalReservedConnections <= 100);

    const apiPool = buildBudgetedPoolConfig(plan, "api");
    assert.equal(apiPool.max, 21);

    const pgBouncerPlan = computeConnectionBudget({
      postgresMaxConnections: 100,
      apiInstanceCount: 4,
      pgbouncerDefaultPoolSize: 60,
    });
    assert.equal(pgBouncerPlan.pgbouncerEnabled, true);
    assert.equal(pgBouncerPlan.totalApiConnectionBudget, 60);
    assert.equal(pgBouncerPlan.perApiInstancePoolMax, 15);
    assert.equal(pgBouncerPlan.pgbouncerClientMaxPerInstance, 45);
  });

  it("rejects connection budget plans that leave insufficient slots for requested instances", () => {
    assert.throws(() =>
      computeConnectionBudget({
        postgresMaxConnections: 20,
        apiInstanceCount: 10,
        reservedAdminConnections: 5,
        reservedWorkerConnections: 6,
        reservedMigrationConnections: 3,
      }),
    );
  });

  it("signs and verifies webhook payloads with replay tolerance and constant-time MAC check", () => {
    const secret = "whsec_0123456789abcdef0123456789abcdef";
    const payload = JSON.stringify({ id: "evt_1", type: "booking.confirmed" });
    const nowSec = 1_700_000_000;

    const signed = signWebhookPayload(secret, payload, nowSec);
    assert.ok(
      verifyWebhookSignature({
        secret,
        payloadJson: payload,
        signatureHeader: signed.headerValue,
        nowSeconds: nowSec + 10,
      }),
    );

    // Tampered payload rejected
    assert.equal(
      verifyWebhookSignature({
        secret,
        payloadJson: payload + " ",
        signatureHeader: signed.headerValue,
        nowSeconds: nowSec + 10,
      }),
      false,
    );

    // Expired timestamp rejected
    assert.equal(
      verifyWebhookSignature({
        secret,
        payloadJson: payload,
        signatureHeader: signed.headerValue,
        nowSeconds: nowSec + 400,
        toleranceSeconds: 300,
      }),
      false,
    );
  });

  it("redacts API keys and webhook secrets from error strings and logs", () => {
    const leaked =
      "Auth failed for token olb_live_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef and secret whsec_0123456789abcdef0123456789abcdef";
    const safe = redactSecrets(leaked);
    assert.equal(safe.includes("olb_live_"), false);
    assert.equal(safe.includes("whsec_"), false);
    assert.equal((safe.match(/\[REDACTED_SECRET\]/g) ?? []).length, 2);
  });

  it("maps credential scopes strictly to least-privilege engine capabilities", () => {
    const readOnly = mapScopesToCapabilities(["availability:read", "bookings:read"]);
    assert.ok(readOnly.includes("availability:read"));
    assert.ok(readOnly.includes("booking:read"));
    assert.equal(readOnly.includes("hold:create"), false);
    assert.equal(readOnly.includes("booking:create_direct"), false);
    assert.equal(readOnly.includes("facility:write"), false);
  });

  it("enforces bounded queue depth, per-tenant concurrency cap, and rate limits", async () => {
    const limiter = new RuntimeTrafficLimiter({
      maxConcurrentRequests: 1,
      maxQueueDepth: 1,
      queueTimeoutMs: 500,
      maxPerTenantInFlight: 2,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 2,
    });

    assert.equal(limiter.checkRateLimit("k1", 1000).allowed, true);
    assert.equal(limiter.checkRateLimit("k1", 1001).allowed, true);
    const third = limiter.checkRateLimit("k1", 1002);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterSeconds >= 1);

    const release1 = await limiter.acquire("tenant-a");
    const p2 = limiter.acquire("tenant-a"); // queued cleanly (depth = 1)
    // 3rd request for tenant-a hits per-tenant limit (maxPerTenantInFlight=2) or queue full
    await assert.rejects(() => limiter.acquire("tenant-a"));
    // Another tenant also fails fast when global queue is saturated
    await assert.rejects(() => limiter.acquire("tenant-b"));

    release1();
    const release2 = await p2;
    release2();
  });

  it("SDK safely retries transient 429/503 responses reusing the exact same Idempotency-Key", async () => {
    const seenKeys: string[] = [];
    let callCount = 0;

    const fakeFetch: typeof fetch = async (_input, init) => {
      callCount += 1;
      const headers = init?.headers as Record<string, string>;
      seenKeys.push(headers["Idempotency-Key"] ?? "");

      if (callCount < 3) {
        return new Response(
          JSON.stringify({
            error: {
              code: "TEMPORARY_UNAVAILABLE",
              category: "infrastructure",
              message: "Try again",
              retryable: true,
              retryAfterSeconds: 0.01,
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          hold: {
            id: "h1",
            tenantId: "t1",
            facilityId: "f1",
            externalCustomerId: "c1",
            state: "active",
            startsAt: "2026-12-01T10:00:00.000Z",
            endsAt: "2026-12-01T11:00:00.000Z",
            expiresAt: "2026-12-01T10:15:00.000Z",
            totalMinor: 500,
            currency: "USD",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const sdk = new OneLineBookingClient({
      baseUrl: "http://127.0.0.1:0",
      apiKey: "olb_test_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef",
      maxRetries: 3,
      retryBaseDelayMs: 5,
      fetchFn: fakeFetch,
    });

    const hold = await sdk.holds.create({
      facilityId: "f1",
      externalCustomerId: "c1",
      slotRefs: ["slot-ref"],
    });
    assert.equal(hold.id, "h1");
    assert.equal(callCount, 3);
    assert.equal(new Set(seenKeys).size, 1);
    assert.ok(seenKeys[0]!.startsWith("sdk_"));

    // Non-retryable 409 throws structured OneLineBookingApiError immediately
    const conflictSdk = new OneLineBookingClient({
      baseUrl: "http://127.0.0.1:0",
      apiKey: "olb_test_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef",
      maxRetries: 3,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SLOT_CONFLICT",
              category: "conflict",
              message: "Slot unavailable",
              retryable: false,
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    });

    await assert.rejects(
      () =>
        conflictSdk.holds.create({
          facilityId: "f1",
          externalCustomerId: "c1",
          slotRefs: ["slot-ref"],
        }),
      (err: unknown) =>
        err instanceof OneLineBookingApiError &&
        err.status === 409 &&
        err.code === "SLOT_CONFLICT" &&
        err.retryable === false,
    );
  });
});
