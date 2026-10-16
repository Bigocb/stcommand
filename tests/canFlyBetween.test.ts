import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The Routes board listed a cross-system route only when the two systems were one jump apart, while the dispatcher flies
 * multi-hop paths: 2026-10-16 the board showed 7 cross-system routes and none of the listed ones was ever flown, since
 * the ones traders were actually flying were two or three gates away.
 */
function fleet(opts: { crossSystem: boolean; oneJump: string[]; paths: Record<string, string[]> }) {
  const f = new FleetManager({ api: {} as any, log: () => {} }) as any;
  f.galaxy = {
    canJumpInto: (a: string, b: string) => opts.oneJump.includes(`${a}>${b}`),
    jumpPath: (a: string, b: string) => opts.paths[`${a}>${b}`],
  };
  f.doctrine = { isEnabledOr: (key: string, d: boolean) => (key === "autoCrossSystemRoutes" ? opts.crossSystem : d) };
  return f as FleetManager;
}

describe("FleetManager.canFlyBetween", () => {
  it("accepts a single open jump, with or without cross-system routes on", () => {
    for (const crossSystem of [true, false]) {
      assert.equal(fleet({ crossSystem, oneJump: ["A>B"], paths: {} }).canFlyBetween("A", "B"), true);
    }
  });

  it("accepts a multi-hop path of open jumps when cross-system routes are on", () => {
    assert.equal(fleet({ crossSystem: true, oneJump: [], paths: { "A>C": ["A", "B", "C"] } }).canFlyBetween("A", "C"), true);
  });

  it("refuses a multi-hop path when cross-system routes are off, and a pair with no path at all", () => {
    assert.equal(fleet({ crossSystem: false, oneJump: [], paths: { "A>C": ["A", "B", "C"] } }).canFlyBetween("A", "C"), false);
    assert.equal(fleet({ crossSystem: true, oneJump: [], paths: {} }).canFlyBetween("A", "Z"), false);
  });
});
