import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { OPS_TOOLS } from "./catalog.js";

/** Expose every ops tool as `stcommand_ops_<name>` — read-only, same catalog the HTTP door serves. */
export function registerOpsTools(server: McpServer, w: TenantWorker): void {
  for (const t of OPS_TOOLS) {
    server.registerTool(
      `stcommand_ops_${t.name}`,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const out = await t.run({ w, now: Date.now }, z.object(t.input).parse(args));
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], structuredContent: out as Record<string, unknown> };
        } catch (err) {
          return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    );
  }
}
