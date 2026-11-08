import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUEUE_TOUR_POLICY, decideQueueTours, needsTour, type QueueTourPolicy, type TourShip, type TourSignals, type TourTarget } from "../src/engine/queueTours.js";

const on: QueueTourPolicy = { ...DEFAULT_QUEUE_TOUR_POLICY, maxShips: 2 };
const NOW = 10_000_000;

const target = (system: string, over: Partial<TourTarget> = {}): TourTarget => ({ system, state: "staged", held: false, addedAt: 1, markets: 10, readyShare: 1, pricedShare: 0, ...over });
const ship = (symbol: string, system: string, over: Partial<TourShip> = {}): TourShip => ({ symbol, system, fuel: 80, fuelCap: 100, held: false, ...over });
// Distance: |difference of the trailing number|, so A1->A4 is 3 hops.
const hops = (a: string, b: string): number | undefined => (a.startsWith("X") && b.startsWith("X") ? Math.abs(Number(a.slice(1)) - Number(b.slice(1))) : undefined);
const sig = (targets: TourTarget[], ships: TourShip[]): TourSignals => ({ now: NOW, targets, ships, hops });

test("off by default: maxShips 0 sends nothing", () => {
  const d = decideQueueTours(sig([target("X5")], [ship("S1", "X1")]), DEFAULT_QUEUE_TOUR_POLICY);
  assert.deepEqual(d, { send: [], notes: [] });
});

test("sends the nearest free ship, with a reason", () => {
  const d = decideQueueTours(sig([target("X5")], [ship("FAR", "X1"), ship("NEAR", "X4")]), on);
  assert.equal(d.send.length, 1);
  assert.equal(d.send[0]!.ship, "NEAR");
  assert.equal(d.send[0]!.hops, 1);
  assert.match(d.send[0]!.reason, /X5/);
});

test("needsTour: held, unreachable, no markets, scouted (unless included) and well priced systems need none", () => {
  assert.equal(needsTour(target("X5"), on), true);
  assert.equal(needsTour(target("X5", { held: true }), on), false);
  assert.equal(needsTour(target("X5", { reachable: false }), on), false);
  assert.equal(needsTour(target("X5", { markets: 0 }), on), false);
  assert.equal(needsTour(target("X5", { state: "scouted" }), on), false);
  assert.equal(needsTour(target("X5", { state: "scouted" }), { ...on, includeScouted: true }), true);
  assert.equal(needsTour(target("X5", { pricedShare: 0.8 }), on), false);
  assert.equal(needsTour(target("X5", { pricedShare: undefined }), on), true);
});

test("held, low-fuel, just-sent and too-far ships are not sent", () => {
  const t = [target("X5")];
  assert.equal(decideQueueTours(sig(t, [ship("H", "X5", { held: true })]), on).send.length, 0);
  assert.equal(decideQueueTours(sig(t, [ship("L", "X4", { fuel: 10 })]), on).send.length, 0);
  assert.equal(decideQueueTours(sig(t, [ship("J", "X4", { sentAt: NOW - 60_000 })]), on).send.length, 0);
  assert.equal(decideQueueTours(sig(t, [ship("F", "X40")]), on).send.length, 0);
  const none = decideQueueTours(sig(t, [ship("F", "X40")]), on);
  assert.match(none.notes.join(" "), /no free ship within/);
  // After the minimum stay it is free again.
  assert.equal(decideQueueTours(sig(t, [ship("J", "X4", { sentAt: NOW - 21 * 60_000 })]), on).send.length, 1);
});

test("a system with a ship in it or heading to it is covered; the ship keeps a slot", () => {
  const d = decideQueueTours(sig([target("X5"), target("X9", { readyShare: 0.5 })], [ship("IN", "X5"), ship("FREE", "X8")]), on);
  assert.deepEqual(d.send.map((s) => [s.ship, s.system]), [["FREE", "X9"]]);
  const heading = decideQueueTours(sig([target("X5")], [ship("W", "X1", { heading: "X5" }), ship("O", "X4")]), on);
  assert.equal(heading.send.length, 0);
  assert.match(heading.notes.join(" "), /each has a ship/);
});

test("moves on: a system at the priced share needs no ship, so its ship is free for the next", () => {
  const targets = [target("X5", { pricedShare: 0.85 }), target("X9", { pricedShare: 0.1 })];
  const d = decideQueueTours(sig(targets, [ship("DONE", "X5", { sentAt: NOW - 30 * 60_000 })]), on);
  assert.deepEqual(d.send.map((s) => [s.ship, s.system]), [["DONE", "X9"]]);
});

test("maxShips caps the ships working at once", () => {
  const targets = [target("X5"), target("X6"), target("X7")];
  const ships = [ship("A", "X4"), ship("B", "X4"), ship("C", "X4")];
  const d = decideQueueTours(sig(targets, ships), { ...on, maxShips: 2 });
  assert.equal(d.send.length, 2);
  assert.match(d.notes.join(" "), /all 2 ships are working/);
});

test("the most ready system is served first", () => {
  const targets = [target("X5", { readyShare: 0.3 }), target("X6", { readyShare: 1 })];
  const d = decideQueueTours(sig(targets, [ship("ONLY", "X1")]), { ...on, maxShips: 1 });
  assert.equal(d.send[0]!.system, "X6");
});

test("no system needs a tour: a note, no sends", () => {
  const d = decideQueueTours(sig([target("X5", { pricedShare: 1 })], [ship("S", "X1")]), on);
  assert.equal(d.send.length, 0);
  assert.match(d.notes.join(" "), /no staged system needs a tour/);
});
