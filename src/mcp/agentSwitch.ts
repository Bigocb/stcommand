import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * One MCP key for every agent on the box.
 *
 * An MCP key belongs to one tenant, so reading another agent's fleet or an earlier week's ledger (last week was THEOREM,
 * this week THEO) needed that tenant's own key. On a box with one owner every tenant is the same person, so that second
 * key only got in the way (operator, 2026-10-29: "forget separate tenants, I am the only one on the box").
 *
 * This wraps `server.registerTool` the way server.ts's own instrumentation does: every tool gains an optional `agent`
 * argument. Left out, or naming the key's own agent, the tool runs exactly as before. Naming another agent runs the same
 * tool against that agent's engine. Allowed under the same rule as the week comparison (src/http/compare.ts): when
 * OPERATOR_AGENTS is unset, or the caller is listed in it. `stcommand_list_agents` lists the agents there are.
 */
export interface AgentRef { tenantId: string; agentSymbol: string }

export interface AgentSwitchDeps<W> {
  /** The key's own agent. */
  own: AgentRef;
  /** Whether this caller may reach other agents. */
  allowed: boolean;
  /** Every tenant on the box. */
  directory: () => Promise<AgentRef[]>;
  /** The engine for a tenant; throws when it is not running (a read must not boot a fleet). */
  workerFor: (ref: AgentRef) => Promise<W>;
  /** Registers the full tool set against one engine, as tools.ts's registerTools does. */
  registerAll: (server: McpServer, w: W) => void;
}

type Cb = (...a: unknown[]) => Promise<unknown>;

const errorText = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function enableAgentArg<W>(server: McpServer, deps: AgentSwitchDeps<W>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = server.registerTool.bind(server) as (...a: any[]) => unknown;
  // Another agent's handlers, built once per request (registerAll against a capture that only records callbacks).
  const others = new Map<string, Promise<Map<string, { cb: Cb; hadSchema: boolean }>>>();
  const handlersFor = (ref: AgentRef) => {
    let p = others.get(ref.tenantId);
    if (!p) {
      p = deps.workerFor(ref).then((w) => {
        const map = new Map<string, { cb: Cb; hadSchema: boolean }>();
        const capture = { registerTool: (name: string, config: { inputSchema?: unknown }, cb: Cb) => { map.set(name, { cb, hadSchema: !!config?.inputSchema }); } };
        deps.registerAll(capture as unknown as McpServer, w);
        return map;
      });
      others.set(ref.tenantId, p);
    }
    return p;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny>; description?: string } & Record<string, unknown>, cb: Cb) => {
    const hadSchema = !!config?.inputSchema;
    const agentArg = z.string().optional().describe("Run this against another agent on the box (e.g. THEOREM). Leave out for this key's own agent.");
    const inputSchema = { ...(config?.inputSchema ?? {}), agent: agentArg };
    return original(name, { ...config, inputSchema }, async (args: Record<string, unknown>, extra: unknown) => {
      const { agent, ...rest } = args ?? {};
      const call = (fn: Cb, withSchema: boolean) => (withSchema ? fn(rest, extra) : fn(extra));
      const wanted = typeof agent === "string" ? agent.trim().toUpperCase() : "";
      if (!wanted || wanted === deps.own.agentSymbol.toUpperCase()) return call(cb, hadSchema);
      if (!deps.allowed) return errorText(`another agent's data needs operator access: list ${deps.own.agentSymbol} in OPERATOR_AGENTS, or leave it unset on a one-owner box`);
      const ref = (await deps.directory()).find((t) => t.agentSymbol.toUpperCase() === wanted);
      if (!ref) return errorText(`no agent ${wanted} on this box (stcommand_list_agents lists them)`);
      try {
        const h = (await handlersFor(ref)).get(name);
        if (!h) return errorText(`${name} is not available for ${wanted}`);
        return call(h.cb, h.hadSchema);
      } catch (err) {
        return errorText(`${wanted}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  };

  original(
    "stcommand_list_agents",
    {
      description: "The agents (tenants) on this box. Any other tool takes `agent` to run against one of them instead of this key's own agent (e.g. last week's THEOREM ledger with stcommand_ops_ledger agent=THEOREM resetDate=2026-10-18).",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const list = await deps.directory();
      return { content: [{ type: "text" as const, text: JSON.stringify({ you: deps.own.agentSymbol, otherAgentsAllowed: deps.allowed, agents: list.map((t) => t.agentSymbol) }, null, 2) }] };
    },
  );
}
