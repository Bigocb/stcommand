import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyCrawler } from "../src/engine/galaxyCrawler.js";

/**
 * The crawler reads gate construction from the public /construction endpoint and records it in the shared table.
 * Only isComplete from a 200 is recorded; a 429 pauses the pass; a 404 is skipped, not taken for "built".
 */
function setup(fetchImpl: (url: string) => Promise<Response>, known: { gateSymbol: string; isComplete: boolean; checkedAtMs?: number }[] = []) {
  const recorded: [string, boolean][] = [];
  const store = {
    listSystemsForGateCrawl: async () => [
      { systemSymbol: "X1-A", crawledWaypoints: [{ symbol: "X1-A-G", type: "JUMP_GATE" }, { symbol: "X1-A-P", type: "PLANET" }], jumpGates: [] },
      { systemSymbol: "X1-B", crawledWaypoints: [{ symbol: "X1-B-G", type: "JUMP_GATE" }], jumpGates: [] },
      { systemSymbol: "X1-C", crawledWaypoints: [{ symbol: "X1-C-G", type: "JUMP_GATE" }], jumpGates: [] },
    ],
    getAllGalaxyGateConstruction: async () => known,
    recordGalaxyGateConstruction: async (g: string, c: boolean) => { recorded.push([g, c]); },
  };
  const logs: string[] = [];
  const crawler = new GalaxyCrawler(store as never, (m) => logs.push(m));
  return { crawler, recorded, logs, run: (t: { mock: any }) => t.mock.method(globalThis, "fetch", (u: URL) => fetchImpl(String(u))) };
}
const ok = (isComplete: boolean) => new Response(JSON.stringify({ data: { symbol: "x", materials: [], isComplete } }), { status: 200 });

describe("gate construction crawl", () => {
  it("records each gate's isComplete, reading only gates, and finishes the pass", async (t) => {
    const s = setup(async (u) => ok(u.includes("X1-B-G") ? false : true));
    s.run(t);
    assert.equal(await (s.crawler as any).crawlGateConstruction(), true);
    assert.deepEqual(s.recorded.sort(), [["X1-A-G", true], ["X1-B-G", false], ["X1-C-G", true]]);
    assert.equal(await (s.crawler as any).crawlGateConstruction(), false, "nothing left until the hourly rebuild");
  });

  it("skips gates already known built", async (t) => {
    const s = setup(async () => ok(true), [{ gateSymbol: "X1-A-G", isComplete: true }, { gateSymbol: "X1-C-G", isComplete: true }]);
    s.run(t);
    await (s.crawler as any).crawlGateConstruction();
    assert.deepEqual(s.recorded, [["X1-B-G", true]]);
  });

  it("pauses on a 429 without losing the gate, and does not take a 404 for built", async (t) => {
    let calls = 0;
    const s = setup(async (u) => {
      calls++;
      if (u.includes("X1-A-G") && calls === 1) return new Response("{}", { status: 429 });
      if (u.includes("X1-B-G")) return new Response("{}", { status: 404 });
      return ok(true);
    });
    s.run(t);
    await (s.crawler as any).crawlGateConstruction();
    assert.deepEqual(s.recorded, [], "rate limited on the first gate: nothing recorded, pass paused");
    assert.equal(calls, 1);
    assert.equal(await (s.crawler as any).crawlGateConstruction(), false, "still paused");
    (s.crawler as any).constructionBackoffUntil = 0;
    await (s.crawler as any).crawlGateConstruction();
    assert.deepEqual(s.recorded.sort(), [["X1-A-G", true], ["X1-C-G", true]], "A comes back after the pause; B's 404 is skipped, not recorded");
  });

  it("tick() runs it after the other passes and before the connection sweep", async (t) => {
    const s = setup(async () => ok(true));
    s.run(t);
    Object.assign(s.crawler as any, { factionsDone: true, systemsDone: true, agentsCrawlDone: true, lastAgentsCrawlAt: Date.now() });
    await s.crawler.tick();
    assert.equal(s.recorded.length, 3);
  });
});
