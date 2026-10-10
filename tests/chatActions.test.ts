import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatAgent, PROPOSAL_TTL_MS, type ProposedAction } from "../src/engine/agentChat.js";

/** The co-pilot proposes fleet changes; nothing runs until the captain confirms. */

function agent() {
  return new ChatAgent({ state: {} as never, apiKey: "" });
}

async function propose(a: ChatAgent, args: Record<string, unknown>): Promise<string> {
  const tool = a.getTools().find((t) => t.name === "propose_fleet_action")!;
  return tool.execute(args);
}

function idFrom(reply: string): string {
  const m = /id ([0-9a-f]{6})/.exec(reply);
  assert.ok(m, `no id in: ${reply}`);
  return m[1]!;
}

describe("propose_fleet_action", () => {
  it("is not marked read-only, and queues without executing", async () => {
    const a = agent();
    const tool = a.getTools().find((t) => t.name === "propose_fleet_action")!;
    assert.equal(tool.readOnly, false);
    const reply = await propose(a, { kind: "set_role", shipSymbol: "THEO-B1", role: "trader" });
    assert.match(reply, /Queued: set THEO-B1 to trader/);
    assert.equal(a.pendingProposals().length, 1);
  });

  it("rejects unknown roles and keepers without a market", async () => {
    const a = agent();
    assert.match(await propose(a, { kind: "set_role", shipSymbol: "THEO-1", role: "admiral" }), /Error: role/);
    assert.match(await propose(a, { kind: "set_role", shipSymbol: "THEO-1", role: "keeper" }), /needs keeperMarket/);
    assert.match(await propose(a, { kind: "dispatch", shipSymbol: "THEO-1" }), /Error: kind/);
    assert.match(await propose(a, { kind: "hold", shipSymbol: "THEO 1" }), /shipSymbol looks wrong/);
    assert.equal(a.pendingProposals().length, 0);
  });
});

describe("confirm and cancel", () => {
  it("runs the executor once on confirm, then refuses a second confirm", async () => {
    const a = agent();
    const id = idFrom(await propose(a, { kind: "hold", shipSymbol: "THEO-B1" }));
    const ran: ProposedAction[] = [];
    const exec = async (act: ProposedAction) => { ran.push(act); return "Done."; };
    assert.equal(await a.confirm(id, exec), "Done.");
    assert.equal(await a.confirm(id, exec), `No pending proposal ${id} (it may have expired or already run).`);
    assert.equal(ran.length, 1);
    assert.equal(ran[0]!.kind, "hold");
  });

  it("cancel drops the proposal without running it", async () => {
    const a = agent();
    const id = idFrom(await propose(a, { kind: "release", shipSymbol: "THEO-B1" }));
    assert.equal(a.cancel(id), `Cancelled ${id}.`);
    assert.equal(a.pendingProposals().length, 0);
  });

  it("reports an executor failure without leaving the proposal queued", async () => {
    const a = agent();
    const id = idFrom(await propose(a, { kind: "hold", shipSymbol: "THEO-B1" }));
    const reply = await a.confirm(id, async () => { throw new Error("ship not docked"); });
    assert.equal(reply, "Failed: ship not docked");
    assert.equal(a.pendingProposals().length, 0);
  });
});

describe("expiry", () => {
  it("an old proposal cannot be confirmed", async () => {
    const a = agent();
    const id = idFrom(await propose(a, { kind: "hold", shipSymbol: "THEO-B1" }));
    const later = Date.now() + PROPOSAL_TTL_MS + 1;
    let ran = false;
    const reply = await a.confirm(id, async () => { ran = true; return "Done."; }, later);
    assert.equal(ran, false);
    assert.match(reply, /No pending proposal/);
  });
});
