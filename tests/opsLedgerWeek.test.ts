import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_TOOLS } from "../src/ops/catalog.js";

const tool = OPS_TOOLS.find((t) => t.name === "ledger")!;
const parse = (a: Record<string, unknown>) => ({ sinceHours: 6, limit: 40, ...a });

function ctxWith(asked: unknown[]) {
  return {
    now: () => Date.parse("2026-10-22T12:00:00Z"),
    w: { tenantId: "t1", agentSymbol: "THEOREM", store: { opsLedger: async (_t: string, f: unknown) => { asked.push(f); return []; } } },
  } as any;
}

describe("ops ledger: reading a past week", () => {
  it("scopes to that week's universe, starts at its first day, and can return the earliest rows first", async () => {
    const asked: any[] = [];
    const r = await tool.run(ctxWith(asked), parse({ type: "JUMP", resetDate: "2026-10-11", oldestFirst: true, limit: 1 }));
    assert.equal(asked[0].universe, "THEOREM@2026-10-11");
    assert.equal(asked[0].sinceIso, "2026-10-11T00:00:00.000Z");
    assert.equal(asked[0].oldestFirst, true);
    assert.equal((r as any).universeKey, "THEOREM@2026-10-11");
  });

  it("without resetDate behaves as before: current week, rolling window, newest first", async () => {
    const asked: any[] = [];
    await tool.run(ctxWith(asked), parse({}));
    assert.equal(asked[0].universe, undefined);
    assert.equal(asked[0].sinceIso, "2026-10-22T06:00:00.000Z");
    assert.ok(!asked[0].oldestFirst);
  });
});
