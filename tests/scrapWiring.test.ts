import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Selling a ship flies it to a yard and then scraps it through the `scrapHere` option each agent is built with.
 * Traders, scouts and keepers were built without it, so `scrapHere?.()` did nothing and the ship sat at the yard
 * forever (found 2026-10-09). A missing option fails silently, so check the wiring where the agents are constructed.
 */
const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");
const lines = src.split("\n");

function constructionSites(pattern: RegExp): number[] {
  return lines.flatMap((l, i) => (pattern.test(l) ? [i] : []));
}

describe("every agent kind a ship can be sold from is given a scrap handler", () => {
  const sites = [
    ...constructionSites(/new ShipAgent\(/),
    ...constructionSites(/new SiphonerAgent\(/),
    ...constructionSites(/new ScoutAgent\(/),
    ...constructionSites(/private traderOptions\(/),
  ];

  it("finds the construction sites", () => {
    assert.ok(sites.length >= 12, `expected at least 12 sites, found ${sites.length}`);
  });

  const ordered = [...sites].sort((x, y) => x - y);
  for (const [n, i] of ordered.entries()) {
    it(`fleet.ts line ${i + 1}: ${lines[i]!.trim().slice(0, 50)}`, () => {
      // From the construction to the next one (or 90 lines): the options object lies in between.
      const end = Math.min(ordered[n + 1] ?? lines.length, i + 90);
      assert.match(lines.slice(i, end).join("\n"), /scrapHere:/, "no scrapHere in this agent's options");
    });
  }
});
