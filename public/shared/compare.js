/**
 * Week over week: this week against any kept week, lined up by hours since each week's first trade (src/engine/weekCompare.ts).
 * Shared by Deck (Insights > Compare, the full view) and Tower (a compact card in More).
 *
 *   const c = mountCompare(rootEl, { api, compact: false });
 *   c.show();   // loads the week list and the chosen comparison
 *   c.hide();
 *
 * GET /api/compare/weeks lists the weeks (an operator also sees every other agent's); GET /api/compare?week=<id> returns both series.
 */
import { escapeHtml } from "/shared/domain.js";

const h = (s) => escapeHtml(String(s ?? ""));
const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };
const compact = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const x = Number(n), a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(x));
};
const signed = (n) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${compact(n)}`);
const pct = (a, b) => (b ? `${a >= b ? "+" : "−"}${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}%` : "—");
const tone = (n) => (n > 0 ? "good" : n < 0 ? "bad" : "");

/** One line chart of two series over hours: this week solid, the other dashed, a dotted line where each week's gate (first jump) opened. */
export function compareChart(a, b, { key, gateA, gateB, height = 150, width = 560, label = "" }) {
  const n = Math.max(a.length, b.length);
  if (n < 2) return `<div class="cmp-empty">Not enough hours yet.</div>`;
  const val = (p) => (p && p[key] !== null && p[key] !== undefined ? Number(p[key]) : null);
  const all = [...a, ...b].map(val).filter((v) => v !== null);
  if (!all.length) return `<div class="cmp-empty">No ${h(label)} readings yet.</div>`;
  let lo = Math.min(0, ...all), hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const pad = { l: 44, r: 8, t: 8, b: 18 };
  const X = (i) => pad.l + (i / (n - 1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const path = (pts) => {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      const v = val(p);
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [lo, lo + (hi - lo) / 2, hi].map((v) => `<g><line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="cmp-grid"/><text x="${pad.l - 5}" y="${(Y(v) + 3).toFixed(1)}" class="cmp-axis" text-anchor="end">${compact(v)}</text></g>`).join("");
  const hourTicks = [0, 24, 48, 72, 96, 120, 144, 168].filter((x) => x < n).map((x) => `<text x="${X(x).toFixed(1)}" y="${height - 4}" class="cmp-axis" text-anchor="middle">${x}h</text>`).join("");
  const gate = (g, cls) => (g !== null && g !== undefined && g < n ? `<line x1="${X(g).toFixed(1)}" x2="${X(g).toFixed(1)}" y1="${pad.t}" y2="${height - pad.b}" class="cmp-gate ${cls}"><title>gate opened at ${g}h</title></line>` : "");
  return `<svg viewBox="0 0 ${width} ${height}" class="cmp-chart" role="img" aria-label="${h(label)} by hours since the first trade">${ticks}${hourTicks}${gate(gateB, "b")}${gate(gateA, "a")}<path d="${path(b)}" class="cmp-line b"/><path d="${path(a)}" class="cmp-line a"/></svg>`;
}

export function mountCompare(root, { api, compact: small = false } = {}) {
  let weeks = null;       // GET /api/compare/weeks
  let data = null;        // GET /api/compare
  let choice = lsGet("compareWeek", "");
  let error = "";
  let busy = false;
  let token = 0;

  root.classList.add("cmp");

  function pick() {
    const list = (weeks?.weeks ?? []).filter((w) => !w.current);
    if (list.some((w) => w.id === choice)) return choice;
    return list[0]?.id ?? "";   // newest other week
  }

  async function load() {
    if (busy) return;
    busy = true; error = "";
    const t = ++token;
    try {
      weeks = await api("GET", "/api/compare/weeks");
      choice = pick();
      data = choice ? await api("GET", `/api/compare?week=${encodeURIComponent(choice)}`) : null;
    } catch (err) {
      error = err.message || String(err);
    } finally {
      busy = false;
      if (t === token) render();
    }
  }

  async function choose(id) {
    choice = id; lsSet("compareWeek", id);
    busy = true; error = ""; render();
    try { data = await api("GET", `/api/compare?week=${encodeURIComponent(id)}`); } catch (err) { error = err.message || String(err); }
    busy = false; render();
  }

  function selectHtml() {
    const list = (weeks?.weeks ?? []).filter((w) => !w.current);
    if (!list.length) return "";
    const own = list.filter((w) => w.own), others = list.filter((w) => !w.own);
    const opt = (w) => `<option value="${h(w.id)}" ${w.id === choice ? "selected" : ""}>${h(w.label)} · ${compact(w.matchedPnl)} matched</option>`;
    return `<label class="cmp-pick">Compare this week with <select id="cmp-sel">
      ${own.length ? `<optgroup label="This agent's weeks">${own.map(opt).join("")}</optgroup>` : ""}
      ${others.length ? `<optgroup label="Other agents (operator)">${others.map(opt).join("")}</optgroup>` : ""}
    </select></label>`;
  }

  function kpi(label, a, b, fmt = compact) {
    const d = a !== null && b !== null && b !== 0 ? pct(a, b) : "";
    return `<div class="kpi"><div class="k">${h(label)}</div><div class="v">${fmt(a)}</div><div class="sub">other ${fmt(b)}${d ? ` · <span class="${tone(a - b)}">${d}</span>` : ""}</div></div>`;
  }

  function render() {
    if (error) { root.innerHTML = `<div class="cmp-empty">${h(error)}</div>`; return; }
    if (!weeks) { root.innerHTML = `<div class="cmp-empty">Loading…</div>`; return; }
    if (!weeks.weeks.some((w) => !w.current)) {
      root.innerHTML = `<div class="cmp-empty">No earlier week to compare with yet. A week is kept once it ends${weeks.operator ? "" : "; other agents' weeks need operator access (OPERATOR_AGENTS)"}.</div>`;
      return;
    }
    const head = `<div class="cmp-head">${selectHtml()}${busy ? '<span class="cmp-note">Loading…</span>' : ""}</div>`;
    if (!data) { root.innerHTML = head; bind(); return; }
    const L = data.likeForLike, A = data.a, B = data.b;
    const gate = (w) => (w.firstJumpHour === null || w.firstJumpHour === undefined ? null : w.firstJumpHour);
    const kpis = `<div class="kpirow cmp-kpis">
      ${kpi(`Matched profit, first ${L.hours} h`, L.a.matchedPnl, L.b.matchedPnl)}
      ${kpi("Profit / hour", L.a.pnlPerHour, L.b.pnlPerHour)}
      ${kpi("Sells", L.a.trades, L.b.trades)}
      ${small ? "" : kpi("Ships bought", L.a.ships, L.b.ships)}
      ${small ? "" : kpi("Best hour", L.a.bestHourPnl, L.b.bestHourPnl)}
      ${kpi("Gate opened (h)", gate(A), gate(B), (v) => (v === null ? "—" : `${v}`))}
    </div>`;
    const charts = `<div class="cmp-charts">
      <div class="cmp-chart-box"><div class="cmp-chart-h">Matched profit, cumulative <span class="cmp-legend"><i class="a"></i>${h(A.label)}<i class="b"></i>${h(B.label)}</span></div>${compareChart(A.points, B.points, { key: "cumPnl", gateA: gate(A), gateB: gate(B), label: "matched profit", height: small ? 120 : 160 })}</div>
      ${small ? "" : `<div class="cmp-chart-box"><div class="cmp-chart-h">Wallet</div>${compareChart(A.points, B.points, { key: "wallet", gateA: gate(A), gateB: gate(B), label: "wallet" })}</div>`}
    </div>`;
    const rows = data.checkpoints.filter((r) => r.a || r.b).filter((r) => !small || [12, 24, 48, 72].includes(r.hour));
    const table = `<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th>Hour</th><th class="num">${small ? "This week" : h(A.label)}</th><th class="num">${small ? "Other" : h(B.label)}</th><th class="num">${small ? "Diff" : "Difference"}</th>${small ? "" : "<th class=\"num\">Wallet A</th><th class=\"num\">Wallet B</th>"}</tr></thead><tbody>${rows.map((r) => `<tr><td>${r.hour} h</td><td class="num">${r.a ? compact(r.a.cumPnl) : "—"}</td><td class="num">${r.b ? compact(r.b.cumPnl) : "—"}</td><td class="num ${tone(r.pnlDelta)}">${signed(r.pnlDelta)}</td>${small ? "" : `<td class="num">${r.a ? compact(r.a.wallet) : "—"}</td><td class="num">${r.b ? compact(r.b.wallet) : "—"}</td>`}</tr>`).join("")}</tbody></table></div>`;
    const foot = `<div class="cmp-foot">Matched profit counts completed round trips only. Hours run from each week's first trade; the dotted lines mark the first gate jump. ${A.reached} h of this week${B.reached < A.reached ? "" : ""}, ${B.reached} h of the other. Totals above are cut at ${L.hours} h so a week in progress is not set against a finished one.</div>`;
    root.innerHTML = head + kpis + charts + table + foot;
    bind();
  }

  function bind() {
    const sel = root.querySelector("#cmp-sel");
    if (sel) sel.addEventListener("change", () => choose(sel.value));
  }

  return { show() { load(); }, hide() { token++; } };
}
