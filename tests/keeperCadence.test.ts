import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keeperPollDelayMs, cadenceSeeds, marketSignature } from "../src/engine/keeperCadence.js";

const MIN = 60_000;

describe("keeperPollDelayMs", () => {
  it("stays at 5 minutes for a market that moved recently", () => {
    assert.equal(keeperPollDelayMs(0), 5 * MIN);
    assert.equal(keeperPollDelayMs(10 * MIN), 5 * MIN);
    assert.equal(keeperPollDelayMs(15 * MIN), 5 * MIN);
  });
  it("relaxes to a third of the idle time", () => {
    assert.equal(keeperPollDelayMs(30 * MIN), 10 * MIN);
    assert.equal(keeperPollDelayMs(60 * MIN), 20 * MIN);
  });
  it("never waits more than 30 minutes", () => {
    assert.equal(keeperPollDelayMs(90 * MIN), 30 * MIN);
    assert.equal(keeperPollDelayMs(24 * 60 * MIN), 30 * MIN);
  });

  it("takes a different ceiling, and never one below the floor", () => {
    assert.equal(keeperPollDelayMs(24 * 60 * MIN, 60 * MIN), 60 * MIN);
    assert.equal(keeperPollDelayMs(90 * MIN, 60 * MIN), 30 * MIN);
    assert.equal(keeperPollDelayMs(24 * 60 * MIN, 1 * MIN), 5 * MIN);
  });
});

describe("keeper cadence seed from stored snapshots", () => {
  const row = (good: string, ts: number, price: number, supply = "MODERATE") => ({ waypoint: "X1-A-1", good, ts, purchasePrice: price, sellPrice: price - 10, supply });

  it("takes the last time any good's price or supply moved, and the latest signature", () => {
    const seeds = cadenceSeeds([row("IRON", 1_000, 50), row("IRON", 2_000, 55), row("IRON", 3_000, 55), row("COPPER", 1_500, 70), row("COPPER", 2_500, 70, "HIGH")]);
    const s = seeds.get("X1-A-1")!;
    assert.equal(s.changedAt, 2_500);
    assert.equal(s.sig, marketSignature([{ symbol: "IRON", purchasePrice: 55, sellPrice: 45, supply: "MODERATE" }, { symbol: "COPPER", purchasePrice: 70, sellPrice: 60, supply: "HIGH" }]));
  });

  it("counts a market that never moved as still since its earliest row", () => {
    assert.equal(cadenceSeeds([row("IRON", 1_000, 50), row("IRON", 5_000, 50)]).get("X1-A-1")!.changedAt, 1_000);
  });

  it("signs a market the same whatever order its goods come in", () => {
    const a = { symbol: "A", purchasePrice: 1, sellPrice: 1 };
    const b = { symbol: "B", purchasePrice: 2, sellPrice: 2 };
    assert.equal(marketSignature([a, b]), marketSignature([b, a]));
  });
});

describe("FleetManager.keeperPollMs after a restart", () => {
  it("starts a market that has sat still from its stored history, not the 5-minute floor", async () => {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const now = Date.now();
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    (fleet as any).store = {
      marketSnapshotsSince: async () => [
        { waypoint: "X1-A-1", good: "IRON", ts: now - 120 * MIN, purchasePrice: 50, sellPrice: 40, supply: "MODERATE" },
        { waypoint: "X1-A-1", good: "IRON", ts: now - 10 * MIN, purchasePrice: 50, sellPrice: 40, supply: "MODERATE" },
      ],
    };
    assert.equal(fleet.keeperPollMs("X1-A-1"), 5 * MIN, "floor until the seed lands");
    await new Promise((r) => setImmediate(r));
    assert.equal(fleet.keeperPollMs("X1-A-1"), 30 * MIN);
  });
});
