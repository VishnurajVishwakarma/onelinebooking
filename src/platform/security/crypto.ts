import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { BookingError } from "../../domain/errors.js";

const SECRET_PREFIX_V1 = "enc.v1.";
const SECRET_PREFIX_V2 = "enc.v2.";

export interface KmsKeyring {
  activeVersion: number;
  keys: Record<number, Buffer>;
  providerName?: string | undefined;
}

function normalizeKeyMaterial(raw: string): Buffer {
  if (/^[a-f0-9]{64}$/i.test(raw.trim())) {
    return Buffer.from(raw.trim(), "hex");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Derives a single 32-byte AES-256-GCM key for backward compatibility.
 */
export function resolveMasterEncryptionKey(explicitKeyHexOrPassphrase?: string): Buffer {
  const configured =
    explicitKeyHexOrPassphrase ??
    process.env.OLB_WEBHOOK_KEY_V1 ??
    process.env.OLB_WEBHOOK_MASTER_KEY ??
    process.env.OLB_MASTER_KEY;

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new BookingError(
        "INVALID_CONFIGURATION",
        "OLB_WEBHOOK_MASTER_KEY or OLB_WEBHOOK_KEYRING_JSON is required in production",
      );
    }
    return createHash("sha256")
      .update("onelinebooking-local-dev-webhook-encryption-key-v1", "utf8")
      .digest();
  }
  return normalizeKeyMaterial(configured);
}

/**
 * Resolves a multi-version KMS keyring supporting envelope key rotation (`enc.v2.<version>...`).
 * Accepts `OLB_WEBHOOK_KEYRING_JSON` (`{"activeVersion":2,"keys":{"1":"...","2":"..."}}`)
 * or fallback to single v1 key (`resolveMasterEncryptionKey`).
 */
export function resolveMasterKeyring(overrideKeyring?: KmsKeyring): KmsKeyring {
  if (overrideKeyring) return overrideKeyring;

  const keyringJson = process.env.OLB_WEBHOOK_KEYRING_JSON;
  if (keyringJson) {
    let parsed: { activeVersion: number; keys: Record<string, string>; providerName?: string };
    try {
      parsed = JSON.parse(keyringJson) as {
        activeVersion: number;
        keys: Record<string, string>;
        providerName?: string;
      };
    } catch {
      throw new BookingError("INVALID_CONFIGURATION", "Malformed OLB_WEBHOOK_KEYRING_JSON");
    }
    const keys: Record<number, Buffer> = {};
    for (const [verStr, material] of Object.entries(parsed.keys ?? {})) {
      const ver = Number(verStr);
      if (!Number.isInteger(ver) || ver < 1) {
        throw new BookingError("INVALID_CONFIGURATION", `Invalid key version '${verStr}' in keyring`);
      }
      keys[ver] = normalizeKeyMaterial(material);
    }
    if (!keys[parsed.activeVersion]) {
      throw new BookingError(
        "INVALID_CONFIGURATION",
        `Active key version ${parsed.activeVersion} missing from OLB_WEBHOOK_KEYRING_JSON`,
      );
    }
    return {
      activeVersion: parsed.activeVersion,
      keys,
      providerName: parsed.providerName ?? "env-kms",
    };
  }

  return {
    activeVersion: 1,
    keys: { 1: resolveMasterEncryptionKey() },
    providerName: "single-master-key",
  };
}

/**
 * Encrypts plaintext with AES-256-GCM under the active keyring version (`enc.v2.<ver>.<iv>.<tag>.<cipher>`).
 * Accepts either a raw Buffer (legacy single-key callers) or a multi-version KmsKeyring.
 */
export function encryptSecret(plaintext: string, key?: Buffer): string;
export function encryptSecret(plaintext: string, keyring: KmsKeyring): { ciphertext: string; keyVersion: number };
export function encryptSecret(plaintext: string, keyOrKeyring?: Buffer | KmsKeyring): { ciphertext: string; keyVersion: number } | string {
  if (Buffer.isBuffer(keyOrKeyring)) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyOrKeyring, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SECRET_PREFIX_V1}${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
  }

  if (keyOrKeyring && "activeVersion" in keyOrKeyring) {
    const ver = keyOrKeyring.activeVersion;
    const key = keyOrKeyring.keys[ver];
    if (!key) {
      throw new BookingError("INTERNAL_ERROR", `Missing encryption key version ${ver}`);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyVersion: ver,
      ciphertext: `${SECRET_PREFIX_V2}${ver}.${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`,
    };
  }

  // Backward-compatible default returning string when no keyring object supplied
  const ring = resolveMasterKeyring();
  const ver = ring.activeVersion;
  const key = ring.keys[ver]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX_V2}${ver}.${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
}

export function encryptWithKeyring(plaintext: string, keyring: KmsKeyring): { ciphertext: string; keyVersion: number } {
  const ver = keyring.activeVersion;
  const key = keyring.keys[ver];
  if (!key) {
    throw new BookingError("INVALID_CONFIGURATION", `Missing active KMS key version ${ver}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyVersion: ver,
    ciphertext: `${SECRET_PREFIX_V2}${ver}.${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`,
  };
}

export function decryptSecret(encoded: string, keyOrKeyring?: Buffer | KmsKeyring): string {
  if (encoded.startsWith(SECRET_PREFIX_V2)) {
    const rest = encoded.slice(SECRET_PREFIX_V2.length);
    const parts = rest.split(".");
    if (parts.length !== 4) {
      throw new BookingError("INTERNAL_ERROR", "Malformed enc.v2 secret payload");
    }
    const [verStr, ivHex, tagHex, cipherHex] = parts;
    const version = Number(verStr);
    const key = Buffer.isBuffer(keyOrKeyring)
      ? keyOrKeyring
      : resolveMasterKeyring(keyOrKeyring).keys[version];
    if (!key) {
      throw new BookingError("INVALID_CONFIGURATION", `Cannot decrypt secret: unknown key version ${version}`);
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex!, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex!, "hex")),
      decipher.final(),
    ]).toString("utf8");
  }

  if (!encoded.startsWith(SECRET_PREFIX_V1)) {
    throw new BookingError("INTERNAL_ERROR", "Unsupported encrypted secret format");
  }
  const rest = encoded.slice(SECRET_PREFIX_V1.length);
  const parts = rest.split(".");
  if (parts.length !== 3) {
    throw new BookingError("INTERNAL_ERROR", "Malformed enc.v1 secret payload");
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const key = Buffer.isBuffer(keyOrKeyring)
    ? keyOrKeyring
    : resolveMasterKeyring(keyOrKeyring).keys[1] ?? resolveMasterEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex!, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex!, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskWebhookSecret(secret: string): string {
  if (secret.length <= 12) return "whsec_****";
  return `${secret.slice(0, 10)}...${secret.slice(-4)}`;
}

/**
 * Hashes developer console passwords with per-user 16-byte random salt via scrypt.
 */
export function hashPassword(password: string): string {
  if (password.length < 10) {
    throw new BookingError("INVALID_INPUT", "Password must be at least 10 characters long");
  }
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt.v1.${salt}.${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(".");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") {
    return false;
  }
  const salt = parts[2]!;
  const expectedHex = parts[3]!;
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const actualBuf = scryptSync(password, salt, expectedBuf.length);
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
}

export interface KmsEnvelopeClient {
  generateDataKey(): Promise<{ plaintextKey: Buffer; ciphertextBlobB64: string; keyId: string }>;
  decryptDataKey(ciphertextBlobB64: string): Promise<Buffer>;
}

export interface AwsKmsConfig {
  keyId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  /** Override for AWS VPC KMS endpoint or local KMS integration harness. */
  endpointUrl?: string | undefined;
}

/**
 * Official AWS SDK v3 (`@aws-sdk/client-kms`) KMS envelope client.
 * Uses `KMSClient` (`GenerateDataKeyCommand` / `DecryptCommand`) with AWS SigV4 signing,
 * optional STS temporary sessionToken credentials, and optional custom `endpointUrl`.
 */
export class AwsKmsEnvelopeProvider implements KmsEnvelopeClient {
  private readonly kms: KMSClient;

  constructor(private readonly config: AwsKmsConfig) {
    this.kms = new KMSClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
      ...(config.endpointUrl ? { endpoint: config.endpointUrl } : {}),
    });
  }

  async generateDataKey(): Promise<{ plaintextKey: Buffer; ciphertextBlobB64: string; keyId: string }> {
    try {
      const out = await this.kms.send(
        new GenerateDataKeyCommand({
          KeyId: this.config.keyId,
          KeySpec: "AES_256",
        }),
      );
      if (!out.Plaintext || !out.CiphertextBlob) {
        throw new BookingError("INTERNAL_ERROR", "Malformed GenerateDataKey response from AWS KMS");
      }
      const plaintextKey = Buffer.from(out.Plaintext);
      if (plaintextKey.length !== 32) {
        throw new BookingError("INTERNAL_ERROR", "AWS KMS GenerateDataKey did not return 32-byte AES-256 key");
      }
      return {
        plaintextKey,
        ciphertextBlobB64: Buffer.from(out.CiphertextBlob).toString("base64"),
        keyId: out.KeyId ?? this.config.keyId,
      };
    } catch (err) {
      if (err instanceof BookingError) throw err;
      throw new BookingError(
        "INTERNAL_ERROR",
        `AWS KMS GenerateDataKey failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async decryptDataKey(ciphertextBlobB64: string): Promise<Buffer> {
    try {
      const out = await this.kms.send(
        new DecryptCommand({
          KeyId: this.config.keyId,
          CiphertextBlob: Buffer.from(ciphertextBlobB64, "base64"),
        }),
      );
      if (!out.Plaintext) {
        throw new BookingError("INTERNAL_ERROR", "Malformed Decrypt response from AWS KMS");
      }
      const key = Buffer.from(out.Plaintext);
      if (key.length !== 32) {
        throw new BookingError("INTERNAL_ERROR", "AWS KMS Decrypt returned invalid key length");
      }
      return key;
    } catch (err) {
      if (err instanceof BookingError) throw err;
      throw new BookingError(
        "INTERNAL_ERROR",
        `AWS KMS Decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const SECRET_PREFIX_KMS_V1 = "enc.kms.v1.";

/**
 * Encrypts sensitive payloads using a freshly generated 256-bit DEK from KMS (`GenerateDataKey`),
 * then wipes the plaintext DEK buffer in memory.
 */
export async function encryptWithKmsEnvelope(plaintext: string, kms: KmsEnvelopeClient): Promise<string> {
  const { plaintextKey, ciphertextBlobB64 } = await kms.generateDataKey();
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", plaintextKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SECRET_PREFIX_KMS_V1}${ciphertextBlobB64}.${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
  } finally {
    plaintextKey.fill(0);
  }
}

/**
 * Unwraps envelope-encrypted secrets (`enc.kms.v1.*`) using KMS `Decrypt`.
 */
export async function decryptWithKmsEnvelope(encoded: string, kms: KmsEnvelopeClient): Promise<string> {
  if (!encoded.startsWith(SECRET_PREFIX_KMS_V1)) {
    throw new BookingError("INVALID_INPUT", "Expected enc.kms.v1 envelope secret");
  }
  const parts = encoded.slice(SECRET_PREFIX_KMS_V1.length).split(".");
  if (parts.length !== 4) {
    throw new BookingError("INTERNAL_ERROR", "Malformed enc.kms.v1 secret payload");
  }
  const [ciphertextBlobB64, ivHex, tagHex, cipherHex] = parts;
  const plaintextKey = await kms.decryptDataKey(ciphertextBlobB64!);
  try {
    const decipher = createDecipheriv("aes-256-gcm", plaintextKey, Buffer.from(ivHex!, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex!, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    plaintextKey.fill(0);
  }
}
