import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DELIVERY_POLICY, deliveryArrived, deliveryNote, pickDeliveryYard, type DeliveryYard } from "../src/engine/keeperDelivery.js";

const yards: DeliveryYard[] = [
  { systemSymbol: "X1-YF38", waypointSymbol: "X1-YF38-D10E", shipType: "SHIP_PROBE", purchasePrice: 25_223 },
  { systemSymbol: "X1-RY50", waypointSymbol: "X1-RY50-Z12X", shipType: "SHIP_PROBE", purchasePrice: 27_487 },
  { systemSymbol: "X1-BQ86", waypointSymbol: "X1-BQ86-C43", shipType: "SHIP_PROBE", purchasePrice: 34_255 },
  { systemSymbol: "X1-DJ38", waypointSymbol: "X1-DJ38-B14F", shipType: "SHIP_INTERCEPTOR", purchasePrice: 109_624 },
  { systemSymbol: "X1-FAR", waypointSymbol: "X1-FAR-A2", shipType: "SHIP_PROBE", purchasePrice: 20_000 },
];
const hops: Record<string, number> = { "X1-YF38": 2, "X1-RY50": 2, "X1-BQ86": 2, "X1-DJ38": 0, "X1-FAR": 9 };
const ctx = (present: (wp: string) => boolean = () => true) => ({ hulls: ["SHIP_PROBE", "SHIP_SURVEYOR"], hopsFrom: (s: string) => hops[s], shipPresentAt: present });
const on = { ...DEFAULT_DELIVERY_POLICY, maxHops: 3 };

describe("pickDeliveryYard: a much cheaper yard with no ship", () => {
  const present = (wp: string) => wp === "X1-BQ86-C43"; // 34,255 + 12,000 = 46,255; YF38 costs 37,223 in all
  it("off (gapRatio 0) says nothing and the pick is unchanged", () => {
    const p = pickDeliveryYard("X1-DJ38", yards, ctx(present), on)!;
    assert.equal(p.yard, "X1-BQ86-C43");
    assert.equal(p.cheaper, undefined);
  });
  it("names the cheaper yard only when the gap reaches the ratio, and still buys at the yard with a ship", () => {
    assert.equal(pickDeliveryYard("X1-DJ38", yards, ctx(present), { ...on, gapRatio: 1.5 })!.cheaper, undefined, "46k vs 37k is under 1.5x");
    const p = pickDeliveryYard("X1-DJ38", yards, ctx(present), { ...on, gapRatio: 1.2 })!;
    assert.equal(p.yard, "X1-BQ86-C43");
    assert.equal(p.cheaper?.yard, "X1-YF38-D10E");
    assert.match(deliveryNote(p, "X1-DJ38-A1"), /X1-YF38-D10E is much cheaper \(37,223c in all\) but none of our ships is docked there/);
  });
});

describe("pickDeliveryYard", () => {
  it("off (maxHops 0, the default) picks nothing", () => {
    assert.equal(pickDeliveryYard("X1-DJ38", yards, ctx(), DEFAULT_DELIVERY_POLICY), undefined);
  });
  it("takes the cheapest hull-plus-jumps among yards within range, not counting the target's own or far ones", () => {
    const p = pickDeliveryYard("X1-DJ38", yards, ctx(), on)!;
    assert.equal(p.yard, "X1-YF38-D10E");
    assert.equal(p.total, 25_223 + 2 * 6_000);
  });
  it("only counts a yard where one of our ships is docked", () => {
    const p = pickDeliveryYard("X1-DJ38", yards, ctx((wp) => wp === "X1-RY50-Z12X"), on)!;
    assert.equal(p.yard, "X1-RY50-Z12X");
    assert.equal(pickDeliveryYard("X1-DJ38", yards, ctx(() => false), on), undefined);
  });
  it("a yard beyond the hop limit is never picked, and jumps count against a cheaper hull", () => {
    assert.equal(pickDeliveryYard("X1-DJ38", yards, ctx(), { ...on, maxHops: 1 }), undefined);
    // within reach, nine jumps of a 20,000c hull still cost more than two jumps of a 25,223c one
    assert.equal(pickDeliveryYard("X1-DJ38", yards, ctx(), { ...on, maxHops: 9 })!.yard, "X1-YF38-D10E");
  });
  it("a preferred hull beats a cheaper one", () => {
    const withSurveyor = [...yards, { systemSymbol: "X1-BQ86", waypointSymbol: "X1-BQ86-H1", shipType: "SHIP_SURVEYOR", purchasePrice: 5_000 }];
    assert.equal(pickDeliveryYard("X1-DJ38", withSurveyor, ctx(), on)!.hull, "SHIP_PROBE");
  });
  it("writes the card line and recognises arrival", () => {
    const p = pickDeliveryYard("X1-DJ38", yards, ctx(), on)!;
    assert.match(deliveryNote(p, "X1-DJ38-EX8Z"), /2 gate jumps \(about 12,000c\) on top of the 25,223c hull, 37,223c in all, to X1-DJ38-EX8Z/);
    assert.equal(deliveryArrived("X1-DJ38", "X1-DJ38-EX8Z"), true);
    assert.equal(deliveryArrived("X1-VK87", "X1-DJ38-EX8Z"), false);
    assert.equal(deliveryArrived(undefined, "X1-DJ38-EX8Z"), false);
  });
});
