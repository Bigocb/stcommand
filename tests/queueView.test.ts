import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { buildQueueView, tradingRows, ageText } from "../public/shared/queueView.js";

const now = Date.parse("2026-10-29T19:00:00Z");
const queue = {
  mode: "auto",
  queue: [
    { system: "X1-LIVE", state: "live", markets: ["a", "b"], releasedAt: "2026-10-29T16:00:00Z", held: false },
    { system: "X1-STG", state: "staged", markets: ["X1-STG-1", "X1-STG-2"], stagedAt: "2026-10-29T18:00:00Z", held: false },
    { system: "X1-SCT", state: "scouted", markets: ["x"], addedAt: "2026-10-29T18:50:00Z", held: true },
  ],
  lastCheck: { live: [{ system: "X1-LIVE", ratio: 1.8, sells: 12 }], decision: { notes: ["3 live premium system(s) not fading, target 3: no release needed"] } },
};
const keepers = { counts: { covered: 5, enroute: 1, staged: 1, parked: 0, pending: 2 }, duplicates: ["M"], markets: [
  { market: "X1-STG-1", status: "staged" }, { market: "X1-STG-2", status: "pending" }, { market: "X1-LIVE-1", status: "covered" },
] };

test("shapes the queue by state, with ages and the live premium", () => {
  const v = buildQueueView({ queue, keepers, review: { budget: { callsPerMinNow: 44.4, apiBudgetPerMin: 90, keepers: 251, max: 300 } }, pnl: {}, stuck: { counts: {} }, approvals: 0, nowMs: now });
  assert.deepEqual(v.counts, { live: 1, staged: 1, scouted: 1 });
  assert.equal(v.live[0].age, "3h 0m");
  assert.equal(v.live[0].ratio, 1.8);
  assert.deepEqual(v.staged[0], { system: "X1-STG", inPlace: 1, of: 2, held: false, since: "1h 0m" });
  assert.equal(v.scouted[0].held, true);
  assert.equal(v.rule, "3 live premium system(s) not fading, target 3: no release needed");
  assert.equal(v.keepers.polling, 44.4);
});

test("flags a last hour more than 25% under the 3-hour rate", () => {
  const t = tradingRows({ 1: { matchedTradingNet: 1_000_000, matchedSales: 90 }, 2: { matchedTradingNet: 4_000_000, matchedSales: 240 }, 3: { matchedTradingNet: 6_000_000, matchedSales: 330 } });
  assert.equal(t.flag, true);
  assert.equal(t.drop, 50);
  assert.equal(tradingRows({ 1: { matchedTradingNet: 2_000_000 }, 2: {}, 3: { matchedTradingNet: 6_000_000 } }).flag, false);
});

test("lists what needs attention, and is empty when nothing does", () => {
  const base = { queue, keepers, review: {}, pnl: {}, nowMs: now };
  assert.deepEqual(buildQueueView({ ...base, stuck: { counts: {} }, approvals: 0 }).attention, []);
  const a = buildQueueView({ ...base, stuck: { counts: { warn: 2, crit: 1 }, findings: [{ ship: "S1", severity: "crit", kind: "stranded", detail: "x" }] }, approvals: 3 }).attention;
  assert.deepEqual(a.map((x: { item: string }) => x.item), ["Approvals", "Stuck ships", "Warnings", "S1"]);
});

test("ageText", () => {
  assert.equal(ageText(30_000), "just now");
  assert.equal(ageText(45 * 60_000), "45m");
  assert.equal(ageText(NaN), "—");
});
