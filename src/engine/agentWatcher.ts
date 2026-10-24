import { API_BASE } from "../core/client.js";
import type { AgentSightingRow, Store } from "../db/store.js";
import { DEFAULT_GATE_POLICY, gateSampleChanged, gatesDue, planScan, systemOfHq, type GateKnown, type PublicAgent, type GatePolicy } from "./agentWatch.js";

/**
 * Watches the public agent directory and the start-system gates, and writes what it sees to agent_sightings, agent_samples and
 * gate_progress_samples (migrations/063_agent_watch.sql, docs/agent-watch.md). Public, tokenless reads only: it neither uses
 * nor competes with any tenant's rate limiter, and it changes nothing in the game.
 *
 * Every SCAN_INTERVAL_MS (15 min) it reads the whole agent list (about 9 requests), records agents it has not seen before in
 * this reset, refreshes the others, and reads the gates of start systems that are due (a new agent's start at once, an
 * unfinished gate every 30 minutes, a finished gate never). Every SAMPLE_INTERVAL_MS (30 min) it also writes each agent's
 * credits and ship count. The first time it runs for a reset it copies that reset's hourly agent_credit_snapshots in, since
 * the weekly cleanup wipes them.
 *
 * Failure never reaches the game or the rest of the server: a failed request pauses or ends the scan, which is tried again at
 * the next interval, and nothing is written from a scan that could not read the whole agent list.
 */

const SCAN_INTERVAL_MS = 15 * 60_000;
const SAMPLE_INTERVAL_MS = 30 * 60_000;
const REQUEST_GAP_MS = 700;

export interface AgentWatcherOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scanIntervalMs?: number;
  sampleIntervalMs?: number;
  gatePolicy?: GatePolicy;
}

export class AgentWatcher {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly scanIntervalMs: number;
  private readonly sampleIntervalMs: number;
  private readonly gatePolicy: GatePolicy;

  private busy = false;
  private lastScanAt: number | undefined;
  private lastSampleAt = 0;
  private resetDate: string | undefined;
  private known = new Map<string, AgentSightingRow>();
  private lastGate = new Map<string, GateKnown & { fulfilled: number; required: number; system: string }>();
  private readonly gateOfSystem = new Map<string, string>();
  private lastSummary = "";

  constructor(private readonly store: Store, private readonly log: (msg: string) => void, opts: AgentWatcherOptions = {}) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.scanIntervalMs = opts.scanIntervalMs ?? SCAN_INTERVAL_MS;
    this.sampleIntervalMs = opts.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.gatePolicy = opts.gatePolicy ?? DEFAULT_GATE_POLICY;
  }

  /** What the last scan did, for the ops tool. */
  status(): { resetDate: string | undefined; lastScanAt: number | undefined; agents: number; summary: string } {
    return { resetDate: this.resetDate, lastScanAt: this.lastScanAt, agents: this.known.size, summary: this.lastSummary };
  }

  /** Called every minute or so; does work only when a scan is due. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const t = this.now();
    if (this.lastScanAt !== undefined && t - this.lastScanAt < this.scanIntervalMs) return;
    this.busy = true;
    try {
      await this.scan();
    } catch (err) {
      this.lastSummary = `scan failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log(`agent watch: ${this.lastSummary}`);
    } finally {
      this.busy = false;
    }
  }

  /** GET with a few retries on 429 and server errors; undefined on a 404; throws when it cannot get an answer. */
  private async get<T>(url: string): Promise<T | undefined> {
    let last = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await this.fetchFn(new URL(url), { signal: AbortSignal.timeout(20_000) });
        await this.sleep(REQUEST_GAP_MS);
        if (res.status === 404) return undefined;
        if (res.ok) return (await res.json()) as T;
        last = `HTTP ${res.status}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await this.sleep(attempt * 3_000);
    }
    throw new Error(`${url} -> ${last}`);
  }

  private async scan(): Promise<void> {
    const status = await this.get<{ resetDate?: string }>(`${API_BASE}/`);
    const resetDate = status?.resetDate;
    if (!resetDate) throw new Error("the status endpoint gave no reset date");
    if (resetDate !== this.resetDate) await this.beginReset(resetDate);

    // The whole agent list or nothing: a partial list would read as agents going missing.
    const agents: PublicAgent[] = [];
    for (let page = 1; page < 200; page++) {
      const res = await this.get<{ data: PublicAgent[]; meta?: { total?: number } }>(`${API_BASE}/agents?page=${page}&limit=20`);
      if (!res) throw new Error(`agent list page ${page} not found`);
      agents.push(...res.data);
      if (res.data.length < 20) break;
    }
    if (!agents.length) throw new Error("the agent list came back empty");

    const t = this.now();
    const bracketStart = this.lastScanAt ?? (this.known.size ? Math.max(...[...this.known.values()].map((k) => k.lastSeenAt)) : undefined);
    const plan = planScan(this.known, agents, t, bracketStart);
    await this.store.insertAgentSightings(resetDate, plan.inserts);
    await this.store.touchAgentSightings(resetDate, plan.touches);
    for (const s of plan.inserts) this.known.set(s.agent, s);
    for (const u of plan.touches) {
      const k = this.known.get(u.agent);
      if (k) this.known.set(u.agent, { ...k, lastSeenAt: u.at, lastCredits: u.credits, lastShips: u.ships, faction: k.faction ?? u.faction, hq: u.hq });
    }
    let sampled = false;
    if (t - this.lastSampleAt >= this.sampleIntervalMs) {
      await this.store.insertAgentSamples(resetDate, t, agents);
      this.lastSampleAt = t;
      sampled = true;
    }
    this.lastScanAt = t;

    const gateReads = await this.readGates(resetDate, agents, new Set(plan.inserts.map((s) => s.system)), t);
    const baseline = plan.inserts.filter((s) => s.source === "baseline").length;
    this.lastSummary = `${agents.length} agents, ${plan.inserts.length - baseline} new${baseline ? `, ${baseline} baseline` : ""}${plan.missing.length ? `, ${plan.missing.length} missing` : ""}${sampled ? ", sampled" : ""}, ${gateReads} gate sample(s)`;
    this.log(`agent watch: ${this.lastSummary}`);
  }

  /** First scan of a reset in this process: load what is on record, and copy the hourly snapshots in if nothing is. */
  private async beginReset(resetDate: string): Promise<void> {
    this.resetDate = resetDate;
    this.known = new Map();
    this.lastGate = new Map();
    this.lastScanAt = undefined;
    this.lastSampleAt = 0;
    let rows = await this.store.loadAgentSightings(resetDate);
    if (!rows.length) {
      const added = await this.store.backfillAgentWatchFromSnapshots(resetDate, `${resetDate}T00:00:00Z`);
      if (added.sightings || added.samples) this.log(`agent watch: copied ${added.sightings} first sightings and ${added.samples} samples from the hourly snapshots for the ${resetDate} reset`);
      rows = await this.store.loadAgentSightings(resetDate);
    }
    for (const r of rows) this.known.set(r.agent, r);
    for (const [gate, g] of await this.store.latestGateSamples(resetDate)) this.lastGate.set(gate, g);
  }

  /** Read the gates that are due; returns how many samples were written. */
  /** Samples carry the scan's time, not the moment of each read, so a gate read a minute into the scan still counts as the state at first sight. */
  private async readGates(resetDate: string, agents: readonly PublicAgent[], urgent: ReadonlySet<string>, scanAt: number): Promise<number> {
    const systems = [...new Set(agents.map((a) => systemOfHq(a.headquarters)))];
    const missing = systems.filter((s) => !this.gateOfSystem.has(s));
    if (missing.length) for (const [s, g] of await this.store.gateSymbolsForSystems(missing)) this.gateOfSystem.set(s, g);
    const due = gatesDue(systems, this.lastGate, this.gateOfSystem, scanAt, this.gatePolicy, urgent);
    const rows: { gate: string; system: string; at: number; fulfilled: number; required: number; complete: boolean }[] = [];
    for (const d of due) {
      try {
        let gate = d.gate;
        if (gate === undefined) {
          // The crawler has not stored this system's waypoints yet: ask for its gate directly.
          const list = await this.get<{ data: { symbol: string }[] }>(`${API_BASE}/systems/${d.system}/waypoints?type=JUMP_GATE&limit=1`);
          gate = list?.data[0]?.symbol;
          if (!gate) continue;
          this.gateOfSystem.set(d.system, gate);
        }
        const res = await this.get<{ data: { materials?: { required: number; fulfilled: number }[]; isComplete?: boolean } }>(`${API_BASE}/systems/${d.system}/waypoints/${gate}/construction`);
        if (!res || typeof res.data?.isComplete !== "boolean") continue;
        const mats = res.data.materials ?? [];
        const sample = { gate, system: d.system, at: scanAt, fulfilled: mats.reduce((s, m) => s + m.fulfilled, 0), required: mats.reduce((s, m) => s + m.required, 0), complete: res.data.isComplete };
        const prev = this.lastGate.get(gate);
        if (gateSampleChanged(prev, sample)) {
          rows.push(sample);
          this.lastGate.set(gate, { sampledAt: sample.at, complete: sample.complete, fulfilled: sample.fulfilled, required: sample.required, system: d.system });
        } else if (prev) this.lastGate.set(gate, { ...prev, sampledAt: sample.at });
      } catch (err) {
        // A rate limit or network failure ends the gate reads for this scan; the agents are already recorded.
        this.log(`agent watch: gate reads stopped early: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    await this.store.insertGateSamples(resetDate, rows);
    return rows.length;
  }
}
