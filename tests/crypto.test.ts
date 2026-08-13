import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, signSessionCookie, verifySessionCookie } from "../src/auth/crypto.js";

before(() => {
  // Tests must not depend on whatever SESSION_SECRET (if any) is in the
  // ambient environment — set a known-good one so this suite is
  // deterministic whether or not .env is configured.
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
});

describe("encryptSecret/decryptSecret", () => {
  it("round-trips a plaintext string", () => {
    const { enc, iv } = encryptSecret("st-token-abc123");
    assert.equal(decryptSecret(enc, iv), "st-token-abc123");
  });

  it("produces a different iv (and ciphertext) each call, even for the same plaintext", () => {
    const a = encryptSecret("same plaintext");
    const b = encryptSecret("same plaintext");
    assert.notDeepEqual(a.iv, b.iv);
    assert.notDeepEqual(a.enc, b.enc);
    assert.equal(decryptSecret(a.enc, a.iv), "same plaintext");
    assert.equal(decryptSecret(b.enc, b.iv), "same plaintext");
  });

  it("throws when the auth tag doesn't verify (tampered ciphertext)", () => {
    const { enc, iv } = encryptSecret("do not tamper with me");
    const tampered = Buffer.from(enc);
    tampered[0] = tampered[0]! ^ 0xff;
    assert.throws(() => decryptSecret(tampered, iv));
  });

  it("throws with the wrong key", () => {
    const { enc, iv } = encryptSecret("secret");
    const savedKey = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = randomBytes(32).toString("hex");
    try {
      assert.throws(() => decryptSecret(enc, iv));
    } finally {
      process.env.SESSION_SECRET = savedKey;
    }
  });
});

describe("signSessionCookie/verifySessionCookie", () => {
  it("round-trips a session id", () => {
    const signed = signSessionCookie("11111111-1111-1111-1111-111111111111");
    assert.equal(verifySessionCookie(signed), "11111111-1111-1111-1111-111111111111");
  });

  it("rejects a tampered session id with a stale signature", () => {
    const signed = signSessionCookie("11111111-1111-1111-1111-111111111111");
    const forged = signed.replace("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    assert.equal(verifySessionCookie(forged), undefined);
  });

  it("rejects a garbage cookie value", () => {
    assert.equal(verifySessionCookie("not-a-real-cookie"), undefined);
    assert.equal(verifySessionCookie(""), undefined);
    assert.equal(verifySessionCookie(undefined), undefined);
  });

  it("rejects a signature produced under a different secret", () => {
    const signed = signSessionCookie("some-session-id");
    const savedKey = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = randomBytes(32).toString("hex");
    try {
      assert.equal(verifySessionCookie(signed), undefined);
    } finally {
      process.env.SESSION_SECRET = savedKey;
    }
  });
});
