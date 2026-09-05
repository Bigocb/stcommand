import type { ActivityEntry } from "../db/store.js";
import { ChatLLM, withRetry, type ChatLLMOptions } from "../core/chatLLM.js";

interface ShipSnapshot {
  symbol: string;
  nav?: { waypointSymbol?: string; status?: string };
}

const TONE = [
  "The bridge is quiet except for the hum of the reactors.",
  "Starlight flickers across the command console.",
  "A soft chime marks another completed cycle.",
  "The fleet moves like clockwork through the dark.",
];

function randomPick(arr: string[]): string {
  const item = arr[Math.floor(Math.random() * arr.length)];
  return item ?? "Silence on the comms.";
}

function kindVerb(kind: string): string {
  switch (kind) {
    case "extract": return "extracted";
    case "sell": return "sold";
    case "buy": return "purchased";
    case "navigate": return "navigated";
    case "refuel": return "refueled";
    default: return kind;
  }
}

/** Templated fallback used when no LLM is configured or the call fails. */
export function generateLog(
  activity: ActivityEntry[],
  credits: number,
  ships: ShipSnapshot[],
): string {
  if (activity.length === 0) {
    return `${randomPick(TONE)} Awaiting the first telemetry burst from the fleet.`;
  }
  const latest = activity[0];
  const lines: string[] = [];
  lines.push(`${randomPick(TONE)}`);

  const shipCount = ships.length;
  const activeShips = ships.filter((s) => s.nav?.status !== "DOCKED").length;
  lines.push(`Command reports ${shipCount} ship${shipCount === 1 ? "" : "s"} on the board, ${activeShips} currently underway.`);

  const sells = activity.filter((a) => a.kind === "sell");
  const buys = activity.filter((a) => a.kind === "buy");
  const extracts = activity.filter((a) => a.kind === "extract");

  if (sells.length) {
    const total = sells.reduce((sum, a) => sum + (a.credits ?? 0), 0);
    lines.push(`Recent trades brought in ${total.toLocaleString("en-US")} credits across ${sells.length} transaction${sells.length === 1 ? "" : "s"}.`);
  }
  if (extracts.length) {
    lines.push(`Mining lasers have cut ${extracts.length} new extraction${extracts.length === 1 ? "" : "s"} from the asteroid fields.`);
  }
  if (buys.length) {
    const spent = buys.reduce((sum, a) => sum + Math.abs(a.credits ?? 0), 0);
    lines.push(`The quartermaster logged ${spent.toLocaleString("en-US")} credits in procurement.`);
  }

  if (latest) {
    lines.push(`Latest event: ${latest.shipSymbol} ${kindVerb(latest.kind)} — ${latest.detail}.`);
  }
  lines.push(`Current treasury: ${credits.toLocaleString("en-US")} credits.`);

  return lines.join(" ");
}

const NARRATIVE_SYSTEM = `You are the captain's log of a SpaceTraders fleet — a first-person ship's log written by the captain, not a corporate report.

Write 2-4 sentences in a dry, wry, spacefaring voice. Ground every claim in the telemetry you are given: never invent ships, credits, or events that are not in the data. Vary the phrasing between entries; do not repeat the same opening. Keep it under 60 words. No markdown, no headers, no bullet points — just prose.`;

/** Summarize activity into a compact telemetry block for the model. */
function telemetryBlock(activity: ActivityEntry[], credits: number, ships: ShipSnapshot[]): string {
  const sells = activity.filter((a) => a.kind === "sell");
  const buys = activity.filter((a) => a.kind === "buy");
  const extracts = activity.filter((a) => a.kind === "extract");
  const sellTotal = sells.reduce((sum, a) => sum + (a.credits ?? 0), 0);
  const buyTotal = buys.reduce((sum, a) => sum + Math.abs(a.credits ?? 0), 0);
  const activeShips = ships.filter((s) => s.nav?.status !== "DOCKED").length;
  const latest = activity[0];

  const lines = [
    `Credits: ${credits.toLocaleString("en-US")}`,
    `Ships: ${ships.length} total, ${activeShips} underway`,
    `Recent activity (${activity.length} events, newest first):`,
    ...activity.slice(0, 8).map((a) => `- ${a.shipSymbol} ${a.kind}${a.credits ? ` (${a.credits >= 0 ? "+" : ""}${a.credits})` : ""}: ${a.detail}`),
  ];
  if (sells.length) lines.push(`Sells: ${sells.length} for ${sellTotal.toLocaleString("en-US")} credits`);
  if (buys.length) lines.push(`Buys: ${buys.length} for ${buyTotal.toLocaleString("en-US")} credits`);
  if (extracts.length) lines.push(`Extractions: ${extracts.length}`);
  if (latest) lines.push(`Latest: ${latest.shipSymbol} ${latest.kind} — ${latest.detail}`);
  return lines.join("\n");
}

export interface NarrativeWriterOptions {
  llm?: ChatLLM;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  onEvent?: ChatLLMOptions["onEvent"];
  /** Floor on how often a tenant's log may be regenerated. See below. */
  minIntervalMs?: number;
  /** Injectable clock, so the interval policy is testable without waiting. */
  now?: () => number;
  /**
   * Whether an absent `apiKey` may fall back to the process-wide
   * ST_LLM_API_KEY. True for standalone/CLI use, where that env var *is* the
   * configuration. The multi-tenant server passes false: a tenant who has
   * not set a key has not agreed to spend anyone's, and quietly billing the
   * operator for every tenant's captain's log is the kind of default that is
   * only discovered on an invoice.
   */
  envFallback?: boolean;
}

/**
 * The floor between two LLM calls for one tenant.
 *
 * The dashboard polls /api/narrative every 30s. A busy fleet produces a new
 * activity row far more often than that, so "regenerate whenever something
 * changed" is really "regenerate every poll" — around 120 calls an hour, per
 * tenant, to rewrite a paragraph nobody asked to have rewritten.
 *
 * Ten minutes caps it near six calls an hour. That is the difference between
 * this being a background nicety and being the most expensive thing the app
 * does, and a captain's log describing the last ten minutes is not obviously
 * worse than one describing the last thirty seconds — it has more to say.
 */
const MIN_INTERVAL_MS = 10 * 60_000;

export type NarrativeSource = "llm" | "template";

export interface NarrativeResult {
  log: string;
  source: NarrativeSource;
  /** Set when a configured LLM failed and the template answered instead. */
  error?: string;
}

/**
 * LLM-backed captain's log. Falls back to the templated `generateLog` when no
 * LLM is configured or a generation fails, so the dashboard never goes blank.
 */
export class NarrativeWriter {
  private readonly llm?: ChatLLM;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private lastKey = "";
  private lastLog = "";
  private lastAt = 0;
  private lastError?: string;

  constructor(opts: NarrativeWriterOptions = {}) {
    const apiKey = opts.apiKey ?? (opts.envFallback === false ? undefined : process.env.ST_LLM_API_KEY);
    if (apiKey) {
      this.llm =
        opts.llm ??
        new ChatLLM({
          apiKey,
          model: opts.model ?? process.env.ST_LLM_MODEL ?? "deepseek-v4-flash:0731",
          baseUrl: opts.baseUrl,
          onEvent: opts.onEvent,
        });
    } else if (opts.llm) {
      this.llm = opts.llm;
    }
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Whether an LLM is available for narrative generation. */
  get enabled(): boolean {
    return this.llm !== undefined;
  }

  /** The model in use, for reporting which one wrote the log. */
  get model(): string | undefined {
    return this.llm?.model;
  }

  /**
   * Generate a captain's log entry.
   *
   * Two gates stand in front of the model, and both exist to keep this cheap
   * enough to leave on:
   *
   *  1. Nothing happened. The key is the latest activity row, not the whole
   *     snapshot — credits tick with every trade and the ship count moves
   *     when a hull is bought, but neither is an *event*, and keying on them
   *     meant a busy fleet invalidated the cache on essentially every poll.
   *     They still appear in the log; they just do not trigger one.
   *  2. Something happened, but too recently. See MIN_INTERVAL_MS.
   *
   * In both cases the cached LLM text is returned rather than the template.
   * Falling back to the template between calls would make the pane flip
   * between two voices every thirty seconds, which reads as a bug.
   */
  async generate(
    activity: ActivityEntry[],
    credits: number,
    ships: ShipSnapshot[],
  ): Promise<NarrativeResult> {
    if (!this.llm) return { log: generateLog(activity, credits, ships), source: "template" };

    const key = `${activity[0]?.timestamp ?? ""}|${activity[0]?.detail ?? ""}`;
    const fresh = this.now() - this.lastAt < this.minIntervalMs;
    if (this.lastLog && (key === this.lastKey || fresh)) {
      return { log: this.lastLog, source: "llm" };
    }

    try {
      const telemetry = telemetryBlock(activity, credits, ships);
      const { reply } = await withRetry(() =>
        this.llm!.complete(
          [
            { role: "system", content: NARRATIVE_SYSTEM },
            { role: "user", content: `Telemetry:\n${telemetry}\n\nWrite today's log entry.` },
          ],
          { maxTokens: 200 },
        ),
      );
      const trimmed = reply.trim();
      if (!trimmed) throw new Error("model returned an empty log");
      // Only commit the key and the clock on success. A failed call must not
      // start the ten-minute cooldown, or one blip would mean ten minutes of
      // template text with the model sitting idle.
      this.lastKey = key;
      this.lastAt = this.now();
      this.lastLog = trimmed;
      this.lastError = undefined;
      return { log: trimmed, source: "llm" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged once per distinct failure rather than on every poll: a wrong
      // key would otherwise fill the tenant's log with the same line forever.
      if (message !== this.lastError) {
        console.error("[narrative] LLM generation failed, using template:", message);
        this.lastError = message;
      }
      return { log: generateLog(activity, credits, ships), source: "template", error: message };
    }
  }
}
