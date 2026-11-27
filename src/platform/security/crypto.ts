import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { BookingError } from "../../domain/errors.js";

const SECRET_PREFIX = "enc.v1.";

/**
 * Derives a 32-byte AES-256-GCM encryption key from OLB_WEBHOOK_MASTER_KEY / OLB_MASTER_KEY.
 * Throws in production (NODE_ENV=production) if no master key env var is explicitly provisioned.
 */
export function resolveMasterEncryptionKey(explicitKeyHexOrPassphrase?: string): Buffer {
  const configured =
    explicitKeyHexOrPassphrase ??
    process.env.OLB_WEBHOOK_MASTER_KEY ??
    process.env.OLB_MASTER_KEY;

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new BookingError(
        "INVALID_CONFIGURATION",
        "OLB_WEBHOOK_MASTER_KEY is required in production to encrypt webhook secrets",
      );
    }
    // Deterministic non-production key isolated strictly to local dev/test runs
    return createHash("sha256")
      .update("onelinebooking-local-dev-webhook-encryption-key-v1", "utf8")
      .digest();
  }

  if (/^[a-f0-9]{64}$/i.test(configured.trim())) {
    return Buffer.from(configured.trim(), "hex");
  }
  return createHash("sha256").update(configured, "utf8").digest();
}

export function encryptSecret(plaintext: string, masterKey?: Buffer): string {
  const key = masterKey ?? resolveMasterEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString("hex")}.${tag.toString("hex")}.${ciphertext.toString("hex")}`;
}

export function decryptSecret(encoded: string, masterKey?: Buffer): string {
  if (!encoded.startsWith(SECRET_PREFIX)) {
    throw new BookingError("INTERNAL_ERROR", "Unsupported encrypted secret format");
  }
  const rest = encoded.slice(SECRET_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 3) {
    throw new BookingError("INTERNAL_ERROR", "Malformed encrypted secret payload");
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const key = masterKey ?? resolveMasterEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex!, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex!, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherHex!, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
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

