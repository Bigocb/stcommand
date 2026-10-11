import { routeMessage, selectToolNames, type RouterPolicy } from "./copilotRouter.js";
import { redactSecrets, toDecisionRows, type DecisionRow, type Judge } from "./judge.js";
import { getJudge } from "./judgeLive.js";
import type { Doctrine } from "./doctrine.js";

/**
 * Plugs the co-pilot router into a ChatAgent as its `toolFilter`: for each message, ask the decision model what kind of
 * question it is and return the tool names to expose. Everything about the decision is in copilotRouter.ts; this only
 * reads the clause, logs, and records. With the clause off it returns every tool without calling anything.
 */
export function makeToolFilter(deps: {
  doctrine: Pick<Doctrine, "isEnabledOr" | "value">;
  log: (msg: string) => void;
  record?: (rows: DecisionRow[]) => Promise<void>;
  /** Defaults to the process's model; a test passes its own. */
  judge?: () => Judge | undefined;
}): (message: string, toolNames: string[]) => Promise<string[]> {
  return async (message, toolNames) => {
    const policy: RouterPolicy = { enabled: deps.doctrine.isEnabledOr("jevRouter", false), floor: deps.doctrine.value("jevRouter", 85) / 100 };
    if (!policy.enabled) return toolNames;
    const out = await routeMessage((deps.judge ?? getJudge)(), message, policy);
    const kept = selectToolNames(toolNames, out.decision);
    deps.log(`${out.decision.reason}${out.decision.narrow ? `: exposing ${kept.length} of ${toolNames.length} tools` : ""}`);
    if (out.request && out.result && deps.record) {
      const rows = toDecisionRows("router", redactSecrets(message).slice(0, 200), out.request, out.result, out.decision.narrow, out.decision.reason);
      void deps.record(rows).catch((e) => deps.log(`router: decision log not saved: ${e instanceof Error ? e.message : String(e)}`));
    }
    return kept;
  };
}
