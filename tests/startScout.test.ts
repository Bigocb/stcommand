import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreStart, DEFAULT_START_POLICY, type StartFacts, type StartMarket } from "../src/engine/startScore.js";
import { scoutStarts, scoutSymbol, MAX_SCOUT_COUNT, type ScoutPorts } from "../src/engine/startScout.js";

/**
 * 2026-10-26: THEO's home system had one FAB_MATS producer and the gate price went from 1,200 to 13,500 once purchases passed its
 * refill rate; last week's system had a second source. A start is now scored from what is readable right after registering, and
 * several agents can be registered and ranked in one go.
 */
const mk = (symbol: string, o: Partial<StartMarket> = {}): StartMarket => ({ symbol, imports: [], exports: [], exchange: [], ...o });
const chain = (fab: number, circ = 1): StartMarket[] => [
  ...Array.from({ length: fab }, (_, i) => mk(`F${i}`, { exports: ["FAB_MATS"], imports: ["IRON", "QUARTZ_SAND"] })),
  ...Array.from({ length: circ }, (_, i) => mk(`C${i}`, { exports: ["ADVANCED_CIRCUITRY"], imports: ["ELECTRONICS", "MICROPROCESSORS"] })),
  mk("I", { exports: ["IRON", "QUARTZ_SAND", "ELECTRONICS", "MICROPROCESSORS"] }),
];
const facts = (markets: StartMarket[], agentSymbol = "A1"): StartFacts => ({ agentSymbol, headquarters: "X1-AB-A1", system: "X1-AB", markets });

describe("scoreStart", () => {
  it("scores two FAB_MATS sources well above one, and one well above none", () => {
    const two = scoreStart(facts(chain(2)));
    const one = scoreStart(facts(chain(1)));
    const none = scoreStart(facts(chain(0)));
    assert.ok(two.score > one.score + 100);
    assert.ok(one.score > none.score + 150);
    assert.deepEqual(two.fabSources, ["F0", "F1"]);
    assert.match(two.reasons.join(" "), /2 FAB_MATS sources/);
    assert.match(one.reasons.join(" "), /one FAB_MATS source/);
    assert.match(none.reasons.join(" "), /no FAB_MATS source/);
  });
  it("an exchange that sells FAB_MATS counts as a source", () => {
    const s = scoreStart(facts([...chain(1), mk("X", { exchange: ["FAB_MATS"] })]));
    assert.equal(s.fabSources.length, 2);
  });
  it("penalises a system with no circuitry producer and names inputs nobody sells", () => {
    const s = scoreStart(facts([mk("F", { exports: ["FAB_MATS"] })]));
    assert.match(s.reasons.join(" "), /no ADVANCED_CIRCUITRY source/);
    assert.deepEqual(s.missingInputs.sort(), ["ELECTRONICS", "IRON", "MICROPROCESSORS", "QUARTZ_SAND"]);
  });
  it("more markets and goods add a little, capped", () => {
    const base = scoreStart(facts(chain(1)));
    const big = scoreStart(facts([...chain(1), ...Array.from({ length: 60 }, (_, i) => mk(`M${i}`, { exports: [`G${i}`] }))]));
    assert.ok(big.score > base.score);
    assert.ok(big.score - base.score <= DEFAULT_START_POLICY.marketCap + DEFAULT_START_POLICY.goodCap);
  });
});

function ports(opts: { failOn?: string; systems?: Record<string, StartMarket[]> } = {}): ScoutPorts & { registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    sleep: async () => {},
    suffix: (i) => `X${i}`,
    register: async (symbol) => {
      if (symbol === opts.failOn) throw new Error("registration failed (409): symbol taken");
      registered.push(symbol);
      return { token: `tok-${symbol}`, agentSymbol: symbol, headquarters: `X1-${symbol}-A1` };
    },
    read: async (_token, _hq, agentSymbol) => facts(opts.systems?.[agentSymbol] ?? chain(1), agentSymbol),
  };
}

describe("scoutStarts", () => {
  it("registers nothing unless go is set, and says what it would register", async () => {
    const p = ports();
    const out = await scoutStarts({ count: 3, prefix: "SC", ports: p, go: false });
    assert.deepEqual(p.registered, []);
    assert.deepEqual(out.planned, ["SCX0", "SCX1", "SCX2"]);
    assert.deepEqual(out.results, []);
  });
  it("registers each, scores each, and ranks best first", async () => {
    const p = ports({ systems: { SCX0: chain(1), SCX1: chain(2), SCX2: chain(0) } });
    const out = await scoutStarts({ count: 3, prefix: "SC", ports: p, go: true });
    assert.deepEqual(out.results.map((r) => r.agentSymbol), ["SCX1", "SCX0", "SCX2"]);
    assert.equal(out.results[0]!.token, "tok-SCX1");
  });
  it("one failed registration is reported and does not stop the rest", async () => {
    const p = ports({ failOn: "SCX1" });
    const out = await scoutStarts({ count: 3, prefix: "SC", ports: p, go: true });
    assert.equal(out.results.length, 2);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0]!.error, /symbol taken/);
  });
  it("refuses a silly count or prefix", async () => {
    await assert.rejects(() => scoutStarts({ count: MAX_SCOUT_COUNT + 1, prefix: "SC", ports: ports(), go: true }), /count must be/);
    await assert.rejects(() => scoutStarts({ count: 0, prefix: "SC", ports: ports(), go: true }), /count must be/);
    await assert.rejects(() => scoutStarts({ count: 2, prefix: "bad prefix!", ports: ports(), go: true }), /prefix must be/);
  });
  it("symbols stay within 3 to 14 letters and digits", () => {
    assert.equal(scoutSymbol("SCOUT", "ab-c d").length <= 14, true);
    assert.match(scoutSymbol("SCOUT", "9x!z"), /^[A-Za-z0-9]+$/);
  });
});
