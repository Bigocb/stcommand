import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Covers public/shared/api.js — the transport layer all four UI versions
 * share. A bug here reaches every one of them at once, and none of it is
 * reachable from the DOM-diff harness: that renders a logged-out page, so
 * it never exercises a request, an error body, or a 401.
 *
 * The module is browser code (it binds `window.fetch` at import time), so
 * `window` is stubbed before the dynamic import below. Nothing else about
 * it needs a DOM.
 *
 * Both `globalThis.fetch` and `window.fetch` are stubbed together, because
 * in a browser they are the same object — which is exactly why `api()`,
 * which calls the bare global, still passes through the interceptor that
 * `onUnauthorized()` installs on `window.fetch`. Stubbing only one would
 * test a split that does not exist in the environment this code runs in.
 */
function setFetch(fn: (input: any, init?: any) => Promise<Response>) {
  (globalThis as any).window.fetch = fn;
  (globalThis as any).fetch = fn;
}
/**
 * The contract public/shared/api.js promises its four consumers. Written out
 * rather than inferred: `public/` is browser code and deliberately outside
 * the TypeScript project (tsconfig includes only src and tests, allowJs is
 * off), so widening the build to compile it would emit browser modules into
 * dist/ for no benefit. Declaring the shape here keeps the typecheck honest
 * and states the contract in one readable place.
 */
interface SharedApi {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  nativeFetch: typeof fetch;
  onUnauthorized: (handler: (message: string) => void) => void;
}

let api: SharedApi;
let fetchCalls: { url: string }[];
let nextResponse: () => Response;

before(async () => {
  (globalThis as any).window = {};
  setFetch((input: any) => {
    fetchCalls.push({ url: typeof input === "string" ? input : input?.url ?? "" });
    return Promise.resolve(nextResponse());
  });
  // @ts-expect-error — untyped browser ES module; SharedApi above is the contract.
  api = await import("../public/shared/api.js");
});

beforeEach(() => {
  fetchCalls = [];
  nextResponse = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  setFetch((input: any) => {
    fetchCalls.push({ url: typeof input === "string" ? input : input?.url ?? "" });
    return Promise.resolve(nextResponse());
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("shared/api.js — api()", () => {
  it("returns the parsed body on success", async () => {
    nextResponse = () => json({ ok: true, ships: 14 });
    assert.deepEqual(await api.api("GET", "/api/state"), { ok: true, ships: 14 });
  });

  it("sends a JSON content-type and body only when there is one", async () => {
    let seenInit: any;
    setFetch((_i: any, init: any) => { seenInit = init; return Promise.resolve(json({})); });
    await api.api("GET", "/api/state");
    assert.equal(seenInit.headers["Content-Type"], undefined, "a bodyless GET must not claim to send JSON");
    await api.api("POST", "/api/doctrine", { key: "cashFloor", value: 1 });
    assert.equal(seenInit.headers["Content-Type"], "application/json");
    assert.equal(seenInit.body, '{"key":"cashFloor","value":1}');
  });

  it("prefers the server's own error message over the bare status line", async () => {
    // The dashboard routes write these for the operator to read; falling back
    // to "400 Bad Request" would discard the useful half.
    nextResponse = () => json({ error: "value must be a number" }, 400);
    await assert.rejects(() => api.api("POST", "/api/doctrine", {}), /value must be a number/);
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    nextResponse = () => new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" });
    await assert.rejects(() => api.api("GET", "/api/state"), /502 Bad Gateway/);
  });

  it("attaches the raw Response so callers can branch on status", async () => {
    nextResponse = () => json({ error: "nope" }, 503);
    const err = await api.api("GET", "/api/state").then(() => null, (e: any) => e);
    assert.equal(err.response.status, 503);
  });
});

describe("shared/api.js — onUnauthorized()", () => {
  /** Install the interceptor over a fetch we control, and report handler hits. */
  function install() {
    const hits: string[] = [];
    setFetch((input: any) => {
      fetchCalls.push({ url: typeof input === "string" ? input : input?.url ?? "" });
      return Promise.resolve(nextResponse());
    });
    api.onUnauthorized((msg: string) => hits.push(msg));
    return hits;
  }

  it("fires on a 401 from an engine route", async () => {
    const hits = install();
    nextResponse = () => new Response("", { status: 401 });
    await (globalThis as any).window.fetch("/api/state");
    assert.deepEqual(hits, ["Session expired — sign in again."]);
  });

  it("stays silent for a 401 from the gate routes", async () => {
    // A 401 there means "those credentials were wrong", which the login form
    // reports inline — treating it as a dead session would replace a useful
    // message with a redundant one.
    const hits = install();
    nextResponse = () => new Response("", { status: 401 });
    await (globalThis as any).window.fetch("/api/gate/login");
    assert.deepEqual(hits, []);
  });

  it("stays silent for a 401 from outside /api", async () => {
    const hits = install();
    nextResponse = () => new Response("", { status: 401 });
    await (globalThis as any).window.fetch("/shared/fonts.css");
    assert.deepEqual(hits, []);
  });

  it("stays silent on non-401 failures, including 403", async () => {
    const hits = install();
    for (const status of [200, 403, 404, 500]) {
      nextResponse = () => new Response("", { status });
      await (globalThis as any).window.fetch("/api/state");
    }
    assert.deepEqual(hits, []);
  });

  it("passes the response through untouched", async () => {
    const hits = install();
    nextResponse = () => json({ credits: 1327000 });
    const res = await (globalThis as any).window.fetch("/api/state");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { credits: 1327000 });
    assert.deepEqual(hits, []);
  });
});
