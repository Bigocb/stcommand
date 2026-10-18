import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-10-18: TraderOptions.requestApproval existed and floorSaleApproved() used it, but fleet.ts never passed it, so a lot held below its loss
// floor never asked the operator (THEOREM-64, 8u VIRAL_AGENTS, silent for 20 minutes). Every TraderAgent is built from traderOptions().
test("traderOptions() hands every trader the approvals gate for below-floor sales", () => {
  const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");
  const start = src.indexOf("private traderOptions(");
  assert.ok(start > 0, "traderOptions exists");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(body, /requestApproval:\s*\(kind, o\) => this\.approvals\.request\(kind, o\)/);
});
