import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDLE_POLICY, decideIdleParking, type IdleFacts } from "../src/engine/idleSystems.js";

const H = 3_600_000;
const NOW = 100 * H;
const f = (system: string, ageH: number, sells: number, parked = false): IdleFacts => ({ system, releasedAt: NOW - ageH * H, sells, parked });
const on = { hours: 6 };

describe("idle system parking (pure)", () => {
  it("off (hours 0, the default) parks nothing and unparks what was parked", () => {
    const d = decideIdleParking([f("X1-A", 20, 0), f("X1-B", 20, 0, true)], NOW, DEFAULT_IDLE_POLICY);
    assert.deepEqual(d.park, []);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-B"]);
  });
  it("parks only a system old enough with zero sells in the window", () => {
    const d = decideIdleParking([f("X1-OLD0", 7, 0), f("X1-OLD1", 7, 1), f("X1-NEW0", 3, 0)], NOW, on);
    assert.deepEqual(d.park.map((x) => x.system), ["X1-OLD0"]);
    assert.match(d.park[0]!.reason, /no sells in the last 6 h/);
  });
  it("unparks a parked system as soon as it sells, and leaves a still-idle one parked", () => {
    const d = decideIdleParking([f("X1-A", 9, 2, true), f("X1-B", 9, 0, true)], NOW, on);
    assert.deepEqual(d.unpark.map((x) => x.system), ["X1-A"]);
    assert.deepEqual(d.park, []);
  });
});
