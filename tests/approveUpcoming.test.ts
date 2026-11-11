import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/mcp/tools.js";

/**
 * The MCP path behind the Approvals screen's "Approve — tag as keeper" button: `stcommand_approve_upcoming` appends the
 * market to the keeper priority list through the same FleetManager method the dashboard's POST /api/keeper/markets uses
 * (FleetManager.approveKeeperPriorityMarket — append plus the coverage check), and `stcommand_get_approvals` can show the
 * same `upcoming` rows. No database: the server and worker are fakes.
 */
type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;

function setup(initial: string[] = ["X1-OLD-1"]) {
  const tools = new Map<string, Cb>();
  const server = { registerTool: (name: string, _config: unknown, cb: Cb) => tools.set(name, cb) } as unknown as McpServer;
  const marketList = [...initial];
  const approved: string[] = [];
  const actions: { kind: string; detail: string }[] = [];
  const w = {
    tenantId: "t1",
    fleet: {
      approveKeeperPriorityMarket: async (market: string) => {
        approved.push(market);
        if (!marketList.includes(market)) marketList.push(market);
        return [...marketList];
      },
      keeperCoverList: async () => true,
      priorityUncovered: async () => marketList,
    },
    store: {
      listOpenApprovals: async () => [{ id: "a1", kind: "buyShip", shipSymbol: "SHIP-1" }],
      listDecidedApprovals: async () => [],
      recordOperatorAction: async (_t: string, kind: string, _s: string | undefined, detail: string) => { actions.push({ kind, detail }); },
    },
  };
  registerTools(server, w as never);
  return { tools, marketList, approved, actions };
}

describe("stcommand_approve_upcoming", () => {
  it("approves the market through the keeper list path and records the action", async () => {
    const { tools, marketList, approved, actions } = setup();
    const out = await tools.get("stcommand_approve_upcoming")!({ market: "X1-NEW-1" });

    assert.deepEqual(approved, ["X1-NEW-1"], "one market, through the append-plus-check method");
    assert.deepEqual(marketList, ["X1-OLD-1", "X1-NEW-1"]);
    assert.deepEqual(out.structuredContent, { ok: true, markets: ["X1-OLD-1", "X1-NEW-1"], coverList: true });
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.kind, "mcp_approve_upcoming");
    assert.match(actions[0]!.detail, /X1-NEW-1/);
  });

  it("a market already on the list stays on it (never a toggle-off)", async () => {
    const { tools, marketList, approved } = setup(["X1-OLD-1", "X1-NEW-1"]);
    const out = await tools.get("stcommand_approve_upcoming")!({ market: "X1-NEW-1" });
    assert.deepEqual(approved, ["X1-NEW-1"]);
    assert.deepEqual(marketList, ["X1-OLD-1", "X1-NEW-1"]);
    assert.deepEqual((out.structuredContent as { markets: string[] }).markets, ["X1-OLD-1", "X1-NEW-1"]);
  });
});

describe("stcommand_get_approvals", () => {
  it("answers with the open cards only, as before, unless includeUpcoming is set", async () => {
    const { tools } = setup(["X1-OLD-1"]);
    const plain = await tools.get("stcommand_get_approvals")!({});
    assert.deepEqual(Object.keys(plain.structuredContent!), ["approvals"]);

    const withUpcoming = await tools.get("stcommand_get_approvals")!({ includeUpcoming: true });
    assert.deepEqual(withUpcoming.structuredContent, {
      approvals: [{ id: "a1", kind: "buyShip", shipSymbol: "SHIP-1" }],
      upcoming: ["X1-OLD-1"],
    });
  });
});
