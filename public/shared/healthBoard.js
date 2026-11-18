/**
 * The server health board: big status tiles and the last 6 hours as charts. Shared by the key-gated admin page (/admin,
 * GET /api/admin/health*) and the Admin > Health tab of Deck and Tower (GET /api/operator/health*). The status words and
 * thresholds come from the server (src/engine/serverHealth.ts); this only draws them.
 *
 * Built for an operator with low vision: large type, a status WORD on every tile and chart (colour is never the only
 * cue), charts drawn at the width they are shown at so their 15-18 px labels stay that size, and tap-to-enlarge on every
 * chart (shared/blowout.js picks up svg[role="img"]). It brings its own styles and reads the page's --green, --amber,
 * --red and --bone, with fallbacks, so it fits whichever page mounts it.
 *
 *   await loadHealthBoard(rootEl, (path) => fetchJson(path), { base: "/api/admin" });
 */

const STYLE_ID = "health-board-style";
const CSS = `
.hb { --hb-ok: var(--green, #58e6ab); --hb-warn: var(--amber, #ffb347); --hb-bad: var(--red, #ff6b7a); --hb-text: var(--bone, #e7ecf5); color: var(--hb-text); }
.hb-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.hb-head h2 { font-family: var(--chrome, inherit); font-size: 18px; letter-spacing: .08em; text-transform: uppercase; margin: 0; color: var(--hb-text); }
.hb-word { font-family: var(--chrome, inherit); font-weight: 700; font-size: 34px; letter-spacing: .06em; line-height: 1; padding: 10px 22px; border-radius: 10px; border: 3px solid currentColor; }
.hb-word.ok, .hb-aw.ok { color: var(--hb-ok); }
.hb-word.warn, .hb-aw.warn { color: var(--hb-warn); }
.hb-word.bad, .hb-aw.bad { background: var(--hb-bad); border-color: var(--hb-bad); color: #000; }
.hb-asof { font-size: 15px; }
.hb-reasons { margin: 0 0 14px; padding: 0; list-style: none; }
.hb-reasons li { font-size: 16px; line-height: 1.5; padding: 4px 0 4px 12px; border-left: 4px solid var(--hb-bad); margin-bottom: 4px; }
.hb-group { font-family: var(--chrome, inherit); font-size: 16px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin: 18px 0 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hb-aw { font-size: 16px; padding: 2px 10px; border-radius: 6px; border: 2px solid currentColor; }
.hb-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.hb-tile { background: rgba(0,0,0,.35); border: 2px solid rgba(255,255,255,.18); border-left-width: 10px; border-radius: 10px; padding: 14px 16px; min-height: 150px; display: flex; flex-direction: column; gap: 4px; }
.hb-tile.ok { border-left-color: var(--hb-ok); }
.hb-tile.warn { border-color: var(--hb-warn); }
.hb-tile.bad { border-color: var(--hb-bad); background: #2a0a0f; }
.hb-tile .hl { font-family: var(--chrome, inherit); font-weight: 600; font-size: 15px; }
.hb-tile .hv { font-family: var(--chrome, inherit); font-weight: 700; font-size: 40px; line-height: 1.1; color: #fff; word-break: break-word; }
.hb-tile .hw { font-family: var(--chrome, inherit); font-weight: 700; font-size: 22px; letter-spacing: .06em; }
.hb-tile.ok .hw { color: var(--hb-ok); }
.hb-tile.warn .hw { color: var(--hb-warn); }
.hb-tile.bad .hw { background: var(--hb-bad); color: #000; align-self: flex-start; padding: 0 8px; border-radius: 4px; }
.hb-tile .hd { font-size: 14px; line-height: 1.45; opacity: .9; margin-top: auto; }
.hb-note { font-size: 14px; opacity: .9; margin-top: 10px; }
.hb-err { font-size: 15px; color: var(--hb-bad); margin-top: 8px; }
.hb-chart { margin-top: 10px; background: rgba(0,0,0,.35); border: 2px solid rgba(255,255,255,.18); border-radius: 10px; padding: 12px 12px 6px; }
.hb-chart h3 { margin: 0 0 4px; font-family: var(--chrome, inherit); font-size: 19px; font-weight: 700; color: var(--hb-text); }
.hb-chart .hb-sub { font-size: 15px; margin-bottom: 6px; opacity: .95; }
.hb-chart svg { display: block; width: 100%; height: auto; }
.hb-hint { font-size: 14px; opacity: .85; margin-top: 6px; }
@media (max-width: 640px) { .hb-tile .hv { font-size: 32px; } .hb-word { font-size: 28px; } }
`;

const COLORS = { ok: "#58e6ab", warn: "#ffb347", bad: "#ff6b7a", line: "#8ec5ff", line2: "#ffd479", grid: "rgba(255,255,255,.18)" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function ensureHealthStyle(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const tileHtml = (t) => `<div class="hb-tile ${esc(t.level)}"><div class="hl">${esc(t.label)}</div><div class="hv">${esc(t.value)}</div><div class="hw">${esc(t.word)}</div><div class="hd">${esc(t.detail)}</div></div>`;

/** The tiles: the overall word, the reasons, each tenant's tiles, then the server's. */
export function boardHtml(h, { refreshSec } = {}) {
  const reasons = (h.reasons ?? []).length ? `<ul class="hb-reasons">${h.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  const tenants = (h.tenants ?? []).map((t) => `
    <div class="hb-group">${esc(t.agent)}<span class="hb-aw ${esc(t.level)}">${esc(t.word)}</span></div>
    <div class="hb-tiles">${t.tiles.map(tileHtml).join("")}</div>`).join("");
  const asOf = `as of ${new Date(h.asOf).toLocaleTimeString()}${refreshSec ? ` · refreshes every ${refreshSec} s` : ""}`;
  return `<div class="hb-head"><h2>Server health</h2><span class="hb-word ${esc(h.level)}">${esc(h.word)}</span><span class="hb-asof">${esc(asOf)}</span></div>
    ${reasons}
    ${tenants || '<div class="hb-note">No tenant engine is running in this process.</div>'}
    <div class="hb-group">Server (all tenants)</div>
    <div class="hb-tiles">${(h.process ?? []).map(tileHtml).join("")}</div>
    ${(h.notBooted ?? []).length ? `<div class="hb-note">Not running here: ${h.notBooted.map(esc).join(", ")}</div>` : ""}
    ${(h.errors ?? []).length ? `<div class="hb-err">Could not read: ${h.errors.map(esc).join("; ")}</div>` : ""}`;
}

// ── charts ────────────────────────────────────────────────────────────

const ms = (iso) => Date.parse(iso);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** An hour label kept inside the chart: anchored at its end near the right edge, at its start near the left. */
const tickAnchor = (x, left, right) => (x > right - 30 ? "end" : x < left + 30 ? "start" : "middle");
export function fmtMinutes(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return "—";
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 90) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} min`;
}
export function fmtCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${s}${Math.round(a)}`;
}
/** A reading more than this after the one before it starts a new line segment (the server was down or restarting). */
const GAP_BREAK_MS = 3 * 60_000;

/**
 * A line chart over time. `series` are drawn in order, each with its legend word; `dash` draws a limit line
 * (the stall line, the cap). Labels are 16 px at the width given, so pass the width the chart is shown at.
 */
export function timeChart({ label, from, to, series, width = 900, height: baseHeight = 250, yFmt = (v) => String(v), yMax }) {
  let height = baseHeight;
  const fs = width < 520 ? 15 : 16;
  // Legend first, wrapped onto as many rows as the width needs, so its words are never cut off.
  const legendItems = [];
  let lx = Math.max(58, fs * 4.2), row = 0;
  for (const s of series) {
    const w = 32 + s.name.length * fs * 0.62 + 22;
    if (lx + w > width && legendItems.length) { row += 1; lx = Math.max(58, fs * 4.2); }
    legendItems.push({ s, x: lx, y: fs * 0.9 + row * fs * 1.5 });
    lx += w;
  }
  const pad = { l: Math.max(58, fs * 4.2), r: 12, t: fs * 2.4 + row * fs * 1.5, b: fs * 1.9 };
  height += row * fs * 1.5;
  const all = series.flatMap((s) => s.pts.map((p) => p[1])).filter((v) => v !== null && Number.isFinite(v));
  let hi = Math.max(yMax ?? 0, ...all, 0);
  if (hi <= 0) hi = 1;
  hi *= 1.08;
  const X = (t) => pad.l + ((t - from) / Math.max(1, to - from)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - v / hi) * (height - pad.t - pad.b);
  const path = (pts) => {
    let d = "", prev = null;
    for (const [t, v] of pts) {
      if (v === null || !Number.isFinite(v)) { prev = null; continue; }
      d += `${prev === null || t - prev > GAP_BREAK_MS ? "M" : "L"}${X(t).toFixed(1)},${Y(Math.min(v, hi)).toFixed(1)}`;
      prev = t;
    }
    return d;
  };
  const yTicks = [0, hi / 2 / 1.08, hi / 1.08].map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${COLORS.grid}"/><text x="${pad.l - 6}" y="${(Y(v) + fs * 0.35).toFixed(1)}" font-size="${fs}" text-anchor="end">${esc(yFmt(v))}</text>`).join("");
  const spanH = (to - from) / 3_600_000;
  const stepH = width < 520 ? (spanH > 3 ? 2 : 1) : 1;
  const xTicks = [];
  for (let t = Math.ceil(from / (stepH * 3_600_000)) * stepH * 3_600_000; t <= to; t += stepH * 3_600_000) {
    xTicks.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${pad.t}" y2="${height - pad.b}" stroke="${COLORS.grid}" stroke-dasharray="2 4"/><text x="${X(t).toFixed(1)}" y="${height - 6}" font-size="${fs}" text-anchor="${tickAnchor(X(t), pad.l, width - pad.r)}">${esc(clock(t))}</text>`);
  }
  const legend = legendItems.map(({ s, x, y }) => `<line x1="${x}" x2="${x + 26}" y1="${y}" y2="${y}" stroke="${s.color}" stroke-width="${s.dash ? 3 : 4}"${s.dash ? ' stroke-dasharray="7 5"' : ""}/><text x="${x + 32}" y="${y + fs * 0.35}" font-size="${fs}" font-weight="700">${esc(s.name)}</text>`).join("");
  const lines = series.map((s) => `<path d="${path(s.pts)}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 2.5 : 3.5}"${s.dash ? ' stroke-dasharray="7 5"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet" fill="#e7ecf5" font-family="ui-monospace, Menlo, monospace">${yTicks}${xTicks.join("")}${lines}${legend}</svg>`;
}

/** Status as a coloured strip per scope, with the status word written on every run wide enough to hold it. */
export function statusStrip({ label, from, to, rows, width = 900 }) {
  const fs = width < 520 ? 15 : 16;
  const lane = fs * 2.6, gap = 8, padL = Math.min(130, Math.max(70, width * 0.16)), padB = fs * 1.9;
  const height = rows.length * (lane + gap) + padB;
  const X = (t) => padL + ((t - from) / Math.max(1, to - from)) * (width - padL - 10);
  const out = [];
  rows.forEach((r, i) => {
    const y = i * (lane + gap);
    out.push(`<text x="${padL - 8}" y="${(y + lane / 2 + fs * 0.35).toFixed(1)}" font-size="${fs}" font-weight="700" text-anchor="end">${esc(r.name)}</text>`);
    out.push(`<rect x="${padL}" y="${y}" width="${(width - padL - 10).toFixed(1)}" height="${lane}" fill="rgba(255,255,255,.06)"/>`);
    // Runs of the same word, each ending where the next reading starts (or after a minute when the next is far off).
    const runs = [];
    r.samples.forEach((s, k) => {
      const t0 = ms(s.sampledAt);
      const next = r.samples[k + 1] ? ms(r.samples[k + 1].sampledAt) : null;
      const t1 = next !== null && next - t0 <= GAP_BREAK_MS ? next : t0 + 60_000;
      const last = runs[runs.length - 1];
      if (last && last.word === s.word && last.level === s.level && Math.abs(last.t1 - t0) < 1000) last.t1 = t1;
      else runs.push({ word: s.word, level: s.level, t0, t1 });
    });
    for (const run of runs) {
      const x0 = X(Math.max(from, run.t0)), x1 = X(Math.min(to, run.t1));
      const w = Math.max(1, x1 - x0);
      out.push(`<rect x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${lane}" fill="${COLORS[run.level] ?? COLORS.warn}"><title>${esc(run.word)} ${esc(clock(run.t0))}-${esc(clock(run.t1))}</title></rect>`);
      if (w >= run.word.length * fs * 0.68 + 10) out.push(`<text x="${(x0 + w / 2).toFixed(1)}" y="${(y + lane / 2 + fs * 0.35).toFixed(1)}" font-size="${fs}" font-weight="700" text-anchor="middle" style="fill:#000">${esc(run.word)}</text>`);
    }
  });
  const spanH = (to - from) / 3_600_000;
  const stepH = width < 520 ? (spanH > 3 ? 2 : 1) : 1;
  for (let t = Math.ceil(from / (stepH * 3_600_000)) * stepH * 3_600_000; t <= to; t += stepH * 3_600_000) {
    out.push(`<text x="${X(t).toFixed(1)}" y="${height - 6}" font-size="${fs}" text-anchor="${tickAnchor(X(t), padL, width - 10)}">${esc(clock(t))}</text>`);
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" fill="#e7ecf5" font-family="ui-monospace, Menlo, monospace">${out.join("")}</svg>`;
}

const minutesText = (m) => (m ? `OK ${fmtMinutes(m.ok)} · WARN ${fmtMinutes(m.warn)} · STALLED or PROBLEM ${fmtMinutes(m.bad)}` : "no readings");
const lastOf = (rows, key) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] !== null && rows[i][key] !== undefined) return rows[i][key]; return null; };

/** The four charts for the last few hours: status strip, heartbeat against the stall line, API against the cap, profit. */
export function historyHtml(hist, { width = 900 } = {}) {
  const from = ms(hist.from), to = ms(hist.to);
  const hrs = `last ${hist.hours} h`;
  if (!hist.server.length && !hist.tenants.length) {
    return `<div class="hb-chart"><h3>History (${esc(hrs)})</h3><div class="hb-sub">No readings stored yet. One is written every minute from the next server start with this version.</div></div>`;
  }
  const chart = (title, sub, svg) => `<div class="hb-chart"><h3>${esc(title)}</h3><div class="hb-sub">${sub}</div>${svg}</div>`;
  const parts = [];
  const stripRows = [{ name: "Server", samples: hist.server }, ...hist.tenants.map((t) => ({ name: t.agent, samples: t.rows }))].filter((r) => r.samples.length);
  parts.push(chart(`Status, ${hrs}`,
    stripRows.map((r) => `<b>${esc(r.name)}</b>: ${esc(minutesText(hist.minutes[r.name === "Server" ? "server" : r.name]))}`).join("<br>"),
    statusStrip({ label: `Health status, ${hrs}`, from, to, rows: stripRows, width })));

  for (const t of hist.tenants) {
    const pts = (k, f = (v) => v) => t.rows.map((r) => [ms(r.sampledAt), r[k] === null || r[k] === undefined ? null : f(r[k])]);
    const gapNow = lastOf(t.rows, "gapMs"), lineNow = lastOf(t.rows, "stallLineMs");
    const over = gapNow !== null && lineNow !== null && gapNow > lineNow;
    parts.push(chart(`${t.agent}: time since last trade, ${hrs}`,
      `Now <b>${esc(fmtMinutes(gapNow === null ? null : gapNow / 60_000))}</b>, stall line ${esc(fmtMinutes(lineNow === null ? null : lineNow / 60_000))}: <b>${over ? "OVER THE LINE" : "UNDER THE LINE"}</b>. Above the dashed red line the board says STALLED.`,
      timeChart({ label: `${t.agent} heartbeat gap against the stall line, ${hrs}`, from, to, width, yFmt: (v) => fmtMinutes(v), series: [
        { name: "Gap since last trade", color: COLORS.line, pts: pts("gapMs", (v) => v / 60_000) },
        { name: "Stall line", color: COLORS.bad, dash: true, pts: pts("stallLineMs", (v) => v / 60_000) },
      ] })));
    const profitNow = lastOf(t.rows, "profitLastHour");
    parts.push(chart(`${t.agent}: matched profit per hour, ${hrs}`,
      `Each point is the realized profit of the 60 minutes before it. Now <b>${esc(fmtCompact(profitNow))} c</b>.`,
      timeChart({ label: `${t.agent} matched profit per hour, ${hrs}`, from, to, width, yFmt: fmtCompact, series: [
        { name: "Profit, last 60 min", color: COLORS.ok, pts: pts("profitLastHour") },
      ] })));
  }

  if (hist.server.length) {
    const pts = (k) => hist.server.map((r) => [ms(r.sampledAt), r[k]]);
    const cpm = lastOf(hist.server, "callsPerMin"), cap = lastOf(hist.server, "cap");
    parts.push(chart(`API calls a minute against the cap, ${hrs}`,
      `Now <b>${esc(fmtCompact(cpm))} of ${esc(fmtCompact(cap))}</b> a minute. A line near zero with traders on the books is a stall (2026-11-17 ran at about 3).`,
      timeChart({ label: `API calls a minute against the cap, ${hrs}`, from, to, width, yFmt: (v) => String(Math.round(v)), series: [
        { name: "Calls a minute", color: COLORS.line2, pts: pts("callsPerMin") },
        { name: "Cap", color: COLORS.bad, dash: true, pts: pts("cap") },
      ] })));
  }
  return `<div class="hb-group">The last ${esc(hist.hours)} hours</div>${parts.join("")}<div class="hb-hint">Tap a chart to see it large.</div>`;
}

/**
 * Fetch the board and its history and draw both into `root`. `get(path)` returns parsed JSON or throws. A failed
 * history read leaves the tiles up and says so.
 */
export async function loadHealthBoard(root, get, { base, hours = 6, refreshSec } = {}) {
  ensureHealthStyle(root.ownerDocument);
  root.classList.add("hb");
  const [h, hist] = await Promise.allSettled([get(`${base}/health`), get(`${base}/health/history?hours=${hours}`)]);
  if (h.status === "rejected") {
    root.innerHTML = `<div class="hb-head"><h2>Server health</h2><span class="hb-word bad">NO ANSWER</span><span class="hb-asof">${esc(`health check failed at ${new Date().toLocaleTimeString()}: ${h.reason?.message ?? h.reason}`)}</span></div>`;
    return;
  }
  const width = Math.max(300, Math.min(1100, Math.round(root.clientWidth || 900) - 28));
  root.innerHTML = boardHtml(h.value, { refreshSec }) + (hist.status === "fulfilled"
    ? historyHtml(hist.value, { width })
    : `<div class="hb-err">History could not be read: ${esc(hist.reason?.message ?? hist.reason)}</div>`);
}
