import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { jobKind, JOB_KINDS } from "../public/shared/domain.js";

describe("jobKind (Fleet table sub-groups for traders)", () => {
  it("sorts every label jobFor() writes into one group", () => {
    const cases: [string, string][] = [
      ["route: SILVER (pinned by you)", "Routes"],
      ["carrying: 12 IRON_ORE", "Routes"],
      ["contract: FABRICS", "Contracts"],
      ["waiting for contract", "Contracts"],
      ["holding contract cargo: FABRICS (for X1-A-K101)", "Contracts"],
      ["feed: IRON → X1-A-F50", "Feeds"],
      ["chain: Gate → X1-A-F50", "Feeds"],
      ["collector: IRON_ORE + COPPER_ORE → X1-A-H57", "Feeds"],
      ["mission: FAB_MATS @ X1-A-I61", "Mission"],
      ["warehouse buy: IRON", "Mission"],
      ["unassigned", "Unassigned"],
      ["—", "Unassigned"],
    ];
    for (const [job, kind] of cases) assert.equal(jobKind(job), kind, job);
    assert.deepEqual(JOB_KINDS, ["Contracts", "Routes", "Feeds", "Mission", "Unassigned"]);
  });
});
