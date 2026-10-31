import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas } from "../src/engine/galaxy.js";

describe("gate cache heals from a jump that went through", () => {
  it("marks the departure gate complete after a rejection cached it incomplete (J64, 2026-10-31)", () => {
    const atlas = new GalaxyAtlas({} as any);
    const events: string[] = [];
    atlas.onGateEvent = (l) => events.push(l);
    atlas.recordGateNotComplete("X1-HS97-D15C");
    assert.equal(atlas.gateComplete("X1-HS97-D15C"), false);
    atlas.recordJumpCost("X1-HS97-D15C", "X1-J64", 8013);
    assert.equal(atlas.gateComplete("X1-HS97-D15C"), true);
    assert.equal(atlas.provenEdge("X1-HS97", "X1-J64"), true);
    assert.ok(events.some((e) => /marked NOT complete/.test(e)));
    assert.ok(events.some((e) => /went through: marked complete/.test(e)));
  });

  it("a network search reaches the far system over the proven edge", () => {
    const atlas = new GalaxyAtlas({} as any);
    atlas.recordJumpCost("X1-HS97-D15C", "X1-J64", 8013);
    assert.ok(atlas.gateNetwork(["X1-HS97"]).has("X1-J64"));
  });

  it("a jump never downgrades a gate already known complete and stays quiet", () => {
    const atlas = new GalaxyAtlas({} as any);
    const events: string[] = [];
    atlas.onGateEvent = (l) => events.push(l);
    atlas.noteGateComplete("X1-A-G1");
    atlas.recordJumpCost("X1-A-G1", "X1-B", 5000);
    assert.equal(atlas.gateComplete("X1-A-G1"), true);
    assert.deepEqual(events, []);
  });
});
