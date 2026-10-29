import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enableAgentArg, type AgentRef } from "../src/mcp/agentSwitch.js";

type Cb = (...a: unknown[]) => Promise<unknown>;
interface W { agent: string }

function fakeServer() {
  const tools = new Map<string, { config: { inputSchema?: Record<string, unknown> }; cb: Cb }>();
  return { tools, server: { registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, cb: Cb) => { tools.set(name, { config, cb }); } } as unknown as McpServer };
}

// Two tools like tools.ts's: one with arguments, one without. Each answers with the engine it was registered against.
const registerAll = (server: McpServer, w: W) => {
  server.registerTool("with_args", { inputSchema: { n: z.number() } }, (async (args: { n: number }) => ({ who: w.agent, n: args.n })) as never);
  server.registerTool("no_args", {}, (async (extra: unknown) => ({ who: w.agent, extra })) as never);
};

const dir: AgentRef[] = [{ tenantId: "t1", agentSymbol: "THEO" }, { tenantId: "t2", agentSymbol: "THEOREM" }];

function setup(allowed: boolean) {
  const { server, tools } = fakeServer();
  const booted: string[] = [];
  enableAgentArg<W>(server, {
    own: dir[0]!, allowed, directory: async () => dir,
    workerFor: async (ref) => { booted.push(ref.agentSymbol); return { agent: ref.agentSymbol }; },
    registerAll,
  });
  registerAll(server, { agent: "THEO" });
  return { tools, booted };
}

test("without agent, every tool runs against the key's own agent, as before", async () => {
  const { tools, booted } = setup(true);
  assert.deepEqual(await tools.get("with_args")!.cb({ n: 1 }, "x"), { who: "THEO", n: 1 });
  assert.deepEqual(await tools.get("no_args")!.cb({}, "x"), { who: "THEO", extra: "x" });
  assert.deepEqual(booted, []);
  assert.ok("agent" in (tools.get("no_args")!.config.inputSchema ?? {}));
});

test("agent names another tenant: the same tool runs against that agent's engine", async () => {
  const { tools, booted } = setup(true);
  assert.deepEqual(await tools.get("with_args")!.cb({ n: 2, agent: "theorem" }, "x"), { who: "THEOREM", n: 2 });
  assert.deepEqual(await tools.get("no_args")!.cb({ agent: "THEOREM" }, "y"), { who: "THEOREM", extra: "y" });
  assert.deepEqual(booted, ["THEOREM"]); // one engine lookup per request, however many calls
});

test("refused when the caller is not allowed, and for an unknown agent", async () => {
  const no = setup(false);
  assert.equal(((await no.tools.get("with_args")!.cb({ n: 1, agent: "THEOREM" }, "x")) as { isError?: boolean }).isError, true);
  const yes = setup(true);
  assert.match(JSON.stringify(await yes.tools.get("with_args")!.cb({ n: 1, agent: "NOBODY" }, "x")), /no agent NOBODY/);
});

test("list_agents shows the agents and whether others are reachable", async () => {
  const { tools } = setup(true);
  const out = (await tools.get("stcommand_list_agents")!.cb({}, "x")) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(out.content[0]!.text), { you: "THEO", otherAgentsAllowed: true, agents: ["THEO", "THEOREM"] });
});
