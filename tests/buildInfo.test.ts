import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBuildInfo } from "../src/engine/buildInfo.js";

const T0 = Date.parse("2026-11-08T00:00:00Z");
const SHA = "c312bc4e0f1a2b3c4d5e6f708192a3b4c5d6e7f8";

describe("resolveBuildInfo", () => {
  it("reports 'local' with source none when nothing is known", () => {
    const b = resolveBuildInfo({ env: {}, startedAtMs: T0 });
    assert.equal(b.build, "local");
    assert.equal(b.source, "none");
    assert.equal(b.startedAt, "2026-11-08T00:00:00.000Z");
    assert.equal(b.loadedFileMtime, undefined);
  });
  it("takes the commit from the environment first, cut to seven characters", () => {
    const b = resolveBuildInfo({ env: { GIT_COMMIT: SHA }, gitHead: "abcdef1234567", startedAtMs: T0 });
    assert.deepEqual([b.build, b.source], ["c312bc4", "env"]);
  });
  it("prefers RENDER_GIT_COMMIT over the other variables", () => {
    const b = resolveBuildInfo({ env: { BUILD_COMMIT: "1111111", RENDER_GIT_COMMIT: SHA }, startedAtMs: T0 });
    assert.equal(b.build, "c312bc4");
  });
  it("falls back to git HEAD when no variable is set", () => {
    const b = resolveBuildInfo({ env: {}, gitHead: `${SHA}\n`, startedAtMs: T0 });
    assert.deepEqual([b.build, b.source], ["c312bc4", "git"]);
  });
  it("ignores values that are not a commit id", () => {
    const b = resolveBuildInfo({ env: { GIT_COMMIT: "not a sha", RENDER_GIT_COMMIT: "" }, gitHead: "fatal: not a git repository", startedAtMs: T0 });
    assert.deepEqual([b.build, b.source], ["local", "none"]);
  });
  it("reports the loaded file's modification time when it is known", () => {
    const b = resolveBuildInfo({ env: {}, startedAtMs: T0, loadedFileMtimeMs: Date.parse("2026-11-07T20:19:00Z") });
    assert.equal(b.loadedFileMtime, "2026-11-07T20:19:00.000Z");
  });
});
