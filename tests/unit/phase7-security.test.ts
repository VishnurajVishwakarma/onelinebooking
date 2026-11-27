import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  isRestrictedIpAddress,
  maskWebhookSecret,
  resolveMasterEncryptionKey,
  resolveTraceContext,
  sanitizeTelemetryText,
  sendSsrfProtectedWebhookPost,
  signWebhookPayload,
  validateWebhookUrlAndResolve,
  verifyPassword,
  verifyWebhookSignature,
} from "../../src/index.js";

describe("Phase 7A Unit Security Suite: SSRF, Crypto, Telemetry Scrubbing & SDK Boundary", () => {
  it("blocks private IPv4, CGNAT, cloud metadata, loopback, and IPv4-mapped IPv6 addresses", () => {
    const blockedIps = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.10.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:7f00:1",
      "fe80::1",
      "fd12:3456:789a::1",
    ];
    for (const ip of blockedIps) {
      assert.equal(isRestrictedIpAddress(ip), true, `Expected ${ip} to be restricted`);
    }

    const allowedPublicIps = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:2800:220:1::1"];
    for (const ip of allowedPublicIps) {
      assert.equal(isRestrictedIpAddress(ip), false, `Expected ${ip} to be allowed`);
    }
  });

  it("defeats DNS rebinding / mixed DNS records and non-HTTPS/credential URLs", async () => {
    await assert.rejects(() =>
      validateWebhookUrlAndResolve("http://webhook.example.com/hook"),
    );
    await assert.rejects(() =>
      validateWebhookUrlAndResolve("https://user:pass@webhook.example.com/hook"),
    );
    await assert.rejects(() =>
      validateWebhookUrlAndResolve("https://metadata.google.internal/computeMetadata/v1/"),
    );

    // Mixed public + private DNS records must be rejected atomically
    await assert.rejects(() =>
      validateWebhookUrlAndResolve("https://rebind.example.com/hook", {
        resolveAll: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
    );

    // Pure public DNS record resolves and pins exact address
    const valid = await validateWebhookUrlAndResolve("https://hooks.partner.com/events", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    assert.equal(valid.pinnedAddress, "93.184.216.34");
    assert.equal(valid.pinnedFamily, 4);
  });

  it("blocks HTTP 3xx redirects in webhook delivery transport", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      await assert.rejects(
        () =>
          sendSsrfProtectedWebhookPost({
            url: `http://127.0.0.1:${port}/redir`,
            headers: { "Content-Type": "application/json" },
            body: "{}",
            timeoutMs: 2_000,
            ssrfOptions: { allowLocalHttpForTesting: true },
          }),
        (err: Error) => /redirect/i.test(err.message),
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("encrypts webhook secrets with AES-256-GCM and supports dual-secret rotation verification", () => {
    const masterKey = resolveMasterEncryptionKey("test-master-secret-key-for-unit-suite-123");
    const wrongKey = resolveMasterEncryptionKey("different-master-key-for-negative-test");
    const secret1 = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secret2 = "whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const cipher = encryptSecret(secret1, masterKey);
    assert.equal(cipher.includes(secret1), false);
    assert.equal(decryptSecret(cipher, masterKey), secret1);
    assert.throws(() => decryptSecret(cipher, wrongKey));
    assert.equal(maskWebhookSecret(secret1), "whsec_aaaa...aaaa");

    const payload = JSON.stringify({ id: "evt_rot", type: "booking.confirmed" });
    const sig = signWebhookPayload(secret2, payload, 1_700_000_000, secret1);
    assert.ok(verifyWebhookSignature({ secret: secret1, payloadJson: payload, signatureHeader: sig.headerValue, nowSeconds: 1_700_000_005 }));
    assert.ok(verifyWebhookSignature({ secret: secret2, payloadJson: payload, signatureHeader: sig.headerValue, nowSeconds: 1_700_000_005 }));
  });

  it("hashes console passwords safely with scrypt and scrubs credentials & customer PII from telemetry", () => {
    const hash = hashPassword("CorrectHorseBatteryStaple!");
    assert.equal(verifyPassword("CorrectHorseBatteryStaple!", hash), true);
    assert.equal(verifyPassword("wrong-password-123", hash), false);

    const dirty = JSON.stringify({
      token: "olb_live_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef",
      externalCustomerId: "alice@secret-customer.com",
      email: "bob@private.org",
    });
    const clean = sanitizeTelemetryText(dirty);
    assert.equal(clean.includes("olb_live_"), false);
    assert.equal(clean.includes("alice@secret-customer.com"), false);
    assert.equal(clean.includes("bob@private.org"), false);

    const trace = resolveTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    assert.equal(trace.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.ok(trace.traceparent.startsWith("00-4bf92f3577b34da6a3ce929d0e0e4736-"));
  });

  it("enforces browser vs server boundary in packaged @onelinebooking/sdk", async () => {
    const { OneLineBookingPublicClient } = await import(
      pathToFileURL(resolve(process.cwd(), "packages/sdk/dist/esm/browser.js")).href
    );
    const { OneLineBookingClient, SdkSecurityBoundaryError } = await import(
      pathToFileURL(resolve(process.cwd(), "packages/sdk/dist/esm/server.js")).href
    );

    // Browser client rejects secret keys in headers
    assert.throws(
      () =>
        new OneLineBookingPublicClient({
          proxyBaseUrl: "/api",
          headers: { Authorization: "Bearer olb_live_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef" },
        }),
      (err: unknown) => err instanceof SdkSecurityBoundaryError || (err instanceof Error && err.name === "SdkSecurityBoundaryError"),
    );

    // Simulate browser window global and verify server SDK blocks olb_live_ instantiation
    (globalThis as Record<string, unknown>).window = {};
    try {
      assert.throws(
        () =>
          new OneLineBookingClient({
            baseUrl: "http://127.0.0.1:4100",
            apiKey: "olb_live_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef",
          }),
        (err: Error) => err.name === "SdkSecurityBoundaryError",
      );
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});

