import { JudgeError, toDecisionRows, type Answer, type DecisionRow, type Judge } from "./judge.js";
import { buildAttention, shipQuestions, shipState, worthAsking, type AttentionItem, type ShipFacts } from "./attention.js";

/**
 * Runs the attention feed (attention.ts) on a timer-free schedule: the fleet calls refresh() every maintenance pass and this
 * decides whether it is time. The rules run every refresh; the model is asked only about ships that look worth a second
 * opinion, only when something about them changed (or an answer has gone stale), and a bounded number per pass, so the
 * cost and the latency stay small however big the fleet grows. If the model is missing or failing the feed carries on
 * with the plain rules.
 *
 * Every answer is logged through `record` (the judge_decisions table), acted=false: the feed only ever advises.
 */

export interface AttentionFeedDeps {
  /** The current facts for every ship. */
  facts(): ShipFacts[];
  judge?: Judge;
  /** The doctrine clause: enabled, and how sure the model must be (0..1). */
  policy(): { enabled: boolean; floor: number };
  record?(rows: DecisionRow[]): Promise<void>;
  /** Called about hourly to drop old log rows. */
  prune?(): Promise<void>;
  now(): number;
  log?(msg: string): void;
  /** Minimum time between refreshes. */
  minRefreshMs?: number;
  /** How long a model answer is reused while the ship looks the same. */
  answerTtlMs?: number;
  /** The most ships asked about in one refresh. */
  maxAsks?: number;
}

export interface AttentionSnapshot {
  asOf: number;
  enabled: boolean;
  modelConfigured: boolean;
  items: AttentionItem[];
  /** Ships the model was asked about in the last refresh, and how many of those calls failed. */
  asked: number;
  failed: number;
}

/** A coarse description of a ship, so tiny changes (a minute more of silence) do not trigger a new question. */
export function digestOf(f: ShipFacts): string {
  return [
    f.nav, f.doing, f.wants ?? "", f.held, f.restoredHold, f.stranded, f.waitingOnApproval, f.hasRouteAssigned,
    Math.floor((f.minutesSinceLastLogLine ?? 0) / 10), Math.floor(f.timesRepeated / 5), Math.floor(f.secondsPastArrival / 300),
    f.fuelPercent === null ? "x" : Math.floor(f.fuelPercent / 15),
  ].join("|");
}

export class AttentionFeed {
  private snap: AttentionSnapshot = { asOf: 0, enabled: false, modelConfigured: false, items: [], asked: 0, failed: 0 };
  private readonly answers = new Map<string, { digest: string; at: number; answers: Record<string, Answer> }>();
  private lastRun = -Infinity;
  private lastPrune = -Infinity;
  private running = false;

  constructor(private readonly deps: AttentionFeedDeps) {}

  snapshot(): AttentionSnapshot {
    return this.snap;
  }

  /** Recomputes the feed if it is time. Never throws: a feed that fails keeps its last snapshot. */
  async refresh(): Promise<AttentionSnapshot> {
    const d = this.deps;
    if (this.running) return this.snap;
    const now = d.now();
    const policy = d.policy();
    if (!policy.enabled) {
      if (this.snap.enabled || this.snap.items.length) {
        this.snap = { asOf: now, enabled: false, modelConfigured: !!d.judge, items: [], asked: 0, failed: 0 };
        this.answers.clear();
      }
      return this.snap;
    }
    if (now - this.lastRun < (d.minRefreshMs ?? 60_000)) return this.snap;
    this.running = true;
    this.lastRun = now;
    try {
      const facts = d.facts();
      let asked = 0;
      let failed = 0;
      if (d.judge) {
        const ttl = d.answerTtlMs ?? 10 * 60_000;
        const due = facts.filter((f) => {
          if (!worthAsking(f)) return false;
          const hit = this.answers.get(f.symbol);
          return !hit || hit.digest !== digestOf(f) || now - hit.at > ttl;
        }).slice(0, d.maxAsks ?? 8);
        const judge = d.judge;
        const results = await Promise.allSettled(due.map(async (f) => {
          const request = { state: shipState(f), questions: shipQuestions() };
          const result = await judge.decide(request);
          this.answers.set(f.symbol, { digest: digestOf(f), at: now, answers: result.answers });
          if (d.record) await d.record(toDecisionRows("attention", f.symbol, request, result, false)).catch((e) => d.log?.(`attention: decision log not saved: ${e instanceof Error ? e.message : String(e)}`));
        }));
        asked = due.length;
        for (const r of results) {
          if (r.status === "rejected") {
            failed += 1;
            if (failed === 1) d.log?.(`attention: decision model unavailable (${r.reason instanceof JudgeError ? r.reason.message : "unexpected error"}); using the rules alone for those ships`);
          }
        }
      }
      // Forget ships that have gone, and answers about a ship that no longer looks the way it did.
      const live = new Set(facts.map((f) => f.symbol));
      for (const sym of [...this.answers.keys()]) if (!live.has(sym)) this.answers.delete(sym);
      const usable = new Map<string, Record<string, Answer>>();
      for (const f of facts) {
        const hit = this.answers.get(f.symbol);
        if (hit && hit.digest === digestOf(f)) usable.set(f.symbol, hit.answers);
      }
      this.snap = { asOf: now, enabled: true, modelConfigured: !!d.judge, items: buildAttention(facts, usable, { floor: policy.floor }), asked, failed };
      if (d.prune && now - this.lastPrune > 3600_000) {
        this.lastPrune = now;
        await d.prune().catch(() => {});
      }
    } catch (err) {
      d.log?.(`attention: refresh failed (${err instanceof Error ? err.message : String(err)}); keeping the last result`);
    } finally {
      this.running = false;
    }
    return this.snap;
  }
}
