import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeCapped, RECOMPUTE_LOG_MAX_ITEMS } from "../src/engine/dispatcher.js";
import { workerHeapMb } from "../src/engine/dispatchWorkerHost.js";

describe("the dispatch recompute line is capped", () => {
  it("lists everything when the list is short", () => {
    assert.equal(summarizeCapped(["a=1", "b=2"], 20), "a=1, b=2");
  });
  it("says none for an empty list", () => {
    assert.equal(summarizeCapped([], 20), "(none)");
  });
  it("lists the first entries and counts the rest", () => {
    const items = Array.from({ length: 1000 }, (_, i) => `G${i}=${i}`);
    const out = summarizeCapped(items, RECOMPUTE_LOG_MAX_ITEMS);
    assert.ok(out.endsWith(`(+${1000 - RECOMPUTE_LOG_MAX_ITEMS} more)`));
    assert.equal(out.split(", ").length, RECOMPUTE_LOG_MAX_ITEMS + 1);
    assert.ok(out.length < 400, `line part is ${out.length} chars`);
  });
});

describe("the dispatch worker's heap limit", () => {
  it("uses an explicit option first", () => { assert.equal(workerHeapMb(2048, "5000"), 2048); });
  it("falls back to DISPATCH_WORKER_HEAP_MB", () => { assert.equal(workerHeapMb(undefined, "5000"), 5000); });
  it("defaults to 3072 MB", () => {
    assert.equal(workerHeapMb(undefined, undefined), 3072);
    assert.equal(workerHeapMb(undefined, "junk"), 3072);
    assert.equal(workerHeapMb(-1, "0"), 3072);
  });
});
