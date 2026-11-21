import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAgent } from "../src/engine/agentRank.js";

const dir = [
  { symbol: "ALPHA", credits: 500 },
  { symbol: "BRAVO", credits: 300 },
  { symbol: "THEO", credits: 100 },
  { symbol: "DELTA", credits: 50 },
];

test("ranks by the directory's credits when there is no live wallet", () => {
  const r = rankAgent(dir, "THEO")!;
  assert.equal(r.rank, 3);
  assert.equal(r.of, 4);
  assert.deepEqual(r.nextUp, { symbol: "BRAVO", credits: 300, gap: 200 });
  assert.deepEqual(r.leader, { symbol: "ALPHA", credits: 500 });
});

test("the live wallet replaces our directory figure", () => {
  const r = rankAgent(dir, "theo", 400)!;
  assert.equal(r.rank, 2);
  assert.equal(r.credits, 400);
  assert.equal(r.nextUp?.symbol, "ALPHA");
});

test("leading: no next-up, we are the leader", () => {
  const r = rankAgent(dir, "THEO", 900)!;
  assert.equal(r.rank, 1);
  assert.equal(r.nextUp, undefined);
  assert.equal(r.leader.symbol, "THEO");
});

test("ties share a rank", () => {
  assert.equal(rankAgent(dir, "THEO", 300)!.rank, 2);
});

test("not in the directory: ranked from the live wallet, counted once", () => {
  const r = rankAgent(dir.filter((a) => a.symbol !== "THEO"), "THEO", 200)!;
  assert.equal(r.rank, 3);
  assert.equal(r.of, 4);
});

test("unknown without a listing or a wallet", () => {
  assert.equal(rankAgent([], "THEO"), undefined);
});
