import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 2026-10-25: opening tasks never ran on the live box. runOpeningTasks() was called only from FleetManager.tick(), a single-pass
 * helper that run() does not call (run() drives tickCore / tickFeeds / tickMaintenance on their own timers), so a task whose
 * trigger was met (cash 184k against a 130k trigger) stayed "queued" forever. Checked at the source, where it can fail silently.
 */
const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");

test("the live maintenance loop runs the opening tasks", () => {
  const body = /private async tickMaintenance\(\)[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(body, "tickMaintenance not found");
  assert.match(body[0], /runOpeningTasks\(\)/, "tickMaintenance must call runOpeningTasks()");
});

test("run() drives tickMaintenance, so the opening tasks are on the live path", () => {
  const run = /async run\(maxTicks: number\)[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(run, "run() not found");
  assert.match(run[0], /tickMaintenance\(\)/);
});

test("tick() does not run them a second time", () => {
  const tick = /async tick\(\): Promise<void> \{[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(tick, "tick() not found");
  assert.doesNotMatch(tick[0], /runOpeningTasks\(\)/);
});
