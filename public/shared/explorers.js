/**
 * Explorers tab (Deck › Fleet › Explorers): what each explorer is doing, the systems that have been looked at and how they
 * came out, and the keepers bought and stationed.
 *
 *   const s = mountExplorers(rootEl, { api });             // Deck: tables
 *   const s = mountExplorers(rootEl, { api, compact: true }); // Tower: stacked cards for a phone
 *   s.show();  // fetches, refreshes every minute while shown
 *   s.hide();  // stops it
 *
 * Data: GET /api/ops/explorers?sinceHours=N (src/ops/explorers.ts, engine/explorerReport.ts). Read-only: nothing here moves a ship.
 */
import { escapeHtml } from "/shared/domain.js";

const REFRESH_MS = 60_000;
const WINDOWS = [24, 72, 168];
const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };
const h = (s) => escapeHtml(String(s ?? ""));
const n = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const ago = (iso, now) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const VERDICT = {
  toured: { label: "toured", cls: "" },
  surveyed: { label: "not toured yet", cls: "ex-dim" },
  rejected: { label: "rejected", cls: "ex-no" },
  atlas: { label: "from atlas", cls: "ex-dim" },
};
const verdict = (v) => (v ? `<span class="ex-tag ${VERDICT[v]?.cls ?? ""}">${h(VERDICT[v]?.label ?? v)}</span>` : "");

/** Cumulative systems traded in and with keepers over time: two 2px lines, direct end labels, from 0. */
function growthChart(cov, compact = false) {
  const pts = cov.series;
  if (pts.length < 2) return `<div class="mx-note">Growth shows once there are two samples.</div>`;
  // A phone is about 350px wide: a 360-unit viewBox keeps the labels at a readable size instead of shrinking a 600-unit one.
  const W = compact ? 360 : 600, H = 150, L = 30, R = compact ? 74 : 96, T = 10, B = 22;
  const t0 = Date.parse(pts[0].at), t1 = Date.parse(pts[pts.length - 1].at);
  const max = Math.max(1, ...pts.map((p) => Math.max(p.trading, p.keepers)));
  const top = Math.ceil(max / 5) * 5 || 5;
  const x = (iso) => L + ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const line = (key) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const fmtT = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const grid = [0, top / 2, top].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--hair)" stroke-width="1"/><text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--dim)">${Math.round(v)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:210px" role="img" aria-label="Systems traded in: ${last.trading}. Systems with keepers: ${last.keepers}. Cumulative since ${h(fmtT(t0))}.">
    ${grid}
    <path d="${line("trading")}" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line("keepers")}" fill="none" stroke="var(--ice)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(last.at).toFixed(1)}" cy="${y(last.trading).toFixed(1)}" r="3" fill="var(--amber)"><title>${last.trading} systems traded in</title></circle>
    <circle cx="${x(last.at).toFixed(1)}" cy="${y(last.keepers).toFixed(1)}" r="3" fill="var(--ice)"><title>${last.keepers} systems with keepers</title></circle>
    <text x="${W - R + 8}" y="${(y(last.trading) + 3).toFixed(1)}" font-size="10" fill="var(--bone)">${last.trading} traded</text>
    <text x="${W - R + 8}" y="${(y(last.keepers) + (Math.abs(y(last.trading) - y(last.keepers)) < 12 ? 15 : 3)).toFixed(1)}" font-size="10" fill="var(--bone)">${last.keepers} keepers</text>
    <text x="${L}" y="${H - 6}" font-size="9" fill="var(--dim)">${h(fmtT(t0))}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="9" fill="var(--dim)">${h(fmtT(t1))}</text>
  </svg>`;
}

/** The two headline counts, shared by both layouts. */
function coverageTiles(cov, t) {
  const tile = (label, value, sub) => `<div class="ex-kpi"><div class="ex-k">${h(label)}</div><div class="ex-v">${value}</div><div class="mx-note">${h(sub)}</div></div>`;
  return `<div class="ex-kpis">${tile("Systems traded in", n(cov.trading), `${n(cov.tradingLast24h)} in the last 24h`)}${tile("Systems with keepers", n(cov.keepers), "a keeper stationed there now")}${t ? tile("Keeper systems we trade in", `${n(t.keeperSystemsTrading)} of ${n(t.systemsWithKeepers)}`, `${n(t.touredSystemsTrading)} toured, ${n(t.visitedSystemsTrading)} explorer-visited trade`) : ""}${t && t.tradedAfterExplorer !== undefined ? tile("First traded after an explorer got there", `${n(t.tradedAfterExplorer)} of ${n(t.tradedAfterExplorer + t.tradedBeforeExplorer)}`, `${n(t.tradedNoExplorerSeen)} trading systems had no explorer jump in this window`) : ""}</div>`;
}

export function mountExplorers(root, { api, compact = false } = {}) {
  let windowHours = Number(lsGet("explorersWindow", "72")) || 72;
  let data = null;
  let error = "";
  let timer = null;

  root.innerHTML = `<div class="mx-bar">
      <span class="mx-title">Explorers</span>
      <div class="mx-ranges" id="ex-ranges">${WINDOWS.map((w) => `<button data-w="${w}"${w === windowHours ? ' class="on"' : ""}>${w >= 168 ? "7d" : `${w}h`}</button>`).join("")}</div>
    </div>
    <div class="mx-purpose">What the explorers are doing, the systems they have looked at (toured = an explorer finished a tour; rejected = under the worth threshold: fewer than the minimum markets or no shipyard; not toured yet = surveyed in passing), and the keepers bought and stationed. Read-only.</div>
    <div class="mx-note" id="ex-note"></div>
    <div id="ex-body"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  $("ex-ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-w]");
    if (!b) return;
    windowHours = Number(b.dataset.w);
    lsSet("explorersWindow", String(windowHours));
    $("ex-ranges").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    load();
  });

  async function load() {
    try {
      data = await api("GET", `/api/ops/explorers?sinceHours=${windowHours}`);
      error = "";
    } catch (err) {
      error = err.message || String(err);
    }
    render();
  }

  function render() {
    if (error) { $("ex-note").textContent = error; return; }
    if (!data) { $("ex-note").textContent = "Loading…"; return; }
    const t = data.totals;
    const now = Date.parse(data.asOf);
    $("ex-note").textContent = `${t.explorers} explorer${t.explorers === 1 ? "" : "s"} · ${t.systemsToured} toured, ${t.systemsSurveyed} not toured yet, ${t.systemsRejected} rejected · ${t.keepersBought} keeper${t.keepersBought === 1 ? "" : "s"} bought (${n(t.keeperSpend)}c) · ${t.jumps} jumps (${n(t.jumpSpend)}c) in the last ${data.windowHours}h · updated ${new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const ships = data.explorers.map((e) => `<tr>
        <td><b>${h(e.ship)}</b></td>
        <td>${h(e.system)}<div class="mx-note">${h(e.waypoint)}</div></td>
        <td>${h(e.nav)}</td>
        <td>${h(e.doing)}${e.tour ? `<div class="mx-note">touring ${h(e.tour.system)}, ${e.tour.stopsLeft} stop${e.tour.stopsLeft === 1 ? "" : "s"} left</div>` : ""}</td>
        <td>${e.fuelPct}%</td>
        <td>${e.jumps}<div class="mx-note">${n(e.jumpSpend)}c</div></td>
        <td>${e.visited.map((v) => `<span class="ex-visit">${h(v.system)} ${verdict(v.verdict)} <span class="mx-note">${h(ago(v.at, now))}</span></span>`).join("") || `<span class="mx-note">no jumps in this window</span>`}</td>
      </tr>`).join("");

    const systems = data.systems.map((s) => `<tr>
        <td>${h(s.system)}</td><td>${verdict(s.verdict)}</td><td>${s.markets}</td><td>${s.shipyards}</td>
        <td>${s.keepersStationed}${s.keepersBought ? ` <span class="mx-note">(${s.keepersBought} bought)</span>` : ""}</td>
        <td>${s.trading ? "yes" : `<span class="mx-note">no</span>`}</td>
        <td class="mx-note">${h(ago(s.at, now))}</td></tr>`).join("");

    const keepers = data.keepers.map((k) => `<tr>
        <td>${h(k.ship)}</td><td>${h(k.market)}</td><td>${h(k.system)}</td>
        <td class="mx-note">${h(k.hull.replace("SHIP_", ""))} at ${h(k.yard)}</td>
        <td>${n(k.price)}c</td><td class="mx-note">${h(ago(k.at, now))}</td></tr>`).join("");

    if (compact) { $("ex-body").innerHTML = cards(data, now); return; }
    $("ex-body").innerHTML = `
      <div class="panel"><div class="panel-h"><span class="title">Coverage</span><span class="count">cumulative this week</span></div>
        <div class="panel-b">${coverageTiles(data.coverage, t)}${growthChart(data.coverage)}</div></div>
      <div class="panel"><div class="panel-h"><span class="title">Explorer ships</span><span class="count">${data.explorers.length}</span></div>
        <div class="panel-b" style="padding:0">${data.explorers.length ? `<table><tr><th>Ship</th><th>Where</th><th>Nav</th><th>Doing</th><th>Fuel</th><th>Jumps</th><th>Recent systems</th></tr>${ships}</table>` : `<div class="empty">No ship has the explorer role. Set one on the Ships tab.</div>`}</div></div>
      <div class="panel"><div class="panel-h"><span class="title">Systems looked at</span><span class="count">newest ${data.systems.length}</span></div>
        <div class="panel-b" style="padding:0">${systems ? `<table><tr><th>System</th><th>Verdict</th><th>Markets</th><th>Yards</th><th>Keepers</th><th>Trading</th><th>When</th></tr>${systems}</table>` : `<div class="empty">Nothing surveyed yet.</div>`}</div></div>
      <div class="panel"><div class="panel-h"><span class="title">Keepers bought and stationed</span><span class="count">${t.keepersBought} in ${data.windowHours}h</span></div>
        <div class="panel-b" style="padding:0">${keepers ? `<table><tr><th>Keeper</th><th>Stationed at</th><th>System</th><th>Bought</th><th>Price</th><th>When</th></tr>${keepers}</table>` : `<div class="empty">No keeper bought in this window.</div>`}</div></div>`;
  }

  /** The same three lists as stacked cards, for a phone: a table of seven columns does not fit. */
  function cards(d, now) {
    const t = d.totals;
    const ships = d.explorers.map((e) => `<div class="card">
        <div class="row1"><span class="who">${h(e.ship)}</span><span class="amt">${h(e.system)} · ${h(e.nav)}</span></div>
        <div class="detail">${h(e.doing)}${e.tour ? `<br>touring ${h(e.tour.system)}, ${e.tour.stopsLeft} stop${e.tour.stopsLeft === 1 ? "" : "s"} left` : ""}<br>fuel ${e.fuelPct}% · ${e.jumps} jump${e.jumps === 1 ? "" : "s"} (${n(e.jumpSpend)}c)</div>
        <div class="detail">${e.visited.map((v) => `${h(v.system)}${v.verdict ? ` ${h(VERDICT[v.verdict]?.label ?? v.verdict)}` : ""} ${h(ago(v.at, now))}`).join("<br>") || "no jumps in this window"}</div>
      </div>`).join("");
    const systems = d.systems.map((s) => `<div class="card${s.verdict === "rejected" ? "" : " info"}">
        <div class="row1"><span class="who">${h(s.system)}</span><span class="amt">${h(VERDICT[s.verdict]?.label ?? s.verdict)}</span></div>
        <div class="detail">${s.markets} market${s.markets === 1 ? "" : "s"} · ${s.shipyards} yard${s.shipyards === 1 ? "" : "s"} · ${s.keepersStationed} keeper${s.keepersStationed === 1 ? "" : "s"}${s.keepersBought ? ` (${s.keepersBought} bought)` : ""} · ${s.trading ? "trading" : "not trading"} · ${h(ago(s.at, now))}</div>
      </div>`).join("");
    const keepers = d.keepers.map((k) => `<div class="card">
        <div class="row1"><span class="who">${h(k.ship)}</span><span class="amt">${n(k.price)}c</span></div>
        <div class="detail">at ${h(k.market)}<br>${h(k.hull.replace("SHIP_", ""))} bought at ${h(k.yard)} · ${h(ago(k.at, now))}</div>
      </div>`).join("");
    return `<div class="sec-h">Coverage</div><div class="card">${coverageTiles(d.coverage, t)}${growthChart(d.coverage, true)}</div>
      <div class="sec-h">Explorer ships <span class="n">${d.explorers.length}</span></div>${ships || `<div class="detail">No ship has the explorer role.</div>`}
      <div class="sec-h">Systems looked at <span class="n">${d.systems.length}</span></div>${systems || `<div class="detail">Nothing surveyed yet.</div>`}
      <div class="sec-h">Keepers bought and stationed <span class="n">${t.keepersBought}</span></div>${keepers || `<div class="detail">No keeper bought in this window.</div>`}`;
  }

  return {
    show() {
      load();
      clearInterval(timer);
      timer = setInterval(load, REFRESH_MS);
    },
    hide() {
      clearInterval(timer);
      timer = null;
    },
  };
}
