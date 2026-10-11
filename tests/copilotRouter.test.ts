import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_KEEP, INTENTS, buildRouterRequest, decideRoute, routeMessage, selectToolNames, type IntentKey } from "../src/engine/copilotRouter.js";
import { ChatAgent } from "../src/engine/agentChat.js";
import { JudgeError, redactSecrets, type Answer, type Judge, type JudgeResult } from "../src/engine/judge.js";

const on = { enabled: true, floor: 0.85 };
const intent = (choice: string, confidence: number): Answer => ({ type: "choice", choice, probabilities: { [choice]: confidence }, confidence });
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const result = (answers: Record<string, Answer>): JudgeResult => ({ answers, model: "jev-test", inputTokens: 50, outputTokens: 5, latencyMs: 80 });
const judgeOf = (answers: Record<string, Answer>): Judge & { calls: number } => {
  const j = { calls: 0, decide: async () => { j.calls += 1; return result(answers); } };
  return j;
};

// The names of the tools the co-pilot really has, so the table cannot drift from them.
const realTools = new ChatAgent({ state: { get: () => ({}) } as never, apiKey: "test" }).getTools().map((t) => t.name);

describe("the intent table", () => {
  it("names only tools the co-pilot actually has", () => {
    for (const [key, i] of Object.entries(INTENTS)) for (const t of i.tools) assert.ok(realTools.includes(t), `${key} lists "${t}", which the co-pilot does not have`);
    for (const t of ALWAYS_KEEP) assert.ok(realTools.includes(t), `${t} is not a real tool`);
  });

  it("the change tool is never one a narrowing removes", () => {
    const d = decideRoute({ intent: intent("fleet_status", 0.95), wants_change: noul(0) }, on);
    assert.ok(selectToolNames(realTools, d).includes("propose_fleet_action"));
  });
});

describe("buildRouterRequest", () => {
  it("puts 'other' first, since the model leans toward the first option and the unsure answer should be harmless", () => {
    const q = buildRouterRequest("why is THEOREM-1 not moving").questions.intent;
    assert.equal(q?.type, "choice");
    assert.equal(Object.keys((q as { criteria: Record<string, unknown> }).criteria)[0], "other");
  });

  it("redacts a pasted key and trims a long message", () => {
    const state = buildRouterRequest(`my key is sctk_FAKE_KEY_FOR_TESTS_0123456789abcdef ${"x ".repeat(600)}`).state as { captainMessage: string };
    assert.ok(!state.captainMessage.includes("sctk_"));
    assert.ok(state.captainMessage.length <= 600);
    assert.equal(redactSecrets("Bearer abcdefghijklmnop"), "Bearer [redacted]");
  });

  it("sends nothing but the message", () => {
    assert.deepEqual(Object.keys(buildRouterRequest("hi").state as object), ["captainMessage"]);
  });
});

describe("decideRoute", () => {
  it("narrows to the intent's tools when sure", () => {
    const d = decideRoute({ intent: intent("ship_diagnosis", 0.93), wants_change: noul(0.05) }, on);
    assert.equal(d.narrow, true);
    assert.equal(d.intent, "ship_diagnosis");
    const kept = selectToolNames(realTools, d);
    assert.ok(kept.includes("diagnose_ship") && kept.includes("get_ship_log"));
    assert.ok(!kept.includes("get_best_trades"), "market tools are not needed to diagnose a ship");
    assert.match(d.reason, /intent ship_diagnosis: 93% sure, at or above the 85% floor/);
  });

  it("keeps every tool below the floor", () => {
    const d = decideRoute({ intent: intent("ship_diagnosis", 0.7), wants_change: noul(0) }, on);
    assert.equal(d.narrow, false);
    assert.deepEqual(selectToolNames(realTools, d), realTools);
    assert.match(d.reason, /below the 85% floor/);
  });

  it("keeps every tool for 'other', however sure", () => {
    const d = decideRoute({ intent: intent("other", 0.99), wants_change: noul(0) }, on);
    assert.equal(d.narrow, false);
    assert.match(d.reason, /"other"/);
  });

  it("keeps every tool for an intent it does not know", () => {
    assert.equal(decideRoute({ intent: intent("make_coffee", 0.99), wants_change: noul(0) }, on).narrow, false);
  });

  it("a question that may be a request keeps what a request needs", () => {
    const d = decideRoute({ intent: intent("markets_routes", 0.95), wants_change: noul(0.6) }, on);
    const kept = selectToolNames(realTools, d);
    assert.ok(kept.includes("get_best_trades"));
    assert.ok(kept.includes("list_ships"), "the lookups a change needs");
  });

  it("with the clause off every tool is exposed, exactly as before", () => {
    const d = decideRoute({ intent: intent("ship_diagnosis", 0.99), wants_change: noul(0) }, { enabled: false, floor: 0.85 });
    assert.equal(d.narrow, false);
    assert.deepEqual(selectToolNames(realTools, d), realTools);
  });

  it("never removes a tool the table does not know", () => {
    const d = decideRoute({ intent: intent("exploration", 0.95), wants_change: noul(0) }, on);
    assert.ok(selectToolNames([...realTools, "added_later"], d).includes("added_later"));
  });

  it("every intent the model can pick narrows to something non-empty", () => {
    for (const key of Object.keys(INTENTS).filter((k) => k !== "other") as IntentKey[]) {
      const d = decideRoute({ intent: intent(key, 0.95), wants_change: noul(0) }, on);
      assert.ok(selectToolNames(realTools, d).length > 1, key);
    }
  });
});

describe("routeMessage", () => {
  it("does not call the model when the clause is off", async () => {
    const j = judgeOf({ intent: intent("fleet_status", 0.99), wants_change: noul(0) });
    const out = await routeMessage(j, "how are we doing", { enabled: false, floor: 0.85 });
    assert.equal(j.calls, 0);
    assert.equal(out.decision.narrow, false);
  });

  it("carries on without a model", async () => {
    const out = await routeMessage(undefined, "how are we doing", on);
    assert.equal(out.decision.narrow, false);
    assert.match(out.decision.reason, /no decision model configured/);
  });

  it("a failing model means every tool, never an error", async () => {
    const j: Judge = { decide: async () => { throw new JudgeError("decision model returned 529", 529, true); } };
    const out = await routeMessage(j, "why is 1 stuck", on);
    assert.equal(out.decision.narrow, false);
    assert.match(out.decision.reason, /unavailable \(decision model returned 529\)/);
    assert.ok(out.request, "the request is returned so the attempt can still be logged");
  });

  it("returns the request and result for the decision log when it works", async () => {
    const out = await routeMessage(judgeOf({ intent: intent("gate_progress", 0.9), wants_change: noul(0.02) }), "is the gate open", on);
    assert.equal(out.decision.intent, "gate_progress");
    assert.ok(out.request && out.result);
  });
});

// ── The seam: ChatAgent.chat() hands the model the filtered tools ─────────────────────────────────────────────────
import { makeToolFilter } from "../src/engine/copilotRouterLive.js";

function agentWith(toolFilter?: (m: string, names: string[]) => Promise<string[]>) {
  const seen: string[][] = [];
  const llm = { run: async (_m: unknown, tools: { name: string }[]) => { seen.push(tools.map((t) => t.name)); return { reply: "ok", history: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  const agent = new ChatAgent({ state: { get: () => ({ agent: undefined, systems: [], ships: [], totals: { sells: 0, buys: 0 } }) } as never, llm: llm as never, toolFilter });
  return { agent, seen };
}

describe("ChatAgent tool filter seam", () => {
  it("with no filter the model gets every tool (control)", async () => {
    const { agent, seen } = agentWith();
    await agent.chat("hello");
    assert.deepEqual(seen[0], realTools);
  });

  it("hands the model only what the filter returns", async () => {
    const { agent, seen } = agentWith(async () => ["diagnose_ship", "get_ship_log"]);
    await agent.chat("why is 1 stuck");
    assert.deepEqual(seen[0]!.sort(), ["diagnose_ship", "get_ship_log", "propose_fleet_action"].sort());
  });

  it("never lets a filter remove the change tool", async () => {
    const { agent, seen } = agentWith(async () => ["get_fleet_status", "list_ships"]);
    await agent.chat("how are we doing");
    assert.ok(seen[0]!.includes("propose_fleet_action"));
  });

  it("a filter that throws, or returns nothing usable, means every tool", async () => {
    const a = agentWith(async () => { throw new Error("boom"); });
    await a.agent.chat("x");
    assert.deepEqual(a.seen[0], realTools);
    const b = agentWith(async () => []);
    await b.agent.chat("x");
    assert.deepEqual(b.seen[0], realTools);
  });
});

describe("makeToolFilter", () => {
  const doctrine = (enabled: boolean, value = 85) => ({ isEnabledOr: () => enabled, value: () => value });
  const sure = judgeOf({ intent: intent("ship_diagnosis", 0.95), wants_change: noul(0.02) });

  it("does nothing, and does not call the model, while the clause is off", async () => {
    const logs: string[] = [];
    const filter = makeToolFilter({ doctrine: doctrine(false), log: (m) => logs.push(m), judge: () => sure });
    assert.deepEqual(await filter("why is 1 stuck", realTools), realTools);
    assert.equal(sure.calls, 0);
    assert.deepEqual(logs, []);
  });

  it("narrows when on and sure, logs the reason, and records the decision as acted", async () => {
    const logs: string[] = [];
    const rows: { feature: string; acted: boolean; subject: string }[] = [];
    const filter = makeToolFilter({ doctrine: doctrine(true), log: (m) => logs.push(m), record: async (r) => { rows.push(...r); }, judge: () => sure });
    const kept = await filter("why is THEOREM-1 not moving", realTools);
    assert.ok(kept.includes("diagnose_ship") && !kept.includes("get_best_trades"));
    assert.match(logs[0]!, /intent ship_diagnosis: 95% sure.*exposing \d+ of \d+ tools/);
    await new Promise((r) => setImmediate(r));
    assert.equal(rows.length, 2, "one row per question");
    assert.ok(rows.every((r) => r.feature === "router" && r.acted === true));
  });

  it("logs a pasted key redacted, never raw", async () => {
    const rows: { subject: string }[] = [];
    const filter = makeToolFilter({ doctrine: doctrine(true), log: () => {}, record: async (r) => { rows.push(...r); }, judge: () => sure });
    await filter("use sctk_FAKE_KEY_FOR_TESTS_0123456789abcdef to check", realTools);
    await new Promise((r) => setImmediate(r));
    assert.ok(rows.every((r) => !r.subject.includes("sctk_")));
  });

  it("falls back to every tool, quietly, when the model fails", async () => {
    const down: Judge = { decide: async () => { throw new JudgeError("decision model unreachable: TimeoutError", undefined, true); } };
    const filter = makeToolFilter({ doctrine: doctrine(true), log: () => {}, judge: () => down });
    assert.deepEqual(await filter("hi", realTools), realTools);
  });
});
