import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paceRates } from "../src/ops/pace.js";

describe("pace rates", () => {
  it("reports neither rate when there is no open season week and no reset time is known", async () => {
    const w = { tenantId: "t1", store: { activeSeason: async () => null, seasonWeeks: async () => [] } } as any;
    assert.deepEqual(await paceRates(w, Date.now()), { sinceSeason: null, sinceReset: null });
  });

  it("reports no season rate when the season has no open week", async () => {
    const w = { tenantId: "t1", store: { activeSeason: async () => ({ id: 1 }), seasonWeeks: async () => [{ weekNo: 1, openedAt: new Date().toISOString(), closedAt: new Date().toISOString() }] } } as any;
    assert.equal((await paceRates(w, Date.now())).sinceSeason, null);
  });
});
