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
 *   GET /api/ops/system_queue        scouted / staged / live counts, last release
 * `getFleet()` gives { traderCaps } (hold sizes of trader-role ships) from the Deck store. `getWorth()` gives { wallet, holds, total, partial } from the Deck store (same as the top bar); `getAlerts()` gives { approvals, stranded, manualHold } from the Deck store, so the alerts row needs no extra call.
 * Design notes: docs/deck-desktop-design.md, "Glance" (operator 2026-11-24: "I am going to have the overview up on a screen to glance at").
 */
import { escapeHtml } from "/shared/domain.js";
import { hourlyRows } from "/shared/hourly.js";

const WEEK_GOAL = 800_000_000; // operator, 2026-11-23
const WEEK_HOURS = 168;
const CARGO_TARGET = 15_000; // operator, 2026-11-24: total trader cargo by reset
const HEAVY_PRICE_HINT = 1_800_000; // about what the next heavy costs; the buy warning gives the exact figure
const STAGING_STEPS = [[0, 3], [7_500, 5], [12_000, 6]]; // [units, freshStagedAhead], CLAUDE.md "Cargo target"
const SAMPLES_KEY = "glance.holdSamples";
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

/** Staging depth the cargo level calls for, and the next step up. Pure. */
export function stagingAdvice(units, current) {
  let want = STAGING_STEPS[0][1];
  for (const [u, n] of STAGING_STEPS) if (units >= u) want = n;
  const next = STAGING_STEPS.find(([u]) => u > units) ?? null;
  return { want, current, behind: current !== null && current !== undefined && current < want, next: next ? { units: next[0], ahead: next[1], toGo: next[0] - units } : null };
}

/** Units per hour from timestamped samples [{t, u}] over the last 24 h (needs 45+ minutes of history); null until then. Pure. */
export function holdPace(samples, now) {
  const recent = (samples ?? []).filter((x) => now - x.t <= 24 * 3_600_000);
  if (recent.length < 2) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const hrs = (last.t - first.t) / 3_600_000;
  if (hrs < 0.75) return null;
  return Math.max(0, (last.u - first.u) / hrs);
}

/** Premium / fading-soon counts from the engine's own release check (its decision note), so the display agrees with the rule that releases systems. */
export function releaseCounts(q) {
  const note = (q?.lastCheck?.decision?.notes ?? []).join(" ");
  const premium = Number(/(\d+) live premium/.exec(note)?.[1]);
  const target = Number(/target (\d+)/.exec(note)?.[1] ?? q?.policy?.target);
  const soon = Number(/(\d+) fading within/.exec(note)?.[1] ?? 0);
  return { premium: Number.isFinite(premium) ? premium : null, target: Number.isFinite(target) ? target : null, soon: Number.isFinite(soon) ? soon : 0 };
}

function queueCounts(q) {
  const list = Array.isArray(q?.queue) ? q.queue : [];
  const c = { scouted: 0, staged: 0, live: 0 };
  for (const s of list) if (s.state in c) c[s.state]++;
  return { ...c, lastRelease: q?.lastRelease ?? null, ...releaseCounts(q) };
}

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 90 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
}

export function glanceHtml({ metrics, econ, queue, alerts, worth: live, fleet, doctrine, samples }) {
  const now = Date.now();
  const resetAt = Date.parse(metrics?.resetAt ?? "");
  const weekStart = Number.isFinite(resetAt) ? resetAt - WEEK_HOURS * 3_600_000 : null;
  const hourOfWeek = weekStart ? Math.max(0, (now - weekStart) / 3_600_000) : 0;
  const rows = metrics?.buckets ? hourlyRows(metrics.buckets, metrics.bucketMinutes, now) : [];
  const done = rows.filter((r) => !r.partial).slice(0, 3);
  // The colour is judged on the 3-hour average so one good or bad hour does not flip it; the last full hour is shown beside
  // it because the average trails the current rate by an hour or two (operator, 2026-11-25).
  const rate = done.length ? done.reduce((s, r) => s + r.net, 0) / done.length : null;
  const lastFull = done.length ? done[0].net : null;
  const matched = metrics?.matchedSinceReset ?? null;
  const v = paceVerdict({ matched, hourOfWeek, rate });
  const sum = econ?.summary ?? {};
  // Wallet and holds come from the Deck store, the same figures as the top bar, so the two always agree. The economy
  // report is a separate read that can be a minute older (a sale in between moves money from holds to wallet).
  const wallet = live?.wallet ?? sum.wallet ?? metrics?.credits ?? null;
  const holds = live?.holds ?? sum.holds ?? null;
  const worth = live?.total ?? (wallet !== null && holds !== null ? wallet + holds : null);
  const last = sum.lastHour ?? null;
  const q = queueCounts(queue);
  const levelText = { good: "On pace", warn: "Behind pace", bad: "Well behind pace", unknown: "Reading…" }[v.level];

  const status = `<div class="gl-status ${v.level}">
    <div class="gl-hr">Hour ${Math.floor(hourOfWeek)}</div>
    <div class="gl-line"><b>${h(levelText)}</b> · ${fmtM(matched)} of ${fmtM(WEEK_GOAL)} · needs ${fmtM(v.needed)}/h · last hour ${fmtM(lastFull)}/h · 3 h avg ${fmtM(rate)}/h</div>
  </div>`;

  const tiles = [
    { k: "Wallet + holds", v: `${fmtM(worth)}${live?.partial ? "+" : ""}`, s: `wallet ${fmtM(wallet)} · holds ${fmtM(holds)}`, c: "amber" },
    { k: "Last hour (net)", v: fmtM(last?.net), s: `${last?.sales ?? "—"} sales · jumps ${fmtM(last?.jumpFees)}`, c: last && last.net >= v.needed ? "good" : "" },
    { k: "Hulls", v: `${sum.traders ?? "—"}`, s: `${sum.bigHulls ?? "—"} big · floor ${fmtM(sum.floor)}`, c: "" },
    { k: "Week to go", v: `${Math.max(0, WEEK_HOURS - Math.floor(hourOfWeek))} h`, s: `${fmtM(Math.max(0, WEEK_GOAL - (matched ?? 0)))} left`, c: "" },
  ].map((t) => `<div class="gl-tile ${t.c}"><div class="k">${h(t.k)}</div><div class="v">${h(t.v)}</div><div class="s">${h(t.s)}</div></div>`).join("");

  // Hold count: sum of every trader's hold size (the operator's cargo target, 15,000 units, 2026-11-24).
  const caps = (fleet?.traderCaps ?? []).filter((c) => c > 0);
  const units = caps.reduce((n, c) => n + c, 0);
  const cls = [["Bulk 490", (c) => c >= 400], ["Heavy 225", (c) => c >= 200 && c < 400], ["Refining 150", (c) => c >= 100 && c < 200], ["Small ≤80", (c) => c < 100]]
    .map(([k, f]) => ({ k, n: caps.filter(f).length, u: caps.filter(f).reduce((a, c) => a + c, 0) }));
  const pace = holdPace(samples, now);
  const hoursToTarget = pace && pace > 0 && units < CARGO_TARGET ? (CARGO_TARGET - units) / pace : null;
  const hoursLeft = Math.max(0, WEEK_HOURS - hourOfWeek);
  const targetNote = units >= CARGO_TARGET ? "target reached"
    : pace === null ? "buy pace: measuring (needs 45 min open)"
    : hoursToTarget === null ? "no hulls added lately"
    : `${Math.round(pace)} units/h → ${hoursToTarget <= hoursLeft ? "target in " : "misses reset: "}${hoursToTarget.toFixed(0)} h (${hoursLeft.toFixed(0)} h left)`;
  const bar = (pct, mark) => `<span class="b"><i style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></i>${mark === undefined ? "" : `<u style="left:${Math.min(100, mark).toFixed(1)}%"></u>`}</span>`;
  const expected = (hourOfWeek / WEEK_HOURS) * 100;
  const goalRows = [
    { k: "Hold count", v: `${units.toLocaleString("en-US")} / ${CARGO_TARGET.toLocaleString("en-US")} units`, pct: (units / CARGO_TARGET) * 100, s: `${caps.length} traders · ${targetNote}` },
    { k: "Week profit", v: `${fmtM(matched)} / ${fmtM(WEEK_GOAL)}`, pct: ((matched ?? 0) / WEEK_GOAL) * 100, mark: expected, s: `line = even pace (${Math.round(expected)}%)` },
    { k: "Profit rate", v: `${fmtM(rate)}/h of ${fmtM(v.needed)}/h`, pct: v.needed ? ((rate ?? 0) / v.needed) * 100 : 0, s: "last 3 full hours" },
  ].map((g) => `<div class="gl-goal"><div class="t"><span>${h(g.k)}</span><b>${h(g.v)}</b></div>${bar(g.pct, g.mark)}<div class="s">${h(g.s)}</div></div>`).join("");
  const mix = cls.map((c) => `<div><b>${c.n}</b><span>${h(c.k)} · ${c.u.toLocaleString("en-US")}u</span></div>`).join("");
  const hulls = `${goalRows}<div class="gl-mix">${mix}</div>`;
  const stg = stagingAdvice(units, doctrine?.freshStagedAhead ?? null);
  const stagingLine = `<div class="gl-stage ${stg.behind ? "warn" : ""}"><b>Staged ahead ${stg.current ?? "—"}</b> `
    + (stg.behind ? `· cargo calls for ${stg.want}: ask to raise freshStagedAhead` : stg.next ? `· steps to ${stg.next.ahead} at ${stg.next.units.toLocaleString("en-US")} units (${stg.next.toGo.toLocaleString("en-US")} to go)` : "· top step reached") + "</div>";
  const floorV = sum.floor ?? null;
  const buyLine = floorV !== null && wallet !== null ? floorV + HEAVY_PRICE_HINT : null;
  const wmax = Math.max(wallet ?? 0, buyLine ?? 0, 1) * 1.1;
  const walletPanel = floorV === null || wallet === null ? "" : `<div class="gl-goal"><div class="t"><span>Wallet vs floor</span><b>${fmtM(wallet)} · floor ${fmtM(floorV)}</b></div>
    <span class="b"><i style="width:${((wallet / wmax) * 100).toFixed(1)}%;background:${wallet >= buyLine ? "var(--green)" : "var(--amber)"}"></i><u style="left:${((floorV / wmax) * 100).toFixed(1)}%"></u><u style="left:${((buyLine / wmax) * 100).toFixed(1)}%;background:var(--green)"></u></span>
    <div class="s">${wallet >= buyLine ? `a heavy fits (${fmtM(wallet - buyLine)} spare above floor + ~${fmtM(HEAVY_PRICE_HINT)})` : `${fmtM(buyLine - wallet)} short of floor + a heavy (~${fmtM(HEAVY_PRICE_HINT)})`} · white = floor, green = floor + heavy</div></div>`;

  const pipeline = `<div class="gl-pipe">
      <div><b>${q.live}</b><span>live</span></div><div><b>${q.staged}</b><span>staged</span></div><div><b>${q.scouted}</b><span>scouted</span></div>
      <div><b>${q.premium ?? "—"}</b><span>premium (target ${q.target ?? "—"})</span></div><div><b>${q.soon}</b><span>fading soon</span></div><div class="wide"><b>${h(ago(q.lastRelease))}</b><span>last release</span></div></div>`;

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
      <div class="gl-panel"><div class="gl-h">Goals and hold count</div>${hulls}</div>
      <div class="gl-panel"><div class="gl-h">Fresh systems</div>${pipeline}${stagingLine}${walletPanel}</div>
    </div>
    <div class="gl-alerts">${alertRow}</div>`;
}

export function mountGlance(root, { api, getAlerts = () => ({}), getWorth = () => null, getFleet = () => null }) {
  let timer = null, busy = false, data = {}, samples = [];
  try { samples = JSON.parse(localStorage.getItem(SAMPLES_KEY) ?? "[]"); } catch { samples = []; }
  // Hold count over time, per viewer, so a wall screen left open can show the buy pace; a convenience, not a decision input.
  const sample = () => {
    const units = (getFleet()?.traderCaps ?? []).reduce((n, c) => n + c, 0);
    const t = Date.now();
    if (!units || (samples.length && t - samples[samples.length - 1].t < 10 * 60_000)) return;
    samples = [...samples.filter((x) => t - x.t <= 24 * 3_600_000), { t, u: units }];
    try { localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples)); } catch { /* storage unavailable */ }
  };
  const draw = () => { root.innerHTML = glanceHtml({ ...data, alerts: getAlerts(), worth: getWorth(), fleet: getFleet(), samples }); sample(); };
  const load = async () => {
    if (busy) return;
    busy = true;
    const get = (path) => api("GET", path).catch(() => null);
    const [metrics, econ, queue, doc] = await Promise.all([
      get("/api/metrics?hours=24"), get("/api/ops/economy_health"), get("/api/ops/system_queue"), get("/api/doctrine"),
    ]);
    const staged = (doc?.clauses ?? []).find((c) => c.key === "freshStagedAhead")?.value;
    data = { metrics: metrics ?? data.metrics, econ: econ ?? data.econ, queue: queue ?? data.queue, doctrine: staged === undefined ? data.doctrine : { freshStagedAhead: staged } };
    busy = false;
    draw();
  };
  return {
    show() { draw(); load(); clearInterval(timer); timer = setInterval(() => { draw(); load(); }, REFRESH_MS); },
    hide() { clearInterval(timer); timer = null; },
    refresh: draw,
  };
}
