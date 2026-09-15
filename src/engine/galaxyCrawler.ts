import { API_BASE } from "../core/client.js";
import type { Store } from "../db/store.js";

/**
 * Crawls the *public* galaxy-wide reference data — every system's
 * coordinates/type and waypoint layout (GET /systems, paginated), the full
 * faction roster (GET /factions), and opportunistic jump-gate connections
 * (GET /systems/{s}/waypoints/{w}/jump-gate) — into the shared
 * galaxy_systems/galaxy_factions tables (migrations/011_galaxy_topology.sql,
 * 015_galaxy_crawl.sql, 020_galaxy_crawled_waypoints.sql).
 *
 * Deliberately independent of any one tenant's own exploration, and — as of
 * this pass — of any tenant's *client* too: every endpoint here is
 * confirmed live (curl, no Authorization header at all) to need no token.
 * `/systems` and `/factions` are plain public reference data; `/jump-gate`
 * needs the target waypoint charted, but charting is global — the instant
 * *any* player anywhere charts a gate, its connections become visible to
 * this crawler too, with no ship of ours ever having to visit it. This is
 * the same mechanism a third-party community cartography tool almost
 * certainly relies on for showing gate connections it never personally
 * explored.
 *
 * Runs on its own plain `fetch()` calls now, not `SpaceTradersAPI`/
 * `Client` — no tenant needs to be booted for this to make progress, and it
 * no longer draws from the shared per-tenant rate limiter. Still
 * deliberately paced (one call per tick) rather than racing to finish —
 * conservative until production behavior against the public endpoints is
 * actually observed; a galaxy of tens of thousands of systems is a
 * multi-hour-to-multi-day background job either way, same order of
 * magnitude as third-party tools' own "usually mapped by day 2-3."
 */
export interface GalaxyCrawlActivity {
  at: number;
  message: string;
}

interface CrawlSystem {
  symbol: string;
  sectorSymbol: string;
  type: string;
  x: number;
  y: number;
  waypoints: { symbol: string; type: string; x: number; y: number; orbitals: { symbol: string }[]; orbits?: string }[];
}

interface CrawlFaction {
  symbol: string;
  name: string;
  headquarters?: string;
  isRecruiting?: boolean;
}

/** Public agent-directory entry — GET /agents, one row per registered
 *  agent server-wide. Used to answer "who else operates in this system,"
 *  not per-tenant fleet data. */
export interface PublicAgent {
  symbol: string;
  headquarters: string;
  credits: number;
  startingFaction: string;
  shipCount: number;
}

const ACTIVITY_LOG_LIMIT = 50;
/** How long a fully-drained gate queue waits before re-checking every still-
 *  unresolved gate — a gate uncharted today is a matter of *when* someone
 *  else charts it, not whether, so this is a slow re-sweep, not a one-shot. */
const GATE_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** How often to re-crawl the full agent directory. Unlike factions/systems
 *  (static for the life of a server reset), credits and ship counts move —
 *  confirmed live, this is exactly the data a live "who's competing with me
 *  here" panel needs to stay useful, so it can't be a one-shot the way the
 *  other two passes are. An hour is a compromise: agents aren't so many
 *  server-wide (low hundreds on a fresh reset) that a full re-crawl is
 *  expensive, but frequent enough that stats don't go stale for a whole
 *  operating session. */
const AGENTS_REFRESH_INTERVAL_MS = 60 * 60_000;

export class GalaxyCrawler {
  private readonly store: Store;
  private readonly log: (msg: string) => void;
  private factionsDone = false;
  private systemsDone = false;
  private totalSystems: number | undefined;
  private readonly activity: GalaxyCrawlActivity[] = [];

  /** In-memory only, rebuilt from the DB on demand — cheap to redo (one
   *  SELECT), unlike the systems crawl's own resumable page cursor, so a
   *  restart mid-sweep just rebuilds rather than needing persisted state. */
  private gateQueue: { systemSymbol: string; gateSymbol: string }[] = [];
  private gateQueueBuilt = false;
  private lastGateSweepAt = 0;
  private gatesResolvedThisSweep = 0;

  /** Completed agent directory, keyed by system symbol (derived from each
   *  agent's headquarters waypoint). Swapped in atomically once a full pass
   *  finishes — see crawlAgents() — so a reader never sees a half-built
   *  crawl. */
  private agentsBySystem = new Map<string, PublicAgent[]>();
  private agentsCrawlDone = false;
  private lastAgentsCrawlAt = 0;

  /** Last ~50 crawl events, newest first — for a public activity-log panel.
   *  In-memory only; a restart just starts a fresh log, same as it starts
   *  fresh console output today. */
  recentActivity(): GalaxyCrawlActivity[] {
    return [...this.activity].reverse();
  }

  /** Best-known progress toward a full galaxy crawl. `total` is undefined
   *  until the first systems page ever comes back (it rides along on the
   *  API's own pagination `meta.total`, so it needs at least one live
   *  call). */
  async progress(): Promise<{
    factionsDone: boolean; systemsDone: boolean; scanned: number; total: number | undefined;
    gateQueueRemaining: number; gatesResolvedThisSweep: number;
  }> {
    const scanned = await this.store.countGalaxySystems();
    return {
      factionsDone: this.factionsDone, systemsDone: this.systemsDone, scanned, total: this.totalSystems,
      gateQueueRemaining: this.gateQueue.length, gatesResolvedThisSweep: this.gatesResolvedThisSweep,
    };
  }

  /** Agents headquartered in the given system, freshest known snapshot.
   *  Empty until the first agents pass completes (see AGENTS_REFRESH_INTERVAL_MS). */
  agentsInSystem(systemSymbol: string): PublicAgent[] {
    return this.agentsBySystem.get(systemSymbol.toUpperCase()) ?? [];
  }

  private recordActivity(message: string): void {
    this.activity.push({ at: Date.now(), message });
    if (this.activity.length > ACTIVITY_LOG_LIMIT) this.activity.shift();
  }

  constructor(store: Store, log: (msg: string) => void = () => {}) {
    this.store = store;
    this.log = log;
  }

  /**
   * Starts the crawl over from nothing — call this right after the shared
   * `galaxy_systems`/`galaxy_factions`/`galaxy_crawl_state` tables have
   * been truncated (see `Store.truncateSharedGalaxyTables()`, driven by
   * `admin.ts`'s POST /reset-cleanup), so this process notices immediately
   * rather than believing `systemsDone`/`factionsDone` are still true
   * against a table that's now empty. Without this, the crawl would only
   * actually resume on the next full process restart.
   */
  resetCrawlState(): void {
    this.factionsDone = false;
    this.systemsDone = false;
    this.totalSystems = undefined;
    this.gateQueue = [];
    this.gateQueueBuilt = false;
    this.lastGateSweepAt = 0;
    this.gatesResolvedThisSweep = 0;
    this.agentsBySystem = new Map();
    this.agentsCrawlDone = false;
    this.lastAgentsCrawlAt = 0;
    this.activity.length = 0;
    this.recordActivity("Reset detected — galaxy crawl restarting from the beginning");
  }

  /** One unit of crawl work per call — cheap to call on a slow interval
   *  (see cli/index.ts). Factions, then systems, then an ongoing (never
   *  "done") opportunistic sweep of known jump gates for newly-charted
   *  connections. */
  async tick(): Promise<void> {
    if (!this.factionsDone) {
      await this.crawlFactions();
      return;
    }
    if (!this.systemsDone) {
      await this.crawlSystemsPage();
      return;
    }
    if (!this.agentsCrawlDone || Date.now() - this.lastAgentsCrawlAt >= AGENTS_REFRESH_INTERVAL_MS) {
      await this.crawlAgents();
      return;
    }
    await this.crawlOneGate();
  }

  /** Thin wrapper around a plain, tokenless fetch against a public
   *  endpoint — no `SpaceTradersAPI`/`Client` involved, since none of
   *  these need auth (confirmed live). */
  private async fetchPublic<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url);
    const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { message?: string } };
    if (!res.ok) throw new Error(json?.error?.message ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  /** Full faction roster, one shot — small (a couple dozen entries), so no
   *  resumable cursor needed the way the systems crawl has one. */
  private async crawlFactions(): Promise<void> {
    try {
      const out: CrawlFaction[] = [];
      let page = 1;
      for (;;) {
        const res = await this.fetchPublic<{ data: CrawlFaction[] }>("/factions", { limit: 20, page });
        out.push(...res.data.map((f) => ({ symbol: f.symbol, name: f.name, headquarters: f.headquarters, isRecruiting: f.isRecruiting })));
        if (res.data.length < 20) break;
        page += 1;
      }
      await this.store.setGalaxyFactions(out);
      this.log(`galaxy crawl: recorded ${out.length} factions`);
      this.recordActivity(`Recorded ${out.length} factions`);
    } catch (err) {
      this.log(`galaxy crawl: faction pass failed, will retry next tick: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.factionsDone = true;
  }

  /** Full agent directory, one shot — same scale as factions (low hundreds
   *  on a fresh reset), so no resumable cursor needed. Re-run periodically
   *  (see AGENTS_REFRESH_INTERVAL_MS) rather than only once, since unlike
   *  factions/systems, credits and ship counts genuinely change over time. */
  private async crawlAgents(): Promise<void> {
    let out: PublicAgent[];
    try {
      const acc: PublicAgent[] = [];
      let page = 1;
      for (;;) {
        const res = await this.fetchPublic<{ data: PublicAgent[] }>("/agents", { limit: 20, page });
        acc.push(...res.data);
        if (res.data.length < 20) break;
        page += 1;
      }
      out = acc;
    } catch (err) {
      this.log(`galaxy crawl: agent directory pass failed, will retry next tick: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const bySystem = new Map<string, PublicAgent[]>();
    for (const a of out) {
      const system = a.headquarters.split("-").slice(0, 2).join("-");
      (bySystem.get(system) ?? bySystem.set(system, []).get(system)!).push(a);
    }
    this.agentsBySystem = bySystem;
    this.agentsCrawlDone = true;
    this.lastAgentsCrawlAt = Date.now();
    this.log(`galaxy crawl: recorded ${out.length} agents across ${bySystem.size} systems`);
    this.recordActivity(`Recorded ${out.length} agents across ${bySystem.size} systems`);
  }

  /** One page of the galaxy-wide systems list, resuming from wherever the
   *  last call (this process or an earlier one) left off. */
  private async crawlSystemsPage(): Promise<void> {
    const state = (await this.store.getCrawlState<{ page: number }>("galaxy_systems_crawl")) ?? { page: 1 };
    try {
      const res = await this.fetchPublic<{ data: CrawlSystem[]; meta: { total: number } }>("/systems", { limit: 20, page: state.page });
      const batch = res.data;
      const total = res.meta.total;
      this.totalSystems = total;
      for (const sys of batch) {
        await this.store.setGalaxySystemMeta(sys.symbol, sys.sectorSymbol, sys.type, sys.x, sys.y);
        // Free data: this response already embeds every system's waypoints
        // (symbol/type/x/y/orbitals — no traits, those need charting) in
        // the same page fetch already paid for. Persisted separately from
        // any tenant's own scanned waypoints — see mergeSystemWaypoints()'s
        // own comment on why the two must never share a column.
        if (sys.waypoints?.length) await this.store.mergeSystemWaypoints(sys.symbol, sys.waypoints);
      }
      if (state.page % 25 === 1) {
        this.recordActivity(`Scanning page ${state.page} of ~${Math.ceil(total / 20)} (${(state.page - 1) * 20} of ${total} systems so far)`);
      }
      if (batch.length < 20) {
        this.systemsDone = true;
        const finalCount = await this.store.countGalaxySystems();
        this.log(`galaxy crawl: systems pass complete at page ${state.page} (${finalCount} systems total)`);
        this.recordActivity(`Systems crawl complete: ${finalCount} systems mapped`);
        return;
      }
      await this.store.setCrawlState("galaxy_systems_crawl", { page: state.page + 1 });
    } catch (err) {
      this.log(`galaxy crawl: systems page ${state.page} failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One gate off the queue, opportunistically checked for connections a
   *  charted-by-someone-else state would now reveal. Most attempts fail
   *  (still uncharted by anyone) — that's expected, not logged as an
   *  error, since this is a lottery ticket bought for free on every tick,
   *  not a call we ever expected to always succeed. */
  private async crawlOneGate(): Promise<void> {
    if (!this.gateQueueBuilt || (this.gateQueue.length === 0 && Date.now() - this.lastGateSweepAt > GATE_SWEEP_INTERVAL_MS)) {
      await this.buildGateQueue();
    }
    const next = this.gateQueue.shift();
    if (!next) return; // queue drained; waiting for the next sweep window
    try {
      const res = await this.fetchPublic<{ data: { symbol: string; connections: string[] } }>(
        `/systems/${next.systemSymbol}/waypoints/${next.gateSymbol}/jump-gate`,
      );
      await this.store.mergeGateConnections(next.systemSymbol, next.gateSymbol, res.data.connections);
      this.gatesResolvedThisSweep += 1;
      this.log(`gate crawl: ${next.gateSymbol} charted by someone else — ${res.data.connections.length} connection(s)`);
      this.recordActivity(`${next.gateSymbol} → ${res.data.connections.join(", ")} (charted elsewhere)`);
    } catch {
      // Expected: still uncharted by anyone. Not worth a log line per miss —
      // this runs once per tick, forever, across thousands of gates.
    }
  }

  /** Every known jump gate (from the systems crawl's own waypoint data)
   *  that doesn't already have resolved connections, shuffled so a restart
   *  mid-sweep doesn't always re-check the same alphabetical prefix first. */
  private async buildGateQueue(): Promise<void> {
    const rows = await this.store.listSystemsForGateCrawl();
    const queue: { systemSymbol: string; gateSymbol: string }[] = [];
    for (const r of rows) {
      const resolved = new Set((r.jumpGates as { symbol: string }[]).map((g) => g.symbol));
      for (const wp of r.crawledWaypoints as { symbol: string; type: string }[]) {
        if (wp.type === "JUMP_GATE" && !resolved.has(wp.symbol)) queue.push({ systemSymbol: r.systemSymbol, gateSymbol: wp.symbol });
      }
    }
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = queue[i]!;
      queue[i] = queue[j]!;
      queue[j] = tmp;
    }
    this.gateQueue = queue;
    this.gateQueueBuilt = true;
    this.lastGateSweepAt = Date.now();
    this.gatesResolvedThisSweep = 0;
    this.log(`gate crawl: new sweep, ${queue.length} unresolved gates to check`);
    this.recordActivity(`Gate-connection sweep started: checking ${queue.length} known jump gates`);
  }
}
