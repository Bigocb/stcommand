import { confidenceOf, gate, sanitizeState, withFirst, yes, type Answer, type JudgeRequest } from "./judge.js";

/**
 * Attention feed: which ships need a human's eyes, and why.
 *
 * Two voices, kept apart so each can be trusted for what it is:
 *  - RULES (plain code) read facts the engine already has and give a flag with a one-line reason a person can check. They
 *    cover the obvious cases and always work, with or without the model.
 *  - The MODEL (the decision model, advisory) is asked a few literal yes/no questions about the same facts and can raise a
 *    flag the rules did not, or suggest a next step. Its flags carry its probability and are shown as the model's opinion.
 *
 * The model is not good at arithmetic, counting or dates (see judge.ts), so none of that is asked of it: counts, minutes and
 * percentages are worked out in code (ShipFacts) and handed over as plain labelled numbers.
 *
 * Pure: no I/O, no clock. The fleet fills ShipFacts; the feed service (attentionFeed.ts) does the asking.
 */

export interface ShipFacts {
  symbol: string;
  role: string;
  /** DOCKED | IN_ORBIT | IN_TRANSIT */
  nav: string;
  /** What the ship is doing, as the fleet status says ("docked", "transit → X", "manual hold", "cooldown 30s"). */
  doing: string;
  wants?: string;
  wantsReason?: string;
  wantsSource?: string;
  held: boolean;
  /** A hold replayed from saved state when the server booted, not one placed in this session. */
  restoredHold: boolean;
  stranded: boolean;
  /** Null when the ship has no tank (a probe). */
  fuelPercent: number | null;
  cargoPercent: number;
  cooldownSeconds: number;
  /** Seconds past the arrival time while still IN_TRANSIT; 0 otherwise. */
  secondsPastArrival: number;
  /** Minutes since the ship's last log line; null when none is buffered. */
  minutesSinceLastLogLine: number | null;
  /** The log line the ship repeated most in the recent window, and how many times. */
  mostRepeatedLogLine: string | null;
  timesRepeated: number;
  repeatWindowMinutes: number;
  waitingOnApproval: boolean;
  hasRouteAssigned: boolean;
}

export type Severity = "critical" | "warning" | "info";
const RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export interface Reason {
  code: string;
  text: string;
  severity: Severity;
  /** Who raised it. */
  by: "rule" | "model";
}

export interface AttentionItem {
  ship: string;
  role: string;
  severity: Severity;
  reasons: Reason[];
  /** The model's one suggested next step, only when it was sure enough. */
  suggestion?: string;
  /** The model's yes-probabilities, when it was asked. */
  model?: { stuck: number; looping: number; unexpectedHold: number; wasting: number };
}

/** Thresholds for the rules, as data. */
export interface AttentionRules {
  loopTimes: number;
  quietMinutes: number;
  overdueSeconds: number;
  lowFuelPercent: number;
}
export const DEFAULT_RULES: AttentionRules = { loopTimes: 12, quietMinutes: 20, overdueSeconds: 300, lowFuelPercent: 15 };

const ACTIVE_ROLES = new Set(["trader", "miner", "siphoner", "surveyor", "tour", "explorer", "scout"]);

/** The plain-code flags for one ship, each with a reason a person can check. */
export function ruleReasons(f: ShipFacts, rules: AttentionRules = DEFAULT_RULES): Reason[] {
  const out: Reason[] = [];
  const add = (code: string, severity: Severity, text: string) => out.push({ code, severity, text, by: "rule" });
  if (f.stranded) add("stranded", "critical", "stranded: out of fuel with no reachable stop");
  if (f.nav === "IN_TRANSIT" && f.secondsPastArrival > rules.overdueSeconds) {
    add("transit_overdue", "warning", `still in transit ${Math.round(f.secondsPastArrival / 60)} min after its arrival time`);
  }
  if (f.held && f.restoredHold) {
    add("restored_hold", "warning", "held by a saved hold replayed when the server booted, not one placed this session");
  } else if (f.held) {
    add("held", "info", `held by the operator${f.wantsReason ? `: ${f.wantsReason}` : ""}`);
  }
  if (f.mostRepeatedLogLine && f.timesRepeated >= rules.loopTimes && f.nav !== "IN_TRANSIT") {
    const line = f.mostRepeatedLogLine.length > 90 ? `${f.mostRepeatedLogLine.slice(0, 90)}…` : f.mostRepeatedLogLine;
    if (f.waitingOnApproval) add("waiting_approval", "info", `waiting on an approval ("${line}", ${f.timesRepeated} times in ${f.repeatWindowMinutes} min)`);
    else add("retry_loop", "warning", `repeating "${line}" ${f.timesRepeated} times in ${f.repeatWindowMinutes} min`);
  }
  if (
    f.minutesSinceLastLogLine !== null && f.minutesSinceLastLogLine >= rules.quietMinutes &&
    f.nav !== "IN_TRANSIT" && f.cooldownSeconds === 0 && !f.held && ACTIVE_ROLES.has(f.role)
  ) {
    add("quiet", "warning", `no log lines for ${Math.round(f.minutesSinceLastLogLine)} min while not in transit`);
  }
  if (f.fuelPercent !== null && f.fuelPercent < rules.lowFuelPercent && f.nav !== "DOCKED") {
    add("low_fuel", "warning", `fuel at ${Math.round(f.fuelPercent)}%`);
  }
  if (f.role === "trader" && !f.hasRouteAssigned && !f.held && f.nav !== "IN_TRANSIT" && f.cooldownSeconds === 0) {
    add("no_route", "info", "trader with no route assigned");
  }
  return out;
}

/** The fields that may be sent to the model, with the names it will read. Anything not here never leaves the server. */
export function shipState(f: ShipFacts): Record<string, unknown> {
  const raw = {
    ship: f.symbol,
    role: f.role,
    navStatus: f.nav,
    activity: f.doing,
    assignedGoal: f.wants,
    reasonForGoal: f.wantsReason,
    goalSetBy: f.wantsSource,
    heldByOperator: f.held,
    holdWasRestoredAtBoot: f.restoredHold,
    stranded: f.stranded,
    fuelPercent: f.fuelPercent === null ? undefined : Math.round(f.fuelPercent),
    cargoPercent: Math.round(f.cargoPercent),
    cooldownSeconds: f.cooldownSeconds,
    secondsPastArrival: f.secondsPastArrival,
    minutesSinceLastLogLine: f.minutesSinceLastLogLine === null ? undefined : Math.round(f.minutesSinceLastLogLine),
    mostRepeatedLogLine: f.mostRepeatedLogLine ?? undefined,
    timesThatLineRepeated: f.timesRepeated,
    repeatWindowMinutes: f.repeatWindowMinutes,
    waitingOnApproval: f.waitingOnApproval,
    hasRouteAssigned: f.hasRouteAssigned,
  };
  return sanitizeState(raw, Object.keys(raw) as (keyof typeof raw & string)[]);
}

const NEXT_STEPS = {
  nothing: "No action needed",
  wait: "Wait: it is working or waiting for a normal reason",
  read_logs: "Read the ship's recent logs to find out why",
  release_hold: "Release the hold so the fleet's controllers take over again",
  check_approvals: "Check the pending approvals",
  reassign_role: "Give it a different role",
} as const;

const SUGGESTION_TEXT: Record<string, string> = {
  read_logs: "read its recent logs",
  release_hold: "release its hold",
  check_approvals: "check the pending approvals",
  reassign_role: "give it a different role",
};

/** The questions asked about each ship. Literal on purpose: the model answers what is written, not what is meant. */
export function shipQuestions(): JudgeRequest["questions"] {
  const yn = (instructions: string, yesText: string, noText: string) => ({ type: "noul" as const, instructions, criteria: { true: yesText, false: noText } });
  return {
    stuck: yn("Is this ship making no progress, for a reason other than ordinary waiting?", "No progress and no ordinary reason to wait", "Progressing, or waiting for an ordinary reason"),
    looping: yn("Is this ship repeating the same action over and over without getting anywhere?", "Repeating without progress", "Not repeating, or the repeats are progress"),
    unexpected_hold: yn("Is this ship held or paused with no clear current reason?", "Held or paused without a clear reason", "Not held, or held for a clear reason"),
    wasting: yn("Is this ship idle when it should be earning credits?", "Idle when it should be earning", "Busy, or not expected to earn"),
    next_step: {
      type: "choice",
      instructions: "What is the best next step for a person looking at this ship?",
      // "nothing" first: the model leans toward the first option, and the unsure answer should be the harmless one.
      criteria: withFirst({ ...NEXT_STEPS } as Record<string, string>, "nothing"),
    },
  };
}

export interface AttentionPolicy {
  /** 0..1: how sure the model must be for its flag to count. */
  floor: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Rules and (optionally) the model's answers for one ship, combined. Undefined when there is nothing to say. */
export function assess(f: ShipFacts, answers: Record<string, Answer> | undefined, policy: AttentionPolicy, rules: AttentionRules = DEFAULT_RULES): AttentionItem | undefined {
  const reasons = ruleReasons(f, rules);
  let model: AttentionItem["model"];
  let suggestion: string | undefined;
  if (answers) {
    model = { stuck: yes(answers.stuck), looping: yes(answers.looping), unexpectedHold: yes(answers.unexpected_hold), wasting: yes(answers.wasting) };
    const flags: [keyof NonNullable<typeof model>, string, string][] = [
      ["stuck", "stuck", "model: looks stuck"],
      ["looping", "looping", "model: looks like it is repeating without progress"],
      ["unexpectedHold", "unexpected_hold", "model: held with no clear reason"],
      ["wasting", "wasting", "model: idle when it should be earning"],
    ];
    for (const [key, code, text] of flags) {
      const p = model[key];
      if (p >= policy.floor) reasons.push({ code: `model_${code}`, severity: "warning", by: "model", text: `${text} (${pct(p)} sure)` });
    }
    const next = answers.next_step;
    if (next?.type === "choice" && SUGGESTION_TEXT[next.choice] && gate(next, policy.floor, "next step").pass) {
      suggestion = `${SUGGESTION_TEXT[next.choice]} (${pct(confidenceOf(next))} sure)`;
    }
  }
  if (reasons.length === 0) return undefined;
  const severity = reasons.reduce<Severity>((s, r) => (RANK[r.severity] > RANK[s] ? r.severity : s), "info");
  return { ship: f.symbol, role: f.role, severity, reasons, ...(suggestion ? { suggestion } : {}), ...(model ? { model } : {}) };
}

/** The feed: ships that need attention, most urgent first. */
export function buildAttention(facts: readonly ShipFacts[], answers: ReadonlyMap<string, Record<string, Answer>>, policy: AttentionPolicy, rules: AttentionRules = DEFAULT_RULES): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const f of facts) {
    const item = assess(f, answers.get(f.symbol), policy, rules);
    if (item) items.push(item);
  }
  return items.sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.reasons.length - a.reasons.length || a.ship.localeCompare(b.ship));
}

/** Only ships with something worth a second opinion are sent: a quiet, healthy ship costs nothing to leave out. */
export function worthAsking(f: ShipFacts, rules: AttentionRules = DEFAULT_RULES): boolean {
  return ruleReasons(f, rules).some((r) => r.severity !== "info") || f.held || f.timesRepeated >= rules.loopTimes / 2 || (f.minutesSinceLastLogLine ?? 0) >= rules.quietMinutes / 2;
}
