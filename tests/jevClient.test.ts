import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJevJudge, judgeFromEnv, parseJevResponse, JEV_URL } from "../src/engine/jevClient.js";
import { JudgeError, confidenceOf, gate, sanitizeState, withFirst, yes } from "../src/engine/judge.js";

const body = {
  model: "jev-1.13.0",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12 }, confidence: 0.81 },
    frustration: { type: "score", score: 1.05, probabilities: { "0": 0, "1": 0.95, "2": 0.05 }, confidence: 0.92 },
  },
  usage: { input_tokens: 340, output_tokens: 60 },
};
const ok = (b: unknown = body) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const req = { state: { a: 1 }, questions: { is_urgent: { type: "noul" as const, instructions: "urgent?" } } };

describe("parseJevResponse", () => {
  it("reads the documented shape for all three question types", () => {
    const r = parseJevResponse(body);
    assert.equal(r.model, "jev-1.13.0");
    assert.equal(r.inputTokens, 340);
    assert.deepEqual(r.answers.is_urgent, { type: "noul", noul: 0.95 });
    assert.equal(r.answers.department?.type === "choice" && r.answers.department.choice, "billing");
  });

  it("rejects a malformed answer instead of guessing", () => {
    assert.throws(() => parseJevResponse({ answers: { q: { type: "noul", noul: 7 } } }), JudgeError);
    assert.throws(() => parseJevResponse({ answers: { q: { type: "choice", choice: "x" } } }), /answer "q"/);
    assert.throws(() => parseJevResponse({ answers: { q: { type: "mystery" } } }), JudgeError);
    assert.throws(() => parseJevResponse({}), /no answers/);
  });
});

describe("createJevJudge", () => {
  it("posts the state and questions to the official endpoint with a Bearer key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const judge = createJevJudge({ apiKey: "k-test", fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return ok(); }) as unknown as typeof fetch });
    const r = await judge.decide(req);
    assert.equal(seen!.url, JEV_URL);
    assert.equal(JEV_URL, "https://api.typesafe.ai/v1/systemone", "never a look-alike host");
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer k-test");
    assert.deepEqual(JSON.parse(seen!.init.body as string), { state: { a: 1 }, model: "jev-latest", questions: req.questions });
    assert.equal(r.answers.is_urgent?.type, "noul");
  });

  it("retries once on 429 and succeeds", async () => {
    const calls: number[] = [];
    const judge = createJevJudge({ apiKey: "k", sleep: async () => {}, fetch: (async () => { calls.push(1); return calls.length === 1 ? new Response("slow down", { status: 429 }) : ok(); }) as unknown as typeof fetch });
    await judge.decide(req);
    assert.equal(calls.length, 2);
  });

  it("gives up after the retry budget on 529, as retryable", async () => {
    const judge = createJevJudge({ apiKey: "k", retries: 1, sleep: async () => {}, fetch: (async () => new Response("busy", { status: 529 })) as unknown as typeof fetch });
    await assert.rejects(() => judge.decide(req), (e: unknown) => e instanceof JudgeError && e.status === 529 && e.retryable);
  });

  it("a 401 says the key was rejected, without saying what the key was", async () => {
    const judge = createJevJudge({ apiKey: "super-secret-key", fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    await assert.rejects(() => judge.decide(req), (e: unknown) => e instanceof JudgeError && e.status === 401 && !e.message.includes("super-secret-key"));
  });

  it("a network failure is a retryable error that does not echo the state", async () => {
    const judge = createJevJudge({ apiKey: "k", fetch: (async () => { throw new Error("connect ECONNREFUSED with my state"); }) as unknown as typeof fetch });
    await assert.rejects(() => judge.decide({ state: "private", questions: req.questions }), (e: unknown) => e instanceof JudgeError && e.retryable && !e.message.includes("private"));
  });

  it("a response that is not the documented shape is an error", async () => {
    const judge = createJevJudge({ apiKey: "k", fetch: (async () => ok({ answers: { is_urgent: { type: "noul" } } })) as unknown as typeof fetch });
    await assert.rejects(() => judge.decide(req), JudgeError);
  });
});

describe("judgeFromEnv", () => {
  it("is undefined while no key is set, so callers carry on without the model", () => {
    assert.equal(judgeFromEnv({}), undefined);
    assert.equal(judgeFromEnv({ TYPESAFE_API_KEY: "  " }), undefined);
    assert.ok(judgeFromEnv({ TYPESAFE_API_KEY: "k" }));
  });
});

describe("judge helpers", () => {
  it("confidenceOf reads the pick's probability for each type", () => {
    assert.equal(confidenceOf({ type: "noul", noul: 0.9 }), 0.9);
    assert.equal(confidenceOf({ type: "noul", noul: 0.1 }), 0.9, "a confident no is as sure as a confident yes");
    assert.equal(confidenceOf({ type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.62 }), 0.62);
    assert.equal(yes({ type: "noul", noul: 0.4 }), 0.4);
    assert.equal(yes(undefined), 0);
  });

  it("gates on a floor and says why in one line", () => {
    const a = { type: "choice", choice: "x", probabilities: { x: 0.9 }, confidence: 0.9 } as const;
    assert.equal(gate(a, 0.85, "intent").pass, true);
    const low = gate({ ...a, confidence: 0.6 }, 0.85, "intent");
    assert.equal(low.pass, false);
    assert.match(low.reason, /intent: 60% sure, below the 85% floor/);
    assert.equal(gate(undefined, 0.5, "intent").pass, false);
  });

  it("sanitizeState keeps only the allow-listed fields and trims long strings", () => {
    const raw = { symbol: "THEO-1", token: "sctk_secret", note: "x".repeat(500), n: 3, nested: { a: 1 } };
    const out = sanitizeState(raw, ["symbol", "note", "n"]);
    assert.deepEqual(Object.keys(out), ["symbol", "note", "n"]);
    assert.ok(!("token" in out) && !("nested" in out), "anything not named never travels");
    assert.ok((out.note as string).length <= 161);
  });

  it("withFirst moves the safe option to the front and keeps the rest in order", () => {
    assert.deepEqual(Object.keys(withFirst({ a: 1, b: 2, other: 3, c: 4 }, "other")), ["other", "a", "b", "c"]);
    assert.deepEqual(Object.keys(withFirst({ a: 1 }, "missing")), ["a"]);
  });
});
