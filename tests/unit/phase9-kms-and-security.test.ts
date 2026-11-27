import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AwsKmsEnvelopeProvider,
  decryptWithKmsEnvelope,
  encryptWithKmsEnvelope,
} from "../../src/index.js";

describe("Phase 9B Unit Suite: AWS KMS Envelope SigV4 & SDK Publication Artifacts", () => {
  it("executes AWS SigV4 signed GenerateDataKey & Decrypt protocol against local KMS HTTP endpoint", async () => {
    const masterMockKey = randomBytes(32);
    const seenTargets: string[] = [];
    const seenAuthHeaders: string[] = [];

    const mockKmsServer = createServer(async (req, res) => {
      const target = String(req.headers["x-amz-target"] ?? "");
      const auth = String(req.headers["authorization"] ?? "");
      seenTargets.push(target);
      seenAuthHeaders.push(auth);

      assert.ok(auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIATEST/"), "Missing AWS SigV4 header");
      assert.ok(auth.includes("/ap-south-1/kms/aws4_request"), "Missing KMS credential scope");
      assert.ok(req.headers["x-amz-date"], "Missing x-amz-date header");
      assert.equal(req.headers["x-amz-security-token"], "sts_temp_token_phase10");

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        KeyId?: string;
        CiphertextBlob?: string;
      };

      if (target === "TrentService.GenerateDataKey") {
        const dek = randomBytes(32);
        // Simulate KMS envelope wrapping with XOR against mock CMK + tag check prefix
        const wrapped = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) wrapped[i] = dek[i]! ^ masterMockKey[i]!;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-amz-json-1.1");
        res.end(
          JSON.stringify({
            KeyId: body.KeyId,
            Plaintext: dek.toString("base64"),
            CiphertextBlob: wrapped.toString("base64"),
          }),
        );
        return;
      }

      if (target === "TrentService.Decrypt") {
        const wrapped = Buffer.from(String(body.CiphertextBlob ?? ""), "base64");
        const dek = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) dek[i] = wrapped[i]! ^ masterMockKey[i]!;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-amz-json-1.1");
        res.end(
          JSON.stringify({
            KeyId: body.KeyId,
            Plaintext: dek.toString("base64"),
          }),
        );
        return;
      }

      res.statusCode = 400;
      res.end(JSON.stringify({ __type: "UnsupportedOperation" }));
    });

    await new Promise<void>((resolveListen) => mockKmsServer.listen(0, "127.0.0.1", resolveListen));
    const port = (mockKmsServer.address() as AddressInfo).port;

    try {
      const kms = new AwsKmsEnvelopeProvider({
        keyId: "arn:aws:kms:ap-south-1:123456789012:key/test-olb-cmk",
        region: "ap-south-1",
        accessKeyId: "AKIATEST",
        secretAccessKey: "test-secret-access-key",
        sessionToken: "sts_temp_token_phase10",
        endpointUrl: `http://127.0.0.1:${port}`,
      });

      const encrypted = await encryptWithKmsEnvelope("whsec_live_super_secret_payload", kms);
      assert.ok(encrypted.startsWith("enc.kms.v1."));
      assert.ok(!encrypted.includes("whsec_live_super_secret_payload"));

      const decrypted = await decryptWithKmsEnvelope(encrypted, kms);
      assert.equal(decrypted, "whsec_live_super_secret_payload");
      assert.deepEqual(seenTargets, ["TrentService.GenerateDataKey", "TrentService.Decrypt"]);
      assert.equal(seenAuthHeaders.length, 2);

      // Tampering ciphertext tag fails authenticated AES-GCM check
      const parts = encrypted.split(".");
      parts[4] = `${parts[4]!.slice(0, -2)}ff`;
      await assert.rejects(() => decryptWithKmsEnvelope(parts.join("."), kms));
    } finally {
      await new Promise<void>((resolveClose) => mockKmsServer.close(() => resolveClose()));
    }
  });

  it("verifies @onelinebooking/sdk package.json exports and dual ESM/CJS/DTS build artifacts", () => {
    const sdkRoot = resolve(process.cwd(), "packages/sdk");
    const pkg = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8")) as {
      main: string;
      module: string;
      types: string;
      exports: Record<string, { types: string; import: string; require: string }>;
    };

    assert.equal(pkg.main, "./dist/cjs/index.cjs");
    assert.ok(existsSync(resolve(sdkRoot, pkg.main)));
    assert.ok(existsSync(resolve(sdkRoot, pkg.module)));
    assert.ok(existsSync(resolve(sdkRoot, pkg.types)));

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      assert.ok(existsSync(resolve(sdkRoot, target.types)), `Missing types for ${subpath}`);
      assert.ok(existsSync(resolve(sdkRoot, target.import)), `Missing ESM for ${subpath}`);
      assert.ok(existsSync(resolve(sdkRoot, target.require)), `Missing CJS for ${subpath}`);
    }
  });
});

