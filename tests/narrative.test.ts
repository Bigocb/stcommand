import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NarrativeWriter, generateLog } from "../src/engine/narrative.js";
import type { ChatLLM } from "../src/core/chatLLM.js";

/**
 * The captain's log's LLM path.
 *
 * Most of this file is about *not* calling the model. The dashboard polls
 * /api/narrative every 30 seconds and a busy fleet writes activity rows far
 * faster than that, so the difference between a naive "regenerate when
 * something changed" and the policy here is roughly 120 calls an hour against
 * six — which is the difference between a background nicety and the most
 * expensive thing the app does.
 */
let calls: number;
let reply: string;
let fail: Error | null;
let clock: number;

const fakeLLM = () =>
  ({
    model: "test-model",
    complete: async () => {
      calls += 1;
      if (fail) throw fail;
      return { reply, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    },
  }) as unknown as ChatLLM;

const writer = (minIntervalMs = 10 * 60_000) =>
  new NarrativeWriter({ llm: fakeLLM(), apiKey: "k", minIntervalMs, now: () => clock });

const event = (ts: string, detail = "sold 40u FOOD") => ({
  timestamp: ts, shipSymbol: "DAGGER-1", kind: "sell", detail, credits: 100,
}) as any;

beforeEach(() => {
  calls = 0;
  reply = "The dark is quiet. Two hulls docked.";
  fail = null;
  clock = 1_700_000_000_000;
});

describe("NarrativeWriter — when an LLM is configured", () => {
  it("uses it, and says so", async () => {
    const w = writer();
    const out = await w.generate([event("t1")], 1000, []);
    assert.equal(out.source, "llm");
    assert.equal(out.log, "The dark is quiet. Two hulls docked.");
    assert.equal(calls, 1);
    assert.equal(w.model, "test-model");
  });

  it("does not call the model again while nothing has happened", async () => {
    const w = writer();
    const a = [event("t1")];
    await w.generate(a, 1000, []);
    clock += 60 * 60_000; // an hour later — the interval is not what holds here
    await w.generate(a, 1000, []);
    assert.equal(calls, 1, "same latest event means there is nothing new to write about");
  });

  it("ignores credits and ship count changing on their own", async () => {
    // The bug this pins: keying the cache on the whole snapshot meant every
    // trade invalidated it, so a busy fleet regenerated on essentially every
    // poll. Credits still appear in the log; they just do not trigger one.
    const w = writer();
    const a = [event("t1")];
    await w.generate(a, 1000, []);
    clock += 60 * 60_000;
    await w.generate(a, 999_999, [{ symbol: "S1" }, { symbol: "S2" }] as any);
    assert.equal(calls, 1);
  });

  it("does not call the model again within the minimum interval, even on new events", async () => {
    const w = writer();
    await w.generate([event("t1")], 1000, []);
    clock += 60_000; // one minute
    const out = await w.generate([event("t2", "bought 6u FUEL")], 1000, []);
    assert.equal(calls, 1);
    assert.equal(out.source, "llm", "the cached log stands rather than reverting to the template");
    assert.equal(out.log, "The dark is quiet. Two hulls docked.");
  });

  it("regenerates once the interval has passed and something has happened", async () => {
    const w = writer();
    await w.generate([event("t1")], 1000, []);
    clock += 11 * 60_000;
    reply = "A gate opened. The books balanced.";
    const out = await w.generate([event("t2", "bought 6u FUEL")], 1000, []);
    assert.equal(calls, 2);
    assert.equal(out.log, "A gate opened. The books balanced.");
  });
});

describe("NarrativeWriter — when the LLM is not usable", () => {
  it("falls back to the template rather than going blank", async () => {
    fail = new Error("401 invalid api key");
    const w = writer();
    const out = await w.generate([event("t1")], 1000, []);
    assert.equal(out.source, "template");
    assert.equal(out.error, "401 invalid api key", "surfaced so the UI can tell them the key is wrong");
    assert.ok(out.log.length > 0);
  });

  it("does not start the cooldown on a failure", async () => {
    // A blip must not buy ten minutes of template text with the model idle.
    fail = new Error("502");
    const w = writer();
    await w.generate([event("t1")], 1000, []);
    const before = calls;
    fail = null;
    clock += 1_000; // a second later, well inside the interval
    const out = await w.generate([event("t1")], 1000, []);
    assert.equal(calls, before + 1, "should retry immediately rather than sit out the interval");
    assert.equal(out.source, "llm");
  });

  it("treats an empty completion as a failure", async () => {
    reply = "   ";
    const out = await writer().generate([event("t1")], 1000, []);
    assert.equal(out.source, "template");
  });

  it("uses the template when no key is configured at all", async () => {
    const w = new NarrativeWriter({ apiKey: undefined, envFallback: false });
    assert.equal(w.enabled, false);
    const out = await w.generate([event("t1")], 1000, []);
    assert.equal(out.source, "template");
    assert.equal(calls, 0);
  });
});

describe("NarrativeWriter — whose key it spends", () => {
  it("does not fall back to the process-wide key for a tenant who set none", () => {
    // A tenant who has not configured a model has not agreed to spend
    // anyone's budget, and billing the operator for every tenant's log is
    // the kind of default that is only discovered on an invoice.
    const prev = process.env.ST_LLM_API_KEY;
    process.env.ST_LLM_API_KEY = "operator-key";
    try {
      assert.equal(new NarrativeWriter({ envFallback: false }).enabled, false);
      // Standalone/CLI use is the case that env var exists for, so it still
      // works when nothing says otherwise.
      assert.equal(new NarrativeWriter({}).enabled, true);
    } finally {
      if (prev === undefined) delete process.env.ST_LLM_API_KEY;
      else process.env.ST_LLM_API_KEY = prev;
    }
  });
});

describe("generateLog — the template", () => {
  it("still answers with no activity at all", () => {
    const log = generateLog([], 0, []);
    assert.match(log, /Awaiting the first telemetry burst/);
  });

  it("reports the treasury and the fleet it was given", () => {
    const log = generateLog([event("t1")], 1_327_000, [{ symbol: "S1" }] as any);
    assert.match(log, /1,327,000/);
    assert.match(log, /1 ship/);
  });
});
