import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { catchBackoffMs } from "../src/engine/agentStep.js";

/**
 * catchBackoffMs(): every `nextTask()`-family catch (trader/agent/scout/
 * siphoner) used a flat 10s backoff regardless of what failed. Confirmed
 * live: a fleet that had genuinely run out of money retried the exact
 * same unaffordable purchase every ~10s, across eight ships at once, for
 * 45+ minutes straight with zero chance of ever succeeding — nothing
 * about retrying sooner can fix "the account has no money." This is a
 * pure function, so no DB fixture needed (unlike agentStep.test.ts's
 * agent-level tests, which do).
 */
describe("catchBackoffMs", () => {
  it("backs off 10 minutes on SpaceTraders' insufficient-credits wording", () => {
    const err = new Error("Failed to purchase cargo. Agent does not have sufficient credits to purchase 5 unit(s) of FUEL.");
    assert.equal(catchBackoffMs(err), 10 * 60_000);
  });

  it("matches regardless of what was being bought (fuel, cargo, ship, module all reword around the same phrase)", () => {
    const wordings = [
      "Agent does not have sufficient credits to purchase 15 unit(s) of JEWELRY",
      "Failed to purchase ship. Agent does not have sufficient credits.",
      "does NOT have Sufficient Credits for this transaction", // case-insensitive
    ];
    for (const msg of wordings) {
      assert.equal(catchBackoffMs(new Error(msg)), 10 * 60_000, msg);
    }
  });

  it("falls back to the caller's default backoff for any other error", () => {
    assert.equal(catchBackoffMs(new Error("Ship is in transit")), 10_000);
    assert.equal(catchBackoffMs(new Error("Ship is in transit"), 30_000), 30_000);
    assert.equal(catchBackoffMs("a raw string, not an Error"), 10_000);
  });
});
