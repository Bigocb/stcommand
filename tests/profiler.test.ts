import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeCpuProfile, summarizeHeapProfile, type CpuProfile, type HeapProfile } from "../src/ops/profiler.js";

const frame = (functionName: string, url = "file:///app/dist/engine/fleet.js", lineNumber = 9) => ({ functionName, url, lineNumber });

describe("summarizeCpuProfile", () => {
  const profile: CpuProfile = {
    startTime: 0, endTime: 1_000_000, // a 1 s window, in microseconds
    nodes: [
      { id: 1, callFrame: frame("(root)", ""), children: [2, 3, 4, 5] },
      { id: 2, callFrame: frame("(idle)", "") },
      { id: 3, callFrame: frame("computeDispatchRoutes") },
      { id: 4, callFrame: frame("parse", "file:///app/node_modules/pg/lib/x.js", 4) },
      { id: 5, callFrame: frame("(garbage collector)", "") },
    ],
    samples: [2, 3, 3, 4, 5, 2],
    timeDeltas: [400_000, 200_000, 100_000, 100_000, 50_000, 150_000],
  };
  it("separates idle and gc from the work, and ranks functions and files by self time", () => {
    const s = summarizeCpuProfile(profile);
    assert.equal(s.windowMs, 1000);
    assert.equal(s.idleMs, 550);
    assert.equal(s.gcMs, 50);
    assert.equal(s.busyShare, 0.45);
    assert.equal(s.top[0]!.fn, "computeDispatchRoutes dist/engine/fleet.js:10");
    assert.equal(s.top[0]!.selfMs, 300);
    assert.deepEqual(s.byFile.map((f) => f.file), ["dist/engine/fleet.js", "node_modules/pg/lib/x.js"]);
  });
});

describe("summarizeHeapProfile", () => {
  const node = (functionName: string, selfSize: number, children: HeapProfile["head"][] = [], url = "file:///app/dist/engine/fleet.js") =>
    ({ callFrame: frame(functionName, url), selfSize, id: Math.floor(Math.random() * 1e9), children });
  it("sums live bytes by allocating function and keeps the calling stack", () => {
    const head = node("(root)", 0, [node("syncShipManifests", 0, [node("map", 3000), node("map", 2000)]), node("record", 500)]);
    const s = summarizeHeapProfile({ head });
    assert.equal(s.totalBytes, 5500);
    assert.equal(s.top[0]!.fn, "map dist/engine/fleet.js:10");
    assert.equal(s.top[0]!.bytes, 5000);
    assert.deepEqual(s.top[0]!.stack, ["syncShipManifests dist/engine/fleet.js:10"]);
    assert.equal(s.byFile[0]!.file, "dist/engine/fleet.js");
  });
});
