/**
 * The Queue tab's numbers, shaped from the ops endpoints (pure: no DOM, no fetch, no clock).
 *
 *   system_queue  GET /api/ops/system_queue   the fresh-system queue, the live systems' premium and what the release rule says
 *   keepers       GET /api/ops/keepers        coverage per market, with parked keepers as staged or parked
 *   keeper_review GET /api/ops/keeper_review  the keepers' polling load
 *   pnl           GET /api/ops/pnl?sinceHours=N  matched trading profit for 1, 2 and 3 hours
 *   stuck         GET /api/ops/stuck          ships that look wrong
 *
 * It mirrors the hourly update the operator asked for, so the same figures are on screen without asking.
 */

/** A time as milliseconds: the queue sends ISO strings, some callers numbers. */
const ms = (t) => (typeof t === "number" ? t : t ? Date.parse(t) : NaN);

const sysOf = (market) => String(market).slice(0, String(market).lastIndexOf("-"));

/** "3h 12m", "45m", "just now" for a time `ms` ago. */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return hrs < 48 ? `${hrs}h ${min % 60}m` : `${Math.floor(hrs / 24)}d`;
}

/** Matched profit per hour for a window, and its change against the other two windows' per-hour rate. */
export function tradingRows(pnl) {
  const rows = [1, 2, 3].map((h) => {
    const p = pnl?.[h];
    const m = p?.matchedTradingNet;
    return { hours: h, profit: m ?? null, perHour: m === undefined || m === null ? null : m / h, sales: p?.matchedSales ?? null };
  });
  // The last hour against the average of the 3-hour window: a fall of more than a quarter is flagged.
  const last = rows[0]?.perHour, three = rows[2]?.perHour;
  const flag = last !== null && last !== undefined && three ? (last - three) / three <= -0.25 : false;
  return { rows, flag, drop: flag ? Math.round(((three - last) / three) * 100) : 0 };
}

export function buildQueueView({ queue, keepers, review, pnl, stuck, approvals, nowMs }) {
  const q = queue?.queue ?? [];
  const by = (state) => q.filter((s) => s.state === state);
  const rows = keepers?.markets ?? [];
  const inSystem = (system) => rows.filter((m) => sysOf(m.market) === system);
  const liveFacts = new Map((queue?.lastCheck?.live ?? []).map((l) => [l.system, l]));

  const live = by("live")
    .map((s) => {
      const f = liveFacts.get(s.system);
      const at = ms(s.releasedAt);
      return { system: s.system, releasedAt: Number.isFinite(at) ? at : null, age: Number.isFinite(at) ? ageText(nowMs - at) : "—", ratio: f?.ratio ?? null, sells: f?.sells ?? 0, held: !!s.held };
    })
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0));

  const staged = by("staged").map((s) => {
    const mine = inSystem(s.system);
    const inPlace = mine.filter((m) => m.status === "staged" || m.status === "covered").length;
    return { system: s.system, inPlace, of: s.markets?.length ?? 0, held: !!s.held, since: Number.isFinite(ms(s.stagedAt)) ? ageText(nowMs - ms(s.stagedAt)) : "—" };
  });

  const scouted = by("scouted").map((s) => ({ system: s.system, markets: s.markets?.length ?? 0, age: Number.isFinite(ms(s.addedAt)) ? ageText(nowMs - ms(s.addedAt)) : "—", held: !!s.held }));

  const counts = keepers?.counts ?? {};
  const budget = review?.budget ?? {};
  const keeperRows = [
    { label: "Covered", value: counts.covered ?? 0 },
    { label: "En route", value: counts.enroute ?? 0 },
    { label: "Staged (waiting for release)", value: counts.staged ?? 0 },
    { label: "Parked (low value)", value: counts.parked ?? 0 },
    { label: "Uncovered (listed)", value: counts.pending ?? 0 },
    { label: "Duplicates", value: (keepers?.duplicates ?? []).length },
  ];

  const sc = stuck?.counts ?? {};
  const attention = [];
  if ((approvals ?? 0) > 0) attention.push({ item: "Approvals", detail: `${approvals} waiting` });
  if ((sc.crit ?? 0) > 0) attention.push({ item: "Stuck ships", detail: `${sc.crit} critical` });
  if ((sc.warn ?? 0) > 0) attention.push({ item: "Warnings", detail: `${sc.warn} ship warning(s)` });
  for (const f of (stuck?.findings ?? []).filter((x) => x.severity === "crit").slice(0, 5)) attention.push({ item: f.ship, detail: `${f.kind}: ${f.detail}` });
  const trade = tradingRows(pnl);
  if (trade.flag) attention.push({ item: "Profit", detail: `last hour is ${trade.drop}% under the 3-hour rate` });

  return {
    mode: queue?.mode ?? "off",
    rule: (queue?.lastCheck?.decision?.notes ?? [])[0] ?? null,
    counts: { live: live.length, staged: staged.length, scouted: scouted.length },
    live, staged, scouted,
    keepers: { rows: keeperRows, polling: budget.callsPerMinNow ?? null, pollingMax: budget.apiBudgetPerMin ?? 90, stationed: budget.keepers ?? null, limit: budget.max ?? null },
    trade, attention,
  };
}
