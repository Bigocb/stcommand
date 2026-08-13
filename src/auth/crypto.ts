import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Everything here derives its key material from one env var, `SESSION_SECRET`
 * (see .env.example) — a 32-byte value, hex-encoded (`openssl rand -hex 32`).
 * It does two unrelated jobs with the same secret, same as the architecture
 * plan's §3/§4 call for: AES-256-GCM at rest for tenant secrets (SpaceTraders
 * tokens, LLM keys, Discord webhooks), and HMAC-SHA256 for signing session
 * cookies. Reusing one secret for both is fine — they're different algorithms
 * over different inputs, not the same key used to both sign and encrypt the
 * same bytes.
 */
function masterKey(): Buffer {
  const hex = process.env.SESSION_SECRET;
  if (!hex) throw new Error("SESSION_SECRET is not set — see .env.example");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`SESSION_SECRET must be 32 bytes hex-encoded (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

/**
 * Encrypt `plaintext` with AES-256-GCM. Returns `enc` (ciphertext with the
 * 16-byte auth tag appended) and `iv` (12 bytes) as the two columns every
 * `*_enc`/`*_iv` pair in the `tenants` table stores.
 */
export function encryptSecret(plaintext: string): { enc: Buffer; iv: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { enc: Buffer.concat([ciphertext, authTag]), iv };
}

/** Inverse of `encryptSecret`. Throws if the auth tag doesn't verify (wrong key or corrupted data). */
export function decryptSecret(enc: Buffer, iv: Buffer): string {
  const authTag = enc.subarray(enc.length - 16);
  const ciphertext = enc.subarray(0, enc.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Sign a session id for use as a cookie value: `<sessionId>.<hmac>`. The
 * session id itself is a random uuid (unguessable on its own), and the HMAC
 * stops a client from presenting an id it never received a valid cookie for
 * — this is what "no JWT library" means in practice, same shape as
 * straders' existing dashboard-token gate's hash-and-compare, just HMAC'd
 * instead of a single shared secret compared directly.
 */
export function signSessionCookie(sessionId: string): string {
  const mac = createHmac("sha256", masterKey()).update(sessionId).digest("hex");
  return `${sessionId}.${mac}`;
}

/** Verify a cookie value produced by `signSessionCookie`; returns the session id, or undefined if invalid. */
export function verifySessionCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const sessionId = value.slice(0, dot);
  const presentedMac = value.slice(dot + 1);
  const expectedMac = createHmac("sha256", masterKey()).update(sessionId).digest("hex");
  const presented = Buffer.from(presentedMac, "hex");
  const expected = Buffer.from(expectedMac, "hex");
  if (presented.length !== expected.length) return undefined;
  if (!timingSafeEqual(presented, expected)) return undefined;
  return sessionId;
}
