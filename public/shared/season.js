/**
 * Season screen: the multi-week plan and the analysis reports, shared so Deck (and Tower) mount it the same way.
 *
 *   const s = mountSeason(rootEl, { api });
 *   s.show();  // fetches, starts a slow refresh of the open tab
 *   s.hide();  // stops it
 *
 * Tabs:
 *   This week  the phase, the goals with live status, the week's numbers and the top suggestions   GET /api/season
 *   Insights   the analysis report for a window (findings, routes, markets, price moves, changes)  GET /api/ops/analysis
 *   Weeks      every week of the season and the saved reports                                      GET /api/ops/findings_history
 *   Plan       set the phase, goals and notes; close the week; start or end a season               PUT /api/season/week …
 *
 * Suggestions are advisory: they show the tool and arguments that would apply them, and nothing here applies them.
 */
import { escapeHtml } from "/shared/domain.js";

const TABS = [
  { key: "week", label: "This week" },
  { key: "insights", label: "Insights" },
  { key: "weeks", label: "Weeks" },
  { key: "plan", label: "Plan" },
];
const WINDOWS = [6, 24, 72];
const REFRESH_MS = 120_000;

const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* private window: fine */ } };
const h = (s) => escapeHtml(String(s ?? ""));

const compact = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const x = Number(n);
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(x));
};
const share = (x) => (x === null || x === undefined ? "—" : `${(Number(x) * 100).toFixed(1)}%`);
const tone = (n) => (n > 0 ? "good" : n < 0 ? "bad" : "");
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** How a goal's measure reads: shares as percentages, ratios to two places, the rest compact. */
function measure(metric, v) {
  if (v === null || v === undefined) return "—";
  if (metric === "overheadShare") return share(v);
  if (metric === "estimateAccuracy") return Number(v).toFixed(2);
  return compact(v);
}

function goalTargetText(g) {
  if (!g.metric) return "by hand";
  const cmp = g.comparator ?? "";
  if (g.target !== undefined && g.target !== null) return `${cmp === "<=" ? "at most" : cmp === ">=" ? "at least" : ""} ${measure(g.metric, g.target)}`.trim();
  if (g.changePct !== undefined) {
    const base = g.baseline === null || g.baseline === undefined ? "baseline not known yet" : `from ${measure(g.metric, g.baseline)}`;
    return `${g.changePct > 0 ? "+" : ""}${g.changePct}% (${base})`;
  }
  return "—";
}

const statusChip = (s) => `<span class="ss-st ss-st-${h(s)}">${h(s)}</span>`;
const kpi = (label, value, sub = "", cls = "") => `<div class="kpi"><div class="k">${h(label)}</div><div class="v ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
const panel = (title, body, count = "") => `<div class="panel"><div class="panel-h"><span class="dot"></span><span class="title">${h(title)}</span><span class="count">${count}</span></div><div class="panel-b">${body}</div></div>`;
const empty = (text) => `<div class="empty">${h(text)}</div>`;

function suggestionHtml(s) {
  const call = s.tool ? `<code class="ss-call">${h(s.tool)} ${h(JSON.stringify(s.args ?? {}))}</code>` : "";
  return `<li class="ss-sugg"><div class="ss-sugg-a">${h(s.action)}</div><div class="ss-sugg-w">${h(s.why)} · ${h(s.confidence ?? "")}</div>${call}</li>`;
}

function findingHtml(f) {
  const ev = Object.entries(f.evidence ?? {}).filter(([, v]) => v !== null && v !== "").slice(0, 6)
    .map(([k, v]) => `<span class="mx-chip">${h(k)} ${h(typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 ? Number(v.toPrecision(3)) : compact(v)) : v)}</span>`).join("");
  return `<li class="ss-find ss-k-${h(f.kind)}">
    <div class="ss-find-h"><span class="ss-kind">${h(f.kind.replace(/_/g, " "))}</span><span class="ss-conf">${h(f.confidence)} · n=${h(f.sampleSize)}</span></div>
    <div class="ss-find-t">${h(f.headline)}</div>
    <div class="ss-ev">${ev}</div>
    ${f.suggestion ? `<ul class="ss-suggs">${suggestionHtml({ ...f.suggestion, confidence: f.confidence })}</ul>` : ""}
  </li>`;
}

function routeTable(rows) {
  if (!rows?.length) return empty("No completed trips in this window.");
  return `<table><thead><tr><th>Route</th><th class="num">Trips</th><th class="num">Net</th><th class="num">Per trip</th><th class="num">Per loaded h</th><th class="num">Positioning</th><th class="num">vs estimate</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td title="${h(r.ships?.join(" "))}">${h(r.key)}</td><td class="num">${r.trips} <span class="ss-dim">(${r.wins} won)</span></td>
    <td class="num ${tone(r.netProfit)}">${compact(r.netProfit)}</td><td class="num">${compact(r.profitPerTrip)}</td>
    <td class="num">${compact(r.profitPerLoadedHour)}</td><td class="num">${compact(r.positioningCosts)}</td>
    <td class="num">${r.actualVsExpected === null ? "—" : `${Math.round(r.actualVsExpected * 100)}% <span class="ss-dim">(${r.estimated})</span>`}</td></tr>`).join("")}</tbody></table>`;
}

function marketsTable(rows, model) {
  if (!rows?.length) return empty("No multi-lot runs measured in this window.");
  return `<table><thead><tr><th>Market</th><th class="num">Runs</th><th class="num">Move per lot</th><th class="num">Recovery</th><th class="num">Not back</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td>${h(m.key)}</td><td class="num">${m.clusters}</td>
    <td class="num ${m.medianImpactPerLot !== null && m.medianImpactPerLot > model * 1.5 ? "bad" : ""}">${m.medianImpactPerLot === null ? "—" : share(m.medianImpactPerLot)}</td>
    <td class="num">${m.medianRecoveryMinutes === null ? "—" : `${m.medianRecoveryMinutes} min`}</td><td class="num">${m.notRecovered}</td></tr>`).join("")}</tbody></table>`;
}

function movesTable(rows) {
  if (!rows?.length) return empty("No price moves over 5% in the snapshots for the markets we traded.");
  return `<table><thead><tr><th>Market</th><th class="num">Moves</th><th class="num">Us</th><th class="num">Others</th><th class="num">Both</th><th class="num">Unseen</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td title="${h(m.otherShips?.join(" "))}">${h(m.key)}</td><td class="num">${m.moves}</td><td class="num">${m.ours}</td><td class="num">${m.others}</td><td class="num">${m.both}</td><td class="num">${m.unexplained}</td></tr>`).join("")}</tbody></table>`;
}

function changesTable(rows) {
  if (!rows?.length) return empty("No settings changes recorded in this window.");
  return `<table><thead><tr><th>When</th><th>Setting</th><th>Change</th><th class="num">Profit/h before</th><th class="num">after</th><th class="num">Trips</th></tr></thead><tbody>${[...rows].reverse().map((c) => `
    <tr><td>${h(when(c.at))}</td><td>${h(c.setting)}</td><td class="ss-small">${h(JSON.stringify(c.before))} → ${h(JSON.stringify(c.after))}</td>
    <td class="num">${compact(c.windowBefore?.profitPerHour)}</td>
    <td class="num ${c.windowAfter ? tone(c.windowAfter.profitPerHour - c.windowBefore.profitPerHour) : ""}">${c.tooRecent ? "too recent" : compact(c.windowAfter?.profitPerHour)}</td>
    <td class="num">${c.windowBefore?.trips ?? 0} / ${c.windowAfter?.trips ?? "—"}</td></tr>`).join("")}</tbody></table>`;
}

function calibrationHtml(c) {
  if (!c?.fleet?.trips) return empty("No trips with a recorded estimate yet. Estimates are recorded from the 2026-10-15 deploy on.");
  const rows = (c.routes ?? []).slice(0, 10).map((r) => `<tr><td>${h(r.key)}</td><td class="num">${r.trips}</td><td class="num">${r.rawFactor}</td><td class="num">${r.factor}</td></tr>`).join("");
  return `<div class="ss-note">Fleet: trips earned <b>${Math.round(c.fleet.factor * 100)}%</b> of their estimate over ${c.fleet.trips} trips. Per route, shrunk toward the fleet's figure when the sample is small.</div>
    <table><thead><tr><th>Route</th><th class="num">Trips</th><th class="num">Raw</th><th class="num">Factor</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function mountSeason(root, { api } = {}) {
  let tab = lsGet("seasonTab", "week");
  let windowHours = Number(lsGet("seasonWindow", "24")) || 24;
  let season = null;     // GET /api/season
  let report = null;     // GET /api/ops/analysis
  let history = null;    // GET /api/ops/findings_history
  let openReport = null; // one saved report
  let draft = null;      // Plan tab's unsaved edits
  let error = "";
  let busy = false;
  let timer = null;

  root.innerHTML = `<div class="mx-bar">
      <div class="mx-ranges ss-tabs" id="ss-tabs">${TABS.map((t) => `<button data-tab="${t.key}">${t.label}</button>`).join("")}</div>
      <span class="mx-note" id="ss-note"></span>
    </div>
    <div id="ss-body" class="ss-body"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  async function load(force = false) {
    if (busy) return;
    busy = true;
    error = "";
    note("Loading…");
    try {
      if (tab === "week" || tab === "plan" || tab === "weeks" || !season || force) season = await api("GET", `/api/season${tab === "week" ? "" : "?live=0"}`);
      if (tab === "insights") report = await api("GET", `/api/ops/analysis?sinceHours=${windowHours}`);
      if (tab === "weeks") history = await api("GET", "/api/ops/findings_history?limit=30");
      if (tab === "plan" && !draft) draft = draftFrom(season);
      note("");
    } catch (err) {
      error = err.message || String(err);
      note(error);
    } finally {
      busy = false;
      render();
    }
  }

  function note(text) { const el = $("ss-note"); if (el) el.textContent = text; }

  function draftFrom(s) {
    if (!s?.week) return null;
    return { phase: s.week.phase, notes: s.week.notes ?? "", goals: (s.week.goals ?? []).map((g) => ({ ...g })) };
  }

  function render() {
    for (const b of $("ss-tabs").children) b.classList.toggle("on", b.dataset.tab === tab);
    const body = $("ss-body");
    if (tab === "week") body.innerHTML = renderWeek();
    else if (tab === "insights") body.innerHTML = renderInsights();
    else if (tab === "weeks") body.innerHTML = renderWeeks();
    else body.innerHTML = renderPlan();
  }

  // ── This week ──
  function renderWeek() {
    if (!season) return empty(error || "Loading…");
    if (!season.season) return renderStart();
    const w = season.week;
    const phase = season.phases.find((p) => p.key === w.phase);
    const live = season.live;
    const m = live?.metrics ?? {};
    const goals = w.goals ?? [];
    const met = goals.filter((g) => g.status === "met").length;
    const stale = w.staleUniverse ? `<div class="ss-banner">This week was opened in ${h(w.universeKey)}, and the universe is now ${h(season.universeKey)}. Close it in Plan to start the next week from its record.</div>` : "";
    const goalRows = goals.length ? `<table><thead><tr><th>Goal</th><th>Measure</th><th>Target</th><th class="num">Now</th><th>Status</th></tr></thead><tbody>${goals.map((g) => `
      <tr><td>${h(g.text)}${g.fromWeek ? ` <span class="ss-dim">(from week ${g.fromWeek})</span>` : ""}</td>
      <td>${h(season.metrics.find((x) => x.key === g.metric)?.label ?? "by hand")}</td><td>${h(goalTargetText(g))}</td>
      <td class="num">${g.metric ? measure(g.metric, g.measured) : "—"}</td><td>${statusChip(g.status)}</td></tr>`).join("")}</tbody></table>` : empty("No goals for this week yet. Add them in Plan.");
    const suggs = live?.suggestions?.length ? `<ul class="ss-suggs">${live.suggestions.map(suggestionHtml).join("")}</ul>` : empty("No suggestions in this window.");
    return `${stale}
      <div class="kpirow ss-kpis">
        ${kpi("Season", h(season.season.name), `week ${w.weekNo} · since ${h(when(w.openedAt))}`)}
        ${kpi("Phase", h(phase?.label ?? w.phase), h(phase?.summary ?? ""), "amber")}
        ${kpi("Profit / hour", compact(m.profitPerHour), live ? `over ${live.hours} h${live.pace?.sinceReset ? ` · since reset ${compact(live.pace.sinceReset.profitPerHour)}/h over ${live.pace.sinceReset.hours} h` : ""}` : "", tone(m.profitPerHour))}
        ${kpi("Overhead", share(m.overheadShare), "fuel and jumps / sales")}
        ${kpi("Trips", compact(m.trips), `net ${compact(m.netProfit)}`)}
        ${kpi("Goals met", `${met} / ${goals.length}`, "")}
      </div>
      <div class="cols2 ss-cols">
        ${panel("Goals", `<div style="padding:0">${goalRows}</div>`, `${met} met`)}
        ${panel("Suggestions", suggs, "advisory")}
      </div>
      ${live?.notes?.length ? `<div class="ss-note">${live.notes.map(h).join("<br>")}</div>` : ""}`;
  }

  function renderStart() {
    return panel("Start a season", `<div class="ss-form">
      <p class="ss-note">A season is a plan across several weekly universes: a phase and goals each week, a record at the end of each week, and the next week starts from it. A week that ends in Cross-system restarts at Recover, because a reset wipes the gate network.</p>
      <label>Name <input id="ss-new-name" maxlength="120" placeholder="Season 1"></label>
      <button class="btn pri" data-act="start">Start season</button></div>`);
  }

  // ── Insights ──
  function renderInsights() {
    const bar = `<div class="mx-ranges ss-win">${WINDOWS.map((x) => `<button data-win="${x}" class="${x === windowHours ? "on" : ""}">${x}h</button>`).join("")}<button data-act="refresh">Refresh</button></div>`;
    if (!report) return bar + empty(error || "Loading…");
    const s = report.summary;
    return `${bar}
      <div class="kpirow ss-kpis">
        ${kpi("Trips", compact(s.trips), `${s.tripsWithEstimate} with an estimate`)}
        ${kpi("Net trip profit", compact(s.netProfit), "after trip and positioning costs", tone(s.netProfit))}
        ${kpi("Profit / hour", compact(s.profitPerHour), `over ${report.window.hours} h`, tone(s.profitPerHour))}
        ${kpi("Overhead", share(s.overheadShare), "fuel and jumps / sales")}
        ${kpi("Positioning", compact(s.positioningCosts), "jumps and fuel before the buy")}
        ${kpi("Findings", compact(report.findings.length), `${report.suggestions.length} suggestions`)}
      </div>
      ${report.notes?.length ? `<div class="ss-note">${report.notes.map(h).join("<br>")}</div>` : ""}
      <div class="cols2 ss-cols">
        ${panel("Findings", report.findings.length ? `<ul class="ss-finds">${report.findings.map(findingHtml).join("")}</ul>` : empty("Nothing stands out in this window."), `${report.findings.length}`)}
        <div class="ss-stack">
          ${panel("Best routes", `<div style="padding:0">${routeTable(report.routes.best)}</div>`)}
          ${panel("Losing routes", `<div style="padding:0">${routeTable(report.routes.worst)}</div>`)}
        </div>
      </div>
      <div class="cols2 ss-cols">
        ${panel("Our price impact and market recovery", `<div style="padding:0">${marketsTable(report.markets, 0.045)}</div>`, "model 4.5% a lot")}
        ${panel("Who moved prices", `<div style="padding:0">${movesTable(report.priceMoves)}</div>`)}
      </div>
      <div class="cols2 ss-cols">
        ${panel("Settings changes, before and after", `<div style="padding:0">${changesTable(report.changes)}</div>`, "correlation, not proof")}
        ${panel("Calibration", calibrationHtml(report.calibration), "realized / estimated")}
      </div>`;
  }

  // ── Weeks ──
  function renderWeeks() {
    const weeks = season?.weeks ?? [];
    const weekRows = weeks.length ? `<table><thead><tr><th>Week</th><th>Universe</th><th>Phase</th><th>Opened</th><th>Closed</th><th class="num">Profit/h</th><th class="num">Overhead</th><th>Goals</th><th>Report</th></tr></thead><tbody>${[...weeks].reverse().map((w) => {
      const r = w.record;
      const gs = r?.goals ?? w.goals ?? [];
      return `<tr><td>${w.weekNo}</td><td class="ss-small">${h(w.universeKey ?? "—")}</td><td>${h(season.phases.find((p) => p.key === w.phase)?.label ?? w.phase)}</td>
        <td>${h(when(w.openedAt))}</td><td>${w.closedAt ? h(when(w.closedAt)) : "open"}</td>
        <td class="num">${compact(r?.metrics?.profitPerHour)}</td><td class="num">${share(r?.metrics?.overheadShare)}</td>
        <td>${gs.filter((g) => g.status === "met").length} met · ${gs.filter((g) => g.status === "missed").length} missed</td>
        <td>${w.findingsId ? `<button class="ss-link" data-report="${w.findingsId}">#${w.findingsId}</button>` : "—"}</td></tr>`;
    }).join("")}</tbody></table>` : empty("No season weeks yet.");
    const reports = history?.rows?.length ? `<table><thead><tr><th>#</th><th>Saved</th><th>Label</th><th>Universe</th><th>Window</th></tr></thead><tbody>${history.rows.map((r) => `
      <tr><td><button class="ss-link" data-report="${r.id}">#${r.id}</button></td><td>${h(when(r.capturedAt))}</td><td>${h(r.label ?? "")}</td><td class="ss-small">${h(r.universeKey ?? "—")}</td>
      <td class="ss-small">${h(when(r.windowStart))} → ${h(when(r.windowEnd))}</td></tr>`).join("")}</tbody></table>` : empty("No saved reports yet.");
    const save = `<div class="ss-form ss-inline"><input id="ss-cap-label" maxlength="200" placeholder="Label (optional)"><select id="ss-cap-hours">${[6, 24, 72, 168].map((x) => `<option value="${x}" ${x === 24 ? "selected" : ""}>${x}h</option>`).join("")}</select><button class="btn" data-act="capture">Save a report now</button></div>`;
    const detail = openReport ? panel(`Report #${openReport.id}${openReport.label ? ` · ${openReport.label}` : ""}`, (() => {
      const r = openReport.report;
      if (!r) return empty("Report not found.");
      return `<div class="ss-note">${h(when(r.window.from))} → ${h(when(r.window.to))} · ${r.summary.trips} trips · net ${compact(r.summary.netProfit)} · ${compact(r.summary.profitPerHour)}/h · overhead ${share(r.summary.overheadShare)}</div>
        <ul class="ss-finds">${(r.findings ?? []).slice(0, 12).map(findingHtml).join("") || empty("No findings.")}</ul>`;
    })(), `<button class="ss-link" data-act="close-report">close</button>`) : "";
    return `${detail}
      ${panel("Season weeks", `<div style="padding:0">${weekRows}</div>`, season?.season ? h(season.season.name) : "")}
      ${panel("Saved reports", `${save}<div style="padding:0">${reports}</div>`, "kept across resets")}`;
  }

  // ── Plan ──
  function renderPlan() {
    if (!season) return empty(error || "Loading…");
    if (!season.season) return renderStart();
    if (!draft) draft = draftFrom(season);
    const w = season.week;
    const phases = season.phases.map((p) => `<button data-phase="${p.key}" class="${draft.phase === p.key ? "on" : ""}" title="${h(p.summary)}">${h(p.label)}</button>`).join("");
    const metricOpts = (sel) => `<option value="">by hand</option>${season.metrics.map((m) => `<option value="${m.key}" ${sel === m.key ? "selected" : ""}>${h(m.label)}</option>`).join("")}`;
    const rows = draft.goals.map((g, i) => `
      <div class="ss-goal" data-i="${i}">
        <input class="ss-g-text" data-f="text" value="${h(g.text)}" maxlength="300" placeholder="What should this week achieve?">
        <select data-f="metric">${metricOpts(g.metric)}</select>
        ${g.metric ? `<select data-f="comparator"><option value="">auto</option><option value=">=" ${g.comparator === ">=" ? "selected" : ""}>at least</option><option value="<=" ${g.comparator === "<=" ? "selected" : ""}>at most</option></select>
          <select data-f="mode"><option value="target" ${g.changePct === undefined ? "selected" : ""}>target</option><option value="change" ${g.changePct !== undefined ? "selected" : ""}>% vs last week</option></select>
          <input data-f="${g.changePct !== undefined ? "changePct" : "target"}" type="number" step="any" value="${h(g.changePct ?? g.target ?? "")}" placeholder="${g.changePct !== undefined ? "-5" : "target"}">`
          : `<select data-f="status">${["pending", "met", "dropped"].map((s) => `<option ${g.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>`}
        ${g.fromWeek ? `<span class="ss-dim">from week ${g.fromWeek}</span>` : ""}
        <button class="ss-link" data-act="remove-goal" data-i="${i}">remove</button>
      </div>`).join("");
    return panel(`Week ${w.weekNo} plan`, `<div class="ss-form">
        <div class="ss-lbl">Phase</div>
        <div class="mx-ranges ss-phases">${phases}</div>
        <div class="ss-note">${h(season.phases.find((p) => p.key === draft.phase)?.summary ?? "")} A week that ends in Cross-system starts the next at Recover.</div>
        <div class="ss-lbl">Goals</div>
        ${rows || empty("No goals yet.")}
        <div><button class="btn" data-act="add-goal">Add goal</button></div>
        <div class="ss-lbl">Notes</div>
        <textarea id="ss-notes" rows="3" maxlength="4000" placeholder="What we're trying this week, and why">${h(draft.notes)}</textarea>
        <div class="ss-actions">
          <button class="btn pri" data-act="save">Save plan</button>
          <button class="btn" data-act="close-week">Close week ${w.weekNo}</button>
          <span class="ss-spacer"></span>
          <button class="btn deny" data-act="end-season">End season</button>
        </div>
        <div class="ss-note">Closing a week saves its analysis report, scores the goals and opens the next week from the record: the phase (Recover after Cross-system), and every missed or still-open goal.</div>
      </div>`, h(season.season.name));
  }

  async function act(fn) {
    try {
      busy = true;
      note("Saving…");
      season = await fn();
      draft = draftFrom(season);
      note("Saved");
    } catch (err) {
      note(err.message || String(err));
    } finally {
      busy = false;
      render();
    }
  }

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; lsSet("seasonTab", tab); render(); load(); return; }
    if (t.dataset.win) { windowHours = Number(t.dataset.win); lsSet("seasonWindow", String(windowHours)); report = null; render(); load(); return; }
    if (t.dataset.phase && draft) { draft.phase = t.dataset.phase; render(); return; }
    if (t.dataset.report) {
      try { openReport = (await api("GET", `/api/ops/findings_history?id=${Number(t.dataset.report)}`)).rows?.[0] ?? null; } catch (err) { note(err.message); }
      render();
      return;
    }
    switch (t.dataset.act) {
      case "refresh": load(true); break;
      case "close-report": openReport = null; render(); break;
      case "start": {
        const name = root.querySelector("#ss-new-name")?.value?.trim();
        if (!name) { note("Give the season a name."); return; }
        await act(() => api("POST", "/api/season", { name }));
        break;
      }
      case "add-goal": draft.goals.push({ text: "", status: "pending" }); render(); break;
      case "remove-goal": draft.goals.splice(Number(t.dataset.i), 1); render(); break;
      case "save": {
        draft.notes = root.querySelector("#ss-notes")?.value ?? draft.notes;
        const goals = draft.goals.filter((g) => g.text?.trim());
        await act(() => api("PUT", "/api/season/week", { phase: draft.phase, goals, notes: draft.notes }));
        break;
      }
      case "close-week":
        if (!window.confirm(`Close week ${season?.week?.weekNo}? Its report is saved, its goals are scored, and the next week opens.`)) return;
        await act(() => api("POST", "/api/season/week/close", {}));
        break;
      case "end-season":
        if (!window.confirm(`End the season "${season?.season?.name}"? Its weeks are kept.`)) return;
        await act(() => api("POST", "/api/season/end"));
        break;
      case "capture": {
        const label = root.querySelector("#ss-cap-label")?.value?.trim() || undefined;
        const sinceHours = Number(root.querySelector("#ss-cap-hours")?.value) || 24;
        try {
          note("Saving report…");
          const r = await api("POST", "/api/analysis/capture", { label, sinceHours });
          note(`Saved report #${r.id}`);
          history = await api("GET", "/api/ops/findings_history?limit=30");
        } catch (err) { note(err.message); }
        render();
        break;
      }
    }
  });

  // Plan edits: keep the draft in step with the form without re-rendering on every key.
  root.addEventListener("input", (e) => {
    const row = e.target.closest(".ss-goal");
    if (!row || !draft) return;
    const g = draft.goals[Number(row.dataset.i)];
    const f = e.target.dataset.f;
    if (!g || !f) return;
    if (f === "text") g.text = e.target.value;
    else if (f === "target") { g.target = e.target.value === "" ? undefined : Number(e.target.value); delete g.changePct; }
    else if (f === "changePct") { g.changePct = e.target.value === "" ? undefined : Number(e.target.value); delete g.target; }
  });
  root.addEventListener("change", (e) => {
    const row = e.target.closest(".ss-goal");
    if (!row || !draft) return;
    const g = draft.goals[Number(row.dataset.i)];
    const f = e.target.dataset.f;
    if (!g || !f) return;
    if (f === "metric") {
      g.metric = e.target.value || undefined;
      if (!g.metric) { delete g.target; delete g.changePct; delete g.comparator; delete g.baseline; }
      render();
    } else if (f === "comparator") g.comparator = e.target.value || undefined;
    else if (f === "status") g.status = e.target.value;
    else if (f === "mode") {
      if (e.target.value === "change") { g.changePct = g.changePct ?? -5; delete g.target; } else { g.target = g.target ?? 0; delete g.changePct; delete g.baseline; }
      render();
    }
  });

  return {
    show() {
      render();
      load();
      clearInterval(timer);
      // Only the live tabs refresh on their own; Plan never does, so an edit isn't overwritten.
      timer = setInterval(() => { if (tab === "week" || tab === "insights") load(); }, REFRESH_MS);
    },
    hide() { clearInterval(timer); timer = null; },
  };
}

/** A small read-only summary (Tower): season, week and phase, goals, and the top suggestions. */
export async function seasonCardHtml(api) {
  const s = await api("GET", "/api/season");
  if (!s.season) return `<div class="empty">No season yet. Start one from Deck's Season screen.</div>`;
  const w = s.week;
  const phase = s.phases.find((p) => p.key === w.phase);
  const goals = (w.goals ?? []).map((g) => `<li>${statusChip(g.status)} ${h(g.text)}${g.metric ? ` <span class="ss-dim">${measure(g.metric, g.measured)} / ${h(goalTargetText(g))}</span>` : ""}</li>`).join("");
  const suggs = (s.live?.suggestions ?? []).slice(0, 3).map((x) => `<li>${h(x.action)}</li>`).join("");
  return `<div class="ss-card">
    <div class="ss-card-h"><b>${h(s.season.name)}</b> · week ${w.weekNo} · <span class="ss-phase">${h(phase?.label ?? w.phase)}</span></div>
    <div class="ss-card-m">${compact(s.live?.metrics?.profitPerHour)}/h · overhead ${share(s.live?.metrics?.overheadShare)} · ${compact(s.live?.metrics?.trips)} trips</div>
    ${goals ? `<ul class="ss-card-l">${goals}</ul>` : `<div class="empty">No goals this week.</div>`}
    ${suggs ? `<div class="ss-lbl">Suggestions</div><ul class="ss-card-l">${suggs}</ul>` : ""}
  </div>`;
}
