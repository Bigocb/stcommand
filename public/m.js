/**
 * Tower — Home only, this pass. See docs/mobile-app-design.md for the
 * full IA (Fleet/Map/Markets/More follow later) and the approved visual
 * identity this file's markup/CSS implements.
 *
 * Deliberately thin: all data comes through the same shared/*.js store
 * every other UI version already uses (loadBridge/loadApprovals/
 * loadDispatch, the subscribe() reactive slices) — no new fetching layer.
 */
import { api, onUnauthorized } from "/shared/api.js";
import { login, probeSession } from "/shared/session.js";
import { enableAdmin, openAdmin, closeAdmin } from "/shared/admin.js";
import {
  state, bridge, fleetStatus, approvals, dispatchAssignments, dispatchRoutes, minerPreferences, intel,
  marketRoutes, marketSnapshots, contracts, missions, feeds, feedChains, chainHealth, doctrineRules, activity,
  priceGoods, priceWaypointsByGood, pricePoints,
  keeperMarketsCfg, keeperStationsCfg, keeperCoverList,
  subscribe, loadState, loadBridge, loadApprovals, loadDispatch, loadMarkets,
  loadProgramme, loadDoctrine, setDoctrine, loadActivity,
  loadGoods, loadPrices, loadKeepers,
} from "/shared/store.js";
import { startRateLimitIndicator } from "/shared/rateLimit.js";
import { mountMetrics } from "/shared/metrics.js";
import { cooldownHtml, startCooldownTicker, tickCooldowns, loadCollapsed, toggleCollapsed, roleRank } from "/shared/cooldown.js";
import { keeperCoverage, cargoValueText, cargoValueTitle, walletPlusHolds, paceSparkline, paceTrend, isNetworkError, DROPPED_REQUEST_NOTE, fmt, signed, escapeHtml, escapeAttr, countdown, shortWp, chainNote, worstConditionPct, shipTransitLerp, shipHeadingDeg, roleMismatchReason, fmtTime, chainHealthHtml } from "/shared/domain.js";

function fmTag(flightMode) {
  if (flightMode === "DRIFT") return `<span class="fm-tag fm-drift" title="Drifting: not enough fuel for cruise, very slow">drift</span>`;
  if (flightMode === "BURN") return `<span class="fm-tag fm-burn">burn</span>`;
  return "";
}

const $ = (id) => document.getElementById(id);

/* ── auth gate ─────────────────────────────
 * Deliberately scoped down from v6.js's gate: existing tenants only, no
 * register/onboarding flow — an operator setting up a brand-new agent
 * does that from desktop first. Same session-cookie mechanism underneath
 * (POST /api/gate/login), so a tenant already signed in on desktop is
 * already signed in here too — this only matters for a fresh browser/
 * private session.
 */
let authed = false;
onUnauthorized(() => showAuthGate("Session expired — sign in again."));

function showAuthGate(msg) {
  authed = false;
  $("auth-err").textContent = msg ?? "";
  $("app-root").hidden = true;
  $("auth-gate").hidden = false;
}

function hideAuthGate() {
  authed = true;
  $("auth-gate").hidden = true;
  $("app-root").hidden = false;
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("auth-token").value.trim();
  if (!token) return;
  try {
    const who = await login(token);
    hideAuthGate();
    if (who?.operator) enableAdmin($("tab-admin"));
    boot();
  } catch (err) {
    $("auth-err").textContent = err.message || "Could not reach the server.";
  }
});

/* ── tabs ──────────────────────────────────
 * Markets/More exist as real tab targets so the shell reads as
 * complete, but only render an inert placeholder until their own pass —
 * see docs/mobile-app-design.md's "What this pass does not do". Fleet
 * (the ship-card deck) and Map (the radar scope) are built below.
 */
let metricsScreen = null;
function setTab(name) {
  if (name !== "admin") closeAdmin();
  if (name === "admin") openAdmin();
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name));
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  // loadMarkets() on "fleet" too: the sheet's Custom route form reads
  // marketSnapshots for its buy/sell dropdowns, same staleness fix as
  // desktop's own loadViewData() comment for its Fleet tab's Job column.
  // loadProgramme() likewise: claimFor() (fleetRows(), below) reads
  // feeds/missions/contracts to show a feed/chain/mission/contract claim
  // on a ship's card, same as desktop's jobFor() — those previously only
  // ever loaded when the More tab had been opened, so a feed/mission claim
  // silently failed to show on Fleet until an operator happened to visit
  // More first this session. Confirmed live: a feed carrier's card showed
  // no claim at all on a fresh Fleet-tab visit.
  if (name === "fleet") { loadMarkets(); loadProgramme(); renderFleetView(); }
  if (name === "metrics") { metricsScreen ??= mountMetrics($("metrics-root"), { api, netWorth: () => (state?.agent ? walletPlusHolds(state.agent.credits ?? 0, state.cargoValues).total : undefined) }); metricsScreen.show(); }
  else metricsScreen?.hide();
  if (name === "markets") { loadMarkets(); loadGoods(); loadKeepers(); renderMarkets(); }
  if (name === "more") { loadBridge(); loadProgramme(); loadDoctrine(); loadGoods(); loadKeepers(); renderMore(); }
  if (name === "copilot") { loadCopilot(); loadCopilotSettings(); }
}
$("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setTab(b.dataset.tab);
});

/* ── status bar clock ── */
function renderStatusbar() {
  $("sb-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
setInterval(renderStatusbar, 30_000);
startRateLimitIndicator($("sb-time"));
startCooldownTicker();

/* ── home: cockpit tiles ──────────────────── */
function unassignedTraders() {
  const roleBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s.role]));
  // Not idle: a feed/mission carrier (claimFor), or a hold still carrying cargo mid-trade.
  return (state?.ships ?? []).filter(
    (s) => roleBy.get(s.symbol) === "trader" && !dispatchAssignments.some((a) => a.shipSymbol === s.symbol)
      && (s.cargo?.units ?? 0) === 0 && claimFor(s) == null,
  );
}

function renderTiles() {
  const ships = state?.ships ?? [];
  const stranded = fleetStatus.stranded?.length ?? 0;
  const unassigned = unassignedTraders().length;
  const pace = bridge.pace;
  const rate = pace ? pace.perHour1h : bridge.rate ?? 0;
  const trend = pace ? { up: " ▲", down: " ▼", flat: "" }[paceTrend(pace)] : "";
  const wph = walletPlusHolds(state?.agent?.credits ?? bridge.credits ?? 0, state?.cargoValues);

  $("home-tiles").innerHTML = `
    <div class="tile"><div class="k">Credits</div><div class="v">${fmt(state?.agent?.credits ?? bridge.credits ?? 0)}</div></div>
    <div class="tile"><div class="k">Credits + holds</div><div class="v">${fmt(wph.total)}${wph.partial ? "+" : ""}</div><div class="sub">holds ~${fmt(wph.holds)}</div></div>
    <div class="tile"><div class="k">Rate</div><div class="v ${rate >= 0 ? "green" : "red"}">${signed(rate)}<span class="sub"> /hr${trend}</span></div>${pace ? `<div class="sub">3h avg ${signed(pace.perHour3h)} · net trading</div>${paceSparkline(pace.series)}` : ""}</div>
    <div class="tile"><div class="k">Fleet</div><div class="v">${ships.length}<span class="sub"> hulls</span></div><div class="sub">${stranded} stranded · ${unassigned} unassigned</div></div>
  `;
  $("tb-note").textContent = stranded + unassigned + approvals.length > 0
    ? `${approvals.length + stranded + unassigned} need you`
    : "all clear";
}

/* ── home: triage feed ──────────────────────
 * Three sources, same shape every card renders from: an approval awaiting
 * a decision, a stranded ship, or a trader with no route/mission/contract
 * assignment at all (mirrors the desktop Fleet tab's Job column — see
 * jobFor() in v6.js — reduced here to just the "needs attention" case,
 * since Tower's Fleet screen, not Home, is where full per-ship job detail
 * belongs once it's built).
 */
function triageItems() {
  const items = [];
  for (const a of approvals) {
    items.push({
      kind: "approval", key: `a-${a.id}`, cls: "warn", id: a.id,
      who: a.kind, amt: a.cost != null ? `${fmt(a.cost)}c` : "",
      detail: a.detail, exp: a.expiresAt ? `auto-decides ${countdown(a.expiresAt)}` : "",
    });
  }
  for (const s of fleetStatus.stranded ?? []) {
    items.push({
      kind: "stranded", key: `s-${s.symbol}`, cls: "crit",
      who: s.symbol, amt: "Stranded",
      detail: `${s.waypointSymbol ?? "unknown position"}${s.reason ? ` · ${s.reason}` : ""}`, exp: "",
    });
  }
  for (const s of unassignedTraders()) {
    items.push({
      kind: "unassigned", key: `u-${s.symbol}`, cls: "info",
      who: s.symbol, amt: "Unassigned",
      detail: `Idle at ${s.nav?.waypointSymbol ?? "unknown"} · ready for a route`, exp: "",
    });
  }
  return items;
}

function renderTriage() {
  const items = triageItems();
  $("triage-count").textContent = items.length;
  const el = $("triage-list");
  if (!items.length) { el.innerHTML = '<div class="empty">Nothing waiting on you.</div>'; return; }
  el.innerHTML = items.map((it) => `
    <div class="card ${it.cls}">
      <div class="row1"><span class="who">${escapeHtml(it.who)}</span><span class="amt ${it.cls === "crit" ? "red" : it.cls === "warn" ? "amber" : ""}">${escapeHtml(it.amt)}</span></div>
      <div class="detail">${escapeHtml(it.detail)}</div>
      ${it.exp ? `<div class="exp">${escapeHtml(it.exp)}</div>` : ""}
      <div class="acts">
        ${it.kind === "approval"
          ? `<button class="btn pri" data-act="approve" data-id="${escapeHtml(it.id)}">Approve</button><button class="btn deny" data-act="deny" data-id="${escapeHtml(it.id)}">Deny</button>`
          : `<button class="btn ghost" disabled>Reassign — Fleet tab soon</button>`}
      </div>
    </div>`).join("");
}

// Mining/scanning fires constantly and drowns out everything else in a
// raw activity feed — the operator asked for "what's going on with the
// fleet," not a tick-by-tick extraction log. Filtered client-side only;
// the underlying /api/activity feed (and desktop's own view of it) is
// untouched.
const ACTIVITY_HIDDEN_KINDS = new Set(["extract", "survey", "siphon", "scan", "market", "shipyard", "flightmode", "navigate"]);

/** Recent buys/sells/feeds/deliveries, live on Home — moved here from a
 *  buried last-section spot on the More tab (operator report, 2026-09-25:
 *  "the other UIs have an activity feed where I can see buys and sells as
 *  they go by" — Tower had one, but nobody was finding it under nine other
 *  sections on More). Home is the one screen that's always polling, so
 *  this stays live without needing the More tab ever opened. */
function renderHomeActivity() {
  const el = $("home-activity");
  if (!el) return;
  const rows = activity.filter((a) => !ACTIVITY_HIDDEN_KINDS.has(a.kind)).slice(0, 20);
  if (!rows.length) { el.innerHTML = '<div class="empty">No activity yet.</div>'; return; }
  el.innerHTML = rows.map((a) => `
    <div class="act-row">
      <div class="when">${fmtTime(a.timestamp)}</div>
      <div class="txt">${escapeHtml(a.detail)}${a.credits == null ? "" : ` <span class="amt ${a.credits < 0 ? "neg" : "pos"}">${signed(a.credits)}</span>`}</div>
    </div>`).join("");
}

$("triage-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const decision = b.dataset.act === "approve" ? "approved" : "denied";
  b.disabled = true;
  try {
    await api("POST", `/api/approvals/${b.dataset.id}/decide`, { decision });
    await loadApprovals();
  } catch (err) {
    b.disabled = false;
  }
});

function fleetTabActive() {
  return document.querySelector('.screen[data-screen="fleet"]')?.classList.contains("on") ?? false;
}

subscribe("state", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderFleetView(); });
/* Fleet-wide AUTO / HALT, the same switch as Deck's top bar. HALT pauses every ship's loop (they keep
 * flying what they are on); AUTO resumes. The button shows the state the engine reports, not the one tapped. */
function renderFleetModes() {
  const halted = !!fleetStatus.paused;
  document.querySelectorAll("#fleet-modes button").forEach((b) => b.classList.toggle("on", (b.dataset.mode === "halt") === halted));
}
$("fleet-modes").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  const halt = b.dataset.mode === "halt";
  if (halt === !!fleetStatus.paused) return;
  try {
    await api("POST", halt ? "/api/fleet/pause" : "/api/fleet/resume", {});
    await loadBridge();
    renderFleetModes();
  } catch (err) {
    alert(err.message);
  }
});
subscribe("bridge", () => { renderFleetModes(); renderTiles(); renderTriage(); if (fleetTabActive()) renderFleetView(); });
subscribe("dispatch", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderFleetView(); });
subscribe("approvals", () => { renderTiles(); renderTriage(); });

/* ── Fleet: ship-card deck ──────────────────
 * A swipeable deck (tap Prev/Next or swipe) rather than a table — the
 * approved concept for this screen (docs/mobile-app-design.md). Each
 * card's job label reuses the same TraderAssignment vocabulary as the
 * desktop Fleet tab's Job column (jobFor() in v6.js): route/contract/
 * mission/warehouse buy-sell, or "unassigned" for a trader with no
 * assignment at all — the ships worth looking at first.
 */
let fleetIndex = 0;
let sheetShip = null;
let sendFormOpen = false;
let routePickerOpen = false;
let roleFormOpen = false;
let roleFormRole = null;
let detailsOpen = false;
// Custom route: an operator-chosen start/end market pair (and good) pinned
// to this ship, the same manual-override desktop's dispatch-custom form
// posts (POST /api/dispatch, role "direct", source "manual") — see that
// form's own comment in v6.js for why buyPrice/sellPrice/profitPerTrip are
// left for the server to default, and how it survives a restart.
let customRouteFormOpen = false;
// A miner/surveyor's preferred good — biases which survey deposit
// surveyPredicate() favors (src/engine/agent.ts), never a guarantee the
// field actually has that deposit. Same POST /api/miner-preference desktop's
// Dispatch pane form uses.
let minerPrefFormOpen = false;

/** Every one of the sheet's mutually-exclusive inline forms/pickers, closed
 *  together — a toggle opens exactly one of these at a time. */
let tourFormOpen = false;
let tourSystems = [];
function closeSheetForms() {
  tourFormOpen = false;
  sendFormOpen = false;
  routePickerOpen = false;
  roleFormOpen = false;
  roleFormRole = null;
  detailsOpen = false;
  customRouteFormOpen = false;
  minerPrefFormOpen = false;
}

const SHIP_ROLES = ["trader", "miner", "surveyor", "siphoner", "tour", "explorer", "scout", "keeper"];

function jobLabel(assignment) {
  if (!assignment) return null;
  const good = assignment.good;
  if (assignment.role === "direct") return `route: ${good}${chainNote(assignment)}`;
  if (assignment.role === "contractBuy") return `contract: ${good}`;
  if (assignment.role === "haul") return `mission: ${good}`;
  if (assignment.role === "buy") return assignment.missionBuy ? `mission: ${good}` : `warehouse buy: ${good}`;
  if (assignment.role === "sell") return `warehouse sell: ${good}`;
  return good;
}

/** What a ship (any role, not just trader) is signed to right now — a feed/
 *  chain claim, a mission claim, or (lowest priority, informational) cargo
 *  it holds that an active contract still wants. Mirrors jobFor() in v6.js
 *  — see that function's own comment for why non-trader roles need this
 *  too: a feed's crew is very often a miner, and a miner silently holding
 *  contract-protected cargo was exactly the "who's assigned to what"
 *  confusion this closes. */
function claimFor(ship) {
  const feed = feeds.find((f) => f.assignedShips?.includes(ship.symbol));
  if (feed) {
    const label = feed.chainName ? `chain: ${feed.chainName}` : `feed: ${feed.good}`;
    return `${label} → ${feed.targetWaypoint}`;
  }
  const mission = missions.find((m) => m.status !== "complete" && m.assignedShips?.includes(ship.symbol));
  if (mission) {
    const outstanding = (mission.materials ?? []).find((mm) => mm.fulfilled < mm.required);
    return `mission: ${outstanding?.tradeSymbol ?? "supplying"} @ ${mission.targetWaypoint}`;
  }
  const held = new Set((ship.cargo?.inventory ?? []).map((i) => i.symbol));
  const wanted = contracts.find((c) => c.accepted && !c.fulfilled && !c.abandoned && c.deliver.some((d) => held.has(d.tradeSymbol) && d.unitsFulfilled < d.unitsRequired));
  if (wanted) {
    const d = wanted.deliver.find((x) => held.has(x.tradeSymbol));
    return `holding contract cargo: ${d.tradeSymbol} (for ${d.destinationSymbol})`;
  }
  return null;
}

/** "X1-Y84-AZ6F" → "Y84" — the system part of a waypoint, without the sector. */
function sysShort(wp) {
  const parts = String(wp || "").split("-");
  return parts.length >= 2 ? parts[1] : "—";
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const statusBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s]));
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = statusBy.get(s.symbol);
    const assignment = dispatchAssignments.find((a) => a.shipSymbol === s.symbol);
    const claim = claimFor(s);
    // fleetStatusSummary()'s `wants` reads "scrap <yard>" while a sale order is
    // pending; that outranks the role, so surface it (and a way to cancel it).
    const wants = (fleetStatus.summary ?? []).find((x) => x.symbol === s.symbol)?.wants ?? "";
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      manual: !!st?.paused,
      selling: wants.startsWith("scrap"),
      job: claim ?? (st?.role === "trader" ? (jobLabel(assignment) ?? "unassigned") : null),
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      cargoValue: state?.cargoValues?.[s.symbol],
      condition: worstConditionPct(s) ?? 100,
      waypoint: s.nav?.waypointSymbol ?? "",
      nav: s.nav?.status ?? "",
      stranded: strandedBy.has(s.symbol),
      cooldown: cooldownHtml(s),
      // nav.route.arrival is the game's own committed ETA — only meaningful
      // while actually IN_TRANSIT (the API leaves it holding the last
      // flight's arrival time once a ship has landed). Same field/guard as
      // desktop's Fleet tab ETA column (fleetRows() in v6.js).
      eta: s.nav?.status === "IN_TRANSIT" ? s.nav?.route?.arrival : undefined,
      flightMode: s.nav?.status === "IN_TRANSIT" ? s.nav?.flightMode : undefined,
    };
  });
}

/** Time remaining until a ship's committed arrival, as "Xh Ym"/"Ym"/"<1m" —
 *  same format as desktop's fmtEta() in v6.js. "—" once already arrived or
 *  with no active transit, rather than a negative duration. */
function fmtEta(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function hullCard(row, extraClass) {
  const cls = row.stranded ? " crit" : row.job === "unassigned" ? " warn" : "";
  return `
    <div class="hull ${extraClass}${extraClass === "front" ? cls : ""}">
      <div class="hd"><span class="sym">${escapeHtml(row.symbol)}</span><span class="role">${escapeHtml(row.role)}</span></div>
      ${row.job ? `<div class="job">${row.job === "unassigned" ? "unassigned" : "→ " + escapeHtml(row.job)}</div>` : ""}
      <div class="gauges">
        <div class="gauge-row"><span class="g-k">Fuel</span><div class="g-track"><div class="g-fill${row.fuelCap && row.fuel / row.fuelCap < 0.25 ? " red" : ""}" style="width:${row.fuelCap ? (row.fuel / row.fuelCap) * 100 : 0}%"></div></div><span class="g-v">${row.fuel}/${row.fuelCap}</span></div>
        <div class="gauge-row"><span class="g-k">Hold</span><div class="g-track"><div class="g-fill amber" style="width:${row.cargoCap ? (row.cargo / row.cargoCap) * 100 : 0}%"></div></div><span class="g-v"${row.cargoValue ? ` title="${escapeAttr(cargoValueTitle(row.cargoValue))}"` : ""}>${row.cargoCap ? `${row.cargo}/${row.cargoCap}` : "—"}${cargoValueText(row.cargoValue) ? ` <span class="cv">${escapeHtml(cargoValueText(row.cargoValue))}</span>` : ""}</span></div>
        <div class="gauge-row"><span class="g-k">Hull</span><div class="g-track"><div class="g-fill${row.condition < 50 ? " red" : ""}" style="width:${row.condition}%"></div></div><span class="g-v">${row.condition}%</span></div>
      </div>
      <div class="at">${row.stranded ? "STRANDED · " : ""}${escapeHtml(shortWp(row.waypoint))} · ${escapeHtml((row.nav || "idle").replace(/_/g, " ").toLowerCase())} ${row.cooldown ?? ""}</div>
    </div>`;
}

function renderDeck() {
  const rows = fleetRows();
  if (!rows.length) {
    $("deck-stack").innerHTML = '<div class="empty">No ships in the register.</div>';
    $("deck-note").textContent = "";
    $("fleet-sheet").hidden = true;
    return;
  }
  if (fleetIndex >= rows.length) fleetIndex = 0;
  $("deck-note").textContent = `hull ${fleetIndex + 1} of ${rows.length}`;

  let html = "";
  if (rows.length > 2) html += hullCard(rows[(fleetIndex + 2) % rows.length], "back2");
  if (rows.length > 1) html += hullCard(rows[(fleetIndex + 1) % rows.length], "back1");
  html += hullCard(rows[fleetIndex], "front");
  $("deck-stack").innerHTML = html;

  // The deck always pairs a front card with its sheet; the roster (list)
  // view doesn't — it starts closed and only opens on a tap, since
  // showing one ship's action sheet the instant you switch to a screen
  // meant for scanning every ship at once defeats the point of that view.
  if (fleetView === "deck" || sheetOpen) renderSheet(rows[fleetIndex]);
  else $("fleet-sheet").hidden = true;
  tickCooldowns($("deck-stack"));
}

/* ── Fleet: roster (list) view ───────────────
 * "Who's assigned to what, all in one place" without swiping the deck
 * card by card — every ship as one compact row, tap to open the same
 * sheet the deck uses. Scales to a large fleet by scrolling, not paging.
 */
let fleetView = "deck";
let sheetOpen = false;

function renderFleetView() {
  // Always keeps fleetIndex in bounds and the sheet in sync, even while
  // the roster is the visible view — the deck stack itself just stays
  // hidden underneath, which costs nothing worth avoiding.
  renderDeck();
  if (fleetView === "list") renderRoster();
}

function renderRoster() {
  const rows = fleetRows();
  $("roster-hd").textContent = `${rows.length} hull${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) { $("roster-scroll").innerHTML = '<div class="empty">No ships in the register.</div>'; return; }
  const collapsed = loadCollapsed();
  const groups = new Map();
  rows.forEach((r, i) => {
    const g = groups.get(r.role) ?? [];
    g.push({ r, i });
    groups.set(r.role, g);
  });
  const rowHtml = ({ r, i }) => {
    const cls = r.stranded ? " crit" : r.job === "unassigned" ? " warn" : "";
    const jobTxt = r.job == null ? r.role : r.job;
    const jobCls = r.job === "unassigned" ? " unassigned" : "";
    const fuelPct = r.fuelCap ? Math.round((r.fuel / r.fuelCap) * 100) : 0;
    const etaTxt = fmtEta(r.eta);
    return `<button class="roster-row${cls}" data-idx="${i}">
      <span class="rr-id"><span class="sym">${escapeHtml(r.symbol)}</span><span class="role sys" title="${escapeAttr(r.waypoint)}">${escapeHtml(sysShort(r.waypoint))}</span></span>
      <span class="rr-job${jobCls}">${r.stranded ? "STRANDED · " : ""}${escapeHtml(jobTxt)} ${r.cooldown}</span>
      <span class="rr-stats">
        ${r.cargoCap ? `<span class="cg ${r.cargo > 0 ? "on" : "off"}" title="Cargo ${r.cargo}/${r.cargoCap}${cargoValueText(r.cargoValue) ? ` · ${cargoValueText(r.cargoValue)}` : ""}"></span>` : `<span class="cg none"></span>`}
        ${cargoValueText(r.cargoValue) ? `<span class="cv">${escapeHtml(cargoValueText(r.cargoValue))}</span>` : ""}
        ${r.fuelCap ? `<span class="fg ${fuelPct < 25 ? "low" : fuelPct < 50 ? "mid" : "ok"}" title="Fuel ${r.fuel}/${r.fuelCap} (${fuelPct}%)"></span>` : `<span class="fg none"></span>`}
        <span class="eta${etaTxt !== "—" ? " live" : ""}">${escapeHtml(etaTxt)}${fmTag(r.flightMode)}</span>
      </span>
    </button>`;
  };
  $("roster-scroll").innerHTML = [...groups.entries()]
    .sort((a, b) => roleRank(a[0]) - roleRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, items]) => {
      const isCollapsed = collapsed.has(role);
      // A collapsed group must not hide trouble: count what needs attention.
      const crit = items.filter(({ r }) => r.stranded).length;
      const warn = items.filter(({ r }) => !r.stranded && r.job === "unassigned").length;
      const badge = crit ? `<span class="grp-badge crit">${crit} stranded</span>` : warn ? `<span class="grp-badge warn">${warn} unassigned</span>` : "";
      return `<button class="roster-grp" data-grp="${escapeAttr(role)}" aria-expanded="${!isCollapsed}">
        <span class="chev">${isCollapsed ? "▸" : "▾"}</span><span class="g-name">${escapeHtml(role)}</span><span class="g-n">${items.length}</span>${badge}
      </button>${isCollapsed ? "" : items.map(rowHtml).join("")}`;
    }).join("");
  tickCooldowns($("roster-scroll"));
}

$("fleet-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  fleetView = b.dataset.view;
  sheetOpen = false;
  $("fleet-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  $("fleet-deck-view").hidden = fleetView !== "deck";
  $("fleet-roster-view").hidden = fleetView !== "list";
  renderFleetView();
});

$("roster-scroll").addEventListener("click", (e) => {
  const g = e.target.closest("button.roster-grp[data-grp]");
  if (g) { toggleCollapsed(g.dataset.grp); renderRoster(); return; }
  const b = e.target.closest("button.roster-row[data-idx]");
  if (!b) return;
  fleetIndex = Number(b.dataset.idx);
  sheetOpen = true;
  closeSheetForms();
  renderSheet(fleetRows()[fleetIndex]);
});

$("sheet-close").addEventListener("click", () => {
  sheetOpen = false;
  $("fleet-sheet").hidden = true;
});

function renderSheet(row) {
  // subscribe("state"/"bridge"/"dispatch") re-renders the whole Fleet view
  // (including this sheet) on every ~15s poll while the Fleet tab is open —
  // fine normally, but it rebuilds #sheet-actions' innerHTML from scratch,
  // which replaces an open inline form's fields with fresh empty ones and
  // steals focus mid-edit. The Custom route form has three fields (good +
  // two market selects); confirmed live: filling it out took longer than
  // one poll cycle, so the operator's own typing kept getting wiped before
  // they could finish. Bail out of the whole rebuild while a form field
  // inside this sheet has focus — same reasoning as desktop's dropdown-
  // focus guards (renderPriceGoods() etc.): mid-edit is exactly the moment
  // a "keep it fresh" rebuild is most disruptive. The explicit action
  // buttons (Assign, Save, …) still work off the untouched DOM either way.
  const active = document.activeElement;
  if (active && $("sheet-actions").contains(active) && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  sheetShip = row.symbol;
  $("fleet-sheet").hidden = false;
  // Deck's sheet is a fixed pairing with the front card — no point closing
  // it there, since the next card just replaces it. List's sheet is a
  // transient popover over a scan view, so it gets the explicit close.
  $("sheet-close").hidden = fleetView !== "list";
  $("sheet-who").textContent = row.symbol;
  $("sheet-sub").innerHTML = `${escapeHtml(row.role)} · ${escapeHtml((row.nav || "idle").replace(/_/g, " ").toLowerCase())} · ${escapeHtml(shortWp(row.waypoint))} ${row.cooldown ?? ""}`;
  tickCooldowns($("sheet-sub"));

  const holdBtn = row.manual
    ? `<button class="btn" data-act="release">Release</button>`
    : `<button class="btn" data-act="hold">Hold</button>`;
  // A ship with a pending sale order flies to a shipyard to be scrapped no
  // matter its role. Release (server side) now cancels that order.
  const cancelSaleBtn = row.selling
    ? `<button class="btn pri full" data-act="release">Cancel sale — stop flying to be scrapped</button>`
    : "";
  // Same /api/fleet/dock toggle endpoint desktop's .dock-toggle already
  // uses — Tower's sheet just never had a button wired to it. Disabled
  // (not hidden) mid-transit, matching the endpoint's own guard, so the
  // operator sees why rather than the button silently vanishing.
  const dockBtn = row.nav === "IN_TRANSIT"
    ? `<button class="btn" disabled title="in transit — wait for arrival">Dock / Undock</button>`
    : `<button class="btn" data-act="dock-toggle">${row.nav === "DOCKED" ? "Undock" : "Dock"}</button>`;
  let extra = "";
  if (sendFormOpen) {
    extra += `<div class="sheet-inline-form"><input id="send-wp-input" placeholder="Waypoint, e.g. X1-A-B2" /><button class="btn pri" data-act="send-go">Go</button></div>`;
  }
  if (tourFormOpen) {
    const here = (state?.ships ?? []).find((x) => x.symbol === row.symbol)?.nav?.systemSymbol;
    const opts = tourSystems
      .filter((x) => x.symbol !== here)
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((x) => `<option value="${escapeAttr(x.symbol)}">${escapeHtml(x.symbol)}${x.hasShipyard ? " · yard" : ""}${x.hasMarket ? " · markets" : ""}</option>`)
      .join("");
    extra += `<div class="sheet-inline-form">${
      opts
        ? `<select id="tour-system-sel" class="role-select" aria-label="System to tour">${opts}</select><button class="btn pri" data-act="tour-go">Send</button>`
        : '<div class="empty">No other charted systems yet.</div>'
    }</div><div class="detail">Walks the gate graph to that system, then works it (tour: its markets; scout: its uncharted waypoints). Each jump costs about 5k.</div>`;
  }
  if (routePickerOpen) {
    const top = [...dispatchRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 4);
    extra += `<div class="route-pick">${
      top.length
        ? top.map((r) => `<button data-act="route-pick" data-good="${escapeHtml(r.good)}"><span>${escapeHtml(r.good)}</span><b>${signed(r.profitPerTrip)}/trip</b></button>`).join("")
        : '<div class="empty">No profitable routes right now.</div>'
    }</div>`;
  }
  if (roleFormOpen) {
    const ship = (state?.ships ?? []).find((s) => s.symbol === row.symbol);
    const currentRole = roleFormRole ?? (SHIP_ROLES.includes(row.role) ? row.role : SHIP_ROLES[0]);
    const mismatch = ship ? roleMismatchReason(currentRole, ship) : null;
    extra += `<div class="role-form">
      <div class="sheet-inline-form">
        <select class="role-select" aria-label="New role">
          ${SHIP_ROLES.map((r) => `<option value="${r}" ${r === currentRole ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <button class="btn pri" data-act="role-set">Set</button>
      </div>
      ${mismatch ? `<div class="role-warn">⚠ ${escapeHtml(mismatch)}</div>` : ""}
      ${currentRole === "keeper" ? `<input class="role-keeper-wp" placeholder="keeper market waypoint (skip if already there)" />` : ""}
    </div>`;
  }
  // Same manual-override desktop's Dispatch pane custom-route form posts —
  // see the state flag's own comment. Trader-only, same as desktop's ship
  // roster for this form (a route is never something a miner/surveyor/etc.
  // flies).
  if (customRouteFormOpen) {
    const waypoints = [...new Set(marketSnapshots.map((s) => s.waypointSymbol))].sort();
    const opts = waypoints.map((wp) => `<option value="${escapeAttr(wp)}">${escapeHtml(wp)}</option>`).join("");
    extra += `<div class="custom-route-form">
      <input id="custom-route-good" placeholder="Good, e.g. IRON_ORE" style="text-transform:uppercase" />
      <select id="custom-route-buy" class="role-select" aria-label="Start (buy) market">${opts}</select>
      <select id="custom-route-sell" class="role-select" aria-label="End (sell) market">${opts}</select>
      <div class="sheet-inline-form">
        <button class="btn pri" data-act="custom-route-assign">Assign</button>
        <button class="btn ghost" data-act="custom-route-clear">Auto</button>
      </div>
    </div>`;
  }
  // Biases which deposit surveyPredicate() favors for this ship — see the
  // state flag's own comment. Miner-only, same as desktop's ship roster.
  if (minerPrefFormOpen) {
    const current = minerPreferences.find((p) => p.shipSymbol === row.symbol)?.good;
    extra += `<div class="custom-route-form">
      <input id="miner-pref-good-input" placeholder="Preferred good, e.g. IRON_ORE" style="text-transform:uppercase" value="${escapeAttr(current ?? "")}" />
      <div class="sheet-inline-form">
        <button class="btn pri" data-act="miner-pref-set">Save</button>
        <button class="btn ghost" data-act="miner-pref-clear-ship">Clear</button>
      </div>
    </div>`;
  }
  if (detailsOpen) {
    extra += renderShipDetails(row.symbol);
  }
  // A hand-assigned route (Assign route / Custom route) pins the trader to it
  // until cleared; surface the way back to dispatcher control right here.
  const manualRoute = dispatchAssignments.find((a) => a.shipSymbol === row.symbol && a.source === "manual");
  $("sheet-actions").innerHTML = `
    <button class="btn" data-act="send-toggle">Send to waypoint</button>
    ${holdBtn}
    ${dockBtn}
    ${cancelSaleBtn}
    <button class="btn" data-act="route-toggle">Assign route</button>
    ${row.role === "trader" ? `<button class="btn" data-act="custom-route-toggle">Custom route</button>` : ""}
    ${manualRoute ? `<button class="btn pri full" data-act="custom-route-clear">Release to auto — ${escapeHtml(manualRoute.good)} ${escapeHtml(shortWp(manualRoute.buyAt))} → ${escapeHtml(shortWp(manualRoute.sellAt))}</button>` : ""}
    ${row.role === "miner" ? `<button class="btn" data-act="miner-pref-toggle">Mining preference</button>` : ""}
    ${row.role === "tour" || row.role === "scout" ? `<button class="btn" data-act="tour-toggle">${row.role === "scout" ? "Send to system" : "Tour another system"}</button>` : ""}
    <button class="btn" data-act="repair">Repair</button>
    <button class="btn deny" data-act="sell">Sell / Scrap</button>
    <button class="btn ghost full" data-act="role-toggle">${roleFormOpen ? "Close" : `Change role (${escapeHtml(row.role)})`}</button>
    <button class="btn ghost full" data-act="details-toggle">${detailsOpen ? "Close full details" : "Full details"}</button>
    ${extra}
  `;
}

/** Cargo hold, loadout, modules, mounts, and install-from-cargo — the
 *  same fields desktop's ship-detail sheet shows, condensed into one
 *  scrollable block rather than desktop's row of sub-tabs (see
 *  docs/mobile-app-design.md: rarer detail lives behind one link here). */
function roleLabel(role) {
  return String(role).split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

function renderShipDetails(shipSymbol) {
  const ship = (state?.ships ?? []).find((s) => s.symbol === shipSymbol);
  if (!ship) return "";
  const part = (p) => p ? `<div class="detail-row"><span>${escapeHtml(p.name ?? p.symbol)}</span><span class="d">${escapeHtml(p.symbol)}</span></div>` : "";
  const cargo = ship.cargo?.inventory ?? [];
  const modules = ship.modules ?? [];
  const mounts = ship.mounts ?? [];
  const cargoComps = cargo.filter((i) => i.symbol.startsWith("MODULE_") || i.symbol.startsWith("MOUNT_"));

  const role = ship.registration?.role;
  const capacity = ship.cargo?.capacity ?? 0;

  return `<div class="ship-details">
    ${role ? `<div class="detail-row"><span>Type</span><span class="d">${escapeHtml(roleLabel(role))}</span></div>` : ""}
    <div class="dtl-h" title="${escapeAttr(cargoValueTitle(state?.cargoValues?.[ship.symbol]))}">Cargo hold ${ship.cargo?.units ?? 0}/${capacity}${cargoValueText(state?.cargoValues?.[ship.symbol]) ? ` · <span class="cv">${escapeHtml(cargoValueText(state?.cargoValues?.[ship.symbol]))}</span>` : ""}</div>
    ${cargo.length
      ? cargo.map((i) => `<div class="detail-row"><span>${i.units}u ${escapeHtml(i.symbol)}</span><button class="btn deny" data-act="jettison" data-good="${escapeHtml(i.symbol)}" data-units="${i.units}">Jettison</button></div>`).join("")
      : '<div class="empty">Hold is empty.</div>'}
    <div class="dtl-h">Loadout</div>
    ${part(ship.frame)}${part(ship.reactor)}${part(ship.engine)}
    <div class="dtl-h">Modules</div>
    ${modules.length
      ? modules.map((m) => `<div class="detail-row"><span>${escapeHtml(m.name)}</span><button class="btn deny" data-act="remove-comp" data-comp="${escapeHtml(m.symbol)}">Remove</button></div>`).join("")
      : '<div class="empty">No modules.</div>'}
    <div class="dtl-h">Mounts</div>
    ${mounts.length
      ? mounts.map((m) => `<div class="detail-row"><span>${escapeHtml(m.name)}</span><button class="btn deny" data-act="remove-comp" data-comp="${escapeHtml(m.symbol)}">Remove</button></div>`).join("")
      : '<div class="empty">No mounts.</div>'}
    <div class="dtl-h">Components in cargo</div>
    ${cargoComps.length
      ? cargoComps.map((i) => `<div class="detail-row"><span>${escapeHtml(i.symbol)}</span><button class="btn" data-act="install-comp" data-comp="${escapeHtml(i.symbol)}">Install</button></div>`).join("")
      : '<div class="empty">No modules/mounts in cargo.</div>'}
  </div>`;
}

$("sheet-actions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const ship = sheetShip;

  if (act === "send-toggle") { const next = !sendFormOpen; closeSheetForms(); sendFormOpen = next; return renderFleetView(); }
  if (act === "route-toggle") { const next = !routePickerOpen; closeSheetForms(); routePickerOpen = next; return renderFleetView(); }
  if (act === "tour-toggle") {
    const next = !tourFormOpen;
    closeSheetForms();
    tourFormOpen = next;
    if (next) {
      // Charted systems only (same list desktop's tour-dispatch picker offers):
      // a system this tenant has never seen isn't a real target.
      try { tourSystems = (await api("GET", "/api/galaxy/overview")).systems ?? []; }
      catch (err) { alert(err.message); tourFormOpen = false; }
    }
    return renderFleetView();
  }
  if (act === "tour-go") {
    const target = $("tour-system-sel")?.value;
    if (!target) return;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/tour-dispatch", { shipSymbol: ship, targetSystem: target });
      tourFormOpen = false;
      await loadBridge();
      await loadState();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "role-toggle") { const next = !roleFormOpen; closeSheetForms(); roleFormOpen = next; return renderFleetView(); }
  if (act === "details-toggle") { const next = !detailsOpen; closeSheetForms(); detailsOpen = next; return renderFleetView(); }
  if (act === "custom-route-toggle") { const next = !customRouteFormOpen; closeSheetForms(); customRouteFormOpen = next; return renderFleetView(); }
  if (act === "miner-pref-toggle") { const next = !minerPrefFormOpen; closeSheetForms(); minerPrefFormOpen = next; return renderFleetView(); }
  if (act === "jettison") {
    const { good, units } = b.dataset;
    if (!confirm(`Jettison ${units}u ${good} from ${ship}? This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/jettison", { shipSymbol: ship, good, units: Number(units) }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "remove-comp") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/remove-component", { shipSymbol: ship, componentSymbol: b.dataset.comp }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "install-comp") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/install", { shipSymbol: ship, componentSymbol: b.dataset.comp }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "role-set") {
    const role = $("sheet-actions").querySelector(".role-select")?.value;
    if (!role) return;
    const keeperMarket = $("sheet-actions").querySelector(".role-keeper-wp")?.value.trim() || undefined;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/role", { shipSymbol: ship, role, keeperMarket });
      roleFormOpen = false;
      roleFormRole = null;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }

  if (act === "send-go") {
    const wp = $("send-wp-input")?.value.trim();
    if (!wp) return;
    // A waypoint in another system can't be flown to directly. Offer the gate
    // path (tour dispatch) instead of failing with a fuel error.
    const targetSystem = wp.slice(0, wp.lastIndexOf("-"));
    const shipSystem = (state?.ships ?? []).find((s) => s.symbol === ship)?.nav?.systemSymbol;
    if (shipSystem && targetSystem && shipSystem !== targetSystem) {
      if (!confirm(`${wp} is in ${targetSystem}, not ${shipSystem}. Send ${ship} there by the gate path (tour dispatch)?\n\nIt walks the gates to ${targetSystem} (about 5k a jump) and its role becomes tour — change it back when it arrives.`)) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/tour-dispatch", { shipSymbol: ship, targetSystem });
        sendFormOpen = false;
        await loadBridge();
        await loadState();
      } catch (err) { alert(err.message); }
      return renderFleetView();
    }
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/dispatch", { shipSymbol: ship, waypointSymbol: wp });
      sendFormOpen = false;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "route-pick") {
    const route = dispatchRoutes.find((r) => r.good === b.dataset.good);
    b.disabled = true;
    try {
      await api("POST", "/api/dispatch", {
        shipSymbol: ship, good: b.dataset.good,
        buyAt: route?.buyAt, sellAt: route?.sellAt,
        buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
        profitPerTrip: route?.profitPerTrip,
      });
      routePickerOpen = false;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "custom-route-assign") {
    const good = $("custom-route-good")?.value.trim().toUpperCase();
    const buyAt = $("custom-route-buy")?.value;
    const sellAt = $("custom-route-sell")?.value;
    if (!good || !buyAt || !sellAt) { alert("good, start, and end are all required"); return; }
    if (buyAt === sellAt) { alert("start and end must be different markets"); return; }
    b.disabled = true;
    try {
      await api("POST", "/api/dispatch", { shipSymbol: ship, good, buyAt, sellAt });
      customRouteFormOpen = false;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "custom-route-clear") {
    b.disabled = true;
    try { await api("POST", "/api/dispatch", { shipSymbol: ship, clear: true }); await loadDispatch(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "miner-pref-set") {
    const good = $("miner-pref-good-input")?.value.trim().toUpperCase();
    if (!good) { alert("preferred good is required"); return; }
    b.disabled = true;
    try {
      await api("POST", "/api/miner-preference", { shipSymbol: ship, good });
      minerPrefFormOpen = false;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "miner-pref-clear-ship") {
    b.disabled = true;
    try { await api("POST", "/api/miner-preference", { shipSymbol: ship, clear: true }); await loadDispatch(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "hold" || act === "release") {
    b.disabled = true;
    try { await api("POST", `/api/fleet/${act}`, { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "dock-toggle") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/dock", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "repair") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/repair", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderFleetView();
  }
  if (act === "sell") {
    if (!confirm(`Sell ${ship} permanently? It will fly to the nearest shipyard and be scrapped there. This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/sell-ship", { shipSymbol: ship }); await loadState(); }
    catch (err) {
      if (isNetworkError(err)) { try { await loadState(); } catch (_) {} alert(DROPPED_REQUEST_NOTE); }
      else alert(err.message);
    }
    return renderFleetView();
  }
});

$("sheet-actions").addEventListener("change", (e) => {
  if (!e.target.classList.contains("role-select")) return;
  roleFormRole = e.target.value;
  renderFleetView();
});

$("sheet-handle").addEventListener("click", () => {
  const collapsed = $("sheet-actions").hidden;
  $("sheet-actions").hidden = !collapsed;
  $("sheet-sub").hidden = !collapsed;
});

function deckStep(delta) {
  const rows = fleetRows();
  if (!rows.length) return;
  fleetIndex = (fleetIndex + delta + rows.length) % rows.length;
  closeSheetForms();
  renderFleetView();
}
$("deck-prev").addEventListener("click", () => deckStep(-1));
$("deck-next").addEventListener("click", () => deckStep(1));

// Swipe, in addition to the Prev/Next buttons — a deck should feel
// swipeable, but a tap target is the accessible/discoverable fallback.
let deckTouchStartX = null;
$("deck-stack").addEventListener("touchstart", (e) => { deckTouchStartX = e.touches[0].clientX; }, { passive: true });
$("deck-stack").addEventListener("touchend", (e) => {
  if (deckTouchStartX == null) return;
  const dx = e.changedTouches[0].clientX - deckTouchStartX;
  deckTouchStartX = null;
  if (Math.abs(dx) < 40) return;
  deckStep(dx < 0 ? 1 : -1);
});

function marketsTabActive() {
  return document.querySelector('.screen[data-screen="markets"]')?.classList.contains("on") ?? false;
}
/* ── Co-pilot (More tab) ───────────────────────────────────
 * Chat with the tenant's co-pilot. A proposed fleet change comes back with a
 * "Queued … id abc123" reply; its Confirm/Cancel buttons send "/confirm <id>" or
 * "/cancel <id>" as ordinary chat messages, which the server handles itself. */
let cpBusy = false;
const cpBubble = (role, text) => `<div class="cp-msg ${role}">${escapeHtml(text)}</div>`;
function renderCopilotActions(reply) {
  const m = /Queued: .*?id ([0-9a-f]{6})\b/.exec(reply ?? "");
  $("cp-actions").innerHTML = m
    ? `<div class="cp-proposal"><button class="btn pri" data-cp="confirm" data-id="${m[1]}">Confirm ${m[1]}</button><button class="btn ghost" data-cp="cancel" data-id="${m[1]}">Cancel</button></div>`
    : "";
}
async function loadCopilot() {
  try {
    const { messages } = await api("GET", "/api/chat/history");
    $("cp-log").innerHTML = (messages ?? []).filter((x) => x.role === "user" || x.role === "assistant").slice(-30)
      .map((x) => cpBubble(x.role, x.content)).join("") || '<div class="empty">Ask about the fleet, prices or routes.</div>';
    $("cp-log").scrollTop = $("cp-log").scrollHeight;
  } catch (e) { $("cp-status").textContent = e.message; }
}
async function sendCopilot(message) {
  if (!message || cpBusy) return;
  cpBusy = true;
  $("cp-send").disabled = true;
  $("cp-status").textContent = "co-pilot is thinking…";
  $("cp-log").insertAdjacentHTML("beforeend", cpBubble("user", message));
  try {
    const res = await api("POST", "/api/chat", { message });
    $("cp-log").insertAdjacentHTML("beforeend", cpBubble("assistant", res.reply ?? ""));
    $("cp-log").scrollTop = $("cp-log").scrollHeight;
    renderCopilotActions(res.reply);
    $("cp-status").textContent = "";
  } catch (e) {
    $("cp-status").textContent = e.message;
  } finally {
    cpBusy = false;
    $("cp-send").disabled = false;
  }
}
/* Co-pilot settings: base URL, model and key. The key is write-only: it is never read back, so the field is
 * always blank and saving needs it again. Saving replaces the tenant's stored config and takes effect at once. */
async function loadCopilotSettings() {
  try {
    const cfg = await api("GET", "/api/settings/llm");
    $("cp-set-current").textContent = cfg.configured ? `Set: ${cfg.model} at ${cfg.baseUrl ?? "default endpoint"}` : "Not configured — add a base URL, model and key.";
    if (cfg.baseUrl) $("cp-base").value = cfg.baseUrl;
    if (cfg.model) $("cp-model").value = cfg.model;
  } catch (e) { $("cp-set-status").textContent = e.message; }
}
$("cp-gear").addEventListener("click", () => {
  const open = $("cp-settings").hidden;
  $("cp-settings").hidden = !open;
  $("cp-gear").setAttribute("aria-expanded", String(open));
});
$("cp-save").addEventListener("click", async () => {
  const apiKey = $("cp-key").value.trim();
  const model = $("cp-model").value.trim();
  if (!apiKey) { $("cp-set-status").textContent = "Paste the API key to save."; return; }
  if (!model) { $("cp-set-status").textContent = "Model is required."; return; }
  try {
    await api("POST", "/api/settings/llm", { provider: "custom", baseUrl: $("cp-base").value.trim() || undefined, model, apiKey });
    $("cp-key").value = "";
    $("cp-set-status").textContent = "Saved.";
    loadCopilotSettings();
  } catch (e) { $("cp-set-status").textContent = e.message; }
});
$("cp-clear").addEventListener("click", async () => {
  if (!confirm("Remove the co-pilot's API key? The chat will stop working until a new one is saved.")) return;
  try {
    await api("POST", "/api/settings/llm", {});
    $("cp-key").value = "";
    $("cp-set-status").textContent = "Key removed.";
    loadCopilotSettings();
  } catch (e) { $("cp-set-status").textContent = e.message; }
});
/* More tab's own segments, like Markets' (Work / Fleet / Rules). */
$("more-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mseg]");
  if (!b) return;
  document.querySelectorAll("#more-seg button").forEach((x) => x.classList.toggle("on", x === b));
  for (const seg of ["work", "fleet", "rules"]) $(`more-pane-${seg}`).hidden = seg !== b.dataset.mseg;
});
$("cp-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("cp-input").value.trim();
  if (!text) return;
  $("cp-input").value = "";
  sendCopilot(text);
});
$("cp-actions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cp]");
  if (!b) return;
  $("cp-actions").innerHTML = "";
  sendCopilot(`/${b.dataset.cp} ${b.dataset.id}`);
});

function moreTabActive() {
  return document.querySelector('.screen[data-screen="more"]')?.classList.contains("on") ?? false;
}
subscribe("markets", () => { if (marketsTabActive()) renderMarkets(); });

/* ── Markets: Routes / Yards segments ────────
 * Both segments are "where do I put money to make more" decisions, which
 * is why they share a tab rather than living separately (see
 * docs/mobile-app-design.md). Routes reuses the same profit-per-trip
 * computation the desktop Markets panel already shows; tapping a route
 * opens an inline ship picker rather than a separate sheet — assigning is
 * the only action this list needs.
 */
let mktSeg = "routes";
let openRouteGood = null;
let openYardGroup = null;
// Prices segment: same three inputs desktop's price chart takes
// (good/marketplace/timeframe) — see loadPrices()'s own comment in
// store.js for why "all markets" averages every market's price for a good
// into one line, and why picking a specific marketplace narrows to a real,
// trustworthy trend instead.
let priceGood = "";
let priceWaypoint = "";
let priceTimeframeMs = 86_400_000;

function tradersFor() {
  return (fleetStatus.ships ?? []).filter((s) => s.role === "trader");
}

// The same trip priced for each hold size flying (profitPerTrip is the biggest hold's), so a 40-unit shuttle's
// real take isn't read off a figure that assumes an 80-unit hauler. Shown only when the holds differ.
function holdLine(r) {
  const holds = Object.entries(r.profitByHold ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (holds.length < 2) return "";
  return `<div class="rr-holds">${holds.map(([u, p]) => `${u}u ${signed(p)}`).join(" · ")}</div>`;
}

function renderMarketRoutes() {
  const el = $("mkt-routes");
  if (!marketRoutes.length) { el.innerHTML = '<div class="empty">No profitable routes in fresh snapshots.</div>'; return; }
  const top = [...marketRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 20);
  el.innerHTML = top.map((r) => {
    const good = r.goodSymbol;
    // Keyed by good+buyAt+sellAt, not just good — the same good can have
    // several distinct routes in this list (different buy/sell pairs), and
    // matching by good alone mislabeled every same-good row as "flying"
    // whichever ship actually ran a *different* leg of that good (confirmed
    // live 2026-09-21: THEO-1 was shown as flying 3 CLOTHING routes it had
    // nothing to do with — it only ever ran one specific K90→J63 leg).
    const routeKey = `${good}|${r.buyAt}|${r.sellAt}`;
    const assigned = dispatchAssignments.find((a) => a.role === "direct" && a.good === good && a.buyAt === r.buyAt && a.sellAt === r.sellAt);
    const picker = openRouteGood === routeKey
      ? `<div class="ship-pick">${
          tradersFor().length
            ? tradersFor().map((s) => `<button data-act="assign-ship" data-good="${escapeHtml(good)}" data-buy="${escapeHtml(r.buyAt)}" data-sell="${escapeHtml(r.sellAt)}" data-ship="${escapeHtml(s.symbol)}"><span>${escapeHtml(s.symbol)}</span><span>${s.symbol === assigned?.shipSymbol ? "assigned" : "assign"}</span></button>`).join("")
            : '<div class="empty">No trader ships available.</div>'
        }</div>`
      : "";
    return `<div class="route-row">
      <div class="rr-top"><span class="rr-good">${escapeHtml(good)}</span><span class="rr-profit">${signed(r.profitPerTrip)}/trip</span></div>
      ${holdLine(r)}
      <div class="rr-legs">${escapeHtml(shortWp(r.buyAt))} → ${escapeHtml(shortWp(r.sellAt))} · margin ${Math.round(r.marginPct ?? 0)}%${r.crossSystem ? " · cross-system" : ""}${assigned ? ` · flying: ${escapeHtml(assigned.shipSymbol)}` : ""}</div>
      <div class="rr-actions"><button class="btn" data-act="route-toggle" data-key="${escapeHtml(routeKey)}">${openRouteGood === routeKey ? "Close" : "Assign a ship"}</button></div>
      ${picker}
    </div>`;
  }).join("");
}

/** One-line stat summary for a shipyard listing. Cargo comes from the cargo-hold
 *  modules the ship is sold with (the frame itself lists none); speed/crew/
 *  modules appear once a ship of ours has docked at that yard since the stats
 *  started being saved — until then those read "—". */
function shipStatsLine(y) {
  const cargo = (y.modules ?? []).filter((m) => (m.symbol ?? "").startsWith("MODULE_CARGO_HOLD")).reduce((n, m) => n + (m.capacity ?? 0), 0);
  const known = Array.isArray(y.modules);
  const bits = [
    `fuel ${fmt(y.fuelCapacity)}`,
    known ? `cargo ${fmt(cargo)}` : "cargo —",
    y.engineSpeed != null ? `speed ${y.engineSpeed}` : "speed —",
    y.crewRequired != null ? `crew ${y.crewRequired}${y.crewCapacity != null ? `/${y.crewCapacity}` : ""}` : "crew —",
    `slots ${y.moduleSlots}`,
    `mounts ${y.mountingPoints}`,
  ];
  return bits.join(" · ");
}

/** Labelled stat chips for a shipyard listing, replacing the old one-line
 *  "fuel 80 · cargo 15 · speed 9 · crew 0/0 · slots 3 · mounts 2" run, which wrapped
 *  at phone width and padded every ship with zeros that mean "none" (a probe
 *  has no fuel, cargo or crew). Zero/unknown values are left out. */
function shipStatChips(y) {
  const cargo = (y.modules ?? []).filter((m) => (m.symbol ?? "").startsWith("MODULE_CARGO_HOLD")).reduce((n, m) => n + (m.capacity ?? 0), 0);
  const chip = (label, value) => `<span class="chip"><i>${label}</i>${value}</span>`;
  const out = [];
  if (y.fuelCapacity > 0) out.push(chip("FUEL", fmt(y.fuelCapacity)));
  if (cargo > 0) out.push(chip("CARGO", fmt(cargo)));
  if (y.engineSpeed != null) out.push(chip("SPEED", y.engineSpeed));
  if (y.crewCapacity > 0) out.push(chip("CREW", `${y.crewRequired ?? 0}/${y.crewCapacity}`));
  if (y.moduleSlots > 0) out.push(chip("SLOTS", y.moduleSlots));
  if (y.mountingPoints > 0) out.push(chip("MOUNTS", y.mountingPoints));
  return out.length ? `<div class="yc-stats">${out.join("")}</div>` : "";
}

function renderMarketYards() {
  const el = $("mkt-yards");
  const yards = intel.shipyards ?? [], mods = intel.modules ?? [];
  if (!yards.length && !mods.length) { el.innerHTML = '<div class="empty">No shipyard/module intel yet — scout systems to expand.</div>'; return; }
  let html = "";
  if (yards.length) {
    const byType = new Map();
    for (const y of yards) { if (!byType.has(y.shipType)) byType.set(y.shipType, []); byType.get(y.shipType).push(y); }
    const groups = [...byType.values()].map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice)).sort((a, b) => a[0].purchasePrice - b[0].purchasePrice);
    html += `<div class="sec-h">Shipyards</div>`;
    for (const rows of groups) {
      const best = rows[0];
      const others = rows.slice(1, 3);
      const groupKey = best.shipType;
      const isOpen = openYardGroup === groupKey;
      // "also X, Y" used to be inert text — the single Buy button always
      // targeted `best` (cheapest), with no way to buy at any of the other
      // locations it's listing right next to it. Confirmed live: an
      // operator with a ship sitting at one of the "also" waypoints had no
      // way to buy there at all, only at the (possibly distant) cheapest
      // one. Tapping the location line now expands every candidate as its
      // own row with its own Buy button, same toggle pattern
      // openRouteGood already uses below for route assignment.
      const more = rows.length - 1;
      html += `<div class="ycard">
        <div class="yc-top">
          <span class="yc-name">${escapeHtml(best.shipTypeName)}</span>
          <span class="yc-price">${fmt(best.purchasePrice)}<small>c</small></span>
          <button class="btn pri" data-buy-ship="${escapeHtml(best.shipType)}" data-yard="${escapeHtml(best.waypointSymbol)}">Buy</button>
        </div>
        <div class="yc-where">
          <span>${escapeHtml(shortWp(best.waypointSymbol))}</span>
          ${more > 0 ? `<button class="yc-more${isOpen ? " open" : ""}" data-act="yard-toggle" data-group="${escapeHtml(groupKey)}">${isOpen ? "hide" : `+${more} more yard${more === 1 ? "" : "s"}`}</button>` : ""}
        </div>
        ${shipStatChips(best)}
      </div>`;
      if (isOpen) {
        html += `<div class="ship-pick">${rows.map((r) => `<button data-buy-ship="${escapeHtml(r.shipType)}" data-yard="${escapeHtml(r.waypointSymbol)}"><span>${escapeHtml(shortWp(r.waypointSymbol))}</span><span>${fmt(r.purchasePrice)}c</span></button>`).join("")}</div>`;
      }
    }
  }
  if (mods.length) {
    const bySym = new Map();
    for (const m of mods) { if (!bySym.has(m.symbol)) bySym.set(m.symbol, []); bySym.get(m.symbol).push(m); }
    const groups = [...bySym.values()].map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice)).sort((a, b) => a[0].purchasePrice - b[0].purchasePrice);
    html += `<div class="sec-h" style="margin-top:10px">Modules & mounts</div>`;
    for (const rows of groups) {
      const best = rows[0];
      const others = rows.slice(1, 3);
      html += `<div class="yline">
        <span class="yn">${escapeHtml(best.symbol)}<br><span class="rr-legs">${escapeHtml(shortWp(best.waypointSymbol))}${others.length ? ` · also ${others.map((o) => shortWp(o.waypointSymbol)).join(", ")}` : ""}</span></span>
        <span class="yp">${fmt(best.purchasePrice)}c</span>
      </div>`;
    }
  }
  el.innerHTML = html;
}

/** Covered / priority-but-uncovered / unflagged indicator for one market
 *  waypoint, ported from v6.js's own keeperBadge() (same three states, same
 *  /api/keeper/markets endpoint) — the operator's ask was to get this same
 *  at-a-glance-plus-tap-to-toggle affordance onto Tower, not just desktop. */
function keeperBadge(wp) {
  const cov = keeperCoverage(wp, keeperStationsCfg, keeperMarketsCfg, state?.ships);
  if (cov === "covered") return `<span class="keeper-badge covered" title="Keeper stationed here">● covered</span>`;
  if (cov === "enroute") return `<span class="keeper-badge pending" title="A keeper is on its way — this becomes covered when it arrives">◐ pending</span>`;
  if (cov === "pending") return `<span class="keeper-badge pending" data-wp="${escapeAttr(wp)}" role="button" title="On the keeper priority list, no keeper stationed yet — tap to remove">◐ pending</span>`;
  return `<span class="keeper-badge none" data-wp="${escapeAttr(wp)}" role="button" title="Not on the keeper priority list — tap to add">+ keeper</span>`;
}

async function toggleKeeperPriority(wp) {
  const next = keeperMarketsCfg.includes(wp) ? keeperMarketsCfg.filter((m) => m !== wp) : [...keeperMarketsCfg, wp];
  try {
    await api("POST", "/api/keeper/markets", { markets: next });
    await loadKeepers();
  } catch (err) { alert(err.message); }
}

/** Every waypoint this fleet has snapshotted selling `good`, each row's
 *  most recent buy/sell price where a snapshot exists — same source
 *  (priceWaypointsByGood, server-authoritative) desktop's price-waypoint
 *  dropdown reads, not a client-side filter of marketSnapshots, which is a
 *  staleness/system-filtered subset (see store.js's loadGoods() comment
 *  for the live bug that distinction fixed). */
function renderPriceMarketList() {
  const el = $("price-market-list");
  if (!el) return;
  const waypoints = priceWaypointsByGood[priceGood] ?? [];
  if (!waypoints.length) { el.innerHTML = '<div class="empty">No snapshots for this good yet.</div>'; return; }
  const byWp = new Map(marketSnapshots.filter((s) => s.goodSymbol === priceGood).map((s) => [s.waypointSymbol, s]));
  el.innerHTML = waypoints.map((wp) => {
    const snap = byWp.get(wp);
    return `<div class="detail-row"><span>${escapeHtml(shortWp(wp))} ${keeperBadge(wp)}</span><span class="d">${
      snap ? `buy ${fmt(snap.purchasePrice)} · sell ${fmt(snap.sellPrice)}` : "no recent snapshot"
    }</span></div>`;
  }).join("");
}
$("price-market-list").addEventListener("click", (e) => {
  const b = e.target.closest(".keeper-badge[data-wp]");
  if (b) toggleKeeperPriority(b.dataset.wp);
});
subscribe("keepers", () => {
  if (!marketsTabActive()) return;
  if (mktSeg === "prices") renderPriceMarketList();
  if (mktSeg === "systems") renderSystemMarkets();
});

/** Systems segment: every market this fleet has a snapshot for, grouped by
 *  system, each with the same keeper badge as the Prices list — the phone
 *  equivalent of desktop's Prices & snapshots list. */
let sysPick = "";
/** Every market ever priced, any age (GET /api/markets/known) — the Systems list
 *  must include stale ones, since those are the markets that need a keeper. */
let knownMarkets = [];
async function loadKnownMarkets() {
  try {
    const d = await api("GET", "/api/markets/known");
    knownMarkets = d.markets ?? [];
    if (marketsTabActive() && mktSeg === "systems") renderSystemMarkets();
  } catch { /* keep the last list */ }
}
function renderSystemMarkets() {
  const sel = $("sys-sel");
  const sysOf = (wp) => wp.slice(0, wp.lastIndexOf("-"));
  // Known (any age) first; fall back to the fresh snapshots until it has loaded.
  const byWp = new Map();
  for (const m of knownMarkets) byWp.set(m.waypointSymbol, { goods: m.goods, stamp: m.timestamp });
  if (!byWp.size) {
    for (const s of marketSnapshots) {
      const cur = byWp.get(s.waypointSymbol) ?? { goods: 0, stamp: "" };
      cur.goods += 1;
      if (s.timestamp > cur.stamp) cur.stamp = s.timestamp;
      byWp.set(s.waypointSymbol, cur);
    }
  }
  const counts = new Map();
  for (const wp of byWp.keys()) counts.set(sysOf(wp), (counts.get(sysOf(wp)) ?? 0) + 1);
  const systems = [...counts.keys()].sort();
  if (!systems.length) { $("sys-market-list").innerHTML = '<div class="empty">No market snapshots yet.</div>'; sel.innerHTML = ""; return; }
  if (!systems.includes(sysPick)) sysPick = systems[0];
  // Don't rebuild the picker while it is open (15s poll).
  if (document.activeElement !== sel) {
    sel.innerHTML = systems.map((s) => `<option value="${escapeAttr(s)}" ${s === sysPick ? "selected" : ""}>${escapeHtml(s)} (${counts.get(s)})</option>`).join("");
  }
  const rows = [...byWp.keys()].filter((wp) => sysOf(wp) === sysPick).sort();
  $("sys-market-list").innerHTML = rows.map((wp) => {
    const { goods, stamp } = byWp.get(wp);
    const mins = stamp ? Math.round((Date.now() - new Date(stamp).getTime()) / 60000) : null;
    const age = mins === null ? "" : mins < 90 ? `${mins}m` : mins < 2880 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    return `<div class="detail-row"><span>${escapeHtml(shortWp(wp))} ${keeperBadge(wp)}</span><span class="d">${goods} goods${age ? ` · ${age} old` : ""}</span></div>`;
  }).join("");
}
$("sys-sel").addEventListener("change", (e) => { sysPick = e.target.value; renderSystemMarkets(); });
$("sys-market-list").addEventListener("click", (e) => {
  const b = e.target.closest(".keeper-badge[data-wp]");
  if (b) toggleKeeperPriority(b.dataset.wp);
});

/** Compact SVG price line, same shape as desktop's renderPriceChart() (see
 *  v6.js) but in Tower's own palette (amber sell / green buy) — a
 *  from-scratch render rather than a shared function, since desktop's isn't
 *  in a module Tower imports from and this pass is deliberately thin (see
 *  this file's header comment). */
function renderPriceChart() {
  const el = $("price-chart-room");
  if (!el) return;
  if (!pricePoints.length) { el.innerHTML = '<div class="empty">No price history for this good yet.</div>'; return; }
  const W = Math.max(120, el.clientWidth || 320), H = Math.max(80, el.clientHeight || 140), P = 12;
  const sellVals = pricePoints.map((p) => Number(p.avg));
  const buyVals = pricePoints.map((p) => (p.buyAvg == null ? NaN : Number(p.buyAvg)));
  const hasBuy = buyVals.some((v) => Number.isFinite(v));
  const allVals = hasBuy ? [...sellVals, ...buyVals.filter(Number.isFinite)] : sellVals;
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => P + (i / (pricePoints.length - 1 || 1)) * (W - P * 2);
  const y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const toLine = (vals) => vals.map((v, i) => (Number.isFinite(v) ? `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}` : "")).join(" ");
  const sellLine = toLine(sellVals);
  const buyLine = hasBuy ? toLine(buyVals) : "";
  const lastIdx = pricePoints.length - 1;
  const lastBuy = buyVals[lastIdx];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="${P}" x2="${W - P}" y1="${y(min + span * f)}" y2="${y(min + span * f)}" stroke="rgba(255,199,120,0.12)" stroke-width="1"/>`).join("")}
    <path d="${sellLine}" fill="none" stroke="var(--amber)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(lastIdx)}" cy="${y(sellVals[lastIdx])}" r="2.5" fill="var(--amber)"/>
    ${hasBuy ? `<path d="${buyLine}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3,2"/>` : ""}
    ${hasBuy && Number.isFinite(lastBuy) ? `<circle cx="${x(lastIdx)}" cy="${y(lastBuy)}" r="2.5" fill="var(--green)"/>` : ""}
    <text x="${P}" y="${y(max)}" font-size="8" fill="var(--dim)">${Math.round(max)}</text>
    <text x="${P}" y="${y(min)}" font-size="8" fill="var(--dim)">${Math.round(min)}</text>
    ${hasBuy ? `<g transform="translate(${W - P - 66},${P - 4})" font-size="8">
      <line x1="0" y1="0" x2="9" y2="0" stroke="var(--amber)" stroke-width="1.5"/><text x="12" y="3" fill="var(--dim)">sell</text>
      <line x1="34" y1="0" x2="43" y2="0" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="3,2"/><text x="46" y="3" fill="var(--dim)">buy</text>
    </g>` : ""}
  </svg>`;
}

/** Rebuilds the good/marketplace <select> option lists — the marketplace
 *  list is scoped to whatever good is currently chosen and resets to "All
 *  markets" whenever the good changes, since a waypoint valid for one good
 *  rarely applies to another. Returns true when `priceGood` itself changed
 *  (e.g. priceGoods just arrived and picked a first default) so the caller
 *  knows to fetch — mirrors desktop's renderPriceGoods() guard against
 *  re-entering through the very "prices" notify loadPrices() itself fires. */
function renderPricePickers() {
  let goodChanged = false;
  const goodSel = $("price-good-sel");
  if (goodSel && document.activeElement !== goodSel) {
    if (!priceGoods.includes(priceGood)) {
      const next = priceGoods[0] ?? "";
      goodChanged = next !== priceGood;
      priceGood = next;
    }
    goodSel.innerHTML = priceGoods.map((g) => `<option value="${escapeAttr(g)}"${g === priceGood ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
  }
  const wpSel = $("price-wp-sel");
  if (wpSel && document.activeElement !== wpSel) {
    const waypoints = priceWaypointsByGood[priceGood] ?? [];
    if (priceWaypoint && !waypoints.includes(priceWaypoint)) priceWaypoint = "";
    wpSel.innerHTML = `<option value="">All markets</option>` + waypoints.map((wp) => `<option value="${escapeAttr(wp)}"${wp === priceWaypoint ? " selected" : ""}>${escapeHtml(wp)}</option>`).join("");
  }
  return goodChanged;
}

function renderPrices() {
  renderPricePickers();
  if (priceGood) loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
  renderPriceChart();
  renderPriceMarketList();
}

$("price-good-sel").addEventListener("change", (e) => {
  priceGood = e.target.value;
  priceWaypoint = "";
  renderPrices();
});
$("price-wp-sel").addEventListener("change", (e) => {
  priceWaypoint = e.target.value;
  loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});
$("price-timeframe-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-span]");
  if (!b) return;
  priceTimeframeMs = Number(b.dataset.span);
  $("price-timeframe-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});
subscribe("prices", () => {
  refreshFeedFormSelects();
  if (!marketsTabActive() || mktSeg !== "prices") return;
  // priceGoods just arriving (first visit, before any good was chosen) is
  // the one case this needs to trigger its own fetch — everything else
  // (a manual good/marketplace/timeframe change) already called
  // loadPrices() itself before this notify ever fired.
  const goodChanged = renderPricePickers();
  renderPriceChart();
  renderPriceMarketList();
  if (goodChanged && priceGood) loadPrices(priceGood, priceTimeframeMs, priceWaypoint);
});

function renderMarkets() {
  $("mkt-routes").hidden = mktSeg !== "routes";
  $("mkt-yards").hidden = mktSeg !== "yards";
  $("mkt-prices").hidden = mktSeg !== "prices";
  $("mkt-systems").hidden = mktSeg !== "systems";
  if (mktSeg === "prices") renderPrices();
  if (mktSeg === "systems") { renderSystemMarkets(); loadKnownMarkets(); }
  // Skipped while a picker is open, not just re-rendered around it — this is
  // called from the 15s poll subscription (loadMarkets() → subscribe()), and
  // rebuilding the list mid-tap replaces the exact buttons the operator is
  // reaching for. A touch's click can land on whatever new element ends up
  // under the same screen position after a rebuild, not the one that was
  // there when the tap started — confirmed live: choosing a specific "also"
  // shipyard location bought at the cheapest (first-listed) one instead, the
  // operator's tap landing on that row after a poll swapped the list out
  // from under them. Both toggle handlers still call their render function
  // directly to open/close a picker — only the periodic path is guarded.
  if (openRouteGood === null) renderMarketRoutes();
  if (openYardGroup === null) renderMarketYards();
}

$("mkt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-seg]");
  if (!b) return;
  mktSeg = b.dataset.seg;
  $("mkt-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  renderMarkets();
});

$("mkt-routes").addEventListener("click", async (e) => {
  const toggle = e.target.closest("button[data-act='route-toggle']");
  if (toggle) { openRouteGood = openRouteGood === toggle.dataset.key ? null : toggle.dataset.key; return renderMarketRoutes(); }
  const pick = e.target.closest("button[data-act='assign-ship']");
  if (pick) {
    pick.disabled = true;
    // Matched by good+buyAt+sellAt, not just good — same fix as the
    // "flying:" label above: a good with multiple listed routes must
    // assign the exact leg the operator opened this picker from, not
    // whichever route for that good happens to sort first in the list.
    const route = marketRoutes.find((r) => r.goodSymbol === pick.dataset.good && r.buyAt === pick.dataset.buy && r.sellAt === pick.dataset.sell);
    try {
      await api("POST", "/api/dispatch", {
        shipSymbol: pick.dataset.ship, good: route?.goodSymbol,
        buyAt: route?.buyAt, sellAt: route?.sellAt,
        buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
        profitPerTrip: route?.profitPerTrip,
      });
      openRouteGood = null;
      await loadDispatch();
    } catch (err) { alert(err.message); }
    renderMarketRoutes();
  }
});

$("mkt-yards").addEventListener("click", async (e) => {
  const toggle = e.target.closest("button[data-act='yard-toggle']");
  if (toggle) { openYardGroup = openYardGroup === toggle.dataset.group ? null : toggle.dataset.group; return renderMarketYards(); }
  const b = e.target.closest("button[data-buy-ship]");
  if (!b) return;
  b.disabled = true;
  try {
    await api("POST", "/api/fleet/buy", { shipType: b.dataset.buyShip, yardSymbol: b.dataset.yard });
    openYardGroup = null;
    await loadState();
  }
  catch (err) { alert(err.message); b.disabled = false; }
});

/* ── More: list-of-sections ──────────────────
 * Contracts, construction missions, doctrine — lower-frequency
 * checks, deliberately a plain scroll of sections rather than their own
 * tabs (docs/mobile-app-design.md). Starting a brand-new construction
 * mission and full doctrine editing stay desktop-only for now —
 * this covers the day-to-day accept/decline/toggle actions.
 */
function renderMoreContracts() {
  $("more-contract-count").textContent = contracts.length;
  const el = $("more-contracts");
  if (!contracts.length) { el.innerHTML = '<div class="empty">No contracts available.</div>'; return; }
  el.innerHTML = contracts.map((c) => {
    const total = c.onAccepted + c.onFulfilled;
    const done = (c.deliver ?? []).every((d) => d.unitsFulfilled >= d.unitsRequired);
    const delivRows = (c.deliver ?? []).map((d) => {
      const pct = d.unitsRequired ? Math.round((d.unitsFulfilled / d.unitsRequired) * 100) : 0;
      return `<div class="prog-row"><span>${escapeHtml(d.tradeSymbol)} → ${escapeHtml(shortWp(d.destinationSymbol))}</span><span class="pr-pct">${d.unitsFulfilled}/${d.unitsRequired}</span></div><div class="prog-track"><i style="width:${pct}%"></i></div>`;
    }).join("");
    return `<div class="card ${c.accepted && !done ? "info" : ""}">
      <div class="row1"><span class="who">${escapeHtml(c.type)} · ${escapeHtml(c.factionSymbol)}</span><span class="amt">${fmt(total)}c</span></div>
      ${delivRows || '<div class="detail">No deliveries listed</div>'}
      <div class="detail">${c.accepted ? `deadline ${countdown(c.deadline)}` : `accept by ${countdown(c.deadlineToAccept ?? c.deadline)}`}${c.abandoned ? " · not being worked" : ""}${c.declined ? " · declined" : ""}</div>
      <div class="acts">
        ${c.accepted
          ? (c.abandoned
              ? `<button class="btn pri" data-act="resume" data-id="${escapeHtml(c.id)}">Resume work</button>`
              : `<button class="btn deny" data-act="abandon" data-id="${escapeHtml(c.id)}">Stop working</button>`)
          : c.declined
            ? `<button class="btn" data-act="undecline" data-id="${escapeHtml(c.id)}">Allow</button><button class="btn pri" data-act="accept" data-id="${escapeHtml(c.id)}">Accept</button>`
            : `<button class="btn deny" data-act="decline" data-id="${escapeHtml(c.id)}">Decline</button><button class="btn pri" data-act="accept" data-id="${escapeHtml(c.id)}">Accept</button>`}
      </div>
    </div>`;
  }).join("");
}

function renderMoreMissions() {
  const chainEl = $("more-chain");
  if (chainEl) chainEl.innerHTML = chainHealthHtml(chainHealth);
  const el = $("more-missions");
  const active = missions.filter((m) => m.status === "active");
  if (!active.length) { el.innerHTML = '<div class="empty">No construction missions.</div>'; return; }
  el.innerHTML = active.map((m) => {
    const matRows = (m.materials ?? []).map((mat) => {
      const pct = mat.required ? Math.round((mat.fulfilled / mat.required) * 100) : 0;
      const done = mat.fulfilled >= mat.required;
      const only = m.pacing?.onlyMaterials ?? [];
      const held = only.length > 0 && !only.includes(mat.tradeSymbol);
      const hold = done ? "" : `<button class="btn mat-hold${held ? " warn" : ""}" data-act="toggle-material" data-wp="${escapeHtml(m.targetWaypoint)}" data-material="${escapeHtml(mat.tradeSymbol)}" title="${held ? "Held — tap to buy this material again" : "Buying — tap to hold this material"}">${held ? "held" : "buying"}</button>`;
      return `<div class="prog-row"><span>${escapeHtml(mat.tradeSymbol)} ${hold}</span><span class="pr-pct">${done ? "supplied" : `${mat.fulfilled}/${mat.required}`}</span></div><div class="prog-track"><i style="width:${pct}%"></i></div>`;
    }).join("");
    const allDone = (m.materials ?? []).every((mat) => mat.fulfilled >= mat.required);
    const crew = m.assignedShips ?? [];
    const target = m.carrierTarget ?? 1;
    return `<div class="card">
      <div class="row1">
        <span class="who">${escapeHtml(m.targetWaypoint)}</span>
        <span class="amt">${m.paused ? "paused" : allDone ? "complete" : "supplying"}</span>
      </div>
      <div class="detail">crew ${crew.length}/${target}${crew.length ? `: ${escapeHtml(crew.join(", "))}` : ""}</div>
      ${matRows}
      <div class="detail">Buy pacing — slows buying so the price is not outrun. Blank = default. Lot = units per purchase, gap = minutes between purchases, ceiling = % over the 24h low, recover = wait for the ask to fall back within this % of its pre-lot level.</div>
      <div class="acts mission-pacing">
        <span class="detail">lot</span><input type="number" class="mp-lot" min="1" placeholder="default" value="${m.pacing?.buyLotUnits ?? ""}" style="width:56px" aria-label="Units per purchase">
        <span class="detail">gap min</span><input type="number" class="mp-gap" min="1" placeholder="none" value="${m.pacing?.buyGapMin ?? ""}" style="width:72px" aria-label="Minutes between purchases">
        <span class="detail">ceiling %</span><input type="number" class="mp-cap" min="1" placeholder="40" value="${m.pacing?.maxInflationPct ?? ""}" style="width:68px" aria-label="Price ceiling percent">
        <span class="detail" title="Buy the next lot only once the ask is back within this % of its level before the previous lot">recover %</span><input type="number" class="mp-rec" min="1" placeholder="off" value="${m.pacing?.recoverPct ?? ""}" style="width:60px" aria-label="Recovery percent">
        <span class="detail" title="Hold purchases while credits are under this">cash floor</span><input type="number" class="mp-floor" min="1" placeholder="off" value="${m.pacing?.cashFloor ?? ""}" style="width:80px" aria-label="Cash floor">
        <span class="detail" title="Resume once credits are back above this (default floor + 25%)">resume</span><input type="number" class="mp-resume" min="1" placeholder="+25%" value="${m.pacing?.cashResume ?? ""}" style="width:80px" aria-label="Cash resume">
        <button class="btn" data-act="save-pacing" data-wp="${escapeHtml(m.targetWaypoint)}">Save pacing</button>
      </div>
      <div class="acts">
        <input type="number" class="carrier-target" data-wp="${escapeHtml(m.targetWaypoint)}" min="0" value="${target}" style="width:56px" aria-label="Crew target">
        <button class="btn" data-act="set-target" data-wp="${escapeHtml(m.targetWaypoint)}">Set crew size</button>
        ${m.paused
          ? `<button class="btn pri" data-act="resume" data-wp="${escapeHtml(m.targetWaypoint)}">Resume</button>`
          : `<button class="btn deny" data-act="pause" data-wp="${escapeHtml(m.targetWaypoint)}">Stop</button>`}
      </div>
    </div>`;
  }).join("");
}

function renderMoreChains() {
  const el = $("more-chains");
  if (!el) return;
  if (!feedChains.length) { el.innerHTML = '<div class="empty">No feeder chains.</div>'; return; }
  el.innerHTML = feedChains.map((c) => {
    const off = c.tiers.every((t) => t.paused);
    const tierRows = c.tiers.map((t, i) => `<div class="prog-row"><span>${i + 1}. ${escapeHtml(t.good)} → ${escapeHtml(t.targetWaypoint)}</span><span class="pr-pct">${(t.assignedShips ?? []).length}/${t.carrierTarget ?? 1}</span></div>`).join("");
    return `<div class="card">
      <div class="row1">
        <span class="who">${escapeHtml(c.name)}</span>
        <span class="amt">${off ? "off" : "on"}</span>
      </div>
      ${tierRows}
      <div class="acts">
        ${off
          ? `<button class="btn pri" data-act="chain-on" data-chain="${escapeHtml(c.chainId)}">Turn on</button>`
          : `<button class="btn deny" data-act="chain-off" data-chain="${escapeHtml(c.chainId)}">Turn off</button>`}
        <button class="btn" data-act="chain-remove" data-chain="${escapeHtml(c.chainId)}">Remove</button>
      </div>
    </div>`;
  }).join("");
}

$("more-chains").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, chain } = b.dataset;
  if (act === "chain-remove" && !confirm("Remove this whole chain? Every tier's crew is released; this isn't just a pause.")) return;
  b.disabled = true;
  try {
    if (act === "chain-on") await api("POST", "/api/feed-chains/resume", { chainId: chain });
    else if (act === "chain-off") await api("POST", "/api/feed-chains/pause", { chainId: chain });
    else if (act === "chain-remove") await api("POST", "/api/feed-chains/remove", { chainId: chain });
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreChains();
});

function renderMoreFeeds() {
  const el = $("more-feeds");
  if (!feeds.length) { el.innerHTML = '<div class="empty">No feeder tiers.</div>'; return; }
  el.innerHTML = feeds.map((f) => {
    const crew = f.assignedShips ?? [];
    const target = f.carrierTarget ?? 1;
    return `<div class="card">
      <div class="row1">
        <span class="who">${escapeHtml(f.good)} → ${escapeHtml(f.targetWaypoint)}</span>
        <span class="amt">${f.paused ? "off" : "on"}</span>
      </div>
      <div class="detail">${f.mine ? "mined" : f.buyAt ? `buy @ ${escapeHtml(shortWp(f.buyAt))}` : "bought"}${f.chainName ? ` · chain: ${escapeHtml(f.chainName)}` : ""} · crew ${crew.length}/${target}${crew.length ? `: ${escapeHtml(crew.join(", "))}` : ""} · gap ${f.sellGapMs ? `${Math.round(f.sellGapMs / 60_000)}m` : "default"}${f.stopAtSupply ? ` · stop at ${escapeHtml(f.stopAtSupply.toLowerCase())}` : ""}${f.maxLossPerUnit != null ? ` · loss ≤ ${f.maxLossPerUnit}c` : ""}${f.field ? ` · field ${escapeHtml(shortWp(f.field))}` : ""}${f.collector ? ` · collector ${escapeHtml(f.collector)}` : ""}</div>
      <div class="acts">
        <input type="number" class="carrier-target" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}" min="0" value="${target}" style="width:56px" aria-label="Crew target">
        <button class="btn" data-act="set-target" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}">Set crew size</button>
        ${f.paused
          ? `<button class="btn pri" data-act="on" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}">Turn on</button>`
          : `<button class="btn deny" data-act="off" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}">Turn off</button>`}
        <button class="btn" data-act="remove" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}">Remove</button>
      </div>
      <div class="acts">
        <input type="number" class="sell-gap-min" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}" min="0" placeholder="gap min" value="${f.sellGapMs ? Math.round(f.sellGapMs / 60_000) : ""}" style="width:70px" aria-label="Sell gap minutes">
        <button class="btn" data-act="set-sell-gap" data-wp="${escapeHtml(f.targetWaypoint)}" data-good="${escapeHtml(f.good)}" data-mine="${f.mine ? 1 : 0}">Set spread</button>
      </div>
    </div>`;
  }).join("");
}

function renderMoreDoctrine() {
  $("more-doctrine-count").textContent = `${doctrineRules.filter((r) => r.enabled).length} / ${doctrineRules.length} on`;
  const el = $("more-doctrine");
  if (!doctrineRules.length) { el.innerHTML = '<div class="empty">Doctrine unavailable — the fleet is still starting.</div>'; return; }
  el.innerHTML = doctrineRules.map((r) => `
    <div class="doc-row" data-key="${escapeHtml(r.key)}">
      <span class="dn">${escapeHtml(r.name)}</span>
      <span class="tag ${r.enforced ? "live" : ""}">${r.enforced ? "applied" : "not wired"}</span>
      <button class="sw" aria-pressed="${r.enabled}" aria-label="Toggle ${escapeHtml(r.name)}"><i></i></button>
    </div>`).join("");
}

function renderMoreKeepers() {
  $("more-keeper-count").textContent = `${keeperStationsCfg.length} stationed · ${keeperMarketsCfg.length} listed`;
  $("more-keeper-cover").setAttribute("aria-pressed", String(keeperCoverList));
  const ta = $("more-keeper-markets");
  // Don't clobber an edit in progress.
  if (document.activeElement !== ta) ta.value = keeperMarketsCfg.join("\n");
  const el = $("more-keeper-stations");
  const rows = [
    ...keeperMarketsCfg.map((m) => ({ market: m, ship: keeperStationsCfg.find((s) => s.market === m)?.shipSymbol })),
    ...keeperStationsCfg.filter((s) => !keeperMarketsCfg.includes(s.market)).map((s) => ({ market: s.market, ship: s.shipSymbol })),
  ];
  el.innerHTML = rows.length
    ? rows.map((r) => `<div class="detail-row"><span>${escapeHtml(shortWp(r.market))}</span><span class="d">${r.ship ? `● ${escapeHtml(r.ship)}` : "◐ no keeper yet"}</span></div>`).join("")
    : '<div class="empty">No keeper markets listed.</div>';
}

async function postKeepers(body, doneMsg) {
  try {
    await api("POST", "/api/keeper/markets", body);
    // loadKeepers() reassigns store.js's own bindings; an importing module can't.
    await loadKeepers();
    if (doneMsg) alert(doneMsg);
  } catch (err) { alert(err.message); }
}
$("more-keeper-save").addEventListener("click", () => {
  const lines = $("more-keeper-markets").value.split("\n").map((l) => l.trim().toUpperCase()).filter((l) => l.length);
  postKeepers({ markets: lines });
});
$("more-keeper-reset").addEventListener("click", () => postKeepers({ reset: true }));
$("more-keeper-cover").addEventListener("click", () => postKeepers({ coverList: !keeperCoverList }));
subscribe("keepers", () => { if (moreTabActive()) renderMoreKeepers(); });

/** Bulk scrap: a role filter plus a checkbox per ship; Scrap posts the same
 *  /api/fleet/sell-ship call the per-ship Sell button uses, one ship at a time. */
let bulkRole = "miner";
const bulkPicked = new Set();
function renderBulkScrap() {
  const ships = fleetStatus.ships ?? [];
  const roles = [...new Set(ships.map((s) => s.role))].sort();
  const sel = $("bulk-role");
  if (document.activeElement !== sel) {
    if (!roles.includes(bulkRole)) bulkRole = roles[0] ?? "";
    sel.innerHTML = roles.map((r) => `<option value="${escapeAttr(r)}" ${r === bulkRole ? "selected" : ""}>${escapeHtml(r)} (${ships.filter((s) => s.role === r).length})</option>`).join("");
  }
  const rows = ships.filter((s) => s.role === bulkRole).sort((a, b) => a.symbol.localeCompare(b.symbol));
  $("bulk-list").innerHTML = rows.map((s) => `<label class="checkline" style="display:flex;padding:6px 0">
      <input type="checkbox" data-ship="${escapeAttr(s.symbol)}" ${bulkPicked.has(s.symbol) ? "checked" : ""} />
      <span style="flex:1">${escapeHtml(s.symbol)}</span>
      <span class="d">${escapeHtml(s.doing ?? s.nav ?? "")}${s.fuelCap ? ` · fuel ${s.fuel}/${s.fuelCap}` : ""}</span>
    </label>`).join("") || '<div class="empty">No ships with this role.</div>';
  $("more-bulk-count").textContent = `${bulkPicked.size} selected`;
}
$("bulk-role").addEventListener("change", (e) => { bulkRole = e.target.value; renderBulkScrap(); });
$("bulk-all").addEventListener("click", () => { for (const s of fleetStatus.ships ?? []) if (s.role === bulkRole) bulkPicked.add(s.symbol); renderBulkScrap(); });
$("bulk-none").addEventListener("click", () => { bulkPicked.clear(); renderBulkScrap(); });
$("bulk-list").addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-ship]");
  if (!cb) return;
  if (cb.checked) bulkPicked.add(cb.dataset.ship); else bulkPicked.delete(cb.dataset.ship);
  $("more-bulk-count").textContent = `${bulkPicked.size} selected`;
});
$("bulk-go").addEventListener("click", async () => {
  const picked = [...bulkPicked];
  if (!picked.length) return;
  if (!confirm(`Scrap ${picked.length} ship${picked.length === 1 ? "" : "s"} permanently?\n\n${picked.join(", ")}\n\nEach flies to the nearest shipyard and is scrapped there. This cannot be undone.`)) return;
  const btn = $("bulk-go");
  btn.disabled = true;
  const failed = [];
  for (const sym of picked) {
    try { await api("POST", "/api/fleet/sell-ship", { shipSymbol: sym }); bulkPicked.delete(sym); }
    catch (err) { failed.push(`${sym}: ${err.message}`); }
  }
  btn.disabled = false;
  await loadState();
  renderBulkScrap();
  if (failed.length) alert(`${failed.length} could not be sold:\n${failed.join("\n")}`);
});
subscribe("bridge", () => { if (moreTabActive()) renderBulkScrap(); });

function renderMore() {
  renderBulkScrap();
  renderMoreKeepers();
  renderMoreContracts();
  renderMoreMissions();
  renderMoreChains();
  renderMoreFeeds();
  renderMoreDoctrine();
}

$("mission-start-btn").addEventListener("click", async () => {
  const input = $("mission-wp-input");
  const wp = input.value.trim();
  if (!wp) return;
  const btn = $("mission-start-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/missions/start", { waypoint: wp });
    input.value = "";
    await loadProgramme();
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  renderMoreMissions();
});

$("more-missions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, wp } = b.dataset;
  if (act === "pause" && !confirm(`Stop the construction mission at ${wp}? The crew will be released; you can resume later.`)) return;
  b.disabled = true;
  try {
    if (act === "set-target") {
      const input = b.closest(".acts").querySelector(".carrier-target");
      const count = Number(input?.value);
      if (!Number.isFinite(count) || count < 0) { alert("Enter a valid crew size"); return; }
      await api("POST", "/api/missions/carrier-target", { waypoint: wp, count });
    } else if (act === "save-pacing") {
      const row = b.closest(".mission-pacing");
      const val = (cls) => { const v = row.querySelector(cls).value.trim(); return v === "" ? null : Number(v); };
      await api("POST", "/api/missions/pacing", { waypoint: wp, buyLotUnits: val(".mp-lot"), buyGapMin: val(".mp-gap"), maxInflationPct: val(".mp-cap"), recoverPct: val(".mp-rec"), cashFloor: val(".mp-floor"), cashResume: val(".mp-resume") });
    } else if (act === "toggle-material") {
      const m = missions.find((x) => x.targetWaypoint === wp);
      const outstanding = (m?.materials ?? []).filter((x) => x.fulfilled < x.required).map((x) => x.tradeSymbol);
      const only = m?.pacing?.onlyMaterials ?? [];
      const buying = new Set(only.length ? only.filter((x) => outstanding.includes(x)) : outstanding);
      if (buying.has(b.dataset.material)) buying.delete(b.dataset.material); else buying.add(b.dataset.material);
      if (buying.size === 0) { alert("That would hold every material — use Stop to pause the whole mission."); b.disabled = false; return; }
      await api("POST", "/api/missions/pacing", { waypoint: wp, onlyMaterials: outstanding.every((x) => buying.has(x)) ? null : [...buying] });
    } else {
      await api("POST", `/api/missions/${act}`, { waypoint: wp });
    }
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreMissions();
});

/** Good/market pickers for the feed-start form — dropdowns sourced from
 *  priceGoods/priceWaypointsByGood (see loadGoods()), not free text.
 *  Confirmed live 2026-09-27: a typo'd target waypoint (a wrong system
 *  symbol, then a same-system near-miss) left a feed with 0 reachable
 *  markets and a full crew never joining — restricting the picker to
 *  markets that actually exist and actually trade the chosen good makes
 *  that typo class impossible. */
function populateGoodSelect(sel) {
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Good…</option>' + priceGoods.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join("");
  if (priceGoods.includes(current)) sel.value = current;
}
function populateWaypointSelectForGood(sel, good) {
  if (!sel) return;
  const current = sel.value;
  const options = good ? (priceWaypointsByGood[good] ?? []) : [];
  sel.innerHTML = `<option value="">${good ? "Market…" : "Pick a good first…"}</option>` + options.map((wp) => `<option value="${escapeAttr(wp)}">${escapeHtml(wp)}</option>`).join("");
  if (options.includes(current)) sel.value = current;
}
function refreshFeedFormSelects() {
  populateGoodSelect($("feed-good-input"));
  populateWaypointSelectForGood($("feed-wp-input"), $("feed-good-input").value);
}
$("feed-good-input").addEventListener("change", () => populateWaypointSelectForGood($("feed-wp-input"), $("feed-good-input").value));

$("feed-start-btn").addEventListener("click", async () => {
  const wpInput = $("feed-wp-input");
  const goodInput = $("feed-good-input");
  const mineInput = $("feed-mine-input");
  const gapInput = $("feed-sell-gap-input");
  const wp = wpInput.value.trim();
  const good = goodInput.value.trim().toUpperCase();
  if (!wp || !good) return;
  const sellGapMinRaw = gapInput?.value?.trim() ?? "";
  const sellGapMin = sellGapMinRaw === "" ? undefined : Number(sellGapMinRaw);
  const btn = $("feed-start-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/feeds/start", { waypoint: wp, good, carrierTarget: 1, mine: mineInput.checked, sellGapMin });
    wpInput.value = "";
    goodInput.value = "";
    mineInput.checked = false;
    if (gapInput) gapInput.value = "";
    await loadProgramme();
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  renderMoreFeeds();
});

$("more-feeds").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, wp, good, mine } = b.dataset;
  if (act === "remove" && !confirm(`Remove the feed ${good} → ${wp}? Its crew is released; this isn't just a pause.`)) return;
  b.disabled = true;
  try {
    if (act === "set-target") {
      const input = b.closest(".acts").querySelector(".carrier-target");
      const count = Number(input?.value);
      if (!Number.isFinite(count) || count < 0) { alert("Enter a valid crew size"); return; }
      await api("POST", "/api/feeds/carrier-target", { waypoint: wp, good, mine: mine === "1", count });
    } else if (act === "on") {
      await api("POST", "/api/feeds/resume", { waypoint: wp, good, mine: mine === "1" });
    } else if (act === "off") {
      await api("POST", "/api/feeds/pause", { waypoint: wp, good, mine: mine === "1" });
    } else if (act === "remove") {
      await api("POST", "/api/feeds/remove", { waypoint: wp, good, mine: mine === "1" });
    } else if (act === "set-sell-gap") {
      const input = b.closest(".acts").querySelector(".sell-gap-min");
      const sellGapMin = input?.value?.trim() ?? "";
      await api("POST", "/api/feeds/sell-gap", { waypoint: wp, good, mine: mine === "1", sellGapMin: sellGapMin === "" ? null : Number(sellGapMin) });
    }
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreFeeds();
});

$("more-contracts").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const { act, id } = b.dataset;
  b.disabled = true;
  try {
    if (act === "accept" || act === "decline" || act === "undecline") {
      const path = act === "accept" ? "/api/contracts/accept" : act === "decline" ? "/api/contracts/decline" : "/api/contracts/undecline";
      await api("POST", path, { contractId: id });
    } else if (act === "abandon") {
      if (!confirm("Stop working this contract? The fleet will stop buying for it and release any ship assigned to it. It cannot be handed back — the contract stays accepted and will lapse at its deadline, which costs reputation.")) { b.disabled = false; return; }
      await api("POST", "/api/contracts/abandon", { contractId: id });
    } else if (act === "resume") {
      await api("POST", "/api/contracts/resume", { contractId: id });
    }
    await loadProgramme();
  } catch (err) { alert(err.message); }
  renderMoreContracts();
});

$("more-doctrine").addEventListener("click", async (e) => {
  const sw = e.target.closest("button.sw");
  if (!sw) return;
  const key = sw.closest(".doc-row").dataset.key;
  const enabled = sw.getAttribute("aria-pressed") !== "true";
  sw.disabled = true;
  try {
    const res = await api("POST", "/api/doctrine", { key, enabled });
    setDoctrine(res.rules, undefined);
  } catch (err) { alert(err.message); loadDoctrine(); }
  renderMoreDoctrine();
});
subscribe("programme", () => { if (moreTabActive()) { renderMoreContracts(); renderMoreMissions(); renderMoreChains(); renderMoreFeeds(); } });
subscribe("doctrine", () => { if (moreTabActive()) renderMoreDoctrine(); });
subscribe("activity", () => renderHomeActivity());

/* ── boot ──────────────────────────────────
 * Same 15s polling cadence as v6.js's tradeops/ops tabs — Home always
 * needs bridge/approvals/dispatch fresh since it's the one screen that's
 * always on, unlike a desktop tab that only polls while selected.
 */
function boot() {
  loadState();
  loadBridge();
  loadApprovals();
  loadDispatch();
  loadMarkets();
  loadActivity();
  loadProgramme(); // Home's unassigned count reads feed/mission claims (claimFor)
  renderStatusbar();
}
function pollTick() {
  // loadActivity() unconditionally, same as state/bridge/approvals/
  // dispatch above it — Home's own Activity section (moved off the More
  // tab, see renderHomeActivity()'s comment) is on the one screen that's
  // always polling, not gated to a tab being open.
  loadState(); loadBridge(); loadApprovals(); loadDispatch(); loadActivity();
  // Feed/mission claims drive the "unassigned" count on Home and every ship card's job, so they
  // refresh on every tick, not only while Fleet or More is open (a feed carrier read "unassigned"
  // until one of those tabs had been visited).
  loadProgramme();
  if (marketsTabActive() || fleetTabActive()) loadMarkets();
  if (marketsTabActive()) loadGoods();
}
setInterval(() => {
  if (!authed || document.hidden) return;
  pollTick();
}, 15_000);
// A backgrounded tab/app stops this interval entirely (iOS Safari suspends
// timers for a homescreen PWA once it's not the foreground app, sometimes
// discarding them outright rather than just pausing) — v6.js's own
// visibilitychange handler exists for exactly this reason. Without it,
// reopening Tower after even a short time away shows whatever was on
// screen when it was backgrounded until the next 15s tick lands, which
// reads as "doesn't update unless I refresh."
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !authed) return;
  pollTick();
});

(async function boot0() {
  // "?login=1" (the admin page's "+ New agent" link, forwarded here by
  // mobileRedirect.js if it sent a mobile UA to /m) forces the sign-in
  // form even with a live session cookie already in this browser — see
  // v6.js's own boot0 for the full reasoning.
  if (new URLSearchParams(window.location.search).get("login") === "1") {
    window.history.replaceState({}, "", window.location.pathname);
    return showAuthGate();
  }
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  if (session.operator) enableAdmin($("tab-admin"));
  boot();
})();
