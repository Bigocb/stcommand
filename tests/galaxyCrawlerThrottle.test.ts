import { test } from "node:test";
import assert from "node:assert/strict";
import { GalaxyCrawler } from "../src/engine/galaxyCrawler.js";

test("the crawler waits on its throttle before every public request", async () => {
  const events: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { events.push("fetch"); return new Response(JSON.stringify({ data: [] }), { status: 200 }); }) as typeof fetch;
  try {
    const crawler = new GalaxyCrawler({} as never, () => {});
    crawler.setThrottle(async () => { events.push("throttle"); });
    await (crawler as unknown as { fetchPublic(path: string): Promise<unknown> }).fetchPublic("/factions");
    assert.deepEqual(events, ["throttle", "fetch"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the crawler skips its tick while the shared budget is busy", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }); }) as typeof fetch;
  try {
    const crawler = new GalaxyCrawler({} as never, () => {});
    crawler.setBusyCheck(() => true);
    await crawler.tick();
    assert.equal(fetches, 0, "busy: nothing is sent");
  } finally {
    globalThis.fetch = realFetch;
  }
});
