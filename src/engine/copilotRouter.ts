import { JudgeError, gate, redactSecrets, withFirst, yes, type Judge, type JudgeRequest, type JudgeResult } from "./judge.js";

/**
 * Co-pilot router: reads the captain's message and says which kind of question it is, so the co-pilot can be handed only the
 * tools that question needs. Classifying a typed message into a few intents is what the decision model is documented to do
 * well (https://docs.typesafe.ai/patterns/intent-routing.md).
 *
 * It only ever NARROWS the read tools, and only when it is sure. The co-pilot's own change tool, the confirm step and every
 * tool this table does not know about are untouched, so a wrong guess costs a less focused answer, never a wrong action. With
 * the clause off, a low confidence, an "other" verdict or no model at all, the co-pilot gets every tool, exactly as before.
 *
 * Pure apart from the judge it is handed: no clock, no globals, no direct I/O.
 */

export type IntentKey = "other" | "fleet_status" | "ship_diagnosis" | "markets_routes" | "gate_progress" | "change_request" | "exploration";

interface Intent {
  /** Shown to the model as the option's description. */
  describe: string;
  /** The read tools this kind of question needs. */
  tools: readonly string[];
}

/** The change tool is never narrowed away: a question can turn into a request mid-conversation. */
export const ALWAYS_KEEP: readonly string[] = ["propose_fleet_action"];

export const INTENTS: Record<IntentKey, Intent> = {
  other: { describe: "Anything unclear, chatty, broad, or that does not clearly fit one of the others", tools: [] },
  fleet_status: {
    describe: "How the fleet, the credits or the week is going right now, or a summary of what ships are doing",
    tools: ["get_fleet_status", "list_ships", "get_agent", "get_activity", "get_ledger_totals", "get_missions", "get_contracts", "get_ship"],
  },
  ship_diagnosis: {
    describe: "Why one particular ship is doing something, or not moving, or looks stuck",
    tools: ["diagnose_ship", "get_ship_log", "get_ship", "get_fleet_status", "list_ships", "get_activity"],
  },
  markets_routes: {
    describe: "Prices, markets, goods, trade routes, margins or what to trade",
    tools: ["get_best_trades", "get_market_snapshots", "get_goods", "get_price_history", "scan_system_markets", "get_systems", "get_waypoint_coords", "get_distance", "get_loadout_scores"],
  },
  gate_progress: {
    describe: "The jump gate: whether it is open, what it still needs, or how to finish it",
    tools: ["get_gate_status", "get_missions", "get_goods", "get_market_snapshots", "get_best_trades", "get_fleet_status"],
  },
  change_request: {
    describe: "A request to change something: hold or release a ship, set a role, pause or resume the fleet",
    tools: ["get_fleet_status", "get_ship", "list_ships", "diagnose_ship"],
  },
  exploration: {
    describe: "Charting, surveys, systems or distances",
    tools: ["get_surveys", "get_systems", "get_waypoint_coords", "get_distance", "scan_system_markets", "get_market_snapshots"],
  },
};

/** Every tool name the table knows. A tool outside this set (an extra added later) is never removed. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([...ALWAYS_KEEP, ...Object.values(INTENTS).flatMap((i) => [...i.tools])]);

export interface RouterPolicy {
  enabled: boolean;
  /** 0..1: how sure the model must be before the tool set is narrowed. */
  floor: number;
}

export interface RouteDecision {
  /** True when the tool set is narrowed; false means every tool, as before. */
  narrow: boolean;
  intent?: IntentKey;
  confidence: number;
  /** Probability the message asks for a change rather than asking a question. */
  wantsChange: number;
  /** The tools to keep when narrowing. */
  keep?: ReadonlySet<string>;
  /** One line for the log: why this decision. */
  reason: string;
}

const MAX_MESSAGE = 600;

/** The request sent to the model for one captain's message. */
export function buildRouterRequest(message: string): JudgeRequest {
  const criteria = Object.fromEntries(Object.entries(INTENTS).map(([k, v]) => [k, v.describe])) as Record<string, string>;
  return {
    state: { captainMessage: redactSecrets(message).slice(0, MAX_MESSAGE) },
    questions: {
      intent: {
        type: "choice",
        instructions: "Which kind of question or request is the captain's message?",
        // "other" first: the model leans toward the first option, and the unsure answer should be the harmless one.
        criteria: withFirst(criteria, "other"),
      },
      wants_change: {
        type: "noul",
        instructions: "Is the captain asking for something to be changed or done (hold, release, set a role, pause, resume, buy, sell) rather than asking a question?",
        criteria: { true: "Asks for an action or a change", false: "Asks a question or chats" },
      },
    },
  };
}

const ALL = (reason: string, extra: Partial<RouteDecision> = {}): RouteDecision => ({ narrow: false, confidence: 0, wantsChange: 0, reason, ...extra });

/** Turns the model's answers into a decision. Sure and specific narrows the tools; anything else keeps them all. */
export function decideRoute(answers: JudgeResult["answers"], policy: RouterPolicy): RouteDecision {
  if (!policy.enabled) return ALL("router off: every tool");
  const intentAnswer = answers.intent;
  const wantsChange = yes(answers.wants_change);
  if (!intentAnswer || intentAnswer.type !== "choice") return ALL("router: no intent answer, every tool", { wantsChange });
  const intent = intentAnswer.choice as IntentKey;
  const g = gate(intentAnswer, policy.floor, `intent ${intent}`);
  if (!(intent in INTENTS)) return ALL(`router: unknown intent "${intent}", every tool`, { confidence: g.confidence, wantsChange });
  if (!g.pass) return ALL(`router: ${g.reason}; every tool`, { intent, confidence: g.confidence, wantsChange });
  if (intent === "other") return ALL(`router: ${g.reason}, but it is "other"; every tool`, { intent, confidence: g.confidence, wantsChange });
  const keep = new Set<string>([...ALWAYS_KEEP, ...INTENTS[intent].tools]);
  // A question that may really be a request keeps what a request needs.
  if (wantsChange >= 0.4) for (const t of INTENTS.change_request.tools) keep.add(t);
  return { narrow: true, intent, confidence: g.confidence, wantsChange, keep, reason: `router: ${g.reason}` };
}

/** The tool names to expose: every name when not narrowing, else the kept ones plus anything this table does not know. */
export function selectToolNames(all: readonly string[], decision: RouteDecision): string[] {
  if (!decision.narrow || !decision.keep) return [...all];
  return all.filter((n) => decision.keep!.has(n) || !KNOWN_TOOLS.has(n));
}

export interface RouteOutcome {
  decision: RouteDecision;
  /** Present when the model was actually asked, for the decision log. */
  request?: JudgeRequest;
  result?: JudgeResult;
}

/** Asks the model about one message. Never throws: no judge, a disabled clause or a failure all mean "every tool". */
export async function routeMessage(judge: Judge | undefined, message: string, policy: RouterPolicy): Promise<RouteOutcome> {
  if (!policy.enabled) return { decision: ALL("router off: every tool") };
  if (!judge) return { decision: ALL("router: no decision model configured, every tool") };
  const request = buildRouterRequest(message);
  try {
    const result = await judge.decide(request);
    return { decision: decideRoute(result.answers, policy), request, result };
  } catch (err) {
    const why = err instanceof JudgeError ? err.message : "unexpected error";
    return { decision: ALL(`router: decision model unavailable (${why}), every tool`), request };
  }
}
