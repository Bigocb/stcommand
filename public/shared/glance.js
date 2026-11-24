/**
 * Glance: the Overview page for a wall screen. Big readable blocks, almost no tables, nothing that needs a hover.
 *
 *   const g = mountGlance(rootEl, { api, getAlerts });
 *   g.show();   // loads now, then every minute
 *   g.hide();   // stops
 *
 * Reads (all existing, read-only):
 *   GET /api/metrics?hours=24        hourly net, cumulative matched profit this week, the next reset (week start = reset - 7 days)
 *   GET /api/ops/economy_health      wallet, holds, floor, traders, big hulls, last hour, findings
 *   GET /api/ops/pnl?sinceHours=24   per-ship matched profit
 *   GET /api/ops/system_queue        scouted / staged / live counts, last release
 * `getAlerts()` gives { approvals, stranded, manualHold } from the Deck store, so the alerts row needs no extra call.
 * Design notes: docs/deck-desktop-design.md, "Glance" (operator 2026-11-24: "I am going to have the overview up on a screen to glance at").
 */
import { escapeHtml } from "/shared/domain.js";
import { hourlyRows } from "/shared/hourly.js";

const WEEK_GOAL = 800_000_000; // operator, 2026-11-23
const WEEK_HOURS = 168;
const REFRESH_MS = 60_000;
const h = (s) => escapeHtml(String(s ?? ""));

const fmtM = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}${Math.round(a / 1e3)}k`;
  return `${sign}${Math.round(a)}`;
};

/** The pace verdict: green at or over the needed rate, amber from 70% of it, red under. Pure, so it can be tested. */
export function paceVerdict({ matched, goal = WEEK_GOAL, hourOfWeek, rate }) {
  const hoursLeft = Math.max(1, WEEK_HOURS - hourOfWeek);
  const needed = Math.max(0, (goal - (matched ?? 0)) / hoursLeft);
  if (rate === null || rate === undefined) return { level: "unknown", needed, hoursLeft };
  const level = rate >= needed ? "good" : rate >= needed * 0.7 ? "warn" : "bad";
  return { level, needed, hoursLeft };
}

function barsSvg(rows, needed) {
  const bars = rows.slice(0, 24).reverse(); // oldest to newest
  if (!bars.length) return '<div class="gl-empty">No hours yet</div>';
  const W = 1600, H = 230, pad = { l: 8, r: 8, t: 14, b: 26 };
  const max = Math.max(needed * 1.15, ...bars.map((b) => b.net), 1);
  const bw = (W - pad.l - pad.r) / bars.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / max);
  const out = bars.map((b, i) => {
    const x = pad.l + i * bw + 2;
    const top = y(b.net);
    const cls = b.partial ? "part" : b.net >= needed ? "ok" : b.net >= needed * 0.7 ? "lo" : "bad";
    const hr = new Date(b.start).getUTCHours();
    return `<rect class="gl-bar ${cls}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${(H - pad.b - top).toFixed(1)}" rx="3"/>`
      + (i % 3 === 0 ? `<text class="gl-ax" x="${(x + (bw - 4) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${String(hr).padStart(2, "0")}</text>` : "");
  }).join("");
  const yn = y(needed);
  return `<svg class="gl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Net profit per hour, last 24 hours, against the pace needed">
    ${out}<line class="gl-pace" x1="${pad.l}" x2="${W - pad.r}" y1="${yn.toFixed(1)}" y2="${yn.toFixed(1)}"/>
    <text class="gl-ax pace" x="${W - pad.r}" y="${(yn - 5).toFixed(1)}" text-anchor="end">needed ${fmtM(needed)}/h</text></svg>`;
}

function queueCounts(q) {
  const list = Array.isArray(q?.queue) ? q.queue : [];
  const c = { scouted: 0, staged: 0, live: 0 };
  for (const s of list) if (s.state in c) c[s.state]++;
  const fading = list.filter((s) => s.state === "live" && /fading/.test(s.note ?? "")).length;
  return { ...c, lastRelease: q?.lastRelease ?? null, fading };
}

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 90 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
}

export function glanceHtml({ metrics, econ, pnl, queue, alerts }) {
  const now = Date.now();
  const resetAt = Date.parse(metrics?.resetAt ?? "");
  const weekStart = Number.isFinite(resetAt) ? resetAt - WEEK_HOURS * 3_600_000 : null;
  const hourOfWeek = weekStart ? Math.max(0, (now - weekStart) / 3_600_000) : 0;
  const rows = metrics?.buckets ? hourlyRows(metrics.buckets, metrics.bucketMinutes, now) : [];
  const done = rows.filter((r) => !r.partial).slice(0, 3);
  const rate = done.length ? done.reduce((s, r) => s + r.net, 0) / done.length : null;
  const matched = metrics?.matchedSinceReset ?? null;
  const v = paceVerdict({ matched, hourOfWeek, rate });
  const sum = econ?.summary ?? {};
  const wallet = sum.wallet ?? metrics?.credits ?? null;
  const holds = sum.holds ?? null;
  const worth = wallet !== null && holds !== null ? wallet + holds : null;
  const last = sum.lastHour ?? null;
  const q = queueCounts(queue);
  const levelText = { good: "On pace", warn: "Behind pace", bad: "Well behind pace", unknown: "Reading…" }[v.level];

  const status = `<div class="gl-status ${v.level}">
    <div class="gl-hr">Hour ${Math.floor(hourOfWeek)}</div>
    <div class="gl-line"><b>${h(levelText)}</b> · ${fmtM(matched)} of ${fmtM(WEEK_GOAL)} · needs ${fmtM(v.needed)}/h · now ${fmtM(rate)}/h</div>
  </div>`;

  const tiles = [
    { k: "Wallet + holds", v: fmtM(worth), s: `wallet ${fmtM(wallet)} · holds ${fmtM(holds)}`, c: "amber" },
    { k: "Last hour (net)", v: fmtM(last?.net), s: `${last?.sales ?? "—"} sales · jumps ${fmtM(last?.jumpFees)}`, c: last && last.net >= v.needed ? "good" : "" },
    { k: "Hulls", v: `${sum.traders ?? "—"}`, s: `${sum.bigHulls ?? "—"} big · floor ${fmtM(sum.floor)}`, c: "" },
    { k: "Week to go", v: `${Math.max(0, WEEK_HOURS - Math.floor(hourOfWeek))} h`, s: `${fmtM(Math.max(0, WEEK_GOAL - (matched ?? 0)))} left`, c: "" },
  ].map((t) => `<div class="gl-tile ${t.c}"><div class="k">${h(t.k)}</div><div class="v">${h(t.v)}</div><div class="s">${h(t.s)}</div></div>`).join("");

  const ships = (pnl?.topShips ?? []).filter((s) => s.shipSymbol);
  const maxP = Math.max(1, ...ships.map((s) => Math.abs(s.pnl)));
  const hulls = ships.slice(0, 8).map((s) => `<div class="gl-hull ${s.pnl < 0 ? "neg" : ""}">
      <span class="n">${h(s.shipSymbol)}</span>
      <span class="b"><i style="width:${Math.round((Math.abs(s.pnl) / maxP) * 100)}%"></i></span>
      <span class="p">${fmtM(s.pnl)}</span><span class="m">${s.sells} sales</span></div>`).join("");
  const weakest = ships.length > 8 ? ships[ships.length - 1] : null;

  const pipeline = `<div class="gl-pipe">
      <div><b>${q.live}</b><span>live</span></div><div><b>${q.staged}</b><span>staged</span></div><div><b>${q.scouted}</b><span>scouted</span></div>
      <div><b>${q.fading}</b><span>fading</span></div><div class="wide"><b>${h(ago(q.lastRelease))}</b><span>last release</span></div></div>`;

  const flags = [];
  if (alerts?.approvals) flags.push({ t: `${alerts.approvals} approval${alerts.approvals === 1 ? "" : "s"} waiting`, c: "warn" });
  if (alerts?.stranded) flags.push({ t: `${alerts.stranded} stranded`, c: "bad" });
  if (alerts?.manualHold) flags.push({ t: `${alerts.manualHold} on manual hold`, c: "warn" });
  for (const f of econ?.findings ?? []) flags.push({ t: f.text ?? f.message ?? f.kind ?? "economy finding", c: f.level === "bad" ? "bad" : "warn" });
  if (last && last.net > 0 && last.jumpFees / (last.profit || last.net) > 0.25) flags.push({ t: "jump fees over 25% of profit", c: "warn" });
  const prev = rows.filter((r) => !r.partial)[1], cur = rows.filter((r) => !r.partial)[0];
  if (prev && cur && prev.net > 0 && cur.net < prev.net * 0.75) flags.push({ t: `profit down ${Math.round((1 - cur.net / prev.net) * 100)}% on the hour before`, c: "warn" });
  const alertRow = flags.length
    ? flags.map((f) => `<span class="gl-flag ${f.c}">${h(f.t)}</span>`).join("")
    : '<span class="gl-flag ok">All clear</span>';

  return `${status}
    <div class="gl-tiles">${tiles}</div>
    <div class="gl-panel"><div class="gl-h">Net per hour, last 24 h <em>amber line = pace needed</em></div>${barsSvg(rows, v.needed)}</div>
    <div class="gl-cols">
      <div class="gl-panel"><div class="gl-h">Earners, last 24 h ${weakest ? `<em>weakest: ${h(weakest.shipSymbol)} ${fmtM(weakest.pnl)}</em>` : ""}</div>${hulls || '<div class="gl-empty">No sales yet</div>'}</div>
      <div class="gl-panel"><div class="gl-h">Fresh systems</div>${pipeline}</div>
    </div>
    <div class="gl-alerts">${alertRow}</div>`;
}

export function mountGlance(root, { api, getAlerts = () => ({}) }) {
  let timer = null, busy = false, data = {};
  const draw = () => { root.innerHTML = glanceHtml({ ...data, alerts: getAlerts() }); };
  const load = async () => {
    if (busy) return;
    busy = true;
    const get = (path) => api("GET", path).catch(() => null);
    const [metrics, econ, pnl, queue] = await Promise.all([
      get("/api/metrics?hours=24"), get("/api/ops/economy_health"), get("/api/ops/pnl?sinceHours=24"), get("/api/ops/system_queue"),
    ]);
    data = { metrics: metrics ?? data.metrics, econ: econ ?? data.econ, pnl: pnl ?? data.pnl, queue: queue ?? data.queue };
    busy = false;
    draw();
  };
  return {
    show() { draw(); load(); clearInterval(timer); timer = setInterval(() => { draw(); load(); }, REFRESH_MS); },
    hide() { clearInterval(timer); timer = null; },
    refresh: draw,
  };
}
