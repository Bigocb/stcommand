import type { RequestHandler } from "express";

/**
 * Who counts as an operator: the agent symbols listed in `OPERATOR_AGENTS`
 * (comma-separated, case-insensitive), e.g. `OPERATOR_AGENTS=THEO`. Unset means
 * nobody — it fails closed, like ADMIN_KEY did. An env list rather than a
 * database flag so a mistake can't lock the operator out and a tenant can't
 * promote itself.
 */
export function operatorAgents(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.OPERATOR_AGENTS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isOperator(agentSymbol: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return agentSymbol !== undefined && operatorAgents(env).has(agentSymbol.toUpperCase());
}

/** Express guard: requires `req.agentSymbol` (set by resolveTenant) to be an operator. */
export const requireOperator: RequestHandler = (req, res, next) => {
  if (operatorAgents().size === 0) {
    res.status(503).json({ error: "operator access is not configured (OPERATOR_AGENTS unset)" });
    return;
  }
  if (!isOperator(req.agentSymbol)) {
    res.status(403).json({ error: "operator access required" });
    return;
  }
  next();
};
