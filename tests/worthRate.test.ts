import { test } from "node:test";
import assert from "node:assert/strict";
import { rateBetween, worthRate, type WorthSample } from "../src/engine/worthRate.js";

const H = 3_600_000;
const t0 = Date.parse("2026-10-29T12:00:00Z");
// One sample every 5 minutes, worth rising by 1,000,000 an hour from 10,000,000.
const samples: WorthSample[] = Array.from({ length: 49 }, (_, i) => ({ ts: t0 + i * 5 * 60_000, worth: 10_000_000 + (i * 5 * 1_000_000) / 60 }));
const now = samples[samples.length - 1]!.ts;

test("a steady climb reads as that rate over 1 h and 3 h", () => {
  const r = worthRate(samples, [], now)!;
  assert.equal(r.perHour1h, 1_000_000);
  assert.equal(r.perHour3h, 1_000_000);
  assert.equal(r.worth, 14_000_000);
  assert.equal(r.series.length, 6);
});

test("a hull purchase is added back, and a scrap taken out", () => {
  // 2M spent on a hull inside the last hour (worth dips by 2M with it): the rate stays 1M.
  const dipped = samples.map((s) => (s.ts > now - 30 * 60_000 ? { ...s, worth: s.worth - 2_000_000 } : s));
  assert.equal(worthRate(dipped, [{ ts: now - 30 * 60_000 + 1, amount: 2_000_000 }], now)!.perHour1h, 1_000_000);
  // A 500k scrap lifts worth by 500k with no trading: it must not count.
  const lifted = samples.map((s) => (s.ts > now - 30 * 60_000 ? { ...s, worth: s.worth + 500_000 } : s));
  assert.equal(worthRate(lifted, [{ ts: now - 30 * 60_000 + 1, amount: -500_000 }], now)!.perHour1h, 1_000_000);
});

test("no rate without samples near the start of the window, or when the data is stale", () => {
  assert.equal(rateBetween(samples.slice(-3), [], now, 3), null);
  assert.equal(worthRate(samples, [], now + 2 * H), null);
  assert.equal(worthRate([], [], now), null);
});
