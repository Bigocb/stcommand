import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipSnapshotBoard, describeSnapshotSummary } from "../src/engine/shipSnapshots.js";
import { Client } from "../src/core/client.js";

/**
 * Phase 1 of batched ship reads: before any agent trusts a sweep copy instead
 * of reading its ship, measure how often that copy would have been right.
 */

const T0 = 1_000_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const ship = (over: Record<string, unknown> = {}) => ({
  symbol: "S-1",
  nav: { status: "DOCKED", waypointSymbol: "X1-A-1", route: { arrival: iso(T0 - 60_000), destination: { symbol: "X1-A-1" } } },
  fuel: { current: 100 },
  cargo: { units: 10 },
  cooldown: { remainingSeconds: 0, expiration: iso(T0 - 1_000) },
  ...over,
});

function board(start = T0) {
  let now = start;
  const b = new ShipSnapshotBoard(30_000, () => now);
  return { b, at: (ms: number) => { now = ms; } };
}

describe("ShipSnapshotBoard", () => {
  it("counts a read that matches a recent copy", () => {
    const { b, at } = board();
    b.recordSweep([ship()], T0);
    at(T0 + 10_000);
    b.onShipRead("S-1", ship());
    const s = b.takeSummary();
    assert.equal(s.eligible, 1);
    assert.equal(s.matched, 1);
  });

  it("names the field that differs", () => {
    const { b, at } = board();
    b.recordSweep([ship()], T0);
    at(T0 + 10_000);
    b.onShipRead("S-1", ship({ cargo: { units: 25 } }));
    const s = b.takeSummary();
    assert.equal(s.matched, 0);
    assert.equal(s.mismatches.cargoUnits, 1);
    assert.equal(s.mismatches.status, 0);
  });

  it("does not count a read when the ship acted after the copy was taken", () => {
    const { b, at } = board();
    b.recordSweep([ship()], T0);
    at(T0 + 5_000);
    b.onShipAction("S-1");
    at(T0 + 10_000);
    b.onShipRead("S-1", ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-1" } }));
    const s = b.takeSummary();
    assert.equal(s.eligible, 0);
    assert.equal(s.actedSince, 1);
  });

  it("does not count a read when the copy is too old", () => {
    const { b, at } = board();
    b.recordSweep([ship()], T0);
    at(T0 + 31_000);
    b.onShipRead("S-1", ship());
    assert.equal(b.takeSummary().noRecentCopy, 1);
  });

  it("treats a transit whose arrival has passed as arrived, as Phase 2 would", () => {
    const { b, at } = board();
    b.recordSweep([ship({ nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-1", route: { arrival: iso(T0 + 5_000), destination: { symbol: "X1-A-9" } } } })], T0);
    at(T0 + 10_000);
    b.onShipRead("S-1", ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-9" } }));
    assert.equal(b.takeSummary().matched, 1);
  });

  it("treats a cooldown that has run out as clear", () => {
    const { b, at } = board();
    b.recordSweep([ship({ cooldown: { remainingSeconds: 3, expiration: iso(T0 + 3_000) } })], T0);
    at(T0 + 10_000);
    b.onShipRead("S-1", ship());
    assert.equal(b.takeSummary().matched, 1);
  });

  it("summarises and starts over", () => {
    const { b, at } = board();
    b.recordSweep([ship()], T0);
    at(T0 + 1_000);
    b.onShipRead("S-1", ship());
    assert.match(describeSnapshotSummary(b.takeSummary()), /1 matched \(100%\)/);
    assert.equal(b.takeSummary().reads, 0);
  });
});

describe("Client ship observer", () => {
  it("reports single-ship reads and ship actions, and not the paged list", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { symbol: "S-1" } }), { status: 200 })) as typeof fetch;
    const seen: string[] = [];
    try {
      const client = new Client({ token: "t" });
      client.setShipObserver({ onShipRead: (s) => seen.push(`read ${s}`), onShipAction: (s) => seen.push(`act ${s}`) });
      await client.request({ method: "GET", path: "/my/ships/S-1" });
      await client.request({ method: "POST", path: "/my/ships/S-1/dock" });
      await client.request({ method: "GET", path: "/my/ships/S-1/cargo" });
      await client.request({ method: "GET", path: "/my/ships", query: { limit: 20, page: 1 } });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(seen, ["read S-1", "act S-1"]);
  });
});
