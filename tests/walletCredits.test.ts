import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-11-18 04:42 UTC: THEO-38 sold 80 ASSAULT_RIFLES (wallet 103k -> 411k) but FleetManager.walletCredits() still said 84k,
 * the figure from its last 30 s agent read, so the Economy card and get_cargo_value disagreed with the dashboard's tile.
 * Every trade response's balance now reaches the engine through noteCredits().
 */
test("a trade response's balance replaces the cached wallet at once", () => {
  const fleet: any = new FleetManager({ api: {} as any });
  fleet.credits = 84_032;
  fleet.noteCredits(411_572);
  assert.equal(fleet.walletCredits(), 411_572);
});

test("a missing or broken balance leaves the wallet alone", () => {
  const fleet: any = new FleetManager({ api: {} as any });
  fleet.credits = 84_032;
  fleet.noteCredits(Number.NaN);
  fleet.noteCredits(undefined as unknown as number);
  assert.equal(fleet.walletCredits(), 84_032);
});
