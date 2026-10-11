/**
 * The decision-model port: ask typed questions about a state, get probabilities back.
 *
 * This is the narrow interface the rest of the engine uses (the co-pilot router, the attention feed); the HTTP adapter for
 * TypeSafe's Jev lives in jevClient.ts and a stub is enough for tests. Nothing here does I/O or reads a clock.
 *
 * What the model is and is not (https://docs.typesafe.ai, "Jev 1.13 limitations"): it reads literally, is not a
 * calculator, miscounts, treats dates as text, leans toward the FIRST option of a choice, loses accuracy as the state grows,
 * and can be steered by text inside the state. So callers compute numbers, counts and times in code, send a small
 * labelled state, ask literal questions, and treat the answer as a probability to gate on, never as a command.
 */

export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
/** `criteria` maps option -> description (null for none). The API allows 255 options. */
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
/** `criteria` is an ordered list of 2-10 level descriptions. */
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgeRequest {
  /** Small and labelled. Never a credential: see sanitizeState(). */
  state: string | Record<string, unknown>;
  questions: Record<string, Question>;
}

export interface JudgeResult {
  answers: Record<string, Answer>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface Judge {
  decide(request: JudgeRequest): Promise<JudgeResult>;
}

/** Why a call failed, so callers can fall back quietly: the model is advisory and its absence must never stop anything. */
export class JudgeError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "JudgeError";
  }
}

/**
 * Keeps only the named keys of a flat state, dropping everything else and any string long enough to be a blob. The state
 * leaves this server, so it is built from an explicit allow-list of fields rather than by trimming a larger object: a new
 * field added to a ship snapshot next year must not travel unless someone adds it here on purpose.
 */
export function sanitizeState<T extends Record<string, unknown>>(raw: T, allowed: readonly (keyof T & string)[], maxString = 160): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[key] = v.length > maxString ? `${v.slice(0, maxString)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, 8).map((x) => (typeof x === "string" ? (x.length > maxString ? `${x.slice(0, maxString)}…` : x) : x));
  }
  return out;
}

/** The probability of the answer's own pick, so callers gate on one number whatever the question type. */
export function confidenceOf(answer: Answer): number {
  if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
  return answer.confidence;
}

/** The probability that a noul question's answer is yes. */
export function yes(answer: Answer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

export interface Gate {
  /** True when the answer is sure enough to act on at this floor. */
  pass: boolean;
  confidence: number;
  /** One line for the log: what was asked of the answer and how it fared. */
  reason: string;
}

/**
 * Confidence gating (the provider's own pattern): the answer says what, confidence says whether to act on it. Below the
 * floor the caller takes its safe default.
 */
export function gate(answer: Answer | undefined, floor: number, label: string): Gate {
  if (!answer) return { pass: false, confidence: 0, reason: `${label}: no answer` };
  const confidence = confidenceOf(answer);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return confidence >= floor
    ? { pass: true, confidence, reason: `${label}: ${pct(confidence)} sure, at or above the ${pct(floor)} floor` }
    : { pass: false, confidence, reason: `${label}: ${pct(confidence)} sure, below the ${pct(floor)} floor` };
}

/**
 * The model leans toward the first option of a choice, so the order is a decision, not an accident. The safe, do-nothing-new
 * option goes first: when the model is unsure it drifts toward the conservative one. `first` is moved to the front and the
 * rest keep their order.
 */
export function withFirst<T extends Record<string, unknown>>(criteria: T, first: string): T {
  if (!(first in criteria)) return criteria;
  const out: Record<string, unknown> = { [first]: criteria[first] };
  for (const [k, v] of Object.entries(criteria)) if (k !== first) out[k] = v;
  return out as T;
}

/**
 * Free text the captain typed can contain a pasted key, and it is about to leave the server. Anything that looks like one of
 * ours (an MCP key, a Bearer value) or any long unbroken token is replaced before it is sent or logged.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsctk_[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

/** One answered question, in the shape the judge_decisions table keeps for calibration. */
export interface DecisionRow {
  feature: "router" | "attention";
  /** What was judged: a ship symbol, or the (redacted) captain's message. */
  subject: string;
  question: string;
  answer: Answer;
  confidence: number;
  /** The state that was sent, so a decision can be replayed and reviewed later. */
  state: string | Record<string, unknown>;
  model: string;
  inputTokens: number;
  latencyMs: number;
  /** True only when the decision changed what the engine did, as opposed to being logged in shadow. */
  acted: boolean;
  note?: string;
}

/** Turns one call's answers into log rows. */
export function toDecisionRows(feature: DecisionRow["feature"], subject: string, request: JudgeRequest, result: JudgeResult, acted: boolean, note?: string): DecisionRow[] {
  return Object.entries(result.answers).map(([question, answer]) => ({
    feature, subject, question, answer, confidence: confidenceOf(answer), state: request.state,
    model: result.model, inputTokens: result.inputTokens, latencyMs: result.latencyMs, acted, ...(note ? { note } : {}),
  }));
}
