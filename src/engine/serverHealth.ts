/**
 * Server health board (admin page, Phase 1): turns numbers the process already has into a few big tiles with a
 * status word each, so a frozen engine is seen at a glance. Built after 2026-11-17, when the engine stalled at about
 * 31 h uptime (traders idle in orbit, the dispatcher assigning but nothing executing, about 3 API calls a minute) and
 * it cost an hour of trading before anyone noticed.
 *
 * Pure: no I/O and no clock. The caller (src/ops/serverHealthSources.ts) gathers the inputs and passes `now`.
 * Thresholds are a policy object; DEFAULT_HEALTH_POLICY holds the values in use.
 */

export type HealthLevel = "ok" | "warn" | "bad";

export interface HealthPolicy {
  /** Trades older than this are not looked at (the gap is then "longer than the window"). */
  windowMs: number;
  /** Normal gap when the window holds too few trades to measure one. */
  defaultNormalGapMs: number;
  /** The measured normal gap is never taken as smaller than this (a burst of sells must not make 2 minutes look odd). */
  minNormalGapMs: number;
  /** STALLED when the gap is over max(stallMinMs, stallFactor x normal gap). */
  stallMinMs: number;
  stallFactor: number;
  /** WARN ("slow") when the gap is over max(warnMinMs, warnFactor x normal gap). */
  warnMinMs: number;
  warnFactor: number;
  /** After a restart the heartbeat waits this long before it may say STALLED (the first trade takes a minute or two). */
  restartGraceMs: number;
  /** A trader idle (in orbit or docked with nothing to do) longer than this counts as idle on the board. */
  traderIdleMs: number;
  /** A coordinator loop that has not finished a pass for this long: warn / hung. */
  loopWarnMs: number;
  loopBadMs: number;
  /** The ship-task runner has run nothing for this long (and the fleet is not paused): warn. */
  schedulerIdleWarnMs: number;
  /** API: share of the limiter's cap that reads as "at the cap". */
  apiBusyShare: number;
  /** API: fewer calls a minute than this, with traders on the books, reads as "nearly silent" (the 2026-11-17 stall ran at ~3). */
  apiQuietPerMin: number;
  /** API: 429s in the last 60 s: warn / bad. */
  api429Warn: number;
  api429Bad: number;
  /** API: the oldest waiting request has waited this long: warn / bad. */
  apiWaitWarnMs: number;
  apiWaitBadMs: number;
  /** Uptime at which a planned restart is advised (both known stalls came at ~30-31 h). */
  uptimeWarnMs: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  windowMs: 3 * 3_600_000,
  defaultNormalGapMs: 2 * 60_000,
  minNormalGapMs: 60_000,
  stallMinMs: 10 * 60_000,
  stallFactor: 5,
  warnMinMs: 5 * 60_000,
  warnFactor: 3,
  restartGraceMs: 10 * 60_000,
  traderIdleMs: 10 * 60_000,
  loopWarnMs: 60_000,
  loopBadMs: 180_000,
  schedulerIdleWarnMs: 5 * 60_000,
  apiBusyShare: 0.95,
  apiQuietPerMin: 10,
  api429Warn: 3,
  api429Bad: 10,
  apiWaitWarnMs: 30_000,
  apiWaitBadMs: 120_000,
  uptimeWarnMs: 28 * 3_600_000,
};

/** One coordinator loop's last pass (FleetManager.passTimings()). */
export interface LoopTiming {
  name: string;
  lastStartedAt: number | null;
  lastEndedAt: number | null;
  lastMs: number | null;
  maxMs: number | null;
}

export interface TenantHealthInput {
  agent: string;
  /** False when the tenant exists but no engine is booted for it in this process. */
  booted: boolean;
  deadToken?: string | null;
  paused?: boolean;
  /** Epoch ms of PURCHASE and SELL ledger rows in the window, any order. */
  tradeTimes?: number[];
  /** Ships with role trader, and when each went idle (FleetManager.fleetStatusSummary().idleSince). */
  traders?: { symbol: string; idleSince?: number }[];
  stuck?: { crit: number; warn: number } | null;
  wallet?: number | null;
  /** Matched trading profit (sum of realized_pnl on SELL rows) over the last hour. */
  profitLastHour?: number | null;
  loops?: LoopTiming[];
  scheduler?: { queue: number; idleSeconds: number } | null;
}

export interface ApiInput {
  callsPerMin: number;
  cap: number;
  queueDepth: number;
  oldestWaitMs: number;
  avgWaitMs: number;
  maxWaitMs: number;
  hits429Last60s: number;
  windowMin: number;
}

export interface ProcessInput {
  uptimeMs: number;
  instanceId: string;
  instances: { instanceId: string; startedAt: string; lastSeen: string; aliveNow: boolean }[];
  /** Null when the limiter has not reported yet. */
  api: ApiInput | null;
}

export interface Tile {
  key: string;
  label: string;
  /** The big text: a number with its unit, or a word. */
  value: string;
  /** The status word, always present so the tile never relies on colour alone. */
  word: string;
  level: HealthLevel;
  /** One line saying where the number comes from and why it has this level. */
  detail: string;
}

export interface TenantHealth {
  agent: string;
  level: HealthLevel;
  word: string;
  tiles: Tile[];
  heartbeat: { gapMs: number | null; normalGapMs: number; trades: number; stalled: boolean };
}

export interface HealthReport {
  asOf: string;
  level: HealthLevel;
  /** OK, WARN, PROBLEM or STALLED. */
  word: string;
  reasons: string[];
  process: Tile[];
  tenants: TenantHealth[];
  policy: HealthPolicy;
}

const RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, bad: 2 };
const worst = (levels: HealthLevel[]): HealthLevel => levels.reduce<HealthLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

/** "0.2 s", "45 s", "12 min", "3 h 05 min". */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 950) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtSigned = (n: number) => `${Math.round(n) > 0 ? "+" : Math.round(n) < 0 ? "-" : ""}${fmtInt(Math.abs(n))}`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The heartbeat: how long since the last trade, against the normal gap between trades in the window. Trades in the same
 * second (a multi-lot sell) are one event, so the normal gap measures how often the fleet acts, not how many lots it sells.
 */
export function heartbeat(tradeTimes: number[], now: number, p: HealthPolicy = DEFAULT_HEALTH_POLICY): { lastAt: number | null; gapMs: number | null; normalGapMs: number; trades: number; measured: boolean } {
  const since = now - p.windowMs;
  const ts = [...new Set(tradeTimes.filter((t) => t >= since && t <= now).map((t) => Math.floor(t / 1000) * 1000))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
  const measured = gaps.length >= 3;
  const normalGapMs = measured ? Math.max(p.minNormalGapMs, median(gaps)) : p.defaultNormalGapMs;
  const lastAt = ts.length ? ts[ts.length - 1]! : null;
  return { lastAt, gapMs: lastAt === null ? null : now - lastAt, normalGapMs, trades: tradeTimes.filter((t) => t >= since && t <= now).length, measured };
}

function heartbeatTile(t: TenantHealthInput, now: number, uptimeMs: number, p: HealthPolicy): { tile: Tile; stalled: boolean; hb: ReturnType<typeof heartbeat> } {
  const hb = heartbeat(t.tradeTimes ?? [], now, p);
  const traders = (t.traders ?? []).length;
  const stallAt = Math.max(p.stallMinMs, p.stallFactor * hb.normalGapMs);
  const warnAt = Math.max(p.warnMinMs, p.warnFactor * hb.normalGapMs);
  // No trade in the window counts as a gap at least the window long.
  const gap = hb.gapMs ?? p.windowMs;
  const gapText = hb.gapMs === null ? `over ${formatDuration(p.windowMs)}` : formatDuration(gap);
  const normal = `normal gap ${formatDuration(hb.normalGapMs)}${hb.measured ? " (median, last 3 h)" : " (assumed: too few trades to measure)"}`;
  const base = { key: "heartbeat", label: "Heartbeat: time since last trade", value: gapText };
  if (t.paused) return { hb, stalled: false, tile: { ...base, word: "PAUSED", level: "warn", detail: `The fleet is paused by the operator, so no trades are expected. ${normal}.` } };
  if (traders === 0) return { hb, stalled: false, tile: { ...base, word: "NO TRADERS", level: "ok", detail: `No ship has the trader role, so the gap is not judged. ${normal}.` } };
  if (gap > stallAt) {
    if (uptimeMs < p.restartGraceMs) return { hb, stalled: false, tile: { ...base, word: "STARTING", level: "warn", detail: `Server restarted ${formatDuration(uptimeMs)} ago; waiting for the first trade. Stalled after ${formatDuration(stallAt)}.` } };
    return { hb, stalled: true, tile: { ...base, word: "STALLED", level: "bad", detail: `No buy or sell for ${gapText}, over the stall line of ${formatDuration(stallAt)}; ${normal}.` } };
  }
  if (gap > warnAt) return { hb, stalled: false, tile: { ...base, word: "SLOW", level: "warn", detail: `Longer than usual (warn at ${formatDuration(warnAt)}, stalled at ${formatDuration(stallAt)}); ${normal}.` } };
  return { hb, stalled: false, tile: { ...base, word: "NOT STALLED", level: "ok", detail: `${normal}; stalled at ${formatDuration(stallAt)}.` } };
}

function loopsTile(loops: LoopTiming[], now: number, p: HealthPolicy): { tile: Tile; hung: boolean } {
  if (!loops.length) return { hung: false, tile: { key: "loops", label: "Engine loops", value: "—", word: "NO DATA", level: "warn", detail: "No coordinator loop has finished a pass since this server started." } };
  // Age = time since the last pass ended; a pass still running counts from when the one before it ended.
  const rows = loops.map((l) => ({ ...l, age: l.lastEndedAt === null ? (l.lastStartedAt === null ? Infinity : now - l.lastStartedAt) : now - l.lastEndedAt }));
  const oldest = rows.reduce((a, b) => (b.age > a.age ? b : a));
  const slowest = rows.reduce((a, b) => ((b.maxMs ?? 0) > (a.maxMs ?? 0) ? b : a));
  const level: HealthLevel = oldest.age >= p.loopBadMs ? "bad" : oldest.age >= p.loopWarnMs ? "warn" : "ok";
  const word = level === "bad" ? "HUNG" : level === "warn" ? "SLOW" : "RUNNING";
  const per = rows.map((r) => `${r.name} ${r.lastMs === null ? "—" : formatDuration(r.lastMs)}${r.maxMs ? ` (max ${formatDuration(r.maxMs)})` : ""}`).join(", ");
  const value = slowest.maxMs ? formatDuration(slowest.maxMs) : "—";
  return {
    hung: level === "bad",
    tile: {
      key: "loops", label: "Longest engine pass, last 5 min", value, word, level,
      detail: level === "ok" ? `Last pass: ${per}.` : `The ${oldest.name} loop has not finished a pass for ${formatDuration(oldest.age === Infinity ? 0 : oldest.age)}. Last pass: ${per}.`,
    },
  };
}

/** Assess one tenant. `uptimeMs` is the process's, for the restart grace. */
export function assessTenant(t: TenantHealthInput, now: number, uptimeMs: number, p: HealthPolicy = DEFAULT_HEALTH_POLICY): TenantHealth {
  if (!t.booted) {
    return { agent: t.agent, level: "ok", word: "NOT BOOTED", heartbeat: { gapMs: null, normalGapMs: p.defaultNormalGapMs, trades: 0, stalled: false },
      tiles: [{ key: "engine", label: "Engine", value: "Off", word: "NOT BOOTED", level: "ok", detail: "No engine is running for this tenant in this process." }] };
  }
  const tiles: Tile[] = [];
  if (t.deadToken) tiles.push({ key: "token", label: "Agent token", value: "Dead", word: "RESET", level: "bad", detail: t.deadToken });

  const { tile: hbTile, stalled, hb } = heartbeatTile(t, now, uptimeMs, p);
  tiles.push(hbTile);

  const traders = t.traders ?? [];
  const idle = traders.filter((s) => s.idleSince !== undefined && now - s.idleSince >= p.traderIdleMs).length;
  const idleLevel: HealthLevel = traders.length > 0 && idle === traders.length && !t.paused ? "bad" : idle > 0 ? "warn" : "ok";
  tiles.push({ key: "traders", label: `Traders idle over ${formatDuration(p.traderIdleMs)}`, value: `${idle} of ${traders.length}`,
    word: idleLevel === "bad" ? "ALL IDLE" : idle > 0 ? "SOME IDLE" : "WORKING", level: idleLevel,
    detail: "Traders in orbit or docked with nothing to do (the fleet's own idle tracker)." });

  if (t.stuck) {
    const lvl: HealthLevel = t.stuck.crit > 0 ? "bad" : t.stuck.warn > 0 ? "warn" : "ok";
    tiles.push({ key: "stuck", label: "Stuck ships", value: String(t.stuck.crit + t.stuck.warn), word: lvl === "ok" ? "NONE" : lvl === "bad" ? "CRITICAL" : "CHECK", level: lvl,
      detail: `${t.stuck.crit} critical, ${t.stuck.warn} warning (ops stuck: stranded, out of fuel, overdue arrival, suspended).` });
  }

  const { tile: lt, hung } = loopsTile(t.loops ?? [], now, p);
  tiles.push(lt);

  if (t.scheduler) {
    const idleMs = t.scheduler.idleSeconds * 1000;
    const lvl: HealthLevel = !t.paused && idleMs >= p.schedulerIdleWarnMs ? "warn" : "ok";
    tiles.push({ key: "scheduler", label: "Ship tasks: last one ran", value: `${formatDuration(idleMs)} ago`, word: t.paused ? "PAUSED" : lvl === "warn" ? "QUIET" : "RUNNING", level: t.paused ? "warn" : lvl,
      detail: `${fmtInt(t.scheduler.queue)} tasks queued. Quiet can be normal when every ship is in a long transit.` });
  }

  if (t.profitLastHour !== undefined && t.profitLastHour !== null) {
    tiles.push({ key: "profit", label: "Matched profit, last hour", value: `${fmtSigned(t.profitLastHour)} c`, word: t.profitLastHour > 0 ? "EARNING" : "FLAT", level: "ok",
      detail: "Sum of realized profit on sells in the last 60 minutes (completed round trips only)." });
  }
  if (t.wallet !== undefined && t.wallet !== null) {
    tiles.push({ key: "wallet", label: "Wallet", value: `${fmtInt(t.wallet)} c`, word: "CREDITS", level: "ok", detail: "The agent's credits as last polled." });
  }

  const level = worst(tiles.map((x) => x.level));
  const word = stalled || hung ? "STALLED" : t.deadToken ? "DEAD TOKEN" : t.paused ? "PAUSED" : level === "bad" ? "PROBLEM" : level === "warn" ? "WARN" : "OK";
  return { agent: t.agent, level: stalled || hung ? "bad" : level, word, tiles, heartbeat: { gapMs: hb.gapMs, normalGapMs: hb.normalGapMs, trades: hb.trades, stalled: stalled || hung } };
}

/** Process-wide tiles: uptime and restarts, and the shared API limiter. `anyTraders` lets a near-silent API count as a warning. */
export function assessProcess(pr: ProcessInput, anyTraders: boolean, p: HealthPolicy = DEFAULT_HEALTH_POLICY): Tile[] {
  const tiles: Tile[] = [];
  const alive = pr.instances.filter((i) => i.aliveNow).length;
  const restarts = Math.max(0, pr.instances.length - 1);
  const upLevel: HealthLevel = alive > 1 || pr.uptimeMs >= p.uptimeWarnMs ? "warn" : "ok";
  tiles.push({ key: "uptime", label: "Server uptime", value: formatDuration(pr.uptimeMs),
    word: alive > 1 ? "OVERLAP" : pr.uptimeMs >= p.uptimeWarnMs ? "RESTART SOON" : "UP", level: upLevel,
    detail: `${alive} instance${alive === 1 ? "" : "s"} alive now${alive > 1 ? " (deploy overlap: two share one rate limit)" : ""}; ${restarts} restart${restarts === 1 ? "" : "s"} in the last 6 h.` +
      (pr.uptimeMs >= p.uptimeWarnMs ? ` Both known stalls came at ~30-31 h; plan a restart in a quiet hour.` : "") });

  const a = pr.api;
  if (!a) {
    tiles.push({ key: "api", label: "API calls a minute", value: "—", word: "NO DATA", level: "warn", detail: "The shared rate limiter has not reported yet." });
    return tiles;
  }
  const share = a.cap > 0 ? a.callsPerMin / a.cap : 0;
  const quiet = anyTraders && a.callsPerMin < p.apiQuietPerMin;
  const capLevel: HealthLevel = quiet ? "warn" : "ok";
  tiles.push({ key: "api", label: `API calls a minute (last ${a.windowMin} min)`, value: `${fmtInt(a.callsPerMin)} / ${fmtInt(a.cap)}`,
    word: quiet ? "NEARLY SILENT" : share >= p.apiBusyShare ? "AT CAP" : "OK", level: capLevel,
    detail: `${Math.round(share * 100)}% of the limiter's cap. ${quiet ? "Very little traffic with traders on the books: the 2026-11-17 stall ran at ~3 a minute." : share >= p.apiBusyShare ? "At the cap is normal on a busy fleet; watch the wait and 429s." : ""}`.trim() });

  const rlShare = a.callsPerMin > 0 ? a.hits429Last60s / a.callsPerMin : 0;
  const rlLevel: HealthLevel = a.hits429Last60s >= p.api429Bad ? "bad" : a.hits429Last60s >= p.api429Warn ? "warn" : "ok";
  tiles.push({ key: "ratelimit", label: "Rate limited (429s, last 60 s)", value: String(a.hits429Last60s),
    word: rlLevel === "bad" ? "LIMITED" : rlLevel === "warn" ? "SOME" : "NONE", level: rlLevel,
    detail: `About ${(rlShare * 100).toFixed(1)}% of a minute's calls. Warn at ${p.api429Warn}, bad at ${p.api429Bad}.` });

  const waitLevel: HealthLevel = a.oldestWaitMs >= p.apiWaitBadMs ? "bad" : a.oldestWaitMs >= p.apiWaitWarnMs ? "warn" : "ok";
  tiles.push({ key: "queue", label: "API queue: oldest waiting", value: formatDuration(a.oldestWaitMs),
    word: waitLevel === "bad" ? "BLOCKED" : waitLevel === "warn" ? "BACKED UP" : "FLOWING", level: waitLevel,
    detail: `${fmtInt(a.queueDepth)} request${a.queueDepth === 1 ? "" : "s"} waiting; average wait ${formatDuration(a.avgWaitMs)}, worst ${formatDuration(a.maxWaitMs)} in the last ${a.windowMin} min.` });
  return tiles;
}

/** The whole board. */
export function assessServerHealth(pr: ProcessInput, tenants: TenantHealthInput[], now: number, p: HealthPolicy = DEFAULT_HEALTH_POLICY): HealthReport {
  const anyTraders = tenants.some((t) => t.booted && !t.paused && (t.traders ?? []).length > 0);
  const processTiles = assessProcess(pr, anyTraders, p);
  const th = tenants.map((t) => assessTenant(t, now, pr.uptimeMs, p));
  const stalled = th.filter((t) => t.heartbeat.stalled);
  const level = worst([...processTiles.map((x) => x.level), ...th.map((t) => t.level)]);
  const reasons = [
    ...stalled.map((t) => `${t.agent}: ${t.tiles.find((x) => x.word === "STALLED" || x.word === "HUNG")?.detail ?? "stalled"}`),
    ...th.flatMap((t) => t.tiles.filter((x) => x.level === "bad" && x.word !== "STALLED" && x.word !== "HUNG").map((x) => `${t.agent}: ${x.label}: ${x.word}`)),
    ...processTiles.filter((x) => x.level !== "ok").map((x) => `${x.label}: ${x.word}`),
  ];
  const word = stalled.length ? "STALLED" : level === "bad" ? "PROBLEM" : level === "warn" ? "WARN" : "OK";
  return { asOf: new Date(now).toISOString(), level: stalled.length ? "bad" : level, word, reasons, process: processTiles, tenants: th, policy: p };
}
