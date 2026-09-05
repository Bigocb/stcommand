import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IntentBoard, sameGoal, DEFAULT_POLICY } from "../src/engine/intent.js";

/**
 * Step 4 of docs/control-plane-data-plane.md: exactly one owner per ship.
 *
 * The failure this replaces is not hypothetical. The repair diverter claimed a
 * ship while its tour agent went on flying it, so the ship was released and
 * re-diverted every few seconds all day, wearing down further each cycle.
 * Claim-and-release did not prevent that, because nothing arbitrated between
 * two claimants — they took turns.
 */

describe("IntentBoard: one intent per ship", () => {
  it("resolves competing proposals to the highest priority", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "prices are stale", source: "explore" });
    board.propose({ ship: "S1", priority: 1, goal: { kind: "repair", yard: "X1-A-YARD" }, reason: "condition 0.12", source: "repair" });
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "IRON route open", source: "trade" });

    const changes = board.commit();
    assert.equal(changes.length, 1, "one ship, one change");
    assert.deepEqual(board.current("S1")!.goal, { kind: "repair", yard: "X1-A-YARD" });
    assert.equal(board.current("S1")!.reason, "condition 0.12", "the reason travels with the winner");
  });

  it("breaks a priority tie on proposal order, so controller order is deliberate", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "keep", waypoint: "X1-A-M1" }, reason: "first", source: "keeper" });
    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "second", source: "explore" });
    board.commit();
    assert.equal(board.current("S1")!.goal.kind, "keep");
  });

  it("clears proposals after committing, so last pass's opinions do not linger", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "r", source: "trade" });
    board.commit();
    assert.equal(board.pending().length, 0);
    assert.deepEqual(board.commit(), [], "a pass with no proposals changes nothing");
    assert.equal(board.current("S1")!.goal.kind, "trade", "and leaves the standing intent in place");
  });
});

describe("IntentBoard: versioning tracks the work, not the wording", () => {
  it("bumps the version when the goal really changes", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "a", source: "trade" });
    board.commit();
    const v1 = board.current("S1")!.version;

    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "b", source: "explore" });
    board.commit();
    assert.equal(board.current("S1")!.version, v1 + 1);
  });

  it("does not bump when only the reason changed", () => {
    // Anything comparing desired against executing reads the version. A
    // re-worded reason is not new work and must not look like a reassignment.
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-B" }, reason: "nothing charted", source: "explore" });
    board.commit();
    const v1 = board.current("S1")!.version;

    board.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-B" }, reason: "still nothing charted", source: "explore" });
    const changes = board.commit();
    assert.equal(changes.length, 1, "the reason did change, so it is a change");
    assert.equal(board.current("S1")!.version, v1, "but the work did not, so the version holds");
  });

  it("treats a different target of the same kind as different work", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-B" }, reason: "r", source: "e" });
    board.commit();
    const v1 = board.current("S1")!.version;
    board.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-C" }, reason: "r", source: "e" });
    board.commit();
    assert.equal(board.current("S1")!.version, v1 + 1);
  });
});

describe("IntentBoard: hysteresis", () => {
  it("lets a busy earning ship finish rather than churning it onto new work", () => {
    // Switching a trader mid-trip strands whatever it bought for the old
    // route. This is the same reason the dispatcher carries a busy trader's
    // assignment forward instead of reallocating every cycle.
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "IRON", source: "trade" });
    board.commit();

    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "prices stale", source: "explore" });
    const changes = board.commit({ busy: () => true });

    assert.deepEqual(changes, []);
    assert.equal(board.current("S1")!.goal.kind, "trade", "cargo aboard, so it finishes the trip");
  });

  it("still preempts a busy ship for rescue or repair", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "IRON", source: "trade" });
    board.commit();

    board.propose({ ship: "S1", priority: 1, goal: { kind: "repair", yard: "X1-A-YARD" }, reason: "condition 0.08", source: "repair" });
    board.commit({ busy: () => true });

    assert.equal(board.current("S1")!.goal.kind, "repair", "a worn-out hull outranks a full hold");
  });

  it("does not protect a non-earning goal from being replaced", () => {
    // A tour or a hold has nothing to strand, so there is nothing to protect.
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "r", source: "e" });
    board.commit();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "keep", waypoint: "X1-A-M1" }, reason: "cover", source: "keeper" });
    board.commit({ busy: () => true });
    assert.equal(board.current("S1")!.goal.kind, "keep");
  });

  it("an idle ship is reassigned freely", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "IRON", source: "trade" });
    board.commit();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "stale", source: "explore" });
    board.commit({ busy: () => false });
    assert.equal(board.current("S1")!.goal.kind, "tour");
  });
});

describe("IntentBoard: policy and lifecycle", () => {
  it("defaults the safety policy, and lets a controller tighten one field", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 3, goal: { kind: "tour" }, reason: "r", source: "e", policy: { fuelReserve: 40 } });
    board.commit();
    const p = board.current("S1")!.policy;
    assert.equal(p.fuelReserve, 40, "the override applies");
    assert.deepEqual(p.flightModes, DEFAULT_POLICY.flightModes, "and the rest keeps the default");
    assert.ok(!p.flightModes.includes("DRIFT"), "DRIFT stays opt-in");
  });

  it("forgets a scrapped ship entirely", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "r", source: "t" });
    board.commit();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "mine" }, reason: "r", source: "t" });
    board.forget("S1");
    assert.equal(board.current("S1"), undefined);
    assert.deepEqual(board.commit(), [], "and its pending proposals go with it");
  });

  it("reports the previous intent alongside the new one, so a change can be logged", () => {
    const board = new IntentBoard();
    board.propose({ ship: "S1", priority: 2, goal: { kind: "trade" }, reason: "IRON", source: "trade" });
    board.commit();
    board.propose({ ship: "S1", priority: 0, goal: { kind: "tender", to: "S2" }, reason: "S2 stranded", source: "rescue" });
    const [change] = board.commit();
    assert.equal(change!.from!.goal.kind, "trade");
    assert.equal(change!.to.goal.kind, "tender");
  });
});

describe("sameGoal", () => {
  it("compares the target, not just the kind", () => {
    assert.ok(sameGoal({ kind: "keep", waypoint: "A" }, { kind: "keep", waypoint: "A" }));
    assert.ok(!sameGoal({ kind: "keep", waypoint: "A" }, { kind: "keep", waypoint: "B" }));
    assert.ok(!sameGoal({ kind: "tour" }, { kind: "trade" }));
    assert.ok(sameGoal({ kind: "trade" }, { kind: "trade" }));
  });
});
