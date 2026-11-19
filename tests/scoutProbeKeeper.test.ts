import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { packScoutProbes, pickScoutProbeKeeperMarket, unpackScoutProbes } from "../src/engine/stagedScoutProbe.js";
import { unlockYardsFirst } from "../src/engine/keeperOrder.js";

describe("pickScoutProbeKeeperMarket (pure)", () => {
  const spot = (market: string, o: Partial<{ isYard: boolean; sellsProbes: boolean; covered: boolean; listedRank: number }> = {}) => ({ market, isYard: false, sellsProbes: false, covered: false, ...o });

  it("an uncovered yard that sells probes first, even over a better-listed yard without probes", () => {
    const p = pickScoutProbeKeeperMarket([spot("X1-A-M1", { listedRank: 0 }), spot("X1-A-Y1", { isYard: true, listedRank: 1 }), spot("X1-A-Y2", { isYard: true, sellsProbes: true, listedRank: 5 })]);
    assert.equal(p?.market, "X1-A-Y2");
    assert.match(p!.reason, /sells probes/);
  });

  it("then any uncovered yard, then the best listed market", () => {
    assert.equal(pickScoutProbeKeeperMarket([spot("X1-A-M1", { listedRank: 0 }), spot("X1-A-Y1", { isYard: true })])?.market, "X1-A-Y1");
    assert.equal(pickScoutProbeKeeperMarket([spot("X1-A-Y1", { isYard: true, covered: true }), spot("X1-A-M2", { listedRank: 2 }), spot("X1-A-M1", { listedRank: 1 })])?.market, "X1-A-M1");
  });

  it("nothing uncovered (or only unlisted plain markets) = undefined: the probe stays a tour ship", () => {
    assert.equal(pickScoutProbeKeeperMarket([spot("X1-A-Y1", { isYard: true, covered: true }), spot("X1-A-M9")]), undefined);
  });
});

describe("scoutProbes flag (restart)", () => {
  it("round-trips, so a fresh instance knows which probes are scout probes", () => {
    const m = new Map([["THEO-B4", "X1-ZU90"], ["THEO-BC", "X1-GR45"]]);
    assert.deepEqual([...unpackScoutProbes(packScoutProbes(m))], [...m]);
  });
  it("an unreadable or missing flag holds nothing", () => {
    assert.equal(unpackScoutProbes("{oops").size, 0);
    assert.equal(unpackScoutProbes(undefined).size, 0);
    assert.equal(unpackScoutProbes('{"THEO-1":5}').size, 0);
  });
});

describe("unlockYardsFirst (pure)", () => {
  const yards = new Set(["X1-RZ24-B22Z", "X1-RZ24-F29F", "X1-YH41-C41", "X1-KA17-A2"]);
  const isYard = (m: string) => yards.has(m);
  const queue = ["X1-YH41-D46", "X1-YH41-C41", "X1-AC26-H59", "X1-RZ24-F29F", "X1-RZ24-B22Z", "X1-RZ24-X30A", "X1-KA17-A2"];

  it("one yard per system with no keeper goes to the front, in queue order; everything else keeps its order", () => {
    const out = unlockYardsFirst(queue, isYard, new Set(["X1-YH41", "X1-AC26"]));
    assert.deepEqual(out, ["X1-RZ24-F29F", "X1-KA17-A2", "X1-YH41-D46", "X1-YH41-C41", "X1-AC26-H59", "X1-RZ24-B22Z", "X1-RZ24-X30A"]);
  });

  it("a system with a keeper, or gated (staged), is not moved", () => {
    const out = unlockYardsFirst(queue, isYard, new Set(["X1-YH41", "X1-AC26", "X1-RZ24"]), new Set(["X1-KA17"]));
    assert.deepEqual(out, queue);
  });
});
