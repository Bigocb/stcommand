import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectivePrefs, sanitizePrefs, sanitizeSubscription } from "../src/engine/notify/prefs.js";

describe("sanitizePrefs", () => {
  it("keeps only what is valid and clamps numbers", () => {
    assert.deepEqual(sanitizePrefs({ enabled: false, categories: { approvals: false, nope: true, rate: "x" }, maxPerHour: "12", quietHours: { startMin: 1320.4, endMin: 99999, tzOffsetMin: -300 } }),
      { enabled: false, categories: { approvals: false }, maxPerHour: 12, quietHours: { startMin: 1320, endMin: 1439, tzOffsetMin: -300, allowCritical: true } });
    assert.deepEqual(sanitizePrefs({ maxPerHour: 0 }), { maxPerHour: 1 });
    assert.deepEqual(sanitizePrefs(null), {});
    assert.deepEqual(sanitizePrefs({ quietHours: "late" }), {});
    assert.deepEqual(sanitizePrefs({ quietHours: { startMin: 1, endMin: 2, tzOffsetMin: 0, allowCritical: false } }).quietHours?.allowCritical, false);
  });
  it("effectivePrefs lays choices over the defaults", () => {
    assert.deepEqual(effectivePrefs({}), { enabled: true, categories: {}, maxPerHour: 6 });
    assert.equal(effectivePrefs({ maxPerHour: 2 }).maxPerHour, 2);
  });
});

describe("sanitizeSubscription", () => {
  const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
  it("accepts a browser subscription and refuses http, odd keys and nonsense", () => {
    assert.deepEqual(sanitizeSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }), { endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...keys });
    assert.equal(sanitizeSubscription({ endpoint: "http://x.example/a", keys }), undefined);
    assert.equal(sanitizeSubscription({ endpoint: "https://x.example/a", keys: { ...keys, auth: "no good" } }), undefined);
    assert.equal(sanitizeSubscription({ endpoint: "not a url", keys }), undefined);
    assert.equal(sanitizeSubscription(undefined), undefined);
    assert.equal(sanitizeSubscription({ endpoint: "https://x.example/" + "a".repeat(1100), keys }), undefined);
  });
});
