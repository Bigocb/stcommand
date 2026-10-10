/**
 * Financial metrics screen, shared so Deck (and later Tower) can mount it the same way.
 *
 *   const m = mountMetrics(rootEl, { api, netWorth: () => number | undefined });
 *   m.show();  // fetches and starts a slow refresh
 *   m.hide();  // stops the refresh
 *
 * Data comes from GET /api/metrics?hours=N (src/engine/metrics.ts does the sums from the ledger). Net trading is the same
 * figure as the front page pace: realized profit on completed sales less fuel and jumps. Ship purchases and scrap are shown
 * apart so the line does not dip when the fleet grows.
 */
import { fmt, signed, escapeHtml } from "/shared/domain.js";

const RANGES = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "3d" },
];
const DEFAULT_TARGET = 25_738_654; // last week's final credits
const REFRESH_MS = 60_000;

const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };

const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
};
const pct = (n) => `${n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%`;
const cls = (n) => (n > 0 ? "good" : n < 0 ? "bad" : "");

/** Change against the window before, as text with its direction ("+12%"), or "" when there is nothing to compare. */
function delta(now, before) {
  if (!before) return "";
  const d = ((now - before) / Math.abs(before)) * 100;
  return Number.isFinite(d) ? pct(d) : "";
}

function timeLabel(ms, hours) {
  const d = new Date(ms);
  if (hours <= 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString([], { weekday: "short", hour: "2-digit" });
}

/** A line over equal buckets; `values` may hold nulls (gaps). Single axis, labelled at the ends, hover reads a value. */
function lineChart(id, buckets, values, hours, color) {
  const W = 560, H = 170, L = 46, R = 10, T = 10, B = 22;
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined);
  if (pts.length < 2) return `<div class="empty">Not enough data in this range yet.</div>`;
  let min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v));
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (i) => L + (i / (values.length - 1 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(pts.at(-1).i).toFixed(1)},${H - B} L${x(pts[0].i).toFixed(1)},${H - B} Z`;
  const grid = [0, 0.5, 1].map((f) => {
    const v = min + (max - min) * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="mx-grid"/><text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="mx-axis">${compact(v)}</text>`;
  }).join("");
  const last = pts.at(-1);
  return `<svg viewBox="0 0 ${W} ${H}" class="mx-svg" data-chart="${id}" role="img" aria-label="${id}">
    ${grid}
    <path d="${area}" class="mx-area" style="fill:${color}"/>
    <path d="${path}" class="mx-line" style="stroke:${color}"/>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3" style="fill:${color}"/>
    <text x="${L}" y="${H - 6}" class="mx-axis">${timeLabel(buckets[0].t, hours)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" class="mx-axis">now</text>
  </svg>`;
}

/** Bars per bucket, green above zero and red below, on one axis through zero. */
function barChart(id, buckets, values, hours) {
  const W = 560, H = 170, L = 46, R = 10, T = 10, B = 22;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const hasNeg = values.some((v) => v < 0);
  const zero = hasNeg ? T + (H - T - B) / 2 : H - B;
  const span = hasNeg ? (H - T - B) / 2 : H - T - B;
  const bw = (W - L - R) / values.length;
  const bars = values.map((v, i) => {
    const h = (Math.abs(v) / max) * span;
    const yv = v >= 0 ? zero - h : zero;
    return `<rect x="${(L + i * bw + 0.5).toFixed(1)}" y="${yv.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(v === 0 ? 0 : 1, h).toFixed(1)}" rx="1.5" class="${v >= 0 ? "mx-up" : "mx-down"}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="mx-svg" data-chart="${id}" role="img" aria-label="${id}">
    <line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" class="mx-grid"/>
    <text x="${L - 6}" y="${T + 6}" text-anchor="end" class="mx-axis">${compact(max)}</text>
    ${hasNeg ? `<text x="${L - 6}" y="${H - B}" text-anchor="end" class="mx-axis">-${compact(max)}</text>` : `<text x="${L - 6}" y="${zero + 3}" text-anchor="end" class="mx-axis">0</text>`}
    ${bars}
    <text x="${L}" y="${H - 6}" class="mx-axis">${timeLabel(buckets[0].t, hours)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" class="mx-axis">now</text>
  </svg>`;
}

function kpi(label, value, sub, tone = "", title = "") {
  return `<div class="kpi"${title ? ` title="${escapeHtml(title)}"` : ""}><div class="k">${label}</div><div class="v ${tone}">${value}</div><div class="sub">${sub ?? ""}</div></div>`;
}

function table(headers, rows, empty) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<table><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</table>`;
}

export function mountMetrics(root, { api, netWorth } = {}) {
  let hours = Number(lsGet("metricsHours", "6")) || 6;
  let data = null;
  let timer = null;
  let loading = false;
  let error = "";

  root.innerHTML = `<div class="mx-bar">
      <div class="mx-ranges" id="mx-ranges">${RANGES.map((r) => `<button data-h="${r.hours}">${r.label}</button>`).join("")}</div>
      <span class="mx-note" id="mx-note"></span>
    </div>
    <div class="kpirow mx-kpis" id="mx-kpis"></div>
    <div class="cols2 mx-charts">
      <div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">Credits</span><span class="count" id="mx-wallet-h"></span></div><div class="panel-b mx-chart" id="mx-wallet"></div></div>
      <div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">Net trading per interval</span><span class="count" id="mx-net-h"></span></div><div class="panel-b mx-chart" id="mx-net"></div></div>
    </div>
    <div class="panel mx-worth"><div class="panel-h"><span class="dot"></span><span class="title">Credits + holds</span><span class="count" id="mx-worth-h"></span></div><div class="panel-b mx-chart" id="mx-worth"></div></div>
    <div class="panel mx-proj"><div class="panel-h"><span class="dot"></span><span class="title">Pace to reset</span><span class="count">straight line at the window's rate</span></div><div class="panel-b" id="mx-proj"></div></div>
    <div class="cols3 mx-tables">
      <div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">By good</span></div><div class="panel-b" style="padding:0" id="mx-goods"></div></div>
      <div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">By ship</span></div><div class="panel-b" style="padding:0" id="mx-ships"></div></div>
      <div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">By sell system</span></div><div class="panel-b" style="padding:0" id="mx-systems"></div><div class="panel-h" style="border-top:1px solid var(--hair)"><span class="dot"></span><span class="title">Traders with no sale</span></div><div class="panel-b" id="mx-idle"></div></div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  function render() {
    for (const b of $("mx-ranges").children) b.classList.toggle("on", Number(b.dataset.h) === hours);
    if (error) $("mx-note").textContent = error;
    if (!data) return;
    const t = data.totals, p = data.previous;
    const walletChange = data.walletStart !== null && data.walletEnd !== null ? data.walletEnd - data.walletStart : null;
    $("mx-note").textContent = `${data.hours}h window, ${data.bucketMinutes} min intervals · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const vs = (n, b) => { const d = delta(n, b); return d ? `${d} vs previous ${data.hours}h` : "no earlier window to compare"; };
    $("mx-kpis").innerHTML = [
      kpi("Net trading", signed(t.net), vs(t.net, p.net), cls(t.net), "Realized profit on completed sales, less fuel and jumps"),
      kpi("Per hour", signed(t.netPerHour), vs(t.netPerHour, p.netPerHour), cls(t.netPerHour)),
      kpi("Credits", walletChange === null ? "—" : signed(walletChange), data.walletEnd !== null ? `now ${fmt(data.walletEnd)} · includes ship buys` : "", cls(walletChange ?? 0), "Wallet change over the window; moves with ship purchases and cargo in transit as well as profit"),
      kpi("Sales", fmt(t.sells), `${fmt(t.units)} units · ${vs(t.sells, p.sells)}`),
      kpi("Profit / sale", signed(t.profitPerSale), `margin ${t.marginPct}% on cost`, cls(t.profitPerSale)),
      kpi("Overhead", `${t.overheadPct}%`, `fuel ${compact(t.fuel)} · jumps ${compact(t.jumps)}`, t.overheadPct > 25 ? "bad" : "", "Fuel and jump costs as a share of gross profit"),
      kpi("Fleet spend", compact(t.shipsBought), `${t.shipsBoughtCount} bought · scrap +${compact(t.scrapProceeds)}`, "", "Ships bought and scrap proceeds in the window; not part of net trading"),
    ].join("");
    $("mx-wallet-h").textContent = data.walletEnd !== null ? fmt(data.walletEnd) : "";
    $("mx-wallet").innerHTML = lineChart("Credits over time", data.buckets, data.buckets.map((b) => b.wallet), data.hours, "var(--amber)");
    const worthSeries = data.buckets.map((b) => b.worth ?? null);
    const lastWorth = worthSeries.filter((v) => v !== null).at(-1);
    $("mx-worth-h").textContent = lastWorth === undefined ? "" : fmt(lastWorth);
    $("mx-worth").innerHTML = lineChart("Credits plus holds over time", data.buckets, worthSeries, data.hours, "var(--amber)");
    $("mx-net-h").textContent = signed(t.net);
    $("mx-net").innerHTML = barChart("Net trading per interval", data.buckets, data.buckets.map((b) => b.net), data.hours);

    // Pace to reset
    const target = Number(lsGet("metricsTarget", String(DEFAULT_TARGET))) || DEFAULT_TARGET;
    const worth = netWorth?.() ?? (data.walletEnd ?? data.credits);
    const resetMs = data.resetAt ? Date.parse(data.resetAt) : NaN;
    const left = Number.isFinite(resetMs) ? Math.max(0, (resetMs - Date.now()) / 3_600_000) : null;
    if (left === null) {
      $("mx-proj").innerHTML = `<div class="empty">The next reset time is not known yet.</div>`;
    } else {
      const projected = Math.round(worth + t.netPerHour * left);
      const needed = target > worth && left > 0 ? Math.round((target - worth) / left) : 0;
      const gap = projected - target;
      $("mx-proj").innerHTML = `<div class="mx-projgrid">
        <div><div class="k">Credits + holds now</div><div class="mv">${fmt(worth)}</div></div>
        <div><div class="k">Reset in</div><div class="mv">${left.toFixed(1)}h</div></div>
        <div><div class="k">Projected at reset</div><div class="mv ${gap >= 0 ? "good" : "bad"}">${fmt(projected)}</div><div class="sub">at ${signed(t.netPerHour)}/h</div></div>
        <div><div class="k">Target</div><div class="mv"><input id="mx-target" value="${fmt(target)}" inputmode="numeric" aria-label="Target credits"></div><div class="sub">${gap >= 0 ? `${fmt(gap)} ahead` : `${fmt(-gap)} short`}</div></div>
        <div><div class="k">Rate needed</div><div class="mv ${needed > t.netPerHour ? "bad" : "good"}">${needed ? signed(needed) : "reached"}/h</div><div class="sub">from now to the target</div></div>
      </div>`;
      const input = root.querySelector("#mx-target");
      input?.addEventListener("change", () => {
        const v = Number(String(input.value).replace(/[^0-9]/g, ""));
        if (v > 0) { lsSet("metricsTarget", String(v)); render(); }
      });
    }

    $("mx-goods").innerHTML = table(["Good", "Profit", "Units", "Per unit", "Margin"],
      data.byGood.slice(0, 12).map((g) => [escapeHtml(g.good), signed(g.profit), fmt(g.units), signed(g.profitPerUnit), `${g.marginPct}%`]), "No completed sales in this range.");
    $("mx-ships").innerHTML = table(["Ship", "Hold", "Profit", "Sales", "Per sale", "Per hour"],
      data.byShip.slice(0, 14).map((s) => [escapeHtml(s.ship), s.hold ?? "—", signed(s.profit), fmt(s.sells), signed(s.profitPerSale), signed(s.profitPerHour)]), "No completed sales in this range.");
    $("mx-systems").innerHTML = table(["System", "Profit", "Sales"],
      data.bySystem.map((s) => [escapeHtml(s.system), signed(s.profit), fmt(s.sells)]), "No completed sales in this range.");
    $("mx-idle").innerHTML = data.idleTraders.length
      ? data.idleTraders.map((s) => `<span class="mx-chip">${escapeHtml(s)}</span>`).join("")
      : `<span class="sub">Every trader sold something.</span>`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      data = await api("GET", `/api/metrics?hours=${hours}`);
      error = "";
    } catch (err) {
      error = `Could not load metrics: ${err.message}`;
    } finally {
      loading = false;
      render();
    }
  }

  $("mx-ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-h]");
    if (!b) return;
    hours = Number(b.dataset.h);
    lsSet("metricsHours", String(hours));
    data = null;
    render();
    load();
  });

  // Hover: read the value under the pointer from the chart's own buckets.
  root.addEventListener("mousemove", (e) => {
    const svg = e.target.closest?.("svg.mx-svg");
    const tip = root.querySelector(".mx-tip");
    if (!svg || !data) { tip?.remove(); return; }
    const r = svg.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left - (46 / 560) * r.width) / (r.width * (504 / 560))));
    const i = Math.min(data.buckets.length - 1, Math.round(f * (data.buckets.length - 1)));
    const b = data.buckets[i];
    const isWallet = svg.dataset.chart.startsWith("Credits");
    const text = `${timeLabel(b.t, data.hours)} · ${isWallet ? (b.wallet === null ? "—" : fmt(b.wallet)) : `${signed(b.net)} · ${b.sells} sales`}`;
    let el = tip;
    if (!el) { el = document.createElement("div"); el.className = "mx-tip"; root.appendChild(el); }
    el.textContent = text;
    el.style.left = `${e.clientX - root.getBoundingClientRect().left + 12}px`;
    el.style.top = `${e.clientY - root.getBoundingClientRect().top + 12}px`;
  });
  root.addEventListener("mouseleave", () => root.querySelector(".mx-tip")?.remove());

  return {
    show() { render(); load(); clearInterval(timer); timer = setInterval(load, REFRESH_MS); },
    hide() { clearInterval(timer); timer = null; },
  };
}
