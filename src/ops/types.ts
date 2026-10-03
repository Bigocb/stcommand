import type * as z from "zod";
import type { TenantWorker } from "../engine/tenantRegistry.js";

export interface OpsContext {
  w: TenantWorker;
  now: () => number;
}

/** One read-only investigation tool; defined once, exposed over MCP and HTTP. */
export interface OpsTool {
  /** Short name; the MCP tool is `stcommand_ops_<name>`, the HTTP route `/api/ops/<name>`. */
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run: (ctx: OpsContext, args: any) => Promise<unknown>;
}
