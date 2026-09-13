import {
  worstConditionPct,
  shipTransitLerp,
  shortWp,
  abbrev,
  relTime,
  countdown,
  roleMismatchReason,
  escapeHtml,
  escapeAttr,
  fmt,
  signed,
  fmtTime,
  fmtAge,
} from "/shared/domain.js";
import { api, onUnauthorized } from "/shared/api.js";
import {
  state, systems, jumpConnections, bridge, fleetStatus, activity,
  marketSnapshots, marketRoutes, marketSystems, tradeRoutes, intel,
  doctrineRules, doctrineCatalog, doctrineFires, doctrineFireShips,
  connectionStatus,
  loadState, loadBridge, loadActivity, loadMarkets, loadDoctrine,
  loadDoctrineFires, loadDoctrineFireShips, setDoctrine, subscribe,
  dispatchRoutes, dispatchAssignments, warehouseState, keeperMarketsCfg, keeperStationsCfg, keeperCoverList,
  replayByShip, replayT0, replayT1, priceGoods, pricePoints, contracts,
  missions, leaderboard, factions, narrative, narrativeMeta, chatHistory,
  approvals,
  loadDispatch, loadWarehouse, loadKeepers, loadReplay, loadGoods,
  loadPrices, loadProgramme, loadGalaxy, loadNarrative, loadChatHistory,
  loadApprovals,
} from "/shared/store.js";
import {
  login, register as registerAgent, logout as endSession,
  probeSession, fetchOnboardingCatalog, completeOnboarding,
} from "/shared/session.js";
import { applyVersionPreference, mountSwitcher } from "/shared/switcher.js";

const $ = (id) => document.getElementById(id);



/* ── auth gate ─────────────────────────────
   Multi-tenant, session-cookie based (unlike straders' single shared
   dashboard token): POST /api/gate/login or /api/gate/register sets an
   httpOnly signed session cookie, which every subsequent /api/* request
   carries automatically — no Authorization header to attach client-side.
   A 401 from any /api/* call (missing/expired/forged session) re-shows the
   gate. */
let authed = false;
// Transport owns detecting a dead session; showing the gate is ours.
onUnauthorized((msg) => showAuthGate(msg));

function showAuthGate(message) {
  authed = false;
  $("auth-err").textContent = message ?? "";
  $("reg-err").textContent = "";
  $("app-root").hidden = true;
  $("auth-gate").hidden = false;
  showLoginForm();
}

function hideAuthGate() {
  authed = true;
  $("auth-gate").hidden = true;
  $("app-root").hidden = false;
}

function showLoginForm() {
  $("auth-form-login").hidden = false;
  $("auth-form-register").hidden = true;
  $("auth-token").focus();
}

function showRegisterForm() {
  $("auth-form-login").hidden = true;
  $("auth-form-register").hidden = false;
  $("reg-symbol").focus();
}

/** Sign in with an existing SpaceTraders account token. */
async function tryLogin(token) {
  try {
    const { onboardingPending, isNewTenant } = await login(token);
    if (onboardingPending ?? isNewTenant) showOnboarding();
    else { hideAuthGate(); boot(); }
  } catch (err) {
    $("auth-err").textContent = err.message || "Could not reach the server.";
  }
}

/** Register a brand-new SpaceTraders agent, then sign in as it. */
async function tryRegister(agentSymbol, faction, accountToken) {
  try {
    const { onboardingPending, isNewTenant } = await registerAgent(agentSymbol, faction, accountToken);
    if (onboardingPending ?? isNewTenant) showOnboarding();
    else { hideAuthGate(); boot(); }
  } catch (err) {
    $("reg-err").textContent = err.message || "Could not reach the server.";
  }
}

/** New-agent onboarding (docs/policy-library-and-onboarding-plan.md §4) —
 *  a full-screen step before the dashboard, not a modal over it: this is
 *  before the captain has any reason to look at Bridge/Fleet/Markets yet.
 *  The engine itself still boots in the background either way (loading
 *  ships/markets/galaxy so this screen has something to show), but
 *  FleetManager.init() keeps a brand-new tenant paused — no buying, no role
 *  assignment — until POST /api/doctrine/onboard actually confirms a policy
 *  set (see init()'s own comment); this screen never getting its confirm
 *  just leaves the fleet sitting paused, not silently acting on defaults
 *  the captain never chose.
 */
async function showOnboarding() {
  $("auth-gate").hidden = true;
  $("onboarding-gate").hidden = false;
  $("onboard-err").textContent = "";
  $("onboard-list").innerHTML = '<div class="empty">Loading standing orders…</div>';
  // Disabled until the real catalog renders — confirming while this list is
  // still empty would send an empty `selections` object, which
  // completeOnboarding() reads as "adopt nothing," silently turning off
  // every policy (including the cash floor) instead of leaving them at
  // their real defaults.
  $("onboard-confirm").disabled = true;
  // The retry itself is shared knowledge, not presentation — see
  // fetchOnboardingCatalog() for why a 503 here usually means "still
  // booting" rather than "broken".
  $("onboard-retry").hidden = true;
  try {
    renderOnboarding(await fetchOnboardingCatalog());
  } catch (_) {
    $("onboard-list").innerHTML = "";
    $("onboard-err").textContent = "Could not load standing orders — the fleet may still be starting up.";
    // A refresh used to be the only offer here, and it was a dead end: it
    // re-probes the session, sees a live cookie, and (before onboarding
    // became level-triggered) went straight to a dashboard whose fleet was
    // paused pending the onboarding this screen never finished. Retry the
    // fetch in place instead — the screen is the only thing that can clear
    // tenants.onboarding_pending, so it must not be escapable by accident.
    $("onboard-retry").hidden = false;
  }
}

const ONBOARD_CATEGORY_LABEL = { trading: "Trading", fleet: "Fleet growth", risk: "Risk", ops: "Ops" };

function renderOnboarding(catalog) {
  $("onboard-confirm").disabled = false;
  const el = $("onboard-list");
  const byCategory = new Map();
  for (const c of catalog) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }
  el.innerHTML = [...byCategory.entries()].map(([cat, items]) => `
    <div class="onboard-cat">${ONBOARD_CATEGORY_LABEL[cat] ?? cat}</div>
    ${items.map((c) => `
      <label class="onboard-item">
        <input type="checkbox" data-key="${escapeAttr(c.key)}" ${c.defaultAdopted ? "checked" : ""} />
        <span class="body"><span class="n">${escapeHtml(c.name)}</span><span class="d">${escapeHtml(c.description)}</span></span>
      </label>`).join("")}
  `).join("");
}

async function confirmOnboarding() {
  const btn = $("onboard-confirm");
  btn.disabled = true;
  try {
    const selections = {};
    $("onboard-list").querySelectorAll("input[type=checkbox][data-key]").forEach((cb) => { selections[cb.dataset.key] = cb.checked; });
    await completeOnboarding(selections);
    $("onboarding-gate").hidden = true;
    hideAuthGate();
    boot();
  } catch (err) {
    $("onboard-err").textContent = err.message || "Could not save — try again.";
    btn.disabled = false;
  }
}

async function logout() {
  await endSession();
  showAuthGate();
}

/* ── shared state ─────────────────────────── */
let waypoints = [];
let currentSystem = "";
let galaxyMode = false;
/** Filters both Markets-tab panels at once — sent as /api/markets?system=
 *  so the top-N route cut and the system-picker's own option list are both
 *  computed server-side from the right (unfiltered vs. filtered) dataset. */
let marketSystemFilter = "";
let selectedShip = null;
/** shipSymbol -> {x,y} in #map-view's own coordinate space, refreshed every
 *  renderMap() call. Book mode's clause hover uses this to draw pulse rings
 *  around the real hulls a rule governed, in the same space the ships
 *  themselves are drawn in — so they land exactly on the ship, panned/zoomed
 *  or not, with no separate coordinate conversion. */
const shipScreenPos = new Map();
/** Waypoint symbol the tap-to-inspect tip is currently open for (touch UI
 *  only — desktop hover doesn't need this, mouseleave always closes).
 *  Null when closed. */
let mapTipFor = null;
let surveyCache = new Map();
let loadoutScores = [];
let chatBusy = false;
let fleetSort = { key: "net", dir: -1 };
let currentView = "bridge";
let mobileView = "bridge"; // "bridge" | "fleet" | "map" | "ops" | "book"

/* ── replay scrubber ──────────────────────────
   Real playback over GET /api/replay's position samples (see
   tenantRegistry.ts's refreshState() for how those get recorded — one per
   ship per state-refresh cycle). While scrubbing, renderMapLiveOrScrub()
   (the replacement for every direct renderMap(state.ships) call site) draws
   a synthetic ship list interpolated from history instead of live state, so
   normal polling can't stomp the scrubbed frame out from under the operator. */
let scrubLive = true;
let scrubFraction = 1; // 0 = oldest sample in the window, 1 = live
let scrubPlaying = false;
let scrubTimer = null;
let scrubSpeedIdx = 0;
const SCRUB_SPEEDS = [1, 5, 15, 60];

/** The synthetic "ships" array at the current scrub position: for each hull,
 *  its latest recorded sample at or before the scrubbed timestamp. Shaped to
 *  match what renderMap() already expects from a live ship, so it's the same
 *  renderer either way — no separate historical drawing path to maintain. */
function renderScrubFrame() {
  const targetT = replayT0 + scrubFraction * (replayT1 - replayT0);
  const synthetic = [];
  const trails = new Map();
  for (const [symbol, samples] of replayByShip) {
    if (!samples.length) continue;
    let best = samples[0];
    let bestIdx = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].t <= targetT) { best = samples[i]; bestIdx = i; } else break;
    }
    synthetic.push({ symbol, nav: { waypointSymbol: best.waypointSymbol, status: best.status } });

    // The trail: the last few DISTINCT waypoints visited leading up to now.
    // A ship sitting still produces many consecutive samples at the same
    // spot (one every state-refresh cycle) — only the transitions between
    // different waypoints matter for a travel line, so consecutive repeats
    // collapse into one point.
    const trail = [];
    for (let i = bestIdx; i >= 0 && trail.length < 8; i--) {
      const wp = samples[i].waypointSymbol;
      if (trail.length === 0 || trail[trail.length - 1] !== wp) trail.push(wp);
    }
    trail.reverse();
    if (trail.length > 1) trails.set(symbol, trail);
  }
  renderMap(synthetic, trails);
  updateScrubHead();
}

/** Every direct "draw the live fleet" call site goes through this instead of
 *  calling renderMap(state.ships) itself, so a scrub in progress isn't
 *  silently overwritten by the next periodic state refresh. */
function renderMapLiveOrScrub() {
  // state starts null and isn't populated until the first /api/state
  // response lands — renderMap() itself reads state.agent.headquarters
  // unconditionally (for the sector label), so calling it any earlier throws.
  // Previously rare (this only ran from specific event-driven call sites);
  // the 1s ship-motion redraw timer below calls this often enough during
  // that brief boot window to hit it in practice, not just in theory.
  if (!state) return;
  if (scrubLive) renderMap(state.ships ?? []);
  else renderScrubFrame();
}

function renderScrubTrack() {
  const svg = $("scrub-spark");
  if (svg) {
    const series = bridge.series ?? [];
    if (!series.length) {
      svg.innerHTML = "";
    } else {
      const W = 900, H = 22;
      const min = Math.min(0, ...series), max = Math.max(1, ...series);
      const span = max - min || 1;
      const x = (i) => (i / Math.max(1, series.length - 1)) * W;
      const y = (v) => H - ((v - min) / span) * H;
      const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const area = `${line} L${W},${H} L0,${H} Z`;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.innerHTML = `<path d="${area}" class="f-spark-a"></path><path d="${line}" class="f-spark-l" fill="none"></path>`;
    }
  }
  const fmtT = (ms) => ms ? new Date(ms).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "—";
  const t0el = $("scrub-t0"), t1el = $("scrub-t1");
  if (t0el) t0el.textContent = fmtT(replayT0);
  if (t1el) t1el.textContent = fmtT(replayT1);
  updateScrubHead();
}

function updateScrubHead() {
  const head = $("scrub-head");
  if (head) head.style.left = `${(scrubFraction * 100).toFixed(2)}%`;
  const live = $("scrub-live");
  if (live) live.classList.toggle("on", scrubLive);
}

function scrubTogglePlay() {
  scrubPlaying = !scrubPlaying;
  const btn = $("scrub-play");
  if (btn) btn.textContent = scrubPlaying ? "⏸" : "▶";
  if (scrubPlaying) {
    scrubLive = false;
    if (scrubFraction >= 1) scrubFraction = 0;
    scrubTimer = setInterval(scrubTick, 200);
  } else if (scrubTimer) {
    clearInterval(scrubTimer);
  }
}

function scrubTick() {
  const totalMs = (replayT1 - replayT0) || 1;
  const speed = SCRUB_SPEEDS[scrubSpeedIdx];
  // Each real 200ms tick advances the scrub by (200ms * speed * 30) of
  // window-time — tuned so 1x plays the full window in ~2.5 minutes, fast
  // enough to actually watch, slow enough to read ship movement.
  scrubFraction = Math.min(1, scrubFraction + (200 * speed * 30) / totalMs);
  if (scrubFraction >= 1) {
    scrubGoLive();
    return;
  }
  renderScrubFrame();
}

function scrubSeek(clientX) {
  const track = $("scrub-track");
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  scrubFraction = f;
  scrubLive = f >= 0.999;
  if (scrubLive) renderMap(state?.ships ?? []);
  else renderScrubFrame();
  updateScrubHead();
}

function scrubCycleSpeed() {
  scrubSpeedIdx = (scrubSpeedIdx + 1) % SCRUB_SPEEDS.length;
  const el = $("scrub-speed");
  if (el) el.textContent = `${SCRUB_SPEEDS[scrubSpeedIdx]}×`;
}

function scrubGoLive() {
  scrubLive = true;
  scrubFraction = 1;
  scrubPlaying = false;
  if (scrubTimer) clearInterval(scrubTimer);
  const btn = $("scrub-play");
  if (btn) btn.textContent = "▶";
  renderMap(state?.ships ?? []);
  updateScrubHead();
}

/* ── view switching ───────────────────────────
   Three ranked surfaces, not peer rooms: Bridge is where you sit, Doctrine is
   where you go when something has happened twice, Markets is where you go to
   ask a question. Each view pulls only the data it needs, on entry. */
function setView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === name));
  $("view-switch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === name)));
  loadViewData(name);
  if (name === "bridge") requestAnimationFrame(renderMapLiveOrScrub);
}

function loadViewData(name) {
  // Fleet itself needs no fetch of its own — fleetRows() reads state/
  // bridge/fleetStatus, already kept current by the 5s polling loop — but
  // its Job column reads dispatchAssignments, which was previously only
  // ever fetched while on the Trade Ops tab, so the Fleet tab's job info
  // could be stale or entirely empty until an operator happened to visit
  // Trade Ops first.
  if (name === "fleet") { loadDispatch(); renderFleetTable(); }
  if (name === "markets") { loadMarkets(marketSystemFilter); loadGoods(); }
  if (name === "tradeops") { loadDispatch(); loadKeepers(); loadWarehouse(); }
  if (name === "ops") loadProgramme();
  if (name === "galaxy") loadGalaxy();
}

function initViewSwitch() {
  $("view-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) setView(btn.dataset.view);
  });
  // 1/2/3 jump between views when not typing.
  document.addEventListener("keydown", (e) => {
    // Escape must work from inside the co-pilot's own input, which is focused
    // the moment the drawer opens.
    if (e.key === "Escape") {
      $("copilot").classList.remove("open");
      $("copilot-toggle").classList.remove("on");
      $("copilot-toggle").setAttribute("aria-expanded", "false");
      if (e.target.matches("input, textarea")) e.target.blur();
      return;
    }
    if (e.target.matches("input, select, textarea")) return;
    const map = { "1": "bridge", "2": "fleet", "3": "markets", "4": "tradeops", "5": "ops" };
    if (map[e.key]) setView(map[e.key]);
  });
}

/* ── mobile app shell ────────────────────────
   Independent of desktop's currentView/setView: mobile gets its own tiny
   state machine driven by the bottom tab bar, not by setView(). They're
   allowed to disagree (a phone on "map" while desktop sits on "markets" is
   fine). */
function setMobileView(name) {
  mobileView = name;
  document.querySelectorAll(".m-screen").forEach((s) => s.classList.toggle("on", s.dataset.mscreen === name));
  document.querySelectorAll("#m-tabbar button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mtab === name)));
  // A ship-details sheet opened from a previous tab shouldn't stick around
  // covering whichever tab was just switched to.
  document.body.classList.remove("mobile-ship-active");
  document.body.classList.toggle("mobile-map-active", name === "map");
  document.body.classList.toggle("mobile-book-active", name === "book");
  if (name === "map") { setFieldBookMode("field"); requestAnimationFrame(renderMapLiveOrScrub); }
  if (name === "book") setFieldBookMode("book");
}

function initMobileTabbar() {
  $("m-tabbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mtab]");
    if (btn) setMobileView(btn.dataset.mtab);
  });
}

/* ── loaders ──────────────────────────────── */




/** Populates both Markets-tab system-filter selects from the unfiltered
 *  systems list the server always returns, keeping the current selection —
 *  a no-op most polls, since marketSystems rarely changes tick to tick. */
function renderMarketSystemFilter() {
  const opts = `<option value="">All systems</option>` +
    marketSystems.map((s) => `<option value="${escapeAttr(s)}"${s === marketSystemFilter ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
  for (const id of ["routes-system-filter", "snapshots-system-filter", "yards-system-filter"]) {
    const el = $(id);
    if (el && el.innerHTML !== opts) el.innerHTML = opts;
  }
}

function onMarketSystemFilterChange(e) {
  marketSystemFilter = e.target.value;
  loadMarkets(marketSystemFilter);
}

/** Right rail's Lanes list — the same real route data Markets' renderRoutes()
 *  uses, restyled compact for the field. Ranked by profit per trip (already
 *  the order marketRoutes arrives in); the top route gets the "hot" glow. */
function renderLanes() {
  const el = $("rail-lanes");
  if (!el) return;
  if (!marketRoutes.length) { el.innerHTML = '<div class="empty">No profitable routes in fresh snapshots.</div>'; return; }
  el.innerHTML = marketRoutes.slice(0, 8).map((r, i) => {
    const stale = r.ageMinutes > 45;
    return `<div class="lane-card${i === 0 ? " hot" : ""}${stale ? " stale" : ""}">
      <div class="g">${escapeHtml(r.goodSymbol)}</div>
      <div class="r">${escapeHtml(shortWp(r.buyAt))} → ${escapeHtml(shortWp(r.sellAt))} · ${r.volume}u · ${stale ? `<span style="color:var(--red)">${r.ageMinutes}m data</span>` : `${r.ageMinutes}m data`}</div>
      <div class="p">${stale ? "unpriced" : `${signed(r.profitPerTrip)} <small>per trip</small>`}</div>
    </div>`;
  }).join("");
}
// Preserved modals call loadIntel() after buying; markets is the same refresh.
const loadIntel = loadMarkets;

function renderDispatch() {
  // Populate the ship dropdown from ships the engine has actually assigned
  // the trader role — previously guessed by cargo capacity >= 40, which both
  // wrongly included a non-trader ship with a big hold and wrongly excluded
  // a real trader under that threshold. That second case had no fix from
  // the UI at all: a ship manually assigned a route (e.g. the command ship,
  // set to trader) but whose cargo capacity happened to sit below 40 could
  // never appear in this dropdown, so there was no way to select it here to
  // clear the assignment either.
  const traders = (bridge.shipStatus ?? []).filter((s) => s.role === "trader");
  const shipOptions = traders.map((s) => `<option value="${escapeAttr(s.symbol)}">${escapeHtml(s.symbol)}</option>`).join("");
  for (const id of ["dispatch-ship", "mobile-dispatch-ship"]) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = shipOptions;
    if (traders.some((t) => t.symbol === current)) sel.value = current;
  }
  // Populate the good dropdown from available routes.
  const goodSet = [...new Set(dispatchRoutes.map((r) => r.good))];
  const goodOptions = goodSet.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join("");
  for (const id of ["dispatch-good", "mobile-dispatch-good"]) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = goodOptions;
    if (goodSet.includes(current)) sel.value = current;
  }
  // Render the assignment list.
  const rowsHtml = !dispatchAssignments.length
    ? '<div class="empty">No traders assigned routes yet.</div>'
    : dispatchAssignments.map((a) => {
        const routeTxt = a.role === "buy" ? `${shortWp(a.buyAt)} → warehouse`
          : a.role === "sell" ? `warehouse → ${shortWp(a.sellAt)}`
          : a.role === "haul" ? `warehouse → ${shortWp(a.sellAt)} (mission)`
          : a.role === "contractBuy" ? `${shortWp(a.buyAt)} → contract`
          : `${shortWp(a.buyAt)} → ${shortWp(a.sellAt)}`;
        const roleTag = a.role && a.role !== "direct" ? `<span class="tag role-${a.role}">${a.role}</span>` : "";
        return `
        <div class="dispatch-row">
          <span class="ship">${escapeHtml(a.shipSymbol)}</span>
          <span class="good">${escapeHtml(a.good)}</span>
          ${roleTag}
          <span class="route-txt">${escapeHtml(routeTxt)}</span>
          <span class="prof">+${fmt(a.profitPerTrip)}/trip</span>
          <span class="tag ${a.source === "manual" ? "manual" : ""}">${a.source === "manual" ? "manual" : "auto"}</span>
        </div>`;
      }).join("");
  for (const id of ["dispatch-list", "mobile-dispatch"]) {
    const el = $(id);
    if (el) el.innerHTML = rowsHtml;
  }
}

function renderWarehouse() {
  const countTxt = warehouseState.ship
    ? `${warehouseState.ship.shipSymbol} @ ${shortWp(warehouseState.ship.waypointSymbol)}`
    : "no ship designated";
  for (const id of ["warehouse-count", "mobile-warehouse-count"]) { const el = $(id); if (el) el.textContent = countTxt; }

  const summaryHtml = `
    <span>Ship <b>${warehouseState.ship ? escapeHtml(warehouseState.ship.shipSymbol) : "—"}</b></span>
    <span>Total value <b>${fmt(warehouseState.totalValue)}c</b></span>
  `;
  for (const id of ["warehouse-summary", "mobile-warehouse-summary"]) { const el = $(id); if (el) el.innerHTML = summaryHtml; }

  // Goods on the books with no ship to hold them are bookkeeping only — no
  // real cargo backs them until a warehouse ship is designated.
  const warningHtml = (!warehouseState.ship && warehouseState.goods.length)
    ? `<div class="callout warn"><b>No warehouse ship designated.</b> The ${warehouseState.goods.length} good${warehouseState.goods.length === 1 ? "" : "s"} listed below are bookkeeping only — no ship is actually holding them. Designate a ship to make this real.</div>`
    : "";
  for (const id of ["warehouse-warning", "mobile-warehouse-warning"]) { const el = $(id); if (el) el.innerHTML = warningHtml; }

  // Ship dropdown: any ship with a meaningful cargo hold.
  const candidates = (state?.ships ?? []).filter((s) => (s.cargo?.capacity ?? 0) >= 20);
  const shipOptions = candidates.map((s) => `<option value="${escapeAttr(s.symbol)}">${escapeHtml(s.symbol)}</option>`).join("");
  for (const id of ["warehouse-ship", "mobile-warehouse-ship"]) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = shipOptions;
    if (candidates.some((s) => s.symbol === current)) sel.value = current;
  }

  // Good dropdown: whatever's already held, plus anything currently routed.
  const goodSet = [...new Set([...warehouseState.goods.map((g) => g.goodSymbol), ...dispatchRoutes.map((r) => r.good)])];
  const goodOptions = goodSet.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join("");
  for (const id of ["warehouse-good", "mobile-warehouse-good"]) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = goodOptions;
    if (goodSet.includes(current)) sel.value = current;
  }

  const goodsHtml = !warehouseState.goods.length
    ? '<div class="empty">Warehouse is empty.</div>'
    : (() => {
        const maxValue = Math.max(...warehouseState.goods.map((g) => g.value), 1);
        return warehouseState.goods.map((g) => `
          <div class="warehouse-row">
            <span class="good">${escapeHtml(g.goodSymbol)}</span>
            <span class="units">${g.units}u</span>
            <span class="cost">avg ${fmt(g.avgCost)}c</span>
            <div class="bar"><i style="width:${Math.round((g.value / maxValue) * 100)}%"></i></div>
            <span class="value">${fmt(g.value)}c</span>
          </div>`).join("");
      })();
  for (const id of ["warehouse-goods", "mobile-warehouse-goods"]) { const el = $(id); if (el) el.innerHTML = goodsHtml; }

  const targets = warehouseState.targets ?? [];
  const targetsHtml = !targets.length
    ? '<div class="empty">No curated goods — the warehouse buys/sells nothing until you add some.</div>'
    : targets.map((t) => `
        <div class="warehouse-target-row">
          <span class="good">${escapeHtml(t.goodSymbol)}</span>
          <span class="units">target ${t.target}u</span>
          ${t.forMission ? '<span class="mission-tag">mission</span>' : ""}
          <button class="btn ghost remove" data-remove-good="${escapeAttr(t.goodSymbol)}">Remove</button>
        </div>`).join("");
  for (const id of ["warehouse-targets", "mobile-warehouse-targets"]) { const el = $(id); if (el) el.innerHTML = targetsHtml; }
}

/* ── keeper stations ──────────────────────────────
   The configured buy-market list the fleet stations keepers at. Editing it
   takes effect on the next coordinator pass. */

function renderKeepers() {
  $("keeper-markets").value = keeperMarketsCfg.join("\n");
  $("keeper-cover").setAttribute("aria-pressed", String(keeperCoverList));
  const stationed = new Map(keeperStationsCfg.map((s) => [s.market, s.shipSymbol]));
  $("keeper-count").textContent = `${keeperStationsCfg.length} stationed · ${stationed.size} covered`;
  const rows = [
    ...keeperMarketsCfg.map((m, i) => ({
      market: m,
      ship: stationed.get(m),
      label: `listed #${i + 1}`,
      covered: !!stationed.get(m),
    })),
    ...keeperStationsCfg
      .filter((s) => !keeperMarketsCfg.includes(s.market))
      .map((s) => ({ market: s.market, ship: s.shipSymbol, label: "extra", covered: true })),
  ];
  const el = $("keeper-stations");
  if (!rows.length) { el.innerHTML = '<div class="empty">No keeper markets configured.</div>'; return; }
  el.innerHTML = rows.map((r) => `
    <div class="keeper-row">
      <span class="ship">${escapeHtml(shortWp(r.market))}</span>
      <span class="route-txt">${r.ship
        ? `<span class="cover">guarded by ${escapeHtml(shortWp(r.ship))}</span>`
        : `<span class="cover missing">no keeper yet</span>`} · <span style="color:var(--dim)">${escapeHtml(r.label)}</span></span>
    </div>`).join("");
}

async function saveKeepers() {
  const lines = $("keeper-markets").value.split("\n").map((l) => l.trim().toUpperCase()).filter((l) => l.length);
  try {
    const res = await api("POST", "/api/keeper/markets", { markets: lines });
    keeperMarketsCfg = res.markets ?? [];
    showToastGlobal(`Keeper list: ${keeperMarketsCfg.length} markets`);
    await loadKeepers();
  } catch (err) { showToastGlobal(err.message, true); }
}

/** Every known policy tagged with this tenant's adopted state — what the
 *  library section offers to add. doctrineRules stays exactly "this
 *  tenant's active set", unchanged in meaning from before the library. */



/** Real per-ship attribution for "this watch" (default 2h) — which hulls
 *  actually fired each rule, not just the count. This is what Book mode's
 *  clause hover pulses on the map; doctrineFires (above) stays the all-time
 *  aggregate the gutter's fire-count numbers come from. */

/** Book mode's document: standing orders as prose, over the dimmed field.
 *  Every rule renders as a clause (struck-through when disabled); rules with
 *  fire stats get a margin note; hovering a clause with real ship
 *  attribution pulses those hulls on the map behind it. */
async function renderBook() {
  const el = $("book-sheet");
  if (!el) return;
  // A value chip's click-to-edit input (.cval-input, created imperatively by
  // wireClauseValueEditor(), not part of the template below) would simply
  // vanish on a full rebuild — the template always renders the button form,
  // so there is nothing to restore it into. Rather than lose an in-progress
  // numeric edit to a re-render triggered by something unrelated (toggling a
  // different rule, an approvals event, ...), skip this pass entirely while
  // one is open; it is a short, blocking interaction the operator commits or
  // cancels in a few keystrokes, and the render this defers is not lost —
  // whatever triggered it already updated the underlying data.
  if (el.querySelector(".cval-input")) return;
  if (!doctrineRules.length) await loadDoctrine();
  await loadDoctrineFireShips();
  // Snapshot every persistent settings input's value (and focus/caret, for
  // whichever one is currently focused) before the full rebuild below blows
  // them all away with fresh elements — the Discord webhook URL and co-pilot
  // endpoint/model/key fields live in this same sheet and reset mid-edit
  // every time this re-ran for any reason. Same pattern as
  // refreshOpenShipDetails()'s own fix for the ship detail panel.
  const fields = [...el.querySelectorAll("input, select, textarea")]
    .filter((f) => f.id || f.className)
    .map((f) => ({
      selector: f.id ? `#${f.id}` : `.${f.className.trim().split(/\s+/).join(".")}`,
      value: f.value,
      focused: document.activeElement === f,
      caret: typeof f.selectionStart === "number" ? f.selectionStart : null,
    }));

  const applied = doctrineRules.filter((r) => r.enabled).length;
  const clauses = doctrineRules.map((r) => {
    // Ship-cap rules (one auto-created per hull type the fleet owns) are a
    // real fleet-composition policy too — Doctrine.setAdopted() supports
    // removing/re-adding them the same as any catalog entry.
    return `<p class="clause${r.enabled ? "" : " off"}" data-key="${escapeAttr(r.key)}">
      <button type="button" class="tog sw" aria-pressed="${r.enabled}" aria-label="Toggle ${escapeAttr(r.name)}" data-key="${escapeAttr(r.key)}"><i></i></button>
      ${clauseForRule(r)}
      <button type="button" class="remove-policy" data-key="${escapeAttr(r.key)}" title="Remove this policy from the fleet's standing orders">✕</button>
    </p>`;
  }).join("");

  // Policy library: every catalog entry this tenant hasn't adopted, grouped
  // by category — the "add" half of the library ask. Collapsed by default
  // (a disclosure, not a wall of unused policies dominating the sheet).
  const available = doctrineCatalog.filter((c) => !c.adopted);
  const byCategory = new Map();
  for (const c of available) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }
  const CATEGORY_LABEL = { trading: "Trading", fleet: "Fleet growth", risk: "Risk", ops: "Ops" };
  const libraryHtml = available.length
    ? [...byCategory.entries()].map(([cat, items]) => `
        <div class="lib-cat">${CATEGORY_LABEL[cat] ?? cat}</div>
        ${items.map((c) => `
          <p class="clause lib-item">
            <span class="lib-name">${escapeHtml(c.name)}</span> — ${escapeHtml(c.description)}
            <button type="button" class="add-policy" data-key="${escapeAttr(c.key)}" data-value="${c.value}">+ Add</button>
          </p>`).join("")}
      `).join("")
    : `<div class="empty-marg">Every known policy is already part of these standing orders.</div>`;

  const notes = doctrineRules
    .map((r) => ({ r, stats: doctrineFires.get(r.key), ships: doctrineFireShips.get(r.key) ?? [] }))
    .filter((x) => x.stats && x.stats.fireCount > 0)
    .sort((a, b) => b.stats.fireCount - a.stats.fireCount)
    .slice(0, 6);
  const margHtml = notes.length ? notes.map(({ r, stats, ships }, i) => {
    const last = stats.lastFired ? relTime(stats.lastFired) : "never";
    return `<div class="mnote${i === 0 ? " live" : ""}" data-key="${escapeAttr(r.key)}">
      <div class="ml">${i === 0 ? "▸ " : ""}${escapeHtml(r.name)}${i === 0 ? " · live" : ""}</div>
      <div class="mv">Fired <b>${stats.fireCount}</b> time${stats.fireCount === 1 ? "" : "s"}, last ${last}.</div>
      ${ships.length ? `<div class="hulls">${ships.map((s) => `<span data-ship="${escapeAttr(s)}">${escapeHtml(s)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("") : `<div class="empty-marg">No rules have fired yet this watch — the gutter fills in as the fleet runs.</div>`;

  el.innerHTML = `
    <div class="page">
      <div class="oh">Standing orders — in force <span class="r">${applied} / ${doctrineRules.length} applied</span></div>
      ${clauses}
      <div class="sig">
        <span class="t">Signed this watch. The fleet flies on these.</span>
        <span class="st">${fleetStatus.paused ? "Halted" : "Auto · running"}</span>
      </div>
      <details class="policy-library">
        <summary>+ Add a policy${available.length ? ` (${available.length} available)` : ""}</summary>
        ${libraryHtml}
      </details>
      <div class="book-settings">
        <span class="l">Discord alerts</span>
        <button type="button" class="tog sw" id="discord-toggle" aria-pressed="true" aria-label="Pause Discord alerts"><i></i></button>
        <input type="text" id="discord-url" placeholder="Webhook URL" />
        <button class="btn ghost" id="discord-save">Save</button>
        <div class="ok" id="discord-ok"></div>
      </div>
      <div class="book-settings" id="copilot-settings">
        <span class="l">Co-pilot</span>
        <input type="text" id="copilot-baseurl" placeholder="Endpoint (optional)" />
        <input type="text" id="copilot-model" placeholder="Model" />
        <input type="password" id="copilot-key" placeholder="API key" />
        <button class="btn ghost" id="copilot-save">Save</button>
        <button class="btn ghost" id="copilot-clear">Clear</button>
        <div class="ok" id="copilot-ok"></div>
      </div>
    </div>
    <div class="marg">${margHtml}</div>`;

  for (const f of fields) {
    const next = el.querySelector(f.selector);
    if (!next || !f.value) continue;
    next.value = f.value;
    if (f.focused) { next.focus(); if (f.caret !== null && next.setSelectionRange) { try { next.setSelectionRange(f.caret, f.caret); } catch (_) {} } }
  }

  el.querySelectorAll(".clause[data-key]").forEach((p) => {
    const key = p.dataset.key;
    const ships = doctrineFireShips.get(key) ?? [];
    p.addEventListener("mouseenter", () => { p.classList.add("hov"); if (ships.length) pulseHulls(ships); });
    p.addEventListener("mouseleave", () => { p.classList.remove("hov"); clearHullPulse(); });
  });
  el.querySelectorAll(".hulls span[data-ship]").forEach((chip) => {
    chip.addEventListener("mouseenter", () => pulseHulls([chip.dataset.ship]));
    chip.addEventListener("mouseleave", () => clearHullPulse());
    chip.addEventListener("click", () => { setFieldBookMode("field"); openShipDetails(chip.dataset.ship); });
  });
  el.querySelectorAll(".tog.sw[data-key]").forEach((sw) => {
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      saveRule(sw.dataset.key, { enabled: sw.getAttribute("aria-pressed") !== "true" });
    });
  });
  el.querySelectorAll("button.cval[data-key]").forEach(wireClauseValueEditor);
  el.querySelectorAll(".remove-policy[data-key]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); saveAdopted(b.dataset.key, false); });
  });
  el.querySelectorAll(".add-policy[data-key]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); saveAdopted(b.dataset.key, true, Number(b.dataset.value)); });
  });
  // Discord's input/button are recreated on every render (they live inside
  // this dynamic innerHTML), so the listener from initDiscord() needs
  // re-attaching each time too, not just once at boot.
  initDiscord();
  initCopilotSettings();
}

/** Click-to-edit for a book clause's value chip: swaps the button for a
 *  number input sized to the rule's own min/max/step, commits on Enter or
 *  blur, cancels on Escape — the same interaction the plan called for,
 *  reusing saveRule() rather than a separate save path. */
function wireClauseValueEditor(btn) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const { key, min, max, step, value } = btn.dataset;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "cval-input";
    input.min = min; input.max = max; input.step = step;
    input.value = value;
    btn.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      const value = Number(input.value);
      if (Number.isFinite(value)) await saveRule(key, { value });
      else if (fieldBookMode === "book") renderBook();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      if (fieldBookMode === "book") renderBook();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
      else if (ke.key === "Escape") { ke.preventDefault(); cancel(); }
    });
  });
}



// ── Doctrine clause templates ──────────────────────────────────────
// The exact copy from the design doc's clause table (field-and-book-plan.md
// §2.1) — verbatim, not paraphrased. {v} is the editable value chip; text in
// *italics* is a trailing note rendered dimmed after the sentence.
function chip(r) {
  return `<button type="button" class="n cval" data-key="${escapeAttr(r.key)}" data-value="${r.value}" data-min="${r.min}" data-max="${r.max}" data-step="${r.step}" data-unit="${escapeAttr(r.unit)}">${fmt(r.value)}${r.unit}</button>`;
}
const CLAUSE_TEXT = {
  cashFloor: (r) => `Never let the balance fall below ${chip(r)} on any purchase — ships, modules, repairs, cargo. Fuel is always exempt.`,
  marginFloor: (r) => `Ignore arbitrage routes whose per-unit margin is below ${chip(r)}.`,
  maxLossPct: (r) => `Refuse to sell cargo at more than ${chip(r)} loss against its cost basis.`,
  minerTarget: (r) => `Grow the drone fleet until ${chip(r)} miners are active.`,
  promoteAtMiners: (r) => `Promote the biggest-hold miner to trader once ${chip(r)} miners exist.`,
  shipBudget: (r) => `Only consider buying a ship when credits exceed the cash floor by ${chip(r)}.`,
  snapshotMaxAgeMin: (r) => `Ignore market prices older than ${chip(r)}. <em>Both the dispatcher and the traders read this, so they always agree on which routes exist.</em>`,
  keeperCount: (r) => `Station ${chip(r)} ships as market keepers so prices never go stale.`,
  sensorScanIntervalMin: (r) => `Run a sensor scan every ${chip(r)} once there is nothing left to chart. <em>Off by default — this changes the auto-buyer's spending.</em>`,
  siphonTarget: (r) => `Grow the fleet until ${chip(r)} gas siphoners are active.`,
  explorerTarget: (r) => `Grow the fleet until ${chip(r)} ships are dedicated explorers. <em>0 by default — buys none until raised.</em>`,
  exploringEnabled: () => `Allow explorers to jump. <em>Jumps cost real credits — switching this off parks them (a jump already in flight still lands, then stays put) without touching explorerTarget.</em>`,
  explorerCreditFloor: (r) => `Park explorers once credits fall to or below ${chip(r)}. <em>0 disables this floor — only the Exploring switch applies.</em>`,
  warehouseTarget: () => `Route trade through the warehouse. <em>Which goods, and how much of each, is set per-good in the Warehouse pane.</em>`,
  warehouseMax: (r) => `Never hold more than ${chip(r)} of any one good in the warehouse.`,
  warehouseMinMargin: (r) => `Only sell out of the warehouse when the live price clears cost basis by ${chip(r)} per unit.`,
};

function clauseForRule(r) {
  const fn = CLAUSE_TEXT[r.key];
  if (fn) return fn(r);
  if (r.key.startsWith("shipCap:")) {
    const type = r.key.replace(/^shipCap:/, "").replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase();
    return `Fleet cap for ${type}: buy no more than ${chip(r)}.`;
  }
  return `<b>${escapeHtml(r.name)}</b>: ${chip(r)}`;
}

/* ── topbar ───────────────────────────────── */
function renderTopbar() {
  $("credits").textContent = fmt(state?.agent?.credits ?? bridge.credits ?? 0);
  $("ships").textContent = state?.agent?.shipCount ?? bridge.shipCount ?? "—";

  const rate = bridge.rate ?? 0;
  const prev = bridge.prevRate ?? 0;
  const arrow = rate > prev ? " ▲" : rate < prev ? " ▼" : "";
  const el = $("rate");
  el.textContent = signed(rate);
  el.className = "v " + (rate > 0 ? "good" : rate < 0 ? "bad" : "");
  el.insertAdjacentHTML("beforeend", `<small>/hr${arrow}</small>`);

  const forgone = bridge.forgone ?? 0;
  $("forgone").textContent = forgone ? signed(forgone) + "/hr" : "—";
  renderSpark(bridge.series ?? []);
  updateModeToggle();
  renderMobileTopbar();
}

/** Small always-visible dot+label — live/stale/offline — driven by
 *  connectionStatus (shared/store.js), itself derived from loadState()'s
 *  outcome every 5s. "Stale" means the server served the last known-good
 *  fleet from its own durable snapshot instead of a live SpaceTraders read
 *  (see dashboard.ts's /state route) — the operator is looking at real but
 *  possibly-minutes-old data, not nothing. */
function renderConnectionStatus() {
  const { level, staleSince } = connectionStatus;
  const label = level === "live" ? "Live" : level === "stale" ? "Stale" : level === "offline" ? "Offline" : "—";
  const title = level === "stale" && staleSince
    ? `Connection status: showing fleet data as of ${new Date(staleSince).toLocaleTimeString()} — SpaceTraders or this tenant's engine is currently unreachable`
    : level === "offline"
      ? "Connection status: can't reach the server"
      : "Connection status: live";
  for (const id of ["conn-status", "m-conn-status"]) {
    const el = $(id);
    if (!el) continue;
    el.dataset.level = level;
    el.title = title;
    const lbl = el.querySelector(".lbl");
    if (lbl) lbl.textContent = label;
  }
}

function renderSpark(series) {
  const el = $("spark");
  if (!series.length) { el.innerHTML = ""; return; }
  const W = 104, H = 26, P = 2;
  const min = Math.min(0, ...series), max = Math.max(1, ...series);
  const span = max - min || 1;
  const x = (i) => P + (i / Math.max(1, series.length - 1)) * (W - P * 2);
  const y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = series.at(-1) ?? 0;
  const stroke = last >= 0 ? "var(--green)" : "var(--red)";
  el.innerHTML = `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2" fill="${stroke}"/>`;
}

function updateModeToggle() {
  const paused = fleetStatus.paused;
  $("mode-toggle").querySelectorAll("button").forEach((b) => {
    const isHalt = b.dataset.mode === "halt";
    b.classList.toggle("active", isHalt === paused);
    b.classList.toggle("halted", isHalt && paused);
  });
}

function initModeToggle() {
  $("mode-toggle").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    try {
      await api("POST", btn.dataset.mode === "halt" ? "/api/fleet/pause" : "/api/fleet/resume");
      await loadBridge();
    } catch (err) { showToastGlobal(err.message, true); }
  });
}

function renderStrandedBanner() {
  document.getElementById("stranded-banner")?.remove();
  const stranded = fleetStatus.stranded ?? [];
  if (!stranded.length) return;
  const b = document.createElement("div");
  b.id = "stranded-banner";
  b.className = "stranded-banner";
  b.textContent = `${stranded.length} ship${stranded.length > 1 ? "s" : ""} stranded: ${stranded.map((s) => s.symbol).join(", ")}`;
  const main = $("views");
  main.parentElement.insertBefore(b, main);
}

/** Global "something needs a decision" banner — shown on every view, not
 *  just Ops, since the whole point of a gated action is that the operator
 *  might not already be looking at it. Clicking jumps to Ops, where the
 *  actual Approve/Deny controls live. */
function renderApprovalsBanner() {
  document.getElementById("approval-banner")?.remove();
  if (!approvals.length) return;
  const b = document.createElement("div");
  b.id = "approval-banner";
  b.className = "approval-banner";
  b.textContent = `${approvals.length} approval${approvals.length > 1 ? "s" : ""} awaiting your decision — click to review`;
  // setView() alone only drives the desktop layout's view switcher; mobile
  // runs its own independent screen state (see setMobileView()'s own
  // comment), so on a phone this banner navigated nowhere — the operator
  // landed on Ops but the mobile Ops screen just didn't have the Approvals
  // pane rendered onto it yet either. Drive both.
  b.addEventListener("click", () => { setView("ops"); if (isMobile()) setMobileView("ops"); });
  const main = $("views");
  main.parentElement.insertBefore(b, main);
}

function renderApprovals() {
  const html = !approvals.length
    ? '<div class="empty">Nothing waiting on a decision.</div>'
    : approvals.map((a) => `
    <div class="ops-card">
      <div class="ops-head">
        <span class="ops-title">${escapeHtml(a.kind)}</span>
        ${a.shipSymbol ? `<span class="ops-sub">${escapeHtml(a.shipSymbol)}</span>` : ""}
        <span class="fill"></span>
        ${a.cost != null ? `<span class="ops-sub">${fmt(a.cost)}c</span>` : ""}
      </div>
      <div class="ops-row"><span class="ops-sub">${escapeHtml(a.detail)}</span></div>
      <div class="ops-head" style="margin-top:6px">
        <span class="ops-dead">auto-decides ${countdown(a.expiresAt)}</span>
        <span class="fill"></span>
        <button class="btn" data-act="approve" data-id="${escapeAttr(a.id)}">Approve</button>
        <button class="btn" data-act="deny" data-id="${escapeAttr(a.id)}">Deny</button>
      </div>
    </div>`).join("");
  // Same dual-render as renderContracts(): mobile has its own Ops screen
  // with its own #mobile-approvals element, not just a CSS-hidden copy of
  // the desktop pane. Previously only "approvals" was written, so on a
  // phone the count badge/banner correctly saw pending approvals but the
  // Ops tab itself never actually rendered any of them.
  for (const id of ["approval-count", "mobile-approval-count"]) {
    const el = $(id);
    if (el) el.textContent = approvals.length ? `${approvals.length} pending` : "none pending";
  }
  for (const id of ["approvals", "mobile-approvals"]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = html;
    el.querySelectorAll("button[data-act]").forEach((b) => {
      b.addEventListener("click", async () => {
        const decision = b.dataset.act === "approve" ? "approved" : "denied";
        b.disabled = true;
        try {
          await api("POST", `/api/approvals/${b.dataset.id}/decide`, { decision });
          await loadApprovals();
        } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
      });
    });
  }
}

function renderSystemStrip() {
  const el = $("system-strip");
  if (!el) return;
  if (systems.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = systems.map((s) =>
    `<button class="${s.symbol === currentSystem ? "active" : ""}" data-sys="${escapeAttr(s.symbol)}">${escapeHtml(s.symbol)}</button>`).join("");
  el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    currentSystem = b.dataset.sys; renderSystemStrip(); resetMapView(); renderMapLiveOrScrub();
  }));
}
function renderGallery() { /* single-system fleets need no gallery */ }

/* ── BRIDGE: galaxy overview ──────────────────
 * A zoomed-out mode of the SAME per-system 3D map/scene (see renderMap()),
 * not a separate view: every system this tenant's own fleet has actually
 * charted, laid out by real galaxy-wide coordinates (from the shared
 * crawler table, GET /api/galaxy/overview) as small markers in the same
 * three.js scene, with jump-gate edges between them. Picking one switches
 * currentSystem and re-frames the same camera back down onto that system's
 * own waypoints (renderMap()'s existing framedSystem-driven fit) — since
 * both live in one scene on one canvas, orbitCam's existing lerp-toward-
 * orbitGoal easing (tickMap3D()) turns that mode switch into one continuous
 * zoom for free, no separate transition code needed. Confirmed live that
 * DRAGOM's own nearby charted systems sit roughly 200-400 units apart —
 * close enough to a system's own waypoint-scale distances (systemSpan
 * ~80-160) that this reuses the same camera/zoom-clamp math directly
 * rather than needing a second scale regime.
 */
let galaxyOverviewData = null;
/** Which of the two content modes the shared 3D scene currently holds — set
 *  by whichever of renderMap()/renderGalaxy3D() last ran, read by both to
 *  decide whether this call is a fresh mode switch (re-frame the camera) or
 *  just another periodic redraw of the same mode (leave the operator's own
 *  zoom/pan alone). Mirrors framedSystem's existing per-system version of
 *  this same distinction, one level up. */
let mapMode = "system";
/** Route planner state — persists across re-renders while galaxy mode stays
 *  open (loadGalaxyOverview() only refetches on toggle-on, not on a timer),
 *  so picking a destination and then panning/zooming doesn't clear it. */
let routeFrom = "";
let routeTo = "";

async function loadGalaxyOverview() {
  try {
    galaxyOverviewData = await api("GET", "/api/galaxy/overview");
    if (!routeFrom) routeFrom = galaxyOverviewData.home || currentSystem;
  } catch (err) {
    galaxyOverviewData = { systems: [], edges: [], home: "" };
    showToastGlobal(err.message, true);
  }
  renderGalaxyToolbar();
  renderGalaxy3D();
}

/** BFS shortest path (fewest jumps, not distance-weighted — every hop costs
 *  roughly the same order of antimatter regardless of leg length) over the
 *  charted jump-gate graph. Returns the ordered system list including both
 *  ends, or null if the two aren't connected by any known chain of gates —
 *  a real, useful answer here ("nothing charted links these yet") rather
 *  than an error, since it's exactly the gap a scout should close next. */
function bfsRoute(edges, from, to) {
  if (!from || !to) return null;
  if (from === to) return [from];
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) {
      const path = [];
      for (let n = to; n !== null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Populate the shared 3D scene with the galaxy overview instead of one
 * system's own waypoints — called from renderMap() when galaxyMode is on,
 * same camera/pickables pattern. Charted systems (`known`) are real click
 * targets; the `nearby` halo is small, dim, and non-interactive.
 *
 * Each known system collapses to one small generated "mini system" glyph
 * (a core sphere, a tilted decorative ring, and a couple of deterministic
 * orbiting dots — seeded off the system symbol so the same system always
 * looks the same) rather than a full render of its actual waypoints. This
 * used to try to hold the outgoing system's real content on screen and
 * ease the camera back for a continuous zoom-out feel; that fought the
 * scene's clear-and-rebuild-every-render-pass structure (the star's own
 * glow sprites, added once, were getting destroyed on the very first
 * rebuild and never replaced) and reliably left stale geometry on screen.
 * A hard cut — clear everything, drop in the collapsed glyphs — is
 * simpler, and the camera cuts with it (orbitCam snapped straight to
 * orbitGoal, not eased into it) rather than spending a beat easing toward
 * a view nothing has swapped to yet. An eased pull-back sounds nicer in
 * the abstract, but here it meant the camera drifted out over the OLD
 * system's content for however long the overview fetch took, landing on
 * an orphaned in-between look that belonged to neither view — confirmed
 * live on video. One clean cut, camera and content together, reads better
 * than a smooth motion into a state that isn't there yet.
 */
function renderGalaxy3D() {
  // galaxyMode flips synchronously in setGalaxyMode(), before the overview
  // fetch it kicks off resolves — and renderMap()'s ~1s poll tick reads
  // galaxyMode directly, so it can call this function first, with no data
  // yet. Wait for the real fetch rather than rendering an empty galaxy.
  if (!galaxyOverviewData) return;
  if (!sceneReady && !mapUnavailable) initMap3D();
  if (mapUnavailable) return;
  $("map-hud").innerHTML = "Galaxy <b>charted space</b>";

  const enteringGalaxy = mapMode !== "galaxy";
  if (enteringGalaxy) {
    mapMode = "galaxy";
    starGroup.visible = false;
    orbitGoal.target.set(0, 0, 0);
    // Deliberately much farther than a system view's own default (~112-160)
    // — confirmed live that 200 read as barely a pull-back at all, since a
    // system's own waypoints already reach out that far. This needs to be
    // an unmistakable "the camera is now much farther away," not a modest
    // zoom adjustment.
    orbitGoal.radius = 460;
    orbitGoal.phi = 1.0;
    // Snap orbitCam straight to orbitGoal instead of letting tickMap3D()
    // ease toward it over the next several frames — this cut is meant to
    // be instant, alongside the content swap below, not a lingering pan.
    orbitCam.target.copy(orbitGoal.target);
    orbitCam.radius = orbitGoal.radius;
    orbitCam.phi = orbitGoal.phi;
  }
  clearGroup(bodiesGroup);
  clearGroup(ringsGroup);
  clearGroup(glowGroup);
  clearGroup(linesGroup);
  // Ships, their motion trails, and gate-pulse sprites are their own
  // persistent groups (see their declarations) rebuilt by the per-system
  // render path, not this one — renderMap() short-circuits into this
  // function before ever reaching that code while galaxyMode is on, so
  // without this they just froze at whatever they held the moment the
  // toggle flipped and sat there forever, showing up as stray ship glyphs
  // scattered around the collapsed system glyphs.
  clearGroup(shipsGroup);
  clearGroup(gatePulseGroup);
  liveTrailGroup?.clear();
  pickables.length = 0;

  const data = galaxyOverviewData;
  const known = (data?.systems ?? []).filter((s) => s.x !== null && s.y !== null);
  if (!known.length) return;
  const nearby = (data.nearby ?? []).filter((s) => s.x !== null && s.y !== null);

  // Centered on whatever system was on screen a moment ago (falling back to
  // fleet home, then just the first charted system), so re-entering galaxy
  // mode from a given system always lands the camera in the same place
  // relative to it.
  const anchor = known.find((s) => s.symbol === currentSystem) ?? known.find((s) => s.symbol === data.home) ?? known[0];
  const cx = anchor.x, cy = anchor.y;
  // Linear scale, not fitSystemScale()'s sqrt compression — galaxy-adjacent
  // distances (DRAGOM's own charted neighbors sit ~200-400 units apart) are
  // already close in magnitude to a system's own waypoint spread.
  let maxR = 20;
  for (const s of known) maxR = Math.max(maxR, Math.hypot(s.x - cx, s.y - cy));
  const scale = 140 / maxR;
  const toScene = (x, y) => ({ x: (x - cx) * scale, z: (y - cy) * scale });
  systemSpan = 160;

  const path = bfsRoute(data.edges, routeFrom, routeTo);
  const routeEdgeKeys = new Set();
  if (path) for (let i = 0; i < path.length - 1; i++) routeEdgeKeys.add([path[i], path[i + 1]].sort().join("|"));
  const routeSystems = new Set(path ?? []);

  for (const s of nearby) {
    const p = toScene(s.x, s.y);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 6),
      new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.4 }),
    );
    mesh.position.set(p.x, 0, p.z);
    bodiesGroup.add(mesh);
  }

  for (const e of data.edges) {
    const a = known.find((s) => s.symbol === e.a), b = known.find((s) => s.symbol === e.b);
    if (!a || !b) continue;
    const pa = toScene(a.x, a.y), pb = toScene(b.x, b.y);
    const onRoute = routeEdgeKeys.has([e.a, e.b].sort().join("|"));
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(pa.x, 0, pa.z),
      new THREE.Vector3(pb.x, 0, pb.z),
    ]);
    const mat = new THREE.LineBasicMaterial({
      color: themedColor(onRoute ? "--accent" : "--hairline"),
      transparent: true, opacity: onRoute ? 0.9 : 0.4,
    });
    const line = new THREE.Line(geo, mat);
    if (onRoute) line.renderOrder = 5;
    linesGroup.add(line);
  }

  // Deliberately just two states beyond plain/home/route: whether a ship is
  // currently there. A schematic for navigating/planning, not a market
  // survey — that detail already lives in the per-system view.
  for (const s of known) {
    const p = toScene(s.x, s.y);
    const isHome = s.symbol === data.home;
    const onRoute = routeSystems.has(s.symbol);
    const color = s.ships > 0 ? "--accent" : (isHome ? "--ice" : "--dim");
    const coreRadius = isHome ? 2.4 : 1.8;

    const core = new THREE.Mesh(new THREE.SphereGeometry(coreRadius, 14, 10), new THREE.MeshBasicMaterial({ color: themedColor(color) }));
    core.position.set(p.x, 0, p.z);
    bodiesGroup.add(core);
    pickables.push({ mesh: core, kind: "galaxy-system", symbol: s.symbol });

    // A tilted, always-present ring so every glyph reads as "a whole
    // system in miniature" rather than a plain dot on a graph.
    const tilt = hashString(s.symbol + "tilt");
    const glyphRing = new THREE.Mesh(
      new THREE.RingGeometry(coreRadius * 1.8, coreRadius * 2.0, 20),
      new THREE.MeshBasicMaterial({ color: themedColor("--hairline"), side: THREE.DoubleSide, transparent: true, opacity: 0.5 }),
    );
    glyphRing.rotation.x = -Math.PI / 2.4 + tilt * 0.35;
    glyphRing.position.set(p.x, 0, p.z);
    ringsGroup.add(glyphRing);

    // A couple of deterministic orbiting "planets" — purely decorative,
    // seeded off the system symbol so a given system always looks the
    // same rather than reshuffling on every rebuild.
    const planetCount = 1 + Math.floor(Math.abs(hashString(s.symbol + "n")) * 3);
    for (let i = 0; i < planetCount; i++) {
      const angle = hashString(s.symbol + "a" + i) * Math.PI * 2;
      const orbitR = coreRadius * (2.6 + i * 1.1);
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 6, 5),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim") }),
      );
      planet.position.set(p.x + Math.cos(angle) * orbitR, 0, p.z + Math.sin(angle) * orbitR);
      bodiesGroup.add(planet);
    }

    if (isHome || onRoute) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(coreRadius * 3.2, coreRadius * 3.6, 24),
        new THREE.MeshBasicMaterial({ color: themedColor("--ice"), side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.05, p.z);
      ringsGroup.add(ring);
    }

    const label = makeLabelSprite(s.symbol, isHome ? "#dff2ff" : "#93a7bd");
    label.position.set(p.x, coreRadius + 4, p.z);
    bodiesGroup.add(label);
  }
}

/** The route-planner toolbar/result panel floats over the 3D canvas in
 *  galaxy mode — the only DOM piece left of the old flat-SVG overview,
 *  since a From/To search box is still plain HTML, not a scene object. */
function renderGalaxyToolbar() {
  const host = $("galaxy-overview");
  if (!host) return;
  const data = galaxyOverviewData;
  if (!data) { host.innerHTML = ""; return; }
  const known = data.systems.filter((s) => s.x !== null && s.y !== null);
  const missing = data.systems.length - known.length;
  const path = bfsRoute(data.edges, routeFrom, routeTo);
  const options = known.map((s) => `<option value="${escapeAttr(s.symbol)}">`).join("");
  const routeResult = !routeTo
    ? ""
    : path
      ? `<div class="gx-route-result">${path.length - 1} jump${path.length - 1 === 1 ? "" : "s"}: ${path.map((s) => escapeHtml(s)).join(" → ")}</div>`
      : `<div class="gx-route-result gx-route-none">No known gate chain from ${escapeHtml(routeFrom)} to ${escapeHtml(routeTo)} yet — scout further to find one.</div>`;

  host.innerHTML = `<datalist id="gx-system-options">${options}</datalist>
  <div class="gx-toolbar">
    <input list="gx-system-options" id="gx-route-from" placeholder="From" value="${escapeAttr(routeFrom)}" />
    <span class="gx-arrow">→</span>
    <input list="gx-system-options" id="gx-route-to" placeholder="Search a system…" value="${escapeAttr(routeTo)}" />
    <button class="btn ghost" id="gx-route-clear">Clear</button>
  </div>
  ${routeResult}
  ${missing ? `<div class="gx-missing-note">${missing} charted system${missing === 1 ? "" : "s"} not yet in the galaxy index</div>` : ""}`;

  const fromInput = host.querySelector("#gx-route-from"), toInput = host.querySelector("#gx-route-to");
  const commit = () => {
    routeFrom = fromInput.value.trim().toUpperCase();
    routeTo = toInput.value.trim().toUpperCase();
    renderGalaxyToolbar();
    scheduleRebuild();
  };
  fromInput.addEventListener("change", commit);
  toInput.addEventListener("change", commit);
  host.querySelector("#gx-route-clear").addEventListener("click", () => { routeTo = ""; renderGalaxyToolbar(); scheduleRebuild(); });
}

function setGalaxyMode(on) {
  galaxyMode = on;
  $("map-galaxy-toggle")?.classList.toggle("active", on);
  // Per-system-only chrome — not meaningful zoomed out to the galaxy. The
  // map itself (map3d) and its zoom controls stay: same scene, same camera.
  for (const id of ["system-strip", "map-gallery"]) {
    $(id)?.style.setProperty("display", on ? "none" : "");
  }
  document.querySelector(".map-legend")?.style.setProperty("display", on ? "none" : "");
  if (on) {
    // Deliberately NOT kicking the camera here: this used to move it toward
    // the galaxy framing right away, before GET /api/galaxy/overview had
    // resolved — since renderGalaxy3D() (further down) waits for that data
    // and won't swap the scene content until it lands, the camera spent
    // however long that fetch took drifting out over the OLD system's
    // content, an orphaned in-between look that belonged to neither view.
    // renderGalaxy3D() now snaps both camera and content together the
    // instant the data is ready, so this is an abrupt cut either way, not
    // eased motion into a state nothing has swapped to yet.
    loadGalaxyOverview();
  } else {
    $("galaxy-overview").innerHTML = "";
    renderMapLiveOrScrub();
  }
}

function initGalaxyToggle() {
  $("map-galaxy-toggle")?.addEventListener("click", () => setGalaxyMode(!galaxyMode));
}

/* ── BRIDGE: triage ───────────────────────── */
/** The left rail's two states: browsing (triage) or a selected hull's
 *  manifest. Only one shows at a time — this toggles both the sub-panels
 *  and the rail header's own label/count. */
function showRailTriage() {
  const t = $("triage"), m = $("manifest");
  if (t) t.style.display = "";
  if (m) m.style.display = "none";
  // No-op on desktop; on mobile this is "back" out of the ship-details
  // sheet opened by openShipDetails() below.
  document.body.classList.remove("mobile-ship-active");
  setCrumb(null);
  const items = bridge.triage ?? [];
  const n = $("rail-left-n");
  if (n) n.textContent = items.length ? String(items.length) : "clear";
}

function showRailManifest(shipSymbol) {
  const t = $("triage"), m = $("manifest");
  if (t) t.style.display = "none";
  if (m) m.style.display = "";
  setCrumb(shipSymbol);
  const n = $("rail-left-n");
  if (n) n.textContent = "manifest";
}

/** The inspector's breadcrumb. `leaf` is the selected hull, or null for the
 *  root. The root stays a live button in both states — at the root it is
 *  simply where you already are, which is what makes the trail readable as
 *  a position rather than as a back button that appears and vanishes. */
function setCrumb(leaf) {
  const root = $("rail-left-back"), sep = $("rail-left-sep"), title = $("rail-left-title");
  if (!root) return;
  root.classList.toggle("here", !leaf);
  root.setAttribute("aria-disabled", String(!leaf));
  if (sep) sep.hidden = !leaf;
  if (title) { title.hidden = !leaf; title.textContent = leaf ?? ""; }
}

function initInspectorCrumb() {
  $("rail-left-back")?.addEventListener("click", () => {
    if (!selectedShip) return;
    selectedShip = null;
    showRailTriage();
  });
}

function renderTriage() {
  const items = bridge.triage ?? [];
  const countTxt = items.length ? `${items.length} · by cost of inaction` : "clear";
  for (const id of ["triage-count", "mobile-triage-count"]) { const el = $(id); if (el) el.textContent = countTxt; }
  if (!selectedShip) { const n = $("rail-left-n"); if (n) n.textContent = items.length ? String(items.length) : "clear"; }

  const html = !items.length ? '<div class="empty">Nothing needs you. The engine has it.</div>' : items.map((t) => `
    <div class="alert sev${t.severity}">
      <div class="top">
        <span class="what">${escapeHtml(t.title)}</span>
        <span class="cost">${t.costPerHour ? signed(t.costPerHour) + "/hr" : ""}</span>
      </div>
      <div class="why">${escapeHtml(t.detail)}</div>
      ${t.engineWillAct
        ? `<div class="auto">Engine: <b>${escapeHtml(t.engineWillAct)}</b></div>`
        : `<div class="auto">Engine has <b style="color:var(--red)">no plan</b> for this</div>`}
      <div class="acts">
        ${(t.actions ?? []).map((a) =>
          `<button class="btn ${a.kind === "details" ? "" : "pri"}" data-kind="${escapeAttr(a.kind)}" data-body='${escapeAttr(JSON.stringify(a.body ?? {}))}'>${escapeHtml(a.label)}</button>`).join("")}
        ${t.shipSymbol ? `<button class="btn ghost" data-kind="focus" data-ship="${escapeAttr(t.shipSymbol)}">Show</button>` : ""}
      </div>
    </div>`).join("");

  for (const id of ["triage", "mobile-triage"]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = html;
    el.querySelectorAll("button[data-kind]").forEach((b) => {
      b.addEventListener("click", async () => {
        const kind = b.dataset.kind;
        const body = b.dataset.body ? JSON.parse(b.dataset.body) : {};
        if (kind === "details") return openShipDetails(body.shipSymbol);
        if (kind === "focus") { selectedShip = b.dataset.ship; renderFleetTable(); return; }
        const path = { refuel: "/api/fleet/refuel", hold: "/api/fleet/hold", release: "/api/fleet/release" }[kind];
        if (!path) return;
        b.disabled = true;
        try {
          await api("POST", path, body);
          showToastGlobal(`${body.shipSymbol}: ${kind} sent`);
          await loadBridge();
        } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
      });
    });
  }
}

/* ── BRIDGE: fleet table ──────────────────── */
const FLEET_COLS = [
  { key: "symbol", label: "Hull" },
  { key: "role", label: "Doctrine" },
  { key: "job", label: "Job" },
  { key: "net", label: "c/hr", num: true },
  { key: "fuel", label: "Fuel" },
  { key: "cargo", label: "Hold" },
  // Not `num`. That flag is purely presentational — it right-aligns the
  // <th> — and these two render as gauges: a meter followed by its
  // reading, left-aligned in the cell like every other gauge column. With
  // num set, the header sat hard right while its own data sat hard left,
  // so "Cond." appeared to label the crew column and "Crew" labelled
  // nothing. Sorting is unaffected: it keys off the value's type, not this.
  { key: "condition", label: "Cond." },
  { key: "crewCurrent", label: "Crew" },
  { key: "goal", label: "Doing" },
  { key: "at", label: "At" },
];



/** A compact "why is this ship not on the default flight mode" badge — see
 *  src/engine/flightMode.ts for the real decision logic this is just
 *  surfacing. Empty string (no badge) for CRUISE/STEALTH/undefined, since
 *  CRUISE is routine and this engine never selects STEALTH itself. */
function fmTag(flightMode) {
  if (flightMode === "DRIFT") return `<span class="fm-tag fm-drift">drift</span>`;
  if (flightMode === "BURN") return `<span class="fm-tag fm-burn">burn</span>`;
  return "";
}

/**
 * What a trader is actually working on, in the same vocabulary the
 * operator thinks in (route/contract/mission), not the dispatcher's
 * internal role names — see TraderAssignment in dispatcher.ts for what
 * each role means. Only traders carry a dispatch assignment at all; every
 * other role's job is already legible from the Doctrine/Doing columns.
 */
function jobFor(shipSymbol, role) {
  if (role !== "trader") return "—";
  const a = dispatchAssignments.find((x) => x.shipSymbol === shipSymbol);
  if (!a) return "unassigned";
  const good = escapeHtml(a.good);
  if (a.role === "direct") return `route: ${good}`;
  if (a.role === "contractBuy") return `contract: ${good}`;
  if (a.role === "haul") return `mission: ${good}`;
  if (a.role === "buy") return a.missionBuy ? `mission: ${good}` : `warehouse buy: ${good}`;
  if (a.role === "sell") return `warehouse sell: ${good}`;
  return good;
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const earnBy = new Map((bridge.earnings ?? []).map((e) => [e.shipSymbol, e.net]));
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      job: jobFor(s.symbol, st?.role),
      manual: !!st?.paused,
      stranded: strandedBy.has(s.symbol),
      net: earnBy.get(s.symbol) ?? 0,
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      condition: worstConditionPct(s) ?? 100,
      crewCurrent: s.crew?.current ?? 0, crewCapacity: s.crew?.capacity ?? 0, morale: s.crew?.morale ?? 0,
      goal: strandedBy.has(s.symbol) ? "stranded" : st?.paused ? "manual hold" : (s.nav?.status ?? "").replace(/_/g, " ").toLowerCase(),
      at: s.nav?.waypointSymbol ?? "",
      // nav.flightMode is sticky — the API doesn't reset it to CRUISE on
      // arrival, so a ship that flew its last leg in BURN keeps reporting
      // "BURN" while sitting idle in orbit, which reads as meaningless (it
      // isn't burning anything). Only surface it while actually mid-flight,
      // where it means something. CRUISE is the routine default even then,
      // so it's deliberately not surfaced as a tag (see fmTag() below) —
      // only a real deviation from it, while moving, is worth a glance.
      flightMode: s.nav?.status === "IN_TRANSIT" ? s.nav?.flightMode : undefined,
    };
  });
}

/** Compact, card-based fleet summary for the mobile page — the desktop
 *  fleet table's column layout doesn't fit a phone width, so this reuses
 *  the same row data with the dispatch-row styling instead. */
function renderMobileFleet() {
  const el = $("mobile-fleet");
  if (!el) return;
  const rows = fleetRows();
  $("mobile-fleet-count").textContent = `${rows.length} hulls`;
  if (!rows.length) { el.innerHTML = '<div class="empty">No ships yet.</div>'; return; }
  el.innerHTML = rows.map((r) => `
    <div class="dispatch-row mobile-fleet-row" data-ship="${escapeAttr(r.symbol)}">
      <span class="ship">${escapeHtml(r.symbol)}</span>
      <span class="good" style="min-width:0">${escapeHtml(r.role)}</span>
      <span class="route-txt">${r.job !== "—" ? `<b class="${r.job === "unassigned" ? "unassigned" : ""}">${r.job}</b> · ` : ""}${escapeHtml(r.goal)}${r.at ? ` · ${escapeHtml(shortWp(r.at))}` : ""}${fmTag(r.flightMode)}</span>
      <span class="prof">${signed(r.net)}/hr</span>
      <span class="chev">›</span>
    </div>`).join("");
}
$("mobile-fleet").addEventListener("click", (e) => {
  const row = e.target.closest(".mobile-fleet-row[data-ship]");
  if (row) { selectedShip = row.dataset.ship; openShipDetails(selectedShip); }
});

/** Bridge screen's hero card: the single highest-priority triage item,
 *  reusing bridge.triage exactly as renderTriage() does, just rendering
 *  only the first entry into #m-hero instead of the whole list. */
function renderMobileHero() {
  const el = $("m-hero");
  if (!el) return;
  const top = (bridge.triage ?? [])[0];
  if (!top) { el.innerHTML = '<div class="empty">Nothing needs you. The engine has it.</div>'; return; }
  el.innerHTML = `
    <div class="m-hero-tag">Needs you first</div>
    <div class="m-hero-headline">${escapeHtml(top.detail)}</div>
    <div class="m-hero-actions">
      ${(top.actions ?? []).map((a) =>
        `<button class="${a.kind === "details" ? "" : "pri"}" data-kind="${escapeAttr(a.kind)}" data-body='${escapeAttr(JSON.stringify(a.body ?? {}))}'>${escapeHtml(a.label)}</button>`).join("")}
    </div>`;
  el.querySelectorAll("button[data-kind]").forEach((b) => {
    b.addEventListener("click", async () => {
      const kind = b.dataset.kind;
      const body = b.dataset.body ? JSON.parse(b.dataset.body) : {};
      if (kind === "details") return openShipDetails(body.shipSymbol);
      const path = { refuel: "/api/fleet/refuel", hold: "/api/fleet/hold", release: "/api/fleet/release" }[kind];
      if (!path) return;
      b.disabled = true;
      try {
        await api("POST", path, body);
        showToastGlobal(`${body.shipSymbol}: ${kind} sent`);
        await loadBridge();
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
}

/** Bridge screen's fleet strip: same row data as renderMobileFleet(), laid
 *  out as horizontally-scrolling chips instead of stacked rows. */
function renderMobileFleetStrip() {
  const el = $("m-fleet-strip");
  if (!el) return;
  const rows = fleetRows();
  $("m-fleet-strip-count").textContent = `${rows.length} hulls`;
  el.innerHTML = rows.map((r) => `
    <div class="m-ship-chip" data-ship="${escapeAttr(r.symbol)}">
      <div class="sym">${escapeHtml(r.symbol)}</div>
      <div class="role">${escapeHtml(r.role)}</div>
      <div class="bar f"><i style="width:${r.fuelCap ? (r.fuel / r.fuelCap) * 100 : 0}%"></i></div>
      <div class="bar"><i style="width:${r.cargoCap ? (r.cargo / r.cargoCap) * 100 : 0}%"></i></div>
    </div>`).join("");
  el.querySelectorAll(".m-ship-chip").forEach((c) => c.addEventListener("click", () => openShipDetails(c.dataset.ship)));
}

/** Bridge screen's activity feed — the same recent fleet activity the
 *  right rail's watch shows, as a vertical list. */
function renderMobileActivity() {
  const el = $("m-activity");
  if (!el) return;
  if (!activity.length) { el.innerHTML = '<div class="empty">Waiting for fleet activity.</div>'; return; }
  el.innerHTML = activity.slice(0, 12).map((a) => `
    <div class="m-activity-line">
      <span class="when">${fmtTime(a.timestamp)}</span>
      <span class="txt">${escapeHtml(a.detail)}${a.credits == null ? "" : ` <b class="${a.credits < 0 ? "neg" : ""}">${signed(a.credits)}</b>`}</span>
    </div>`).join("");
}

/** Bridge screen's header — credits, net rate, alert count, mirroring the
 *  desktop topbar's data. */
function renderMobileTopbar() {
  const credits = $("m-credits");
  if (credits) credits.textContent = fmt(state?.agent?.credits ?? bridge.credits ?? 0);
  const rate = $("m-rate");
  if (rate) rate.textContent = signed(bridge.rate ?? 0) + "/hr";
  const badge = $("m-alert-badge");
  if (badge) badge.textContent = `${(bridge.triage ?? []).length} alert${(bridge.triage ?? []).length === 1 ? "" : "s"}`;
}

/** Compact one-line-per-ship "what is it doing" strip above the fleet table —
 *  the same summary the coordinator logs each tick, so the UI and the log
 *  agree on why every ship is (or isn't) acting. */
function renderFleetSummary() {
  const el = $("fleet-summary");
  if (!el) return;
  const rows = fleetStatus.summary ?? [];
  if (!rows.length) { el.innerHTML = ""; return; }
  el.innerHTML = rows.map((r) => {
    const cls = r.doing === "stranded" ? "warn" : r.doing === "manual hold" || r.doing === "suspended" ? "hold" : "";
    return `<span class="fs-chip ${cls}" title="${escapeAttr(`${r.symbol} · ${r.role} · ${r.waypoint} · fuel ${r.fuel}/${r.fuelCap} · cargo ${r.cargo}/${r.cargoCap}`)}">
      <b>${escapeHtml(shortWp(r.symbol))}</b> <i>${escapeHtml(r.doing)}</i></span>`;
  }).join("");
}

/** The Fleet tab's roster — every hull, sortable by any column. Field mode's
 *  map is the primary "browse ships" surface for spatial selection, but it
 *  can't show the whole fleet's status at a glance the way a table can, so
 *  this is back as its own tab rather than folded away. */
function renderFleetTable() {
  const el = $("fleet-table");
  if (!el) return;
  const rows = fleetRows();
  const countEl = $("fleet-count");
  if (countEl) countEl.textContent = `${rows.length} hulls`;
  if (!rows.length) { el.innerHTML = '<tbody><tr><td class="empty">No ships in the register.</td></tr></tbody>'; return; }

  const { key, dir } = fleetSort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });

  el.innerHTML = `
    <thead><tr>${FLEET_COLS.map((c) =>
      `<th class="${c.num ? "num " : ""}${key === c.key ? "sorted" : ""}" data-key="${c.key}">${c.label}${key === c.key ? (dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="${r.stranded ? "warn " : ""}${fleetDetailShip === r.symbol ? "sel" : ""}" data-ship="${escapeAttr(r.symbol)}">
        <td><span class="sym">${escapeHtml(shortWp(r.symbol))}</span></td>
        <td>${escapeHtml(r.role)}${r.manual ? ' <span style="color:var(--accent)">·M</span>' : ""}</td>
        <td><span class="goal${r.job === "unassigned" ? " unassigned" : ""}">${r.job}</span></td>
        <td class="num ${r.net > 0 ? "rate-up" : r.net < 0 ? "rate-down" : "rate-zero"}">${r.net ? signed(r.net) : "0"}</td>
        <td class="gauge"><span class="meter"><i style="width:${r.fuelCap ? (r.fuel / r.fuelCap) * 100 : 0}%"></i></span>${r.fuel}</td>
        <td class="gauge"><span class="meter c"><i style="width:${r.cargoCap ? (r.cargo / r.cargoCap) * 100 : 0}%"></i></span>${r.cargoCap ? `${r.cargo}/${r.cargoCap}` : "—"}</td>
        <td class="gauge"><span class="meter${r.condition < 50 ? " neg" : ""}"><i style="width:${r.condition}%"></i></span>${r.condition}%</td>
        <td class="gauge">${r.crewCapacity ? `<span class="meter${r.morale < 40 ? " neg" : ""}"><i style="width:${Math.max(0, Math.min(100, r.morale))}%"></i></span>${r.crewCurrent}/${r.crewCapacity}` : "—"}</td>
        <td><span class="goal">${escapeHtml(r.goal)}${fmTag(r.flightMode)}</span></td>
        <td><span class="goal">${r.at ? escapeHtml(shortWp(r.at)) : "—"}</span></td>
      </tr>`).join("")}</tbody>`;

  el.querySelectorAll("th[data-key]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key;
    fleetSort = { key: k, dir: fleetSort.key === k ? -fleetSort.dir : -1 };
    renderFleetTable();
  }));
  el.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openFleetShipDetail(tr.dataset.ship)));
  refreshFleetShipDetail();
}

/* ── DOCTRINE ─────────────────────────────── */
async function saveRule(key, patch) {
  try {
    const res = await api("POST", "/api/doctrine", { key, ...patch });
    setDoctrine(res.rules, undefined);
    renderMobileDoctrine();
    if (fieldBookMode === "book" && currentView === "bridge") renderBook();
    const r = res.rule;
    showToastGlobal(`${r.name}: ${r.enabled ? `${fmt(r.value)}${r.unit}` : "off"}`);
  } catch (err) { showToastGlobal(err.message, true); loadDoctrine(); }
}

/** Add/remove a policy from this tenant's active set — see saveRule() above
 *  for the value/enabled patch this is deliberately separate from. */
async function saveAdopted(key, adopted, value) {
  try {
    const res = await api("POST", "/api/doctrine/adopt", { key, adopted, value });
    setDoctrine(res.rules, res.catalog);
    renderMobileDoctrine();
    if (fieldBookMode === "book" && currentView === "bridge") renderBook();
    showToastGlobal(adopted ? `${res.rule?.name ?? key} added to standing orders` : `${key} removed from standing orders`);
  } catch (err) { showToastGlobal(err.message, true); loadDoctrine(); }
}

/** On/off only, no value editing — the mobile page's control surface for
 *  doctrine is deliberately narrower than the desktop sliders. */
function renderMobileDoctrine() {
  const el = $("mobile-doctrine");
  if (!el) return;
  if (!doctrineRules.length) { el.innerHTML = '<div class="empty">Doctrine unavailable — the fleet is still starting.</div>'; return; }
  $("mobile-doctrine-count").textContent = `${doctrineRules.filter((r) => r.enabled).length} / ${doctrineRules.length} on`;
  el.innerHTML = doctrineRules.map((r) => `
    <div class="dispatch-row" data-key="${escapeAttr(r.key)}">
      <button class="sw" aria-pressed="${r.enabled}" aria-label="Toggle ${escapeAttr(r.name)}"><i></i></button>
      <span class="good" style="min-width:0;flex:1">${escapeHtml(r.name)}</span>
      <span class="tag ${r.enforced ? "live" : ""}">${r.enforced ? "applied" : "not wired"}</span>
    </div>`).join("");
  el.querySelectorAll("[data-key]").forEach((row) => {
    const key = row.dataset.key;
    const sw = row.querySelector(".sw");
    sw.addEventListener("click", () => saveRule(key, { enabled: sw.getAttribute("aria-pressed") !== "true" }));
  });
}

function renderShiftLog() {
  const el = $("shift-log");
  if (!activity.length) { el.innerHTML = '<div class="empty">No events yet this shift.</div>'; return; }
  el.innerHTML = activity.slice(0, 40).map((a) => `
    <div class="logline">
      <div class="when">${fmtTime(a.timestamp)} · ${escapeHtml(a.kind)}</div>
      <div class="txt">${a.credits == null ? "" : `<span class="amt ${a.credits < 0 ? "neg" : "pos"}">${signed(a.credits)}</span>`}${escapeHtml(a.detail)}</div>
    </div>`).join("");
}

// Now only lives inside Book mode's sheet, rendered fresh each time — guard
// rather than assume the elements exist (they don't until renderBook() has
// run at least once).
async function initDiscord() {
  const urlEl = $("discord-url"), okEl = $("discord-ok"), toggleEl = $("discord-toggle");
  if (!urlEl) return;
  try {
    const cfg = await api("GET", "/api/discord");
    urlEl.placeholder = cfg.configured ? "Webhook set — leave blank to keep it" : "Webhook URL";
    toggleEl?.setAttribute("aria-pressed", String(cfg.enabled));
    if (cfg.configured) { okEl.textContent = cfg.enabled ? "Active." : "Paused."; okEl.style.color = cfg.enabled ? "var(--green)" : "var(--dim)"; }
  } catch (e) { /* engine not ready yet — leave the form blank */ }

  $("discord-save")?.addEventListener("click", async () => {
    const url = urlEl.value.trim();
    if (!url) return;
    try {
      await api("POST", "/api/discord", { webhookUrl: url });
      okEl.textContent = "Relay set.";
      okEl.style.color = "var(--green)";
    } catch (e) { okEl.textContent = e.message; okEl.style.color = "var(--red)"; }
  });

  toggleEl?.addEventListener("click", async () => {
    const next = toggleEl.getAttribute("aria-pressed") !== "true";
    try {
      await api("POST", "/api/discord/enabled", { enabled: next });
      toggleEl.setAttribute("aria-pressed", String(next));
      okEl.textContent = next ? "Relay resumed." : "Relay paused.";
      okEl.style.color = next ? "var(--green)" : "var(--dim)";
    } catch (e) { okEl.textContent = e.message; okEl.style.color = "var(--red)"; }
  });
}

/** Co-pilot LLM settings — recreated each renderBook() call like Discord's,
 *  so this both wires the buttons and prefills endpoint/model from whatever
 *  is already saved (the key itself is never sent back, so that field always
 *  starts blank — "configured" state is shown via the placeholder instead). */
async function initCopilotSettings() {
  const baseUrlEl = $("copilot-baseurl"), modelEl = $("copilot-model"), keyEl = $("copilot-key"), okEl = $("copilot-ok");
  if (!baseUrlEl) return;
  try {
    const cfg = await api("GET", "/api/settings/llm");
    baseUrlEl.value = cfg.baseUrl ?? "";
    modelEl.value = cfg.model ?? "";
    keyEl.placeholder = cfg.configured ? "Key set — leave blank to keep it" : "API key";
    if (cfg.configured) okEl.textContent = `Active (${cfg.model}).`;
  } catch (e) { /* engine not ready yet — leave the form blank */ }

  $("copilot-save").addEventListener("click", async () => {
    const model = modelEl.value.trim();
    const apiKey = keyEl.value.trim();
    if (!model) { okEl.textContent = "Model required."; okEl.style.color = "var(--red)"; return; }
    if (!apiKey) { okEl.textContent = "API key required (first-time setup)."; okEl.style.color = "var(--red)"; return; }
    try {
      await api("POST", "/api/settings/llm", { baseUrl: baseUrlEl.value.trim() || undefined, model, apiKey });
      okEl.style.color = "var(--green)";
      okEl.textContent = "Co-pilot enabled.";
      keyEl.value = "";
      keyEl.placeholder = "Key set — leave blank to keep it";
    } catch (e) { okEl.style.color = "var(--red)"; okEl.textContent = e.message; }
  });
  $("copilot-clear").addEventListener("click", async () => {
    try {
      await api("POST", "/api/settings/llm", {});
      okEl.style.color = "var(--dim)";
      okEl.textContent = "Co-pilot disabled.";
      baseUrlEl.value = "";
      modelEl.value = "";
      keyEl.value = "";
      keyEl.placeholder = "API key";
    } catch (e) { okEl.style.color = "var(--red)"; okEl.textContent = e.message; }
  });
}

/* ── MARKETS ──────────────────────────────── */
function renderRoutes() {
  let html;
  if (!marketRoutes.length) {
    html = '<div class="empty">No profitable routes in fresh snapshots. Tour some markets.</div>';
  } else {
    const misleading = marketRoutes.find((r) => r.marginPct > 60 && r.profitPerTrip < (marketRoutes[0].profitPerTrip / 4));
    const flyable = marketRoutes.filter((r) => !r.crossSystem);
    const gated = marketRoutes.filter((r) => r.crossSystem);
    html = `
      <div class="route-summary">
        <span class="count flyable"><b>${flyable.length}</b> same-system</span>
        <span class="count gated"><b>${gated.length}</b> need a gate</span>
      </div>
      ${flyable.length === 0 ? `<div class="callout warn"><b>No same-system routes right now</b> —
        every profitable route shown needs the gate.</div>` : ""}
      ${misleading ? `<div class="callout"><b>Ranked by what a trip actually earns</b>, not margin percentage.
        ${escapeHtml(misleading.goodSymbol)} shows a ${misleading.marginPct}% margin and sits far down this list —
        ${misleading.volume} units, ${misleading.fuelUnits ?? "?"} fuel to get there.</div>` : ""}
      ${marketRoutes.map((r, i) => `
        <div class="route ${i === 0 ? "best" : ""}">
          <div class="r1">
            <span class="good">${escapeHtml(r.goodSymbol)}</span>
            <span class="per">${signed(r.profitPerTrip)}/trip</span>
          </div>
          <div class="r2">${escapeHtml(shortWp(r.buyAt))} <b>${r.buyPrice}c</b> → ${escapeHtml(shortWp(r.sellAt))} <b>${r.sellPrice}c</b> · ${r.volume}u</div>
          <div class="r3">
            ${r.fuelUnits != null ? `${r.fuelUnits} fuel (${fmt(r.fuelCost)}c) · ` : ""}margin <b>${r.marginPerUnit}c</b> (${r.marginPct}%)
            ${r.crossSystem ? ' · <span style="color:var(--teal)">needs a gate</span>' : ""}
            ${r.ageMinutes > 45 ? ` · <span class="stale">${r.ageMinutes}m old</span>` : ""}
          </div>
        </div>`).join("")}`;
  }
  for (const id of ["routes", "mobile-routes"]) { const el = $(id); if (el) el.innerHTML = html; }
}

function renderSnapshots() {
  const el = $("snapshots");
  $("snap-count").textContent = `${new Set(marketSnapshots.map((s) => s.waypointSymbol)).size} markets`;
  if (!marketSnapshots.length) { el.innerHTML = '<div class="empty">No market snapshots yet.</div>'; return; }
  const byWp = new Map();
  for (const s of marketSnapshots) {
    if (!byWp.has(s.waypointSymbol)) byWp.set(s.waypointSymbol, []);
    byWp.get(s.waypointSymbol).push(s);
  }
  el.innerHTML = [...byWp.keys()].sort().map((wp) => {
    const goods = byWp.get(wp).sort((a, b) => a.goodSymbol.localeCompare(b.goodSymbol));
    const stamp = goods.reduce((m, g) => (g.timestamp > m ? g.timestamp : m), "");
    const age = fmtAge(stamp);
    const stale = stamp && (Date.now() - new Date(stamp).getTime()) > 90 * 60_000;
    return `<div class="mkt">
      <div class="h"><span><b>${escapeHtml(shortWp(wp))}</b></span>
        <span class="age ${stale ? "stale" : ""}">${fmtTime(stamp)} · ${age} old</span></div>
      <div class="goods">${goods.map((g) => `<div class="g">
        <span class="n" title="${escapeAttr(g.goodSymbol)}">${escapeHtml(g.goodSymbol)}</span>
        <span class="b">${g.purchasePrice}</span><span class="s">${g.sellPrice}</span></div>`).join("")}</div>
    </div>`;
  }).join("");
}

let priceGood = "";
// Redraw the price chart from its cached points on resize — the chart's
// viewBox matches the container's live size, so it needs to be recomputed
// when that size changes, not just when new data arrives.
let priceChartResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(priceChartResizeTimer);
  priceChartResizeTimer = setTimeout(() => {
    if (pricePoints.length) renderPriceChart(pricePoints, "price-chart");
  }, 150);
});

/* ── co-pilot drawer ──────────────────────── */
function initCopilot() {
  const drawer = $("copilot"), toggle = $("copilot-toggle");
  let chatLoaded = false;
  const setOpen = (open) => {
    drawer.classList.toggle("open", open);
    toggle.classList.toggle("on", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      $("chat-input").focus();
      if (!chatLoaded) { chatLoaded = true; loadChatHistory(); }
    }
  };
  toggle.addEventListener("click", () => setOpen(!drawer.classList.contains("open")));
  $("copilot-close").addEventListener("click", () => setOpen(false));
  $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
}

/* ── preserved: map, modals, chat, helpers ── */





// Waypoint glyphs by SpaceTraders type — shape and size carry meaning now,
// not just color. Market/shipyard used to override the type entirely (any
// market rendered as an identical dot regardless of whether it was a planet,
// moon, or station); market is now a separate accent ring drawn over
// whatever the waypoint actually is, so shape stays type, and the ring
// answers "can I trade here" independently. Waypoints are sized larger than
// ships throughout (see the ship glyph block below) — they're the permanent
// structure; ships are transient traffic passing through it.
const WP_GLYPH = {
  PLANET: { shape: "circle", r: 6, cls: "wp-planet" },
  GAS_GIANT: { shape: "ringed", r: 6.5, cls: "wp-gas-giant" },
  MOON: { shape: "circle", r: 3, cls: "wp-moon" },
  // Smaller than a planet's r=6 — a station orbits its planet at the exact
  // same coordinate (confirmed: A4 shares A1's x/y, F49 shares F48's), so it
  // was fighting the planet for the same footprint and needing more cluster
  // ring separation than a genuinely smaller, orbiting structure should.
  ORBITAL_STATION: { shape: "diamond", r: 2.3, cls: "wp-station", labeled: true },
  ASTEROID_BASE: { shape: "diamond", r: 2.3, cls: "wp-station", labeled: true },
  JUMP_GATE: { shape: "gate", r: 5, cls: "gate", labeled: true },
  ASTEROID_FIELD: { shape: "asteroid", r: 4.5, cls: "asteroid" },
  ASTEROID: { shape: "asteroid", r: 4, cls: "asteroid" },
  ENGINEERED_ASTEROID: { shape: "asteroid", r: 4.5, cls: "asteroid" },
  FUEL_STATION: { shape: "circle", r: 4.5, cls: "fuel" },
  NEBULA: { shape: "phenomenon", r: 5, cls: "phenomenon" },
  DEBRIS_FIELD: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  GRAVITY_WELL: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  ARTIFICIAL_GRAVITY_WELL: { shape: "phenomenon", r: 4, cls: "phenomenon" },
  __default: { shape: "circle", r: 2.5, cls: "wp" },
};

function drawWaypointGlyph(g, pos, symbol, isMarket, isYard) {
  const { x, y } = pos;
  const title = `<title>${symbol}</title>`;
  // A market is a border on the waypoint's own shape, not a separate marker
  // drawn on top of it — one glyph, one outline, no extra element to
  // position/cluster/collide with anything else.
  const cls = isMarket ? `${g.cls} market` : g.cls;
  // Shipyard can't share the same trick — a shape only has one `stroke`, and
  // a waypoint can be both a market and a shipyard at once — so it's a
  // second, slightly larger concentric ring instead of fighting the market
  // outline for the same property. Rarer than markets in practice, so the
  // extra element is cheap.
  const yardRing = isYard ? `<circle class="yard-ring" cx="${x}" cy="${y}" r="${g.r + 2.4}"></circle>` : "";
  if (g.shape === "gate") {
    return `<rect class="${cls}" x="${x - g.r}" y="${y - g.r}" width="${g.r * 2}" height="${g.r * 2}" transform="rotate(45 ${x} ${y})" data-wp="${symbol}">${title}</rect>${yardRing}`;
  }
  if (g.shape === "diamond") {
    return `<rect class="${cls}" x="${x - g.r}" y="${y - g.r}" width="${g.r * 2}" height="${g.r * 2}" transform="rotate(45 ${x} ${y})" data-wp="${symbol}">${title}</rect>${yardRing}`;
  }
  if (g.shape === "ringed") {
    // The whole body — outer ring ellipse and inner circle both — gets the
    // market outline here, not just the inner circle, so a gas-giant market
    // reads as clearly outlined as every other type instead of a smaller
    // accent buried inside a bigger unmarked shape.
    const ringCls = isMarket ? `${g.cls}-ring market` : `${g.cls}-ring`;
    return `<g data-wp="${symbol}">${title}<ellipse class="${ringCls}" cx="${x}" cy="${y}" rx="${g.r * 1.7}" ry="${g.r * 0.55}" transform="rotate(-24 ${x} ${y})"></ellipse><circle class="${cls}" cx="${x}" cy="${y}" r="${g.r * 0.75}"></circle>${yardRing}</g>`;
  }
  if (g.shape === "asteroid") {
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
  }
  if (g.shape === "phenomenon") {
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
  }
  // circle — planet, moon, fuel station, and the unknown-type fallback
  return `<circle class="${cls}" cx="${x}" cy="${y}" r="${g.r}" data-wp="${symbol}">${title}</circle>${yardRing}`;
}

// One shared hull shape for every ship, regardless of role — the earlier
// per-role shape family (diamond/arrow/slim/block) made a busy map read as
// a zoo of icons rather than a fleet. Role is now carried by color alone
// (see the role-* CSS rules below), grouped the same way the old shape
// families were: miner stands alone, scout/tour together, surveyor/siphoner
// together, keeper/warehouse together — trader (the most common role) is
// the unmarked default, same fill as an unselected/role-less hull always
// had. Local coordinate span is deliberately smaller than WP_GLYPH's radii
// (max ~4.5 here vs. up to 6.5 for a gas giant) so ships read as the
// smaller, moving thing against the larger, fixed waypoints — scale lives
// in the path data itself rather than a CSS transform, since a CSS
// transform on the same element would replace (not compose with) the
// inline rotate() attribute used below for the ship's heading.
//
// `headingDeg` is the real direction of travel (see shipHeadingDeg()) — SVG
// rotation is continuous, so this needed no per-direction sprite art, just
// one vector hull pointed by transform. A docked/orbiting ship (no motion)
// or a mid-transit one with incomplete route data falls back to the old
// fixed tilt (0 stationary / 45 "moving, direction unknown") rather than
// pointing nowhere meaningful.
function shipGlyphMarkup(role, docked, headingDeg) {
  const rot = headingDeg != null ? headingDeg : docked ? 0 : 45;
  return `<path class="hull role-${role ?? "trader"}" d="M0,-2.6 L2.1,2.1 L0,1.1 L-2.1,2.1 Z" transform="rotate(${rot})"></path>`;
}






/**
 * ── 3D map (v6) ──────────────────────────────────────────────────────────
 *
 * v3's flat SVG map replaced by a WebGL scene: the current system's
 * waypoints laid out at their real x/y (unchanged data, just plotted on a
 * horizontal plane instead of a flat screen), viewed through a camera that
 * orbits instead of panning/zooming a 2D transform. A waypoint sharing its
 * exact x/y with another (a station orbiting its planet — SpaceTraders does
 * this routinely) sits at the same point in 3D too, same as it always did;
 * the win over the flat map is that "same point" now separates visibly the
 * moment the camera tilts even slightly, with no cluster-ring math needed.
 *
 * A faint ring is drawn at each waypoint's real distance from the system's
 * origin (0,0) — an orbit path, not decoration: that radius is the same
 * hypot(x,y) the flat map already had, just drawn instead of implied.
 *
 * Everything downstream of "where is this waypoint/ship in the scene" is
 * unchanged: showWaypointTip()/openShipDetails() are the exact same
 * functions v3 called, and shipTransitLerp() (imported from domain.js) is
 * the exact same world-space interpolation the flat map used — only the
 * projection from world (x,y) to something on screen changed.
 *
 * Not ported in this pass: motion trails, and pinch/scroll-zoom's old
 * fixed 0.5–24x range (replaced by an orbit radius clamp scaled to each
 * system's own span, so "zoomed out" always means "the whole system", not
 * a magic number tuned for one).
 */

let lastRenderedShips = [];
/** World-space → scene-space transform from the most recent renderMap()
 *  call: an offset (the system's own centroid) and a uniform scale, so
 *  repositionShips() places a ship exactly where renderMap() would have
 *  placed a waypoint at the same coordinate. */
let mapScale = null;
let shipAnimHandle = null;
/** Live motion-trail state — same idea as the flat map's own liveTrails/
 *  lastTrailSamplePos (a per-ship buffer of recently sampled scene
 *  positions, sampled by distance moved rather than by frame or timer, so
 *  a ship sitting still doesn't fill the buffer with duplicate points). */
let liveTrails = new Map();
let lastTrailSamplePos = new Map();
/** The THREE.Line[] currently drawn for each ship's live trail, so
 *  repositionShips() can replace just that ship's segments each frame
 *  without touching linesGroup's renderMap()-owned contents. */
let liveTrailObjects = new Map();
const TRAIL_SAMPLE_MIN_SCENE = 0.5; // scene units — the flat map's 4px analog
const TRAIL_MAX_POINTS = 10;

const WP3D_COLOR = {
  PLANET: "--ice", GAS_GIANT: "--violet", MOON: "--buff",
  ORBITAL_STATION: "--bone", ASTEROID_BASE: "--bone",
  JUMP_GATE: "--teal", ASTEROID_FIELD: "--warn", ASTEROID: "--warn",
  ENGINEERED_ASTEROID: "--red", FUEL_STATION: "--teal",
  NEBULA: "--violet", DEBRIS_FIELD: "--violet", GRAVITY_WELL: "--violet",
  ARTIFICIAL_GRAVITY_WELL: "--violet",
};
// Kept small deliberately: a body's own radius feeds straight into the
// anti-overlap minimum distance below, so a large radius swallows small
// real coordinate differences under "just enough padding to not overlap."
// Shrinking the bodies gives real distances room to read as real distances.
const WP3D_SIZE = {
  PLANET: 3.0, GAS_GIANT: 4.2, MOON: 1.0,
  ORBITAL_STATION: 0.8, ASTEROID_BASE: 0.8,
  JUMP_GATE: 1.4, ASTEROID_FIELD: 0.6, ASTEROID: 0.45,
  ENGINEERED_ASTEROID: 0.6, FUEL_STATION: 1.0,
  NEBULA: 0.8, DEBRIS_FIELD: 0.6, GRAVITY_WELL: 1.4,
  ARTIFICIAL_GRAVITY_WELL: 1.4,
};
const SHIP3D_COLOR = {
  miner: "--buff", scout: "--violet", tour: "--violet",
  surveyor: "--teal", siphoner: "--teal",
  keeper: "--bone", warehouse: "--bone",
};

/**
 * Artificial Z-axis (elevation) for the 3D map.
 *
 * SpaceTraders only gives x/y, so we invent a stable, meaningful height
 * per waypoint. The goal is visual depth and natural-looking ship flight:
 * not everything sits on the same pancake plane.
 *
 * Rules:
 *  - Planets/gas giants define the ecliptic plane (z ≈ 0).
 *  - Moons orbit above/below their planet in a narrow band.
 *  - Stations orbit farther out from the plane than moons.
 *  - Asteroid fields and nebulae form a thick belt with a gentle wobble.
 *  - Jump gates sit on the plane but get a vertical glow instead of height.
 *  - A deterministic per-symbol micro-jitter separates multiple orbiters
 *    sharing the same x/y (common for stations orbiting a planet).
 *
 * All heights are in scene units, scaled so the camera can still frame the
 * whole system comfortably.
 */
const WP3D_ELEVATION = {
  PLANET: 0,
  GAS_GIANT: 0,
  JUMP_GATE: 0,
  MOON: 2.2,
  ORBITAL_STATION: 4.5,
  ASTEROID_BASE: 4.5,
  FUEL_STATION: 4.0,
  ASTEROID_FIELD: 2.0,
  ASTEROID: 1.5,
  ENGINEERED_ASTEROID: 1.8,
  NEBULA: 3.0,
  DEBRIS_FIELD: 2.2,
  GRAVITY_WELL: 2.5,
  ARTIFICIAL_GRAVITY_WELL: 2.5,
};
const ELEVATION_MICRO_RANGE = 1.2; // ± this much, deterministic per symbol
const TRANSIT_ARC_FACTOR = 0.12;    // arc height as fraction of scene distance

/** Stable pseudo-random float in [-1, 1] from a string. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h / 2147483647);
}

/** Elevation for a single waypoint. Cached by symbol because it is called
 *  from several places (bodies, rings, labels, ships, trails). */
const elevationCache = new Map();
function computeElevation(symbol, type, x, y) {
  const key = symbol;
  if (elevationCache.has(key)) return elevationCache.get(key);
  const base = WP3D_ELEVATION[type] ?? 0;
  const micro = hashString(symbol) * ELEVATION_MICRO_RANGE;
  // Belt objects (asteroid/nebula) also get a slow radial wave so the belt
  // reads as a volume rather than a flat ribbon.
  const r = Math.hypot(x, y);
  const beltWobble = (type === "ASTEROID_FIELD" || type === "ASTEROID" || type === "NEBULA" || type === "DEBRIS_FIELD")
    ? Math.sin(r * 0.15 + hashString(symbol) * 2) * 0.8
    : 0;
  const z = base + micro + beltWobble;
  elevationCache.set(key, z);
  return z;
}

function clearElevationCache() {
  elevationCache.clear();
}

/** Scene position with artificial elevation baked in. */
function waypointScenePos(wp, s) {
  const { x, z } = worldToScene(wp.x, wp.y, s);
  const y = computeElevation(wp.symbol, wp.type, wp.x, wp.y);
  return { x, y, z };
}

/** Elevation of a ship mid-transit. It arcs above/below the straight line
 *  between origin and destination so long hops read as climbs/dives rather
 *  than flat crawls. The arc peaks at the midpoint and returns to the
 *  destination's own elevation. */
function transitArcHeight(baseScenePos, originWP, destWP, s) {
  const originY = originWP ? computeElevation(originWP.symbol, originWP.type, originWP.x, originWP.y) : 0;
  const destY = destWP ? computeElevation(destWP.symbol, destWP.type, destWP.x, destWP.y) : 0;
  // Estimate fraction along the route from the base (flat) position. If
  // either endpoint is missing, just use the straight interpolation.
  let frac = 0.5;
  let routeDist = 0;
  if (originWP && destWP) {
    const o = worldToScene(originWP.x, originWP.y, s);
    const d = worldToScene(destWP.x, destWP.y, s);
    routeDist = Math.hypot(d.x - o.x, d.z - o.z);
    const done = Math.hypot(baseScenePos.x - o.x, baseScenePos.z - o.z);
    frac = routeDist > 0 ? Math.min(1, Math.max(0, done / routeDist)) : 0.5;
  }
  const linearY = originY + (destY - originY) * frac;
  // Arc above the straight line: taller for longer hops, peaking mid-route.
  const arc = routeDist > 0 ? Math.sin(Math.PI * frac) * routeDist * TRANSIT_ARC_FACTOR : 0;
  return { y: linearY + arc };
}

/** A CSS custom property, resolved to whatever color space it's actually
 *  declared in (oklch, hex, whatever the hue picker set) via the browser's
 *  own conversion, so the 3D scene tracks the live theme — including the
 *  operator's hue choice — instead of a hardcoded copy of it. */
const cssColorCache = new Map();
const colorProbe = document.createElement("span");
colorProbe.style.display = "none";
document.body.appendChild(colorProbe);
// Read back through a 1x1 canvas rather than THREE.Color.setStyle(): the
// theme's --accent is declared in oklch (so the hue picker can rotate it),
// and modern browsers hand that straight back from getComputedStyle() as an
// oklch() string. THREE r128 predates CSS Color 4 and can't parse that —
// setStyle() fails silently, leaving the accent black. Canvas fillStyle
// parsing goes through the browser's own CSS color engine and always reads
// back as sRGB bytes via getImageData(), so it handles any color syntax the
// stylesheet throws at it without this needing to know which one that is.
const probeCanvas = document.createElement("canvas");
probeCanvas.width = 1; probeCanvas.height = 1;
const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
function cssColor(varName) {
  colorProbe.style.color = `var(${varName})`;
  const value = getComputedStyle(colorProbe).color;
  probeCtx.fillStyle = value;
  probeCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r / 255, g / 255, b / 255);
}
function invalidateColorCache() { cssColorCache.clear(); }
function themedColor(varName) {
  if (!cssColorCache.has(varName)) cssColorCache.set(varName, cssColor(varName));
  return cssColorCache.get(varName);
}
// A darker two-tone variant of a body/ship's own role color, for secondary
// structural parts (wings, struts, pods) that should read as "part of this
// same thing" rather than a fixed, unrelated accent color — keeps "role/
// selection owns color" intact (nothing here is hardcoded to a bucket or
// waypoint type) while giving flat single-hue shapes some depth.
function trimColor(color) {
  return color.clone().multiplyScalar(0.55);
}
// The hue picker (header) repaints --accent-hue on click; ship/selection
// materials below are read once at scene-build time, so a hue change needs
// this to know the cache is stale. Cheap: only fires on an explicit click.
document.getElementById("hue-picker")?.addEventListener("click", (e) => {
  if (e.target.closest(".hue-btn")) { invalidateColorCache(); scheduleRebuild(); }
});

let scene, camera, renderer, host;
let composer, bloomPass; // undefined if the postprocessing addons failed to load — see initMap3D()
let bodiesGroup, ringsGroup, shipsGroup, glowGroup, linesGroup, liveTrailGroup;
const pickables = []; // { mesh, kind: 'waypoint'|'ship', symbol }
let raycaster, pointerNdc;
const orbitCam = { theta: 0.7, phi: 1.0, radius: 60, target: new THREE.Vector3(0, 0, 0) };
const orbitGoal = { theta: 0.7, phi: 1.0, radius: 60, target: new THREE.Vector3(0, 0, 0) };
let systemSpan = 90; // current system's own radius, used to scale zoom limits to it
let sceneReady = false;
let pendingRebuild = null;
let mapUnavailable = false;
let framedSystem = null; // which system the camera was last auto-fit to
let starGlowPulse = null; // { core, corona, t } — set once in initMap3D(), animated in tickMap3D()
// The star (sphere + its two glow sprites) lives in its own group, never
// touched by clearGroup() — bodiesGroup/glowGroup/etc. get wiped and
// rebuilt on every render pass (system or galaxy), and the star is a
// permanent fixture created once by initMap3D(), not per-render content.
// It used to sit directly in `scene` (mesh) and inside glowGroup (its
// glow sprites) — the glow sprites being in a cleared group meant they
// were destroyed the very first render pass of the whole session and
// never came back. Galaxy mode has no star of its own (a whole system
// reduces to one small marker at that scale), so this group is just
// toggled visible/hidden on mode switch instead.
let starGroup = null;
// Jump-gate "active portal" pulse rings. A persistent group (like
// liveTrailGroup) rather than something renderMap() rebuilds every poll —
// a gate's own animation phase would otherwise reset every ~1s and never
// visibly progress. renderMap() only adds/removes entries as gates appear/
// disappear from the current system; tickMap3D() animates them every frame.
let gatePulseGroup;
const gatePulses = new Map(); // symbol -> { sprite, phase }

function initMap3D() {
  if (sceneReady || mapUnavailable) return;
  host = $("map3d");
  scene = new THREE.Scene();
  // Near/far tightened to what the camera actually ever uses (zoom clamps
  // to [systemSpan*0.35, systemSpan*6] ≈ [28, 480] — see the wheel/pinch
  // handlers below) rather than an arbitrary 0.1-4000. A standard (non-
  // logarithmic) depth buffer's precision is worst at the far end of its
  // range and wasted almost entirely on distances nothing ever renders at;
  // a 40,000:1 near:far ratio left too little precision at the distances
  // that matter, which read as z-fighting flicker between a body and its
  // own atmosphere rim — worse on mobile GPUs' typically lower-precision
  // depth buffers, confirmed live as exactly where it showed up. 1500 (not
  // 480) keeps headroom for wide pans/edge cases without giving back the
  // precision this was fixing.
  camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight || 1, 1, 1500);
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    mapUnavailable = true;
    host.innerHTML = '<div class="map3d-unavailable">3D map unavailable — this browser has no WebGL support.</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth || 1, host.clientHeight || 1);
  host.appendChild(renderer.domElement);

  // Bloom: without it, the star/glow sprites/emissive markers are just
  // bright-colored pixels, no different from any other mesh — a real
  // bloom pass is what actually sells "this is emitting light" rather
  // than "this is painted a bright color". The addon scripts load as
  // plain classic <script> tags in v6.html (same pattern three.min.js
  // itself already uses), so this checks for them rather than assuming —
  // the map has to keep working even if that CDN load fails for any
  // reason, just without the bloom.
  if (typeof THREE.EffectComposer === "function") {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(host.clientWidth || 1, host.clientHeight || 1),
      0.75, // strength — dimmed slightly from 0.9; the star's own glow (a
            // separate corona sprite, dimmed alongside this) still bloomed
            // brighter than intended even after the threshold fix
      0.5,  // radius
      // threshold — raised from an initial 0.18. A normal lit body surface
      // (diffuse shading + the small 0.05 emissive floor) already sits
      // well above a low threshold, so *everything* bloomed a little and
      // the per-type surface textures — much subtler contrast than the
      // star or a glow sprite — got crushed into a uniform soft blur
      // along with it. 0.55 keeps bloom for what's actually meant to look
      // like it's emitting light (the star, glow sprites, jump-gate/fuel
      // halos) without smearing out ordinary lit-surface detail.
      0.55,
    );
    composer.addPass(bloomPass);
  }

  bodiesGroup = new THREE.Group();
  ringsGroup = new THREE.Group();
  shipsGroup = new THREE.Group();
  glowGroup = new THREE.Group();
  linesGroup = new THREE.Group();
  // Separate from linesGroup deliberately: renderMap() clears and rebuilds
  // linesGroup on every state refresh, but a live trail has to survive
  // that — it's built up frame by frame in repositionShips(), independent
  // of the slower render cycle.
  liveTrailGroup = new THREE.Group();
  // Same reasoning as liveTrailGroup: a gate's pulse animation has to keep
  // progressing across renderMap()'s ~1s poll cycle, so it lives outside
  // the groups that cycle gets cleared and rebuilt.
  gatePulseGroup = new THREE.Group();
  starGroup = new THREE.Group();
  scene.add(bodiesGroup, ringsGroup, shipsGroup, glowGroup, linesGroup, liveTrailGroup, gatePulseGroup, starGroup);

  // Bodies use a lit material now (see WP3D_MATERIAL below) instead of flat
  // MeshBasicMaterial — a shaded, lit sphere reads as a rendered object. The
  // system star is the light source: a point light at the origin radiates
  // outward in all directions, so every body is lit from the center no
  // matter where it orbits. Low decay keeps distant outliers from going dim.
  //
  // The star's own *visible* color (STAR_COLOR below, a warm red dwarf
  // tone) and the *light* it casts are deliberately different colors now —
  // confirmed live: casting light in that same warm-pink tone washed every
  // lit body pink, since it was the only real light source in the scene.
  // A near-neutral warm-white light keeps the star looking like a red
  // dwarf without tinting everything else.
  //
  // The dark side was also crushed to near-black: a PointLight decays with
  // distance, so anything shadow-facing got only whatever the flat ambient
  // fill provided, and that fill was too dim/dark a color to matter. A
  // HemisphereLight fills from every direction with NO distance falloff
  // (unlike the star), so it's what actually keeps a shadow face legible
  // regardless of how far that body orbits — the flat AmbientLight is kept
  // too, small, just to lift the absolute floor a touch further.
  scene.add(new THREE.HemisphereLight(0x4a5578, 0x1a1420, 1.35));
  scene.add(new THREE.AmbientLight(0x2a3040, 0.35));
  const starLight = new THREE.PointLight(0xfff1d8, 2.2, 0, 0.32);
  starLight.position.set(0, 0, 0);
  scene.add(starLight);

  // A central star marker, bigger than planets so it reads as the system
  // primary and justifies pushing everything else outward. Red dwarf tone
  // is easier on the eyes than a blazing white sun and still reads as a
  // star. The sphere itself is unlit (MeshBasicMaterial — it IS the light
  // source, nothing should shade it), but a flat single fillStyle read as
  // a placeholder dot rather than a star: a radial gradient texture gives
  // it a hot white-yellow core fading to the red-dwarf edge, the same
  // "limb" cue a real star photo has.
  const STAR_COLOR = 0xff7b72;
  const starTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "#fff8e8");
    g.addColorStop(0.35, "#ffd9a0");
    g.addColorStop(0.7, "#ff9a72");
    g.addColorStop(1, "#" + new THREE.Color(STAR_COLOR).getHexString());
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(6.5, 32, 24),
    new THREE.MeshBasicMaterial({ map: starTex }),
  );
  star.position.set(0, 0, 0);
  starGroup.add(star);

  // Layered glow instead of one flat halo: a tight hot-white core glow
  // reads as brightness right at the surface, a much larger, softer,
  // dimmer corona around that reads as light actually spilling into
  // space. `starGlowPulse` holds both so tickMap3D() can breathe them —
  // a static glow read as another placeholder once the sphere itself
  // stopped looking like one.
  const starCoreGlow = makeGlowSprite(new THREE.Color(0xfff2d0), 26);
  const starCorona = makeGlowSprite(new THREE.Color(STAR_COLOR), 70);
  starCoreGlow.position.set(0, 0, 0);
  starCorona.position.set(0, 0, 0);
  starCorona.material.opacity = 0.42;
  starGroup.add(starCorona, starCoreGlow);
  starGlowPulse = { core: starCoreGlow, corona: starCorona, t: 0 };

  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2();

  applyOrbitCamera();
  attachMapControls();
  new ResizeObserver(onMapResize).observe(host);
  sceneReady = true;
  tickMap3D();
}

function onMapResize() {
  if (!sceneReady) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) {
    composer.setSize(w, h);
    bloomPass.resolution.set(w, h);
  }
}

function applyOrbitCamera() {
  const sp = orbitCam.radius * Math.sin(orbitCam.phi);
  camera.position.set(
    orbitCam.target.x + sp * Math.cos(orbitCam.theta),
    orbitCam.target.y + orbitCam.radius * Math.cos(orbitCam.phi),
    orbitCam.target.z + sp * Math.sin(orbitCam.theta),
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(orbitCam.target);
}

/** A tiny deterministic PRNG seeded from a string (via hashString above), so
 *  a body's surface texture and crater/blotch placement are stable across
 *  every re-render instead of re-randomizing (and visibly flickering) on
 *  every ~1s poll. Not cryptographic — a linear congruential generator is
 *  plenty for "these blotches always land in the same place." */
function seededRandom(seedStr) {
  let seed = Math.abs(Math.floor(hashString(seedStr) * 2147483647)) || 1;
  return function () {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** 3D simplex noise (Gustavson's public-domain algorithm), permutation
 *  table shuffled by the same seeded `rand` a body's drawer already
 *  receives — so a waypoint's noise field is exactly as stable as
 *  everything else keyed off its symbol. Returns roughly [-1, 1]. Sampled
 *  in 3D (never the flat 2D canvas directly) so wrapping it around a
 *  sphere has no seam at U=0/1 and no pinching at the poles — see
 *  sphereNoise() below. */
function makeSimplex3(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const grad3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  ];
  const F3 = 1 / 3, G3 = 1 / 6;
  return function simplex3(xin, yin, zin) {
    let n0, n1, n2, n3;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const X0 = i - t, Y0 = j - t, Z0 = k - t;
    const x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 < 0) n0 = 0;
    else {
      const gi0 = permMod12[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0 + grad3[gi0][2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 < 0) n1 = 0;
    else {
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1 + grad3[gi1][2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 < 0) n2 = 0;
    else {
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2 + grad3[gi2][2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 < 0) n3 = 0;
    else {
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n3 = t3 * t3 * (grad3[gi3][0] * x3 + grad3[gi3][1] * y3 + grad3[gi3][2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  };
}

/** Sums `octaves` layers of the given noise fn at doubling frequency and
 *  `persistence`-scaled amplitude (standard fractal Brownian motion),
 *  normalized back to roughly [-1, 1]. */
function fbm3(noiseFn, x, y, z, octaves, persistence) {
  let total = 0, amplitude = 1, maxAmplitude = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    total += noiseFn(x * freq, y * freq, z * freq) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= persistence;
    freq *= 2;
  }
  return total / maxAmplitude;
}

/** UV→sphere→fbm3 glue: converts a canvas pixel's (u, v) to a point on a
 *  unit sphere and samples fbm3 there, so the resulting texture has no
 *  seam where U wraps and no pinch at the poles. */
function sphereNoise(noiseFn, u, v, octaves, persistence, freq) {
  const theta = u * Math.PI * 2;
  const phi = v * Math.PI;
  const x = Math.sin(phi) * Math.cos(theta) * freq;
  const y = Math.cos(phi) * freq;
  const z = Math.sin(phi) * Math.sin(theta) * freq;
  return fbm3(noiseFn, x, y, z, octaves, persistence);
}

/** Fills the whole canvas from a per-pixel (u, v) -> [r, g, b, a] callback
 *  in one ImageData write instead of thousands of individual fillRect
 *  calls — the noise-driven drawer backgrounds below all use this. */
function paintNoiseCanvas(ctx, size, colorAt) {
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const [r, g, b, a] = colorAt(u, v);
      const idx = (y * size + x) * 4;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Procedural per-body surface texture — grayscale lightness only, drawn
 * once per waypoint symbol and cached (elevationCache's own pattern) so a
 * periodic renderMap() doesn't regenerate a canvas, and re-roll its random
 * placement, on every poll. Applied as `material.map` alongside the
 * existing flat `color`: Three multiplies the two, so a system still reads
 * by its established WP3D_COLOR palette — this only adds real surface
 * detail (continents, bands, craters) on top of it instead of replacing it.
 * Types with no plausible natural surface (stations, gates, gravity wells)
 * return null and stay flat, same as before this pass.
 */
/**
 * One cache entry per waypoint holds everything derived from its biome
 * canvas: the texture makeBodyTexture() hands to the material, and the raw
 * pixel data makeBodyGeometry() reads as a height field for real vertex
 * displacement — see that function's comment. Both draw from the exact
 * same canvas (same variant, same seed), so the bumps line up with the
 * pattern instead of two independently-random textures fighting each
 * other.
 */
const bodyVisualCache = new Map();
function ensureBodyVisual(symbol, type, traits) {
  if (bodyVisualCache.has(symbol)) return bodyVisualCache.get(symbol);
  const variants = BODY_TEXTURE_DRAWERS[type];
  if (!variants) {
    bodyVisualCache.set(symbol, null);
    return null;
  }
  // Prefer the waypoint's own real SpaceTraders traits over a coin flip: a
  // VOLCANIC-tagged planet should look volcanic, not whichever variant its
  // symbol happened to hash to. BODY_TEXTURE_TRAITS lists, per type, which
  // trait symbols point at which variant index — first match wins. Only
  // waypoints with none of the listed traits (or a type with no mapping at
  // all) fall back to the old hash, which is still what keeps two otherwise
  // identical bodies from looking like carbon copies.
  const traitSymbols = (traits ?? []).map((t) => t?.symbol ?? t);
  const traitMap = BODY_TEXTURE_TRAITS[type];
  let variantIndex = traitMap ? traitMap.findIndex((symbols) => symbols.some((s) => traitSymbols.includes(s))) : -1;
  if (variantIndex < 0) {
    // Which variant a waypoint gets is picked once, from a hash of its own
    // symbol — a real SpaceTraders symbol never changes, so this is stable
    // forever with no need to actually assign-and-persist a "subtype" on
    // first discovery: the hash IS the persisted assignment, for free.
    variantIndex = Math.floor(Math.abs(hashString(symbol + ":variant")) * variants.length) % variants.length;
  }
  const variant = variants[variantIndex];
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  variant(ctx, size, seededRandom(symbol));
  // The drawers above were designed against a flat, unlit preview and read
  // clearly there — but under this map's actual point-light + PBR specular
  // response, that same ~90-220 lightness range gets compressed hard: the
  // lit hemisphere pushes toward a blown-out highlight, the unlit side
  // toward a flat emissive floor, and what's left in between barely
  // survives. Push contrast out from mid-gray before this ever becomes a
  // texture, so the surface pattern still reads once real lighting (and
  // the sphere-UV mip issue worked around above) get their turn at it.
  const boosted = ctx.getImageData(0, 0, size, size);
  const px = boosted.data;
  const contrast = 1.7;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.max(0, Math.min(255, (px[i] - 128) * contrast + 128));
    px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] - 128) * contrast + 128));
    px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] - 128) * contrast + 128));
  }
  ctx.putImageData(boosted, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Confirmed live (a JUNGLE planet rendering as a flat, patternless blob)
  // and reproduced in isolation: a body's mip-mapped canvas texture, wrapped
  // around a SphereGeometry's UVs, samples as a smooth near-uniform blur
  // with no surface detail at all — even fully unlit, even on a bare test
  // scene with nothing else in it. A flat PlaneGeometry with the identical
  // texture renders correctly; only the sphere's wrapped UVs trigger it,
  // which points at automatic mip selection picking a wildly-too-coarse
  // level (the U seam's UV derivative jumps hugely at a full 0→1 wrap).
  // Skipping mipmaps and sampling the base level directly restores the
  // pattern. The texture is only ever seen at a few fixed close-in zoom
  // levels on this map, never minified enough for losing mips to look
  // aliased, so there's no real tradeoff here.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  // Reused across every renderMap() rebuild — see clearGroup()'s comment for
  // why this must survive the mesh that's currently wearing it.
  tex.__persistent = true;
  const entry = { tex, imageData: boosted, size };
  bodyVisualCache.set(symbol, entry);
  return entry;
}

function makeBodyTexture(symbol, type, traits) {
  return ensureBodyVisual(symbol, type, traits)?.tex ?? null;
}

// Planets and moons get real relief carved into the mesh, not just a flat
// color texture — the same biome canvas ensureBodyVisual() already draws
// (jungle canopy, volcanic cracks, ice fractures, crater fields...) doubles
// as a height field, so a JUNGLE world reads as lumpy canopy and a rocky
// moon as genuinely cratered under real lighting, not just tinted. Gas
// giants (fluid, banded, no surface) and everything else keep a plain
// sphere — displacement only makes sense for a body with actual terrain.
const DISPLACED_BODY_TYPES = new Set(["PLANET", "MOON"]);
const bodyGeometryCache = new Map();
function makeBodyGeometry(symbol, type, traits, radius) {
  if (bodyGeometryCache.has(symbol)) return bodyGeometryCache.get(symbol);
  const displace = DISPLACED_BODY_TYPES.has(type);
  // Higher tessellation only where it buys real detail — everything else
  // keeps the original 20x16 a flat-shaded sphere doesn't need more than.
  const geo = displace
    ? new THREE.SphereGeometry(radius, 48, 32)
    : new THREE.SphereGeometry(radius, 20, 16);
  if (displace) {
    const visual = ensureBodyVisual(symbol, type, traits);
    if (visual) {
      const { imageData, size } = visual;
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      // Up to ~7% of the body's own radius — enough to read as real relief
      // at this map's usual zoom without turning a planet into a spiky mess.
      const amplitude = radius * 0.07;
      for (let i = 0; i < pos.count; i++) {
        const px = Math.min(size - 1, Math.max(0, Math.floor(uv.getX(i) * size)));
        const py = Math.min(size - 1, Math.max(0, Math.floor((1 - uv.getY(i)) * size)));
        const lightness = imageData.data[(py * size + px) * 4] / 255; // grayscale: R=G=B
        const displacement = (lightness - 0.5) * 2 * amplitude;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.hypot(x, y, z) || 1;
        const scale = (len + displacement) / len;
        pos.setXYZ(i, x * scale, y * scale, z * scale);
      }
      pos.needsUpdate = true;
      // Bent normals from the new bumps, not the original sphere's — this
      // is what makes the relief actually catch light instead of just
      // silently reshaping the silhouette.
      geo.computeVertexNormals();
    }
  }
  // Reused across every renderMap() rebuild — recomputing ~1,600 displaced
  // vertices every ~1s poll for every visible planet/moon for no reason
  // would be wasteful, and clearGroup() already knows to leave a
  // `__persistent` resource alone instead of disposing it out from under
  // the cache that's still holding it (see that function's comment).
  geo.__persistent = true;
  bodyGeometryCache.set(symbol, geo);
  return geo;
}

// ASTEROID/ASTEROID_FIELD/ENGINEERED_ASTEROID get the same "not quite
// round" treatment as ASTEROID_BASE's rock, rather than the smooth sphere
// every other undisplaced type keeps — real asteroids read as lumpy at any
// size, unlike a planet or gas giant. Deliberately its own cache/function
// rather than folding into makeBodyGeometry()/DISPLACED_BODY_TYPES: that
// pipeline's displacement rides the body's own biome canvas as a height
// field (continents, ice fractures...) which doesn't apply to a bare rock,
// so this perturbs the mesh geometry directly instead.
const IRREGULAR_ROCK_TYPES = new Set(["ASTEROID", "ASTEROID_FIELD", "ENGINEERED_ASTEROID"]);
const rockGeometryCache = new Map();
function makeRockGeometry(symbol, radius) {
  if (rockGeometryCache.has(symbol)) return rockGeometryCache.get(symbol);
  const rand = seededRandom(symbol + ":rock");
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const bump = 1 + (rand() - 0.5) * 0.4;
    pos.setXYZ(i, (x / len) * len * bump, (y / len) * len * bump, (z / len) * len * bump);
  }
  geo.computeVertexNormals();
  geo.__persistent = true; // same reuse-across-rebuilds reasoning as bodyGeometryCache
  rockGeometryCache.set(symbol, geo);
  return geo;
}

// Each type maps to an array of *variant* drawers, not one — which variant
// a given waypoint gets is picked in makeBodyTexture() from a hash of its
// own symbol, so two PLANET waypoints in the same system can look
// genuinely different (continents vs. ice vs. cracked-volcanic) instead of
// every one being a minor random reshuffle of the same single pattern.
//
// This used to say every variant was deliberately grayscale — pattern
// only, never hue — to protect the map's one color contract (WP3D_COLOR
// says "this is a planet" vs "this is a gas giant" by hue). Confirmed
// live: that was the actual reason only the volcanic variant ever read as
// textured. A pure `rgba(v,v,v,a)` blotch only shifts *lightness*, and
// this map's real lighting (a strong point light plus PBR specular
// response) compresses lightness differences hard — volcanic's orange
// embers survived because a hue shift doesn't get compressed the same
// way, not because its blotches were bigger or more opaque (the failed
// first attempt at this fix pushed every variant's alpha and value range
// toward volcanic's own and it made no visible difference). Every variant
// below now carries a small hue accent the same way volcanic always did.
// The accents are subtly off-neutral, not saturated — the base fill (most
// of the visible disc) stays close to the type's own palette color, so
// "this is a planet" still reads at a glance; only the feature blotches
// that are supposed to stand out now actually can.
const BODY_TEXTURE_DRAWERS = {
  PLANET: [
    // Continents: soft overlapping blotches at varying lightness — reads
    // as terrain from orbit without needing real Perlin noise for a
    // sphere this small on screen.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Land above the noise field's median, base tone below it — real
      // jagged coastlines instead of soft round blobs.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 3, 0.5, 1.8);
        if (n > 0) {
          const t = Math.min(1, n * 1.8);
          const val = Math.round(140 + t * 95);
          // Warm tan/green landmass hue, not pure gray — see the comment
          // above BODY_TEXTURE_DRAWERS for why a hue accent (not just
          // alpha/range) is what actually survives this map's real lighting.
          return [Math.min(255, val + 12), Math.min(255, val + 4), Math.max(0, val - 22), 255];
        }
        const val = Math.round(130 + n * 25);
        return [val, val, val, 255];
      });
    },
    // Ice: a bright base with soft frost patches for area coverage plus a
    // network of cracks on top — the patches alone (cracks are thin lines
    // that cover almost no area) are what make this variant actually read
    // from a distance instead of just looking like a flat pale ball with
    // a few hairline scratches.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A lower-frequency fbm layer for frost-patch area coverage, plus a
      // ridge-noise pass (1 - abs(noise), the standard trick for linear
      // crack-like features) for the crack network — a real fracture
      // pattern instead of hand-drawn random-walk lines.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const frost = sphereNoise(noise, u, v, 3, 0.5, 1.6);
        const ridge = 1 - Math.abs(sphereNoise(noise, u + 7.3, v + 2.1, 1, 0.5, 2.6));
        if (ridge > 0.92) return [70, 90, 110, 255];
        const base = Math.round(160 + frost * 70);
        // Cold blue-white frost, not pure gray.
        return [Math.max(0, base - 20), base, Math.min(255, base + 15), 255];
      });
    },
    // Volcanic: a dark base with glowing cracks/blotches — same silhouette
    // as the continents variant but inverted lightness and hot accents.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Higher-frequency ridge noise for the fracture network itself,
      // thresholded and colored with the same warm-ember hue at the ridge
      // crests. The radial-gradient glow below is a lighting effect on top
      // of the fractures, not a background pattern — left untouched.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const ridge = 1 - Math.abs(sphereNoise(noise, u, v, 1, 0.5, 3.2));
        if (ridge > 0.85) {
          const t = (ridge - 0.85) / 0.15;
          return [Math.round(200 + t * 55), Math.round(90 + t * 90), Math.round(50 + t * 70), 255];
        }
        return [58, 50, 48, 255];
      });
      for (let i = 0; i < 10; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.03 + rand() * 0.1);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,180,120,0.9)");
        g.addColorStop(0.4, "rgba(200,90,50,0.5)");
        g.addColorStop(1, "rgba(200,90,50,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
    // Swamp: a mid-grey base pocked with small dark bog pools plus a
    // network of thin winding waterways — busier and more irregular than
    // continents' broad soft blotches, reading as wet, low terrain rather
    // than dry landmasses.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Low-threshold blotchy fbm for bog-pool coverage, plus a ridge-noise
      // pass for the waterway channels — a real drainage-like network
      // instead of hand-drawn random-walk lines.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const bog = sphereNoise(noise, u, v, 2, 0.55, 1.8);
        const channel = 1 - Math.abs(sphereNoise(noise, u + 4.1, v + 9.7, 1, 0.5, 2.8));
        if (channel > 0.93) return [35, 55, 35, 255];
        if (bog > 0.25) {
          const val = Math.round(30 + (bog - 0.25) * 40);
          // Murky bog green, not pure gray.
          return [Math.max(0, val - 10), val + 12, Math.max(0, val - 15), 255];
        }
        return [138, 138, 128, 255];
      });
    },
    // Rocky: a barren, cracked rock face — jagged angular facets at varying
    // lightness plus a few sharper impact-style dark/light pairs, closer to
    // the moon's cratered look than continents' soft terrain but denser and
    // more fractured, since this is a whole planet's worth of exposed stone.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // High-frequency, low-octave noise for jagged facet coverage — the
      // discrete crater stamps below are genuinely better represented as
      // shapes than noise, so they stay as-is.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 3.5);
        const val = Math.round(125 + n * 65);
        // Warm reddish-brown stone, not pure gray.
        return [Math.min(255, val + 15), Math.max(0, val - 10), Math.max(0, val - 25), 255];
      });
      const craters = 4 + Math.floor(rand() * 5);
      for (let i = 0; i < craters; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.05);
        ctx.beginPath();
        ctx.fillStyle = "rgba(30,22,18,0.7)";
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = "rgba(230,210,190,0.55)";
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    // Barren: flat and mostly featureless — deliberately the quietest
    // variant of the set, but still real enough to read as *something*
    // rather than vanishing entirely once real lighting gets hold of it.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A single low-amplitude, low-frequency octave only — deliberately
      // the quietest variant, matching its "nothing much going on"
      // character; noise here should barely read, not disappear.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 1, 0.5, 1.2);
        const val = Math.round(135 + n * 18);
        // Dusty tan, not pure gray — kept subtler than the busier variants.
        return [Math.min(255, val + 10), val, Math.max(0, val - 14), 255];
      });
    },
    // Jungle: dense, heavily overlapping blotches at high count — reads as
    // near-total canopy cover, the busiest and most textured of the
    // vegetated variants next to continents' sparser landmasses.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // High-frequency, high-octave-count fbm thresholded broadly — canopy
      // covers most of the surface, the busiest variant of the set.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 3, 0.6, 2.4);
        const t = Math.max(0, Math.min(1, (n + 0.6) / 1.2));
        const val = Math.round(80 + t * 130);
        // Real canopy green, not pure gray.
        return [Math.max(0, val - 35), Math.min(255, val + 10), Math.max(0, val - 35), 255];
      });
    },
    // Ocean: mostly a flat, smooth base (open water) with just a few small,
    // crisp light patches (islands/reefs) — the inverse of continents'
    // land-dominant look, land is the exception here instead of the rule.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // The inverse of continents: a high threshold so only small isolated
      // bright regions surface as islands against an otherwise flat field.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.55, 2.2);
        if (n > 0.55) {
          const val = Math.round(160 + (n - 0.55) * 180);
          // Sandy tan islands against blue water, not pure gray.
          return [Math.min(255, val + 15), val, Math.max(0, val - 35), 255];
        }
        const val = Math.round(150 + n * 20);
        return [val, val, val, 255];
      });
      // A few broad, very soft current/depth bands so it doesn't read as
      // perfectly flat.
      for (let i = 0; i < 3; i++) {
        const y = rand() * size;
        const h = size * (0.08 + rand() * 0.1);
        const v = Math.round(60 + rand() * 30);
        ctx.fillStyle = `rgba(${Math.max(0, v - 20)},${Math.max(0, v - 10)},${Math.min(255, v + 25)},0.4)`;
        ctx.fillRect(0, y, size, h);
      }
    },
    // Radioactive: a scarred, speckled base with scattered small glowing
    // hot-spots — similar idea to volcanic's accent glow but colder, finer,
    // and much more numerous, reading as widespread contamination rather
    // than a few active vents.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // The scattered-hotspot glow loop below already works and isn't a
      // "background pattern" problem — untouched. Only the base speckle
      // fill swaps from per-pixel random dots to very-high-frequency,
      // low-octave noise.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 1, 0.5, 6);
        // Sickly green-yellow glow specks and dark scarring, not pure gray.
        if (n > 0.6) return [20, 24, 16, 255];
        if (n < -0.6) {
          const val = Math.round(200 + (-n - 0.6) * 130);
          return [Math.max(0, val - 40), val, Math.max(0, val - 130), 255];
        }
        return [122, 122, 120, 255];
      });
      for (let i = 0; i < 8; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.05);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(210,255,90,0.9)");
        g.addColorStop(1, "rgba(210,255,90,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
  ],
  GAS_GIANT: [
    // Storm bands: horizontal bands of varying lightness plus a couple of
    // wavy streaks breaking up the hard edges — the classic look.
    (ctx, size, rand) => {
      const bands = 6 + Math.floor(rand() * 5);
      for (let i = 0; i < bands; i++) {
        const v = Math.round(150 + rand() * 105);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, (i / bands) * size, size, size / bands + 1);
      }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "#fff";
      for (let i = 0; i < 3; i++) {
        const yBase = rand() * size;
        const phase = rand() * 10;
        ctx.lineWidth = 2 + rand() * 4;
        ctx.beginPath();
        ctx.moveTo(0, yBase);
        for (let x = 0; x <= size; x += 8) ctx.lineTo(x, yBase + Math.sin(x * 0.05 + phase) * 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
    // Great storm: fewer, wider bands plus one big swirling oval accent —
    // reads as a single dominant storm system rather than uniform stripes.
    (ctx, size, rand) => {
      const bands = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < bands; i++) {
        const v = Math.round(150 + rand() * 105);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, (i / bands) * size, size, size / bands + 1);
      }
      const sx = size * (0.3 + rand() * 0.4), sy = size * (0.3 + rand() * 0.4);
      const sr = size * (0.12 + rand() * 0.08);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      g.addColorStop(0, "rgba(255,255,255,0.5)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1.6, 1);
      ctx.translate(-sx, -sy);
      ctx.fillRect(0, 0, size, size);
      ctx.restore();
    },
  ],
  MOON: [
    // Cratered: dark base with light/dark crater pairs (rim + highlight)
    // scattered across the surface.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // Discrete crater stamps stay as-is; only the flat base fill swaps
      // for a low-octave noise background.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 2.5);
        const val = Math.round(100 + n * 35);
        return [val, val, val, 255];
      });
      const count = 10 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.02 + rand() * 0.07);
        ctx.beginPath();
        ctx.fillStyle = "rgba(25,22,20,0.8)";
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        // Warm rim highlight, not pure gray — see the comment above
        // BODY_TEXTURE_DRAWERS for why hue (not just alpha) is what
        // actually survives this map's real lighting.
        ctx.fillStyle = "rgba(225,205,180,0.6)";
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    // Smooth/mottled: fewer, larger soft patches and no crisp craters — a
    // moon that reads as geologically quieter than its cratered sibling.
    (ctx, size, rand) => {
      const noise = makeSimplex3(rand);
      // A single low-octave fbm blotch field, replacing the radial-gradient
      // patches — a geologically quiet moon.
      paintNoiseCanvas(ctx, size, (u, v) => {
        const n = sphereNoise(noise, u, v, 2, 0.5, 2);
        const val = Math.round(105 + n * 45);
        return [Math.min(255, val + 15), val, Math.max(0, val - 18), 255];
      });
    },
  ],
  ASTEROID: [
    // Coarse blocky noise — a rough, jagged rock face rather than a
    // smooth gradient, matching how small/near these bodies read.
    (ctx, size, rand) => {
      const cell = 8;
      for (let y = 0; y < size; y += cell) {
        for (let x = 0; x < size; x += cell) {
          const v = Math.round(120 + rand() * 130);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    },
    // Streaked: elongated jagged facets instead of a uniform grid — reads
    // as a more angular, fractured chunk of rock.
    (ctx, size, rand) => {
      ctx.fillStyle = "#8a8a8a";
      ctx.fillRect(0, 0, size, size);
      const facets = 14 + Math.floor(rand() * 10);
      for (let i = 0; i < facets; i++) {
        const x = rand() * size, y = rand() * size;
        const w = size * (0.05 + rand() * 0.2), h = size * (0.03 + rand() * 0.08);
        const v = Math.round(100 + rand() * 140);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rand() * Math.PI);
        ctx.fillStyle = `rgba(${v},${v},${v},0.6)`;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
      }
    },
  ],
  // Soft, large, overlapping wisps — a gas cloud rather than a solid
  // surface, so blobs are bigger and softer than a planet's continents.
  // Left as a single variant: a nebula is diffuse by nature, so the same
  // technique already varies plenty from its own random blob placement.
  NEBULA: [
    (ctx, size, rand) => {
      ctx.fillStyle = "#999";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 6; i++) {
        const x = rand() * size, y = rand() * size;
        const r = size * (0.2 + rand() * 0.35);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,255,255,0.35)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    },
  ],
};
BODY_TEXTURE_DRAWERS.ASTEROID_FIELD = BODY_TEXTURE_DRAWERS.ASTEROID;
BODY_TEXTURE_DRAWERS.ENGINEERED_ASTEROID = BODY_TEXTURE_DRAWERS.ASTEROID;
BODY_TEXTURE_DRAWERS.DEBRIS_FIELD = BODY_TEXTURE_DRAWERS.ASTEROID;

// Real waypoint traits (WaypointTraitSymbol from the SpaceTraders schema)
// that point at a specific BODY_TEXTURE_DRAWERS variant index for that type.
// Index in this array === index into that type's drawer array above.
// A waypoint with none of a type's listed traits falls back to the hash in
// makeBodyTexture() — most waypoints only carry economy/settlement traits
// (MARKETPLACE, HIGH_TECH, ...) with nothing environmental to key off.
const BODY_TEXTURE_TRAITS = {
  // Every real SpaceTraders planet-biome trait (ROCKY, VOLCANIC, FROZEN,
  // SWAMP, BARREN, TEMPERATE, JUNGLE, OCEAN, RADIOACTIVE) gets its own
  // explicit entry here — a planet with none of these (rare; most carry
  // exactly one) is the only case that reaches the symbol-hash fallback in
  // makeBodyTexture(). Leaving a trait unmapped is what let a JUNGLE planet
  // draw as volcanic purely by hash luck; every biome trait needs a home.
  PLANET: [
    ["TEMPERATE"], // continents — also the fallback default
    ["FROZEN", "ICE_CRYSTALS"], // ice
    ["VOLCANIC", "MAGMA_SEAS", "SUPERVOLCANOES", "ASH_CLOUDS"], // volcanic
    ["SWAMP"], // swamp
    ["ROCKY"], // rocky
    ["BARREN"], // barren
    ["JUNGLE"], // jungle
    ["OCEAN"], // ocean
    ["RADIOACTIVE"], // radioactive
  ],
  MOON: [
    ["DEEP_CRATERS", "SHALLOW_CRATERS", "ROCKY"], // cratered
    ["TERRAFORMED", "TEMPERATE"], // smooth/mottled
  ],
};

/**
 * Atmospheric fresnel rim: a slightly larger, additive-blended shell around
 * a body that's nearly invisible face-on and brightens toward the visible
 * silhouette edge — the standard cheap "planet glow" trick (no post-
 * processing pipeline needed, unlike real bloom). Real atmospheres scatter
 * light most at a grazing angle, which is exactly what `1 - dot(normal,
 * viewDir)` measures, so this doubles as the fix for airless-looking
 * terminators: the edge now reads as lit air, not a hard cutoff into black.
 */
const ATMOSPHERE_RIM_VERTEX = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const ATMOSPHERE_RIM_FRAGMENT = `
  uniform vec3 rimColor;
  uniform float rimPower;
  uniform float rimIntensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
    gl_FragColor = vec4(rimColor, pow(rim, rimPower) * rimIntensity);
  }
`;
function makeAtmosphereRim(size, colorHex, power, intensity) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      rimColor: { value: new THREE.Color(colorHex) },
      rimPower: { value: power },
      rimIntensity: { value: intensity },
    },
    vertexShader: ATMOSPHERE_RIM_VERTEX,
    fragmentShader: ATMOSPHERE_RIM_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(size * 1.16, 24, 18), mat);
}
// Per-type atmosphere tint/power/intensity — planets and gas giants get a
// confident glow; moons (mostly airless) get a much fainter one, just
// enough to soften the terminator without implying a real atmosphere.
const ATMOSPHERE_RIM = {
  PLANET: { color: 0x9fd0ff, power: 2.4, intensity: 0.8 },
  GAS_GIANT: { color: 0xffcf8a, power: 1.9, intensity: 0.9 },
  MOON: { color: 0xcdd8e8, power: 3.0, intensity: 0.35 },
};

/** Shared hollow-ring gradient for jump-gate pulses — transparent center
 *  and outside, bright only in a band partway out, so scaling the whole
 *  sprite up over time reads as a ring expanding outward from the gate
 *  rather than a glow blob growing in place. */
let gatePulseTexture = null;
function getGatePulseTexture() {
  if (gatePulseTexture) return gatePulseTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#fff0");
  g.addColorStop(0.62, "#fff0");
  g.addColorStop(0.78, "#fffc");
  g.addColorStop(1, "#fff0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  gatePulseTexture = new THREE.CanvasTexture(c);
  return gatePulseTexture;
}

/** Shared soft-round point sprite for asteroid-field particles — generated
 *  once (not per field) since every field's particles use the same dot,
 *  just tinted by that field's own WP3D_COLOR at material level. */
let asteroidDotTexture = null;
function getAsteroidDotTexture() {
  if (asteroidDotTexture) return asteroidDotTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "#fffa");
  g.addColorStop(1, "#fff0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  asteroidDotTexture = new THREE.CanvasTexture(c);
  // Shared across every field/every rebuild — see clearGroup()'s comment.
  asteroidDotTexture.__persistent = true;
  return asteroidDotTexture;
}

/**
 * A real asteroid field is *many* small rocks, not one dot — rendering it
 * as a single sphere (same as every other waypoint type) was the one
 * place the map's "one body, one dot" convention actively undersold what
 * the type means. This scatters a small cloud of point sprites in a
 * flattened spherical shell around the field's own position, seeded from
 * its symbol so the scatter is stable across re-renders. Decorative only —
 * the actual pickable/selectable body underneath (added by the caller,
 * same as every other type) is untouched, so click-to-select behavior
 * doesn't change.
 */
function makeAsteroidCluster(symbol, size, color) {
  const rand = seededRandom(symbol + ":cluster");
  const count = 26;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = size * (1.1 + rand() * 2.0);
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.35; // flattened, not a true sphere
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: getAsteroidDotTexture(), color, size: Math.max(0.18, size * 0.4),
    sizeAttenuation: true, transparent: true, depthWrite: false, alphaTest: 0.05,
  });
  return new THREE.Points(geo, mat);
}

// Orbital stations and asteroid bases used to render as a plain sphere,
// same as everything else, differentiated only by size/color/height — a
// station looked identical in silhouette to a moon. Both now build a real
// multi-part THREE.Group instead of a single sphere Mesh: the waypoint-body
// loop below is responsible for positioning the returned group and pushing
// every sub-mesh (not just the group) into `pickables`, since pickAt()
// raycasts against individual meshes and looks them up by exact reference.
function makeStationBody(symbol, size, color) {
  const group = new THREE.Group();

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.4, 16, 12),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.08, roughness: 0.4, metalness: 0.6 }),
  );
  group.add(hub);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(size * 1.05, size * 0.13, 8, 28),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.05, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  const strutMat = new THREE.MeshStandardMaterial({ color: themedColor("--dim"), roughness: 0.6, metalness: 0.5 });
  const struts = [];
  const strutCount = 4;
  for (let i = 0; i < strutCount; i++) {
    const angle = (2 * Math.PI * i) / strutCount;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.045, size * 0.045, size * 0.75, 6), strutMat);
    strut.position.set(Math.cos(angle) * size * 0.72, 0, Math.sin(angle) * size * 0.72);
    strut.rotation.z = Math.PI / 2;
    strut.rotation.y = -angle;
    group.add(strut);
    struts.push(strut);
  }

  const rand = seededRandom(symbol + ":station-lights");
  const lights = [];
  for (let i = 0; i < 3; i++) {
    const angle = rand() * Math.PI * 2;
    const light = makeGlowSprite(themedColor("--buff"), size * 0.45);
    light.position.set(Math.cos(angle) * size * 1.05, 0, Math.sin(angle) * size * 1.05);
    group.add(light);
    lights.push(light);
  }

  return { group, meshes: [hub, ring, ...struts] };
}

// A single irregular displaced icosahedron (no shared cache the way
// makeBodyGeometry() has one for planets/moons — cheap enough, and unique
// per waypoint, to just rebuild each renderMap() pass like the rings/stalks
// already do) plus one small attached structure standing in for the actual
// base, oriented outward from a random point on the rock's own surface.
function makeAsteroidBaseBody(symbol, size, color) {
  const rand = seededRandom(symbol + ":asteroidbase");
  const group = new THREE.Group();

  const geo = new THREE.IcosahedronGeometry(size, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const bump = 1 + (rand() - 0.5) * 0.45;
    pos.setXYZ(i, (x / len) * len * bump, (y / len) * len * bump, (z / len) * len * bump);
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: themedColor("--dim"), roughness: 0.9, metalness: 0.05, flatShading: true,
  }));
  group.add(rock);

  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  const bx = Math.sin(phi) * Math.cos(theta);
  const by = Math.sin(phi) * Math.sin(theta);
  const bz = Math.cos(phi);
  const structure = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.5, size * 0.35, size * 0.5),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, roughness: 0.5, metalness: 0.5 }),
  );
  structure.position.set(bx * size * 0.9, by * size * 0.9, bz * size * 0.9);
  structure.lookAt(bx * size * 2, by * size * 2, bz * size * 2);
  group.add(structure);

  const light = makeGlowSprite(themedColor("--buff"), size * 0.6);
  light.position.set(bx * size * 1.15, by * size * 1.15, bz * size * 1.15);
  group.add(light);

  return { group, meshes: [rock, structure] };
}

function makeGlowSprite(color, size) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  const hex = "#" + color.getHexString();
  g.addColorStop(0, hex + "aa");
  g.addColorStop(1, hex + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(size, size, 1);
  return sp;
}

function shouldLabelWaypoint(wp) {
  const traits = wp.traits ?? [];
  const hasMarket = traits.some((t) => (t.symbol ?? t) === "MARKETPLACE");
  const hasShipyard = traits.some((t) => (t.symbol ?? t) === "SHIPYARD");
  const isParent = wp.type === "PLANET" || wp.type === "GAS_GIANT";
  return isParent || wp.type === "JUMP_GATE" || hasMarket || hasShipyard;
}

function makeLabelSprite(text, color) {
  // The sprite maps its *whole* texture onto whatever quad sp.scale gives
  // it — sizing that quad from the measured text width while the canvas
  // stayed a fixed, mostly-blank 220x28 squished the entire texture (glyphs
  // included) down to a sliver. Sizing the canvas to the text itself keeps
  // canvas pixels and sprite-scale units in the same frame, so nothing gets
  // squeezed.
  const scale = 3;
  const font = "500 10px Rajdhani, sans-serif";
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 6;
  const h = 16;
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const ctx = c.getContext("2d");
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.fillText(text, 3, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(w * 0.08, h * 0.08, 1);
  sp.center.set(0, 0.5);
  return sp;
}

/**
 * Same shape as the flat map's own bounding-box fit (renderMap()'s
 * min/max/span/pad math) — the whole system framed by default rather than
 * cropped to whatever happens to be active — just producing a 3D scale
 * factor and centroid instead of an SVG viewBox.
 */
/**
 * A linear world->scene scale cannot show both ends of a real SpaceTraders
 * system at once: a home cluster's own members are often tens of units
 * apart while a genuine outlier sits hundreds of units out — two orders of
 * magnitude apart. Scaled to keep the outlier on screen, the home cluster's
 * real spacing collapses to sub-body-size and the anti-overlap pass alone
 * decides its layout; scaled to resolve the home cluster, outliers go off
 * the edge. Distance from the system's star (its natural center, (0,0) in
 * SpaceTraders' own coordinates) is compressed through sqrt() instead — the
 * same trick subway maps and fisheye views use for data with a huge dynamic
 * range: nearby differences get outsized visual room, a distant point still
 * reads as clearly farther, without either end swallowing the other's
 * resolution.
 */
function fitSystemScale(pool) {
  let maxR = 20;
  for (const p of pool) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
  // A slightly gentler compression than sqrt() so nearby planets keep more
  // of their real separation while distant outliers still fit. Tuned for the
  // new "readable" body sizes (planets ~3-4, orbiters ~0.5-1). The larger
  // target pushes the home cluster farther from the central star so the map
  // reads as a real solar system rather than a tight knot.
  const pow = 0.55;
  const scale = 140 / Math.pow(maxR, pow); // world units -> scene units
  return { scale, pow };
}

function worldToScene(x, y, s) {
  const r = Math.hypot(x, y);
  if (r < 1e-6) return { x: 0, z: 0 };
  const rPrime = Math.pow(r, s.pow) * s.scale;
  return { x: (x / r) * rPrime, z: (y / r) * rPrime };
}

/**
 * Confirmed live: every biome texture (bodyTextureCache) and the shared
 * asteroid-dot sprite (asteroidDotTexture) were rendering as a flat,
 * patternless gradient — never the jungle/rocky/ice/etc. surface pattern,
 * even fully unlit with the atmosphere rim hidden. Root cause: this ran on
 * every ~1s renderMap() poll, disposing `material.map` for every mesh being
 * torn down. That's correct for a label sprite's one-off canvas-text
 * texture (freshly redrawn each render, genuinely needs freeing), but wrong
 * for a *cached* texture that's deliberately reused across rebuilds — the
 * first poll disposed the GPU resource bodyTextureCache/asteroidDotTexture
 * still held a JS reference to, so the very next rebuild rebound an already-
 * disposed texture. The first frame after a fresh page load looked fine
 * (nothing had been disposed yet); every frame after the first poll didn't.
 * Persistent textures are tagged `.__persistent` where created
 * (makeBodyTexture(), getAsteroidDotTexture()) and skipped here. The same
 * applies to makeBodyGeometry()'s displaced planet/moon geometry — freeing
 * that every poll would be the exact same bug, just for the mesh shape
 * instead of its texture, so geometry checks the same flag before disposal.
 */
function disposeObject3D(c) {
  if (c.geometry && !c.geometry.__persistent) c.geometry.dispose();
  if (c.material?.map && !c.material.map.__persistent) c.material.map.dispose();
  c.material?.dispose?.();
}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    // Station/asteroid-base bodies and ship hulls are THREE.Group instances
    // holding several meshes each (hub+ring+struts, rock+structure,
    // fuselage+wings...) — a bare pop()+dispose() here only ever touched the
    // group itself (no geometry/material of its own), silently leaking every
    // mesh nested inside it on each rebuild. traverse() reaches all of them.
    c.traverse(disposeObject3D);
  }
}

function scheduleRebuild() {
  if (pendingRebuild) return;
  pendingRebuild = requestAnimationFrame(() => { pendingRebuild = null; renderMap(state?.ships ?? []); });
}

function renderMap(ships, trails = new Map()) {
  if (galaxyMode) { renderGalaxy3D(); return; }
  if (!sceneReady && !mapUnavailable) initMap3D();
  if (mapUnavailable) return;
  const sys = currentSystem || state.agent.headquarters.slice(0, state.agent.headquarters.lastIndexOf("-"));
  $("map-hud").innerHTML = `Sector <b>${sys}</b>`;

  // Same cross-system leak guard the flat map had: an in-transit ship's
  // route carries raw world coordinates with no system tag of its own, so
  // filtering the whole list up front (before shipTransitLerp() runs on any
  // of it) is the one fix that covers every case.
  ships = ships.filter((s) => s.nav.systemSymbol === sys);
  lastRenderedShips = ships;

  const system = systems.find((s) => s.symbol === sys);
  waypoints = system?.waypoints ?? state.waypoints ?? [];
  if (!waypoints.length) {
    const seen = new Map();
    for (const s of ships) {
      const wp = s.nav.waypointSymbol;
      if (!seen.has(wp)) seen.set(wp, { x: Math.random() * 100, y: Math.random() * 100 });
    }
    waypoints = [...seen.entries()].map(([symbol, p]) => ({ symbol, x: p.x, y: p.y, type: "PLANET", traits: [] }));
  }

  // A real home system commonly runs 50-90 waypoints, most of them bare
  // asteroids/debris with no market, shipyard, or fleet reason to ever be
  // shown — plotting all of them turned the map into unreadable noise for
  // no operational payoff. Keep only what an operator would ever act on: a
  // market or shipyard, a jump gate, or wherever a ship actually is. This
  // is a rendering-only subset — the shared `waypoints` stays the full
  // list, since other panels (the miner field picker, ship-details lookup)
  // need waypoints this map no longer draws.
  // Previously filtered down to markets/shipyards/gates/occupied waypoints
  // only, as noise-reduction for dense 50-90-waypoint systems -- reverted
  // per user request: bare asteroids and other unremarkable waypoints are
  // expected to render (this is what the old flat map's "little circles"
  // scattered around a system were), not be hidden entirely.
  const sceneWaypoints = waypoints;

  const s = fitSystemScale(sceneWaypoints);
  mapScale = s;
  systemSpan = 80;

  // Leaving galaxy mode is a scene-content mode switch too — see
  // renderGalaxy3D()'s own comment on why this is a hard cut rather than a
  // held-content transition.
  if (mapMode !== "system") {
    mapMode = "system";
    starGroup.visible = true;
  }
  clearGroup(bodiesGroup);
  clearGroup(ringsGroup);
  clearGroup(glowGroup);
  clearGroup(linesGroup);
  pickables.length = 0;

  const seenRadii = new Set();

  // SpaceTraders routinely puts several waypoints at the exact same x/y — a
  // gas giant and the stations orbiting it share one coordinate. Ported from
  // the flat map's byCoord/relaxation pass (same algorithm, scene-space x/z
  // in place of screen-space sx/sy): a coincident group first fans out on a
  // ring sized to its members, then a few relaxation passes nudge any two
  // waypoints — clustered or not — that still overlap apart. Left as raw
  // worldToScene() output, every member of such a group rendered as one
  // stacked sphere with the rest hidden behind it.
  const effR = (wp) => WP3D_SIZE[wp.type] ?? 1.8;
  const byCoord = new Map();
  for (const wp of sceneWaypoints) {
    const key = `${wp.x},${wp.y}`;
    if (!byCoord.has(key)) byCoord.set(key, []);
    byCoord.get(key).push(wp);
  }
  const posBySymbol = new Map();
  for (const group of byCoord.values()) {
    const { x: baseX, z: baseZ } = worldToScene(group[0].x, group[0].y, s);
    if (group.length === 1) {
      posBySymbol.set(group[0].symbol, { x: baseX, z: baseZ });
      continue;
    }
    const maxEffR = Math.max(...group.map(effR));
    const ringR = maxEffR * 1.15 + Math.min(group.length, 6) * 0.35;
    group.forEach((wp, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      posBySymbol.set(wp.symbol, { x: baseX + ringR * Math.cos(angle), z: baseZ + ringR * Math.sin(angle) });
    });
  }
  const relaxEntries = sceneWaypoints.map((wp) => ({ symbol: wp.symbol, r: effR(wp), ...posBySymbol.get(wp.symbol) }));
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < relaxEntries.length; i++) {
      for (let j = i + 1; j < relaxEntries.length; j++) {
        const a = relaxEntries[i], b = relaxEntries[j];
        let dx = b.x - a.x, dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        const minDist = a.r + b.r + 0.6;
        if (dist >= minDist) continue;
        if (dist < 0.01) { dx = 1; dz = 0; dist = 1; }
        const push = ((minDist - dist) / dist) * 0.5;
        const ox = dx * push, oz = dz * push;
        a.x -= ox; a.z -= oz;
        b.x += ox; b.z += oz;
      }
    }
  }
  for (const e of relaxEntries) posBySymbol.set(e.symbol, { x: e.x, z: e.z });

  const activeGateSymbols = new Set();
  for (const wp of sceneWaypoints) {
    const { x, z } = posBySymbol.get(wp.symbol);
    const color = themedColor(WP3D_COLOR[wp.type] ?? "--ice");
    const size = WP3D_SIZE[wp.type] ?? 1.8;
    const y = computeElevation(wp.symbol, wp.type, wp.x, wp.y);

    let body;
    if (wp.type === "ORBITAL_STATION" || wp.type === "ASTEROID_BASE") {
      const built = wp.type === "ORBITAL_STATION"
        ? makeStationBody(wp.symbol, size, color)
        : makeAsteroidBaseBody(wp.symbol, size, color);
      body = built.group;
      body.position.set(x, y, z);
      bodiesGroup.add(body);
      // pickAt() raycasts against individual meshes, not groups, and looks
      // the hit up by exact reference — every visible sub-mesh needs its
      // own pickables entry (all resolving to the same waypoint symbol) or
      // clicking most of the shape would silently miss.
      for (const mesh of built.meshes) {
        pickables.push({ mesh, kind: "waypoint", symbol: wp.symbol });
      }
    } else {
      body = new THREE.Mesh(
        IRREGULAR_ROCK_TYPES.has(wp.type)
          ? makeRockGeometry(wp.symbol, size)
          : makeBodyGeometry(wp.symbol, wp.type, wp.traits, size),
        // A small emissive floor in the body's own color, independent of any
        // light reaching it — the HemisphereLight above already keeps the
        // shadow side well off pure black at normal distances, but this is
        // the actual floor for a body far enough out that even that fill
        // reads as dim: a hint of the body's own hue rather than a void.
        // `map` (when this type has a texture drawer) rides alongside color:
        // Three multiplies the two, so the surface detail below tints to
        // this system's own palette rather than replacing it.
        new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: 0.05, roughness: 0.55, metalness: 0.15,
          map: makeBodyTexture(wp.symbol, wp.type, wp.traits),
        }),
      );
      body.position.set(x, y, z);
      bodiesGroup.add(body);
      pickables.push({ mesh: body, kind: "waypoint", symbol: wp.symbol });
    }

    const rim = ATMOSPHERE_RIM[wp.type];
    if (rim) {
      const rimMesh = makeAtmosphereRim(size, rim.color, rim.power, rim.intensity);
      rimMesh.position.copy(body.position);
      bodiesGroup.add(rimMesh);
    }

    // A faint vertical stalk connects elevated orbiters back to the
    // ecliptic plane, so the operator can see which planet/region they
    // belong to even when the camera is looking edge-on.
    if (Math.abs(y) > 0.3) {
      const stalkLen = Math.max(0.2, Math.abs(y) - size * 0.4);
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, stalkLen, 8),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.22 }),
      );
      stalk.position.set(x, Math.sign(y) * (stalkLen / 2 + size * 0.35), z);
      ringsGroup.add(stalk);
    }

    if (wp.type === "GAS_GIANT") {
      const belt = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.5, size * 1.9, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      belt.position.copy(body.position);
      belt.rotation.x = -Math.PI / 2 + 0.35;
      bodiesGroup.add(belt);
    }
    if (wp.type === "ASTEROID_FIELD") {
      const cluster = makeAsteroidCluster(wp.symbol, size, color);
      cluster.position.copy(body.position);
      bodiesGroup.add(cluster);
    }
    if (wp.type === "JUMP_GATE" || wp.type === "FUEL_STATION") {
      const glow = makeGlowSprite(color, size * 3.5);
      glow.position.copy(body.position);
      glowGroup.add(glow);
    }
    if (wp.type === "JUMP_GATE") {
      activeGateSymbols.add(wp.symbol);
      let pulse = gatePulses.get(wp.symbol);
      if (!pulse) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: getGatePulseTexture(), color, transparent: true, depthWrite: false,
        }));
        gatePulseGroup.add(sprite);
        // Own phase per gate (from its symbol) so multiple gates in one
        // system don't pulse in lockstep — reads as more alive than a
        // single synchronized heartbeat would.
        pulse = { sprite, phase: Math.abs(hashString(wp.symbol)) * Math.PI * 2, baseSize: size * 2.2 };
        gatePulses.set(wp.symbol, pulse);
      }
      pulse.sprite.position.copy(body.position);
    }
    const isMarket = (wp.traits ?? []).some((t) => (t.symbol ?? t) === "MARKETPLACE");
    if (isMarket) {
      const marketGlow = makeGlowSprite(themedColor("--buff"), size * 2.5);
      marketGlow.position.copy(body.position);
      glowGroup.add(marketGlow);
    }

    if (shouldLabelWaypoint(wp)) {
      const label = makeLabelSprite(shortWp(wp.symbol), "#" + themedColor("--dim").getHexString());
      label.position.set(x, y + size + 1.3, z);
      bodiesGroup.add(label);
    }

    // A real orbit path — the waypoint's actual distance from the system's
    // origin, not a fabricated one. Deduped by radius so a station sharing
    // its planet's exact x/y doesn't draw the same ring twice. Kept on the
    // ecliptic plane (y=0); the body itself floats at its computed elevation.
    const radius = Math.pow(Math.hypot(wp.x, wp.y), s.pow) * s.scale;
    const key = Math.round(radius * 4);
    if (radius > 0.5 && !seenRadii.has(key)) {
      seenRadii.add(key);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.05, radius + 0.05, 96),
        new THREE.MeshBasicMaterial({ color: themedColor("--dim"), transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ringsGroup.add(ring);
    }
  }

  // A gate that's left this render (system switch, or no longer counted
  // "purposeful") gets its pulse sprite disposed rather than left running
  // forever in a group renderMap() never otherwise touches.
  for (const [symbol, pulse] of gatePulses) {
    if (activeGateSymbols.has(symbol)) continue;
    gatePulseGroup.remove(pulse.sprite);
    pulse.sprite.material.dispose();
    gatePulses.delete(symbol);
  }

  // Trade lanes: removed for now — two rounds of tuning (occlusion, then
  // arc height) still didn't read well in the real, dense-cluster case.
  // Revisit with a different approach rather than a third parameter tweak.

  // Ship trails — real recent movement history during scrub playback (see
  // renderScrubFrame()), not the static trade lanes above. Segments nearer
  // the ship's current position are more opaque than older ones, matching
  // the flat map's own fading-trail treatment. Same depthTest reasoning as
  // the trade lanes above. Elevation is included so trails follow the same
  // 3D layout as live ship movement.
  const trailColor = themedColor("--dim");
  for (const [, trail] of trails) {
    for (let i = 1; i < trail.length; i++) {
      const a = scenePosForWaypoint(trail[i - 1], s);
      const b = scenePosForWaypoint(trail[i], s);
      if (!a || !b) continue;
      const frac = i / (trail.length - 1);
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y + 0.08, a.z),
        new THREE.Vector3(b.x, b.y + 0.08, b.z),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity: 0.1 + frac * 0.4, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 9;
      linesGroup.add(line);
    }
  }

  // Frame the whole system, same intent as the flat map's default fit —
  // but only on first arriving here or switching systems. renderMap() runs
  // on every periodic state refresh, not just navigation; resetting the
  // camera every time was undoing any zoom or pan the operator had just
  // made mid-session.
  if (framedSystem !== sys || mapMode !== "system") {
    // Only a mode switch (leaving galaxy view) gets its camera snapped
    // instantly, alongside the content swap — a plain system-to-system
    // switch while already in system mode keeps the normal eased pan.
    // See renderGalaxy3D()'s own comment on why an eased camera here reads
    // worse, not better, once the target it's easing toward already exists.
    const leavingGalaxy = mapMode !== "system";
    framedSystem = sys;
    mapMode = "system";
    orbitGoal.target.set(0, 0, 0);
    orbitGoal.radius = 160;
    orbitGoal.phi = 1.0;
    if (leavingGalaxy) {
      orbitCam.target.copy(orbitGoal.target);
      orbitCam.radius = orbitGoal.radius;
      orbitCam.phi = orbitGoal.phi;
    }
    // A live trail's points are in the old system's scene coordinates —
    // meaningless (and, worse, plottable-looking garbage) once worldToScene
    // is scaled for a different system.
    liveTrails.clear();
    lastTrailSamplePos.clear();
    for (const obj of liveTrailObjects.values()) disposeTrailGroup(obj);
    liveTrailGroup?.clear();
    liveTrailObjects.clear();
  }

  renderShipsInto(ships, s);
  if (shipAnimHandle) cancelAnimationFrame(shipAnimHandle);
  if (scrubLive) shipAnimHandle = requestAnimationFrame(repositionShips);
}

/**
 * Procedural hull-plating texture — same idea as the planet/moon biome
 * canvases (a drawn pattern applied as `material.map` so it multiplies
 * with the ship's own role color instead of replacing it), but for ships:
 * an irregular grid of panel seams, per-panel brightness variation like
 * brushed/weathered plate, and rivets at the panel corners. One shared
 * canvas for every ship's every hull part (not per-symbol like a body's
 * texture — plating doesn't need to be unique per ship, just present) so
 * this only ever draws once per page load, then rides `tex.repeat` to
 * tile across whatever size box/cylinder/cone face it lands on.
 */
let hullPanelTexture = null;
function makeHullPanelTexture() {
  if (hullPanelTexture) return hullPanelTexture;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(150,150,150)";
  ctx.fillRect(0, 0, size, size);

  // An irregular grid, not an even tile — real plating doesn't repeat on a
  // neat interval, and an even grid would read as a texture bug (moire)
  // once it's tiled small over a tiny hull part. Contrast pushed hard
  // (a 100-value swing per panel, near-black seams/rivets) because a
  // subtler first pass (30-value swing, mid-gray seams) washed out to
  // looking flat on an actual small on-screen hull — confirmed live.
  const vLines = [0, 21, 37, 70, 91, size];
  const hLines = [0, 17, 45, 76, 101, size];
  for (let i = 0; i < vLines.length - 1; i++) {
    for (let j = 0; j < hLines.length - 1; j++) {
      const v = 90 + Math.floor(Math.random() * 100);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(vLines[i], hLines[j], vLines[i + 1] - vLines[i], hLines[j + 1] - hLines[j]);
    }
  }
  ctx.strokeStyle = "rgb(25,25,25)";
  ctx.lineWidth = 3.5;
  for (const x of vLines) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke(); }
  for (const y of hLines) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  ctx.fillStyle = "rgb(15,15,15)";
  for (const x of vLines.slice(1, -1)) {
    for (const y of hLines.slice(1, -1)) {
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // A small hull part (a fin, a pod) would otherwise show only a sliver of
  // one panel — repeating the pattern a few times over keeps plating
  // visible at every part's own scale. Bumped from 2x2: even with the
  // contrast fix above, 2x2 still tiled too coarsely to put a visible seam
  // on the smallest parts (fins, pods) at normal zoom.
  tex.repeat.set(3, 3);
  tex.__persistent = true;
  hullPanelTexture = tex;
  return tex;
}

// Real SpaceTraders frame symbols (confirmed via grep across the codebase)
// bucketed into five silhouette families, plus a sixth "command" bucket that
// overrides all of them for the one flagship per fleet (SpaceTraders' own
// registration.role, not this app's dispatcher role used for SHIP3D_COLOR).
// A frame this app hasn't seen yet falls back to "explorer" rather than the
// single undifferentiated cone every ship used to render as.
const FRAME_HULL_BUCKET = {
  FRAME_PROBE: "probe", FRAME_DRONE: "probe",
  FRAME_FIGHTER: "fighter", FRAME_INTERCEPTOR: "fighter", FRAME_RACER: "fighter",
  FRAME_FRIGATE: "frigate", FRAME_CRUISER: "frigate", FRAME_DESTROYER: "frigate",
  FRAME_LIGHT_FREIGHTER: "hauler", FRAME_HEAVY_FREIGHTER: "hauler", FRAME_TRANSPORT: "hauler",
  FRAME_BULK_FREIGHTER: "hauler", FRAME_CARRIER: "hauler",
  FRAME_EXPLORER: "explorer", FRAME_SHUTTLE: "explorer", FRAME_MINER: "explorer",
};

function shipHullBucket(sh) {
  if (sh.registration?.role === "COMMAND") return "command";
  return FRAME_HULL_BUCKET[sh.frame?.symbol] ?? "explorer";
}

// Every hull below is built nose-first along +Z (the same convention the
// old single ConeGeometry ended up in after its own body.rotation.x =
// Math.PI/2 — see that rotation's comment history) so renderShipsInto()'s
// outer group.rotation.y (transit heading) and .x (transit pitch) apply
// unchanged. `mat` (the fuselage/primary parts) carries the real role/
// selection color; `trimMat` is that same color darkened (trimColor()) for
// secondary parts — wings, fins, pods, engines — so a hull reads as more
// than a flat single-hue silhouette without introducing any color that
// isn't derived from the ship's own.
function buildShipHull(bucket, mat, trimMat) {
  const group = new THREE.Group();
  const meshes = [];
  const add = (mesh) => { group.add(mesh); meshes.push(mesh); return mesh; };

  switch (bucket) {
    case "command": {
      const fuselage = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 0.6, 8), mat));
      fuselage.rotation.x = Math.PI / 2;
      const nose = add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 8), mat));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.41;
      const fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.3), trimMat));
      fin.position.set(0, 0.13, -0.05);
      fin.rotation.x = -0.5;
      const wingL = add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.16), trimMat));
      wingL.position.set(-0.18, -0.02, -0.18);
      wingL.rotation.z = 0.25;
      const wingR = add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.16), trimMat));
      wingR.position.set(0.18, -0.02, -0.18);
      wingR.rotation.z = -0.25;
      const engineL = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), trimMat));
      engineL.rotation.x = Math.PI / 2;
      engineL.position.set(-0.26, -0.03, -0.28);
      const engineR = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), trimMat));
      engineR.rotation.x = Math.PI / 2;
      engineR.position.set(0.26, -0.03, -0.28);
      break;
    }
    case "probe": {
      const body = add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 6), mat));
      body.rotation.x = Math.PI / 2;
      const dish = add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), trimMat));
      dish.position.z = -0.15;
      break;
    }
    case "fighter": {
      const body = add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), mat));
      body.rotation.x = Math.PI / 2;
      const wingL = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.18), trimMat));
      wingL.position.set(-0.24, 0, -0.05);
      wingL.rotation.z = 0.1;
      const wingR = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.18), trimMat));
      wingR.position.set(0.24, 0, -0.05);
      wingR.rotation.z = -0.1;
      break;
    }
    case "frigate": {
      const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.55, 8), mat));
      body.rotation.x = Math.PI / 2;
      const nose = add(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 8), mat));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.36;
      const finL = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.2), trimMat));
      finL.position.set(-0.13, 0.02, -0.2);
      const finR = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.2), trimMat));
      finR.position.set(0.13, 0.02, -0.2);
      break;
    }
    case "hauler": {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.55), mat));
      const podL = add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.4), trimMat));
      podL.position.set(-0.24, -0.02, -0.02);
      const podR = add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.4), trimMat));
      podR.position.set(0.24, -0.02, -0.02);
      break;
    }
    case "explorer":
    default: {
      const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.45, 8), mat));
      body.rotation.x = Math.PI / 2;
      const dish = add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), trimMat));
      dish.position.z = -0.2;
      break;
    }
  }
  return { group, meshes };
}

// Real cargo capacity varies enormously (a probe hauls 0, a carrier several
// hundred) and the old single cone was one fixed size regardless — a
// sqrt curve keeps small ships from vanishing to a pinprick and large ones
// from swallowing the map, clamped to a sane on-screen range.
function shipHullScale(sh) {
  const cap = sh.cargo?.capacity ?? 0;
  // Floor raised from 0.7 to 1.0: at 0.7 a 0-capacity probe rendered too
  // small to read clearly even though it was correctly proportioned
  // relative to everything else — the whole curve needed lifting, not the
  // ratio changed.
  return Math.min(1.9, Math.max(1.0, 1.0 + 0.04 * Math.sqrt(cap)));
}

function renderShipsInto(ships, s) {
  clearGroup(shipsGroup);

  // Ships docked/orbiting at the same waypoint would otherwise all sit at
  // that waypoint's own scene position — the exact center of its body's
  // sphere. On the flat map that's harmless (a ship glyph just paints on
  // top); in 3D it means the ship ends up inside that sphere's actual
  // geometry, hidden rather than merely overlapping. Every waypoint's
  // stationary ships (a group of one included, so a lone ship still clears
  // the body's surface) fan onto a ring sized to that body's own radius.
  // In-transit ships are left alone — they're moving through empty space
  // with no body to hide inside, and repositionShips() moves them every
  // frame without recomputing this grouping.
  const dockedByWaypoint = new Map();
  for (const sh of ships) {
    if (sh.nav.status === "IN_TRANSIT") continue;
    const wp = sh.nav.waypointSymbol;
    if (!dockedByWaypoint.has(wp)) dockedByWaypoint.set(wp, []);
    dockedByWaypoint.get(wp).push(sh.symbol);
  }
  const dockedOffset = new Map();
  for (const [wpSymbol, symbols] of dockedByWaypoint) {
    const bodyR = WP3D_SIZE[waypoints.find((w) => w.symbol === wpSymbol)?.type] ?? 1.8;
    // Tight orbit for small bodies (moons/stations) so ships stay visually
    // attached to their waypoint inside a planet cluster, not floating in
    // the parent planet's space. Lifted slightly in y so they read as
    // orbiting rather than embedded in the surface.
    const ringR = bodyR * 1.0 + 0.7 + Math.min(symbols.length, 6) * 0.35;
    symbols.forEach((sym, i) => {
      const angle = (2 * Math.PI * i) / symbols.length;
      dockedOffset.set(sym, { dx: ringR * Math.cos(angle), dy: bodyR * 0.35, dz: ringR * Math.sin(angle) });
    });
  }

  for (const sh of ships) {
    const role = (fleetStatus.ships ?? []).find((r) => r.symbol === sh.symbol)?.role;
    const docked = sh.nav.status === "DOCKED";
    const sel = sh.symbol === selectedShip;
    const color = sel ? themedColor("--accent") : themedColor(SHIP3D_COLOR[role] ?? "--star");

    const group = new THREE.Group();
    // Lit like the waypoint bodies now, but with a strong emissive glow in
    // the same color rather than plain unlit — a ship still has to read as
    // a bright, glanceable marker at a glance, not a shaded model with a
    // dark side that can wash out against space. One material shared by
    // every part of this ship's hull: role/selection owns the color, the
    // hull shape (see buildShipHull) owns which kind of ship it reads as.
    // map alone wasn't enough: a flat, UV-independent emissive glow this
    // strong (built for "read as a bright marker," not a shaded planet)
    // swamped the diffuse texture's contrast entirely -- confirmed live,
    // the hull looked completely flat even zoomed in close. Same texture
    // as emissiveMap makes the seams/rivets dim the glow too, so the
    // pattern survives being lit this bright.
    const hullTex = makeHullPanelTexture();
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2,
      map: hullTex, emissiveMap: hullTex,
    });
    const trim = trimColor(color);
    const trimMat = new THREE.MeshStandardMaterial({
      color: trim, emissive: trim, emissiveIntensity: 0.4, roughness: 0.45, metalness: 0.25,
      map: hullTex, emissiveMap: hullTex,
    });
    const hull = buildShipHull(shipHullBucket(sh), mat, trimMat);
    hull.group.scale.setScalar(shipHullScale(sh));
    group.add(hull.group);
    if (sel) {
      // A 3D torus ring that stays oriented with the ship instead of a flat
      // disk lying on the ecliptic plane. It scales with the tiny new ship
      // size so the selection read is tight, not a giant pancake.
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.06, 8, 32),
        new THREE.MeshBasicMaterial({ color: themedColor("--accent"), transparent: true, opacity: 0.75 }),
      );
      halo.rotation.x = Math.PI / 2;
      group.add(halo);
    }

    let scenePos;
    if (sh.nav.status === "IN_TRANSIT") {
      const r = sh.nav.route;
      const world = shipTransitLerp(sh) ?? { x: r?.origin?.x ?? 0, y: r?.origin?.y ?? 0 };
      const originWP = waypoints.find((w) => w.symbol === r?.origin?.symbol);
      const destWP = waypoints.find((w) => w.symbol === r?.destination?.symbol);
      const base = worldToScene(world.x, world.y, s);
      const arc = transitArcHeight(base, originWP, destWP, s);
      scenePos = { x: base.x, y: arc.y, z: base.z };
      if (r?.origin && r?.destination) {
        const o = scenePosForWaypoint(r.origin.symbol, s) ?? { ...worldToScene(r.origin.x, r.origin.y, s), y: 0 };
        const d = scenePosForWaypoint(r.destination.symbol, s) ?? { ...worldToScene(r.destination.x, r.destination.y, s), y: 0 };
        const dx = d.x - o.x, dy = d.y - o.y, dz = d.z - o.z;
        if (dx !== 0 || dz !== 0) {
          group.rotation.y = Math.atan2(dx, dz);
          // A small pitch so the hull tilts toward/away from the destination's elevation.
          const dist = Math.hypot(dx, dz) || 1;
          group.rotation.x = Math.PI / 2 + Math.atan2(dy, dist);
        }
      }
    } else {
      const wp = waypoints.find((w) => w.symbol === sh.nav.waypointSymbol);
      scenePos = wp ? waypointScenePos(wp, s) : { x: 0, y: 0, z: 0 };
    }
    const off = dockedOffset.get(sh.symbol);
    group.position.set(scenePos.x + (off?.dx ?? 0), scenePos.y + (off?.dy ?? 0), scenePos.z + (off?.dz ?? 0));

    shipsGroup.add(group);
    // pickAt() raycasts against individual meshes and looks the hit up by
    // exact reference — every part of the hull needs its own entry (all
    // resolving to this same ship) or clicking most of a multi-mesh hull
    // would silently miss.
    for (const mesh of hull.meshes) {
      pickables.push({ mesh, kind: "ship", symbol: sh.symbol, group });
    }
  }
}

function findWaypointPos(symbol, s) {
  const wp = waypoints.find((w) => w.symbol === symbol);
  return wp ? { x: wp.x, y: wp.y } : { x: 0, y: 0 };
}

/** Scene position of a waypoint by symbol, looked up against the full
 *  `waypoints` list rather than the map's own purposeful-only subset —
 *  trade-route markets and ship-trail history can name a waypoint that
 *  isn't itself drawn as a body (a plain rock a ship passed through). */
function scenePosForWaypoint(symbol, s) {
  const wp = waypoints.find((w) => w.symbol === symbol);
  return wp ? waypointScenePos(wp, s) : null;
}

function disposeTrailGroup(group) {
  for (const line of group.children) {
    line.geometry?.dispose?.();
    line.material?.dispose?.();
  }
}

function repositionShips() {
  shipAnimHandle = null;
  const mapVisible = (!isMobile() && currentView === "bridge") || (isMobile() && mobileView === "map");
  if (!mapVisible || !scrubLive || !mapScale || !lastRenderedShips.length) return;
  const inTransitSymbols = new Set(lastRenderedShips.filter((sh) => sh.nav.status === "IN_TRANSIT").map((sh) => sh.symbol));
  // Prune trail state for any ship not in transit *right now*, before the
  // early return below for "nothing to animate" — otherwise the pass where
  // the fleet's last in-transit ship arrives at its destination never
  // reaches this, leaving its sample buffer stale for whenever it next
  // departs (its new trail would jump from the previous leg's tail).
  for (const symbol of [...liveTrails.keys()]) {
    if (inTransitSymbols.has(symbol)) continue;
    liveTrails.delete(symbol);
    lastTrailSamplePos.delete(symbol);
    const obj = liveTrailObjects.get(symbol);
    if (obj) {
      liveTrailGroup.remove(obj);
      disposeTrailGroup(obj);
      liveTrailObjects.delete(symbol);
    }
  }
  if (inTransitSymbols.size === 0) return;
  const trailColor = themedColor("--accent");
  for (const p of pickables) {
    if (p.kind !== "ship") continue;
    const sh = lastRenderedShips.find((x) => x.symbol === p.symbol);
    if (!sh || sh.nav.status !== "IN_TRANSIT") continue;
    const world = shipTransitLerp(sh);
    if (!world) continue;
    const r = sh.nav.route;
    const base = worldToScene(world.x, world.y, mapScale);
    const originWP = waypoints.find((w) => w.symbol === r?.origin?.symbol);
    const destWP = waypoints.find((w) => w.symbol === r?.destination?.symbol);
    const { y } = transitArcHeight(base, originWP, destWP, mapScale);
    p.group.position.set(base.x, y, base.z);

    // Motion trail for in-transit ships. Sampled by scene distance moved,
    // not every frame, and tinted by the ship's own role color so each
    // trajectory is glanceable against the dark map.
    const points = liveTrails.get(sh.symbol) ?? [];
    const lastPos = lastTrailSamplePos.get(sh.symbol);
    if (!lastPos || Math.hypot(base.x - lastPos.x, base.z - lastPos.z) >= TRAIL_SAMPLE_MIN_SCENE) {
      points.push({ x: base.x, y, z: base.z });
      if (points.length > TRAIL_MAX_POINTS) points.shift();
      liveTrails.set(sh.symbol, points);
      lastTrailSamplePos.set(sh.symbol, { x: base.x, y, z: base.z });
    }
    if (points.length > 1) {
      const old = liveTrailObjects.get(sh.symbol);
      if (old) {
        liveTrailGroup.remove(old);
        disposeTrailGroup(old);
      }
      const trailGroup = new THREE.Group();
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        // 0.25-0.7: a real fade from tail to head while making sure no
        // segment is ever too faint to notice — matches the flat map's own
        // live-trail opacity range.
        const opacity = 0.25 + (i / (points.length - 1)) * 0.45;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y + 0.06, a.z),
          new THREE.Vector3(b.x, b.y + 0.06, b.z),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity, depthTest: false, linewidth: 2 });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 8;
        line.material.linewidth = 2;
        trailGroup.add(line);
      }
      liveTrailGroup.add(trailGroup);
      liveTrailObjects.set(sh.symbol, trailGroup);
    }
  }
  shipAnimHandle = requestAnimationFrame(repositionShips);
}

/** Book mode's clause hover: ring the real hulls a rule fired against, at
 *  their real (projected) screen position. Same idea as the flat map's
 *  version — draw at shipScreenPos — just filled from a 3D→screen
 *  projection instead of an SVG transform's own x/y. */
function pulseHulls(shipSymbols) {
  clearHullPulse();
  if (!sceneReady) return;
  const rect = host.getBoundingClientRect();
  const group = document.createElement("div");
  group.id = "hull-pulse-group-3d";
  for (const sym of shipSymbols) {
    const p = pickables.find((x) => x.kind === "ship" && x.symbol === sym);
    if (!p) continue;
    const v = p.group.position.clone().project(camera);
    const x = (v.x * 0.5 + 0.5) * rect.width;
    const y = (-v.y * 0.5 + 0.5) * rect.height;
    shipScreenPos.set(sym, { x, y });
    const dot = document.createElement("div");
    dot.className = "hull-pulse-3d";
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    group.appendChild(dot);
  }
  host.appendChild(group);
}

function clearHullPulse() {
  document.getElementById("hull-pulse-group-3d")?.remove();
}

function resetMapView() {
  orbitGoal.target.set(0, 0, 0);
  orbitGoal.radius = galaxyMode ? 200 : 112;
  orbitGoal.theta = 0.7;
  orbitGoal.phi = 1.0;
}

// Drag pans the target across the ground plane rather than orbiting the
// camera around a fixed point — this is a top-down strategic map (v3's
// flat map has no rotation at all, just pan and zoom), so a fixed point
// you can only orbit around meant an outer waypoint stayed out of reach
// short of zooming out far enough to shrink everything else with it.
// Panning direction is derived from the camera's current facing (theta)
// so a drag always moves the world the way it visually should, whatever
// angle the map happens to be at.
function panCamera(dx, dy) {
  const panSpeed = orbitCam.radius * 0.0022;
  const theta = orbitCam.theta;
  const rightX = Math.sin(theta), rightZ = -Math.cos(theta);
  const fwdX = -Math.cos(theta), fwdZ = -Math.sin(theta);
  orbitGoal.target.x -= dx * rightX * panSpeed - dy * fwdX * panSpeed;
  orbitGoal.target.z -= dx * rightZ * panSpeed - dy * fwdZ * panSpeed;
}

function rotateCamera(dx, dy) {
  orbitGoal.theta -= dx * 0.006;
  orbitGoal.phi = Math.max(0.2, Math.min(Math.PI - 0.2, orbitGoal.phi - dy * 0.005));
}

// Same clamp the wheel/pinch handlers below use — a button click just
// nudges orbitGoal.radius by a fixed factor instead of a continuous
// gesture delta. Zooming in means a SMALLER radius (camera closer).
function zoomMapBy(factor) {
  const min = systemSpan * 0.35, max = systemSpan * 6;
  orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * factor));
}

function attachMapControls() {
  $("map-fit")?.addEventListener("click", resetMapView);
  $("map-zoom-in")?.addEventListener("click", () => zoomMapBy(1 / 1.4));
  $("map-zoom-out")?.addEventListener("click", () => zoomMapBy(1.4));
  // Right-click-drag orbits (desktop's usual "secondary drag" gesture) —
  // genuine depth is one of the few things a 3D map has over the flat one,
  // worth keeping reachable even though plain drag now pans.
  host.addEventListener("contextmenu", (e) => e.preventDefault());

  let dragging = false, rotating = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  host.addEventListener("pointerdown", (e) => {
    if (e.button === 2) rotating = true; else dragging = true;
    lastX = downX = e.clientX; lastY = downY = e.clientY;
    host.classList.add("dragging");
  });
  window.addEventListener("pointerup", (e) => {
    const wasRotating = rotating;
    dragging = false; rotating = false;
    host.classList.remove("dragging");
    if (wasRotating || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // was a drag, not a click
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { if (mapTipFor) hideWaypointTip(); return; }
    if (hit.kind === "galaxy-system") {
      currentSystem = hit.symbol;
      setGalaxyMode(false);
      renderSystemStrip();
    } else if (hit.kind === "ship") openShipDetails(hit.symbol);
    else {
      if (mapTipFor === hit.symbol) hideWaypointTip();
      else { showWaypointTip(hit.symbol); mapTipFor = hit.symbol; }
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging && !rotating) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (rotating) rotateCamera(dx, dy); else panCamera(dx, dy);
  });
  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    const min = systemSpan * 0.35, max = systemSpan * 6;
    orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * (1 + e.deltaY * 0.0012)));
  }, { passive: false });
  host.addEventListener("dblclick", resetMapView);

  // Touch: one finger pans, two fingers combine pinch-to-zoom (distance)
  // with drag-to-rotate (midpoint movement) in the same gesture.
  let pinchDist = null, pinchMidX = 0, pinchMidY = 0;
  host.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchMidX = (a.clientX + b.clientX) / 2;
      pinchMidY = (a.clientY + b.clientY) / 2;
    }
  }, { passive: true });
  host.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && dragging) {
      const t = e.touches[0];
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      lastX = t.clientX; lastY = t.clientY;
      panCamera(dx, dy);
    } else if (e.touches.length === 2 && pinchDist != null) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const min = systemSpan * 0.35, max = systemSpan * 6;
      orbitGoal.radius = Math.max(min, Math.min(max, orbitGoal.radius * (1 + (pinchDist - d) * 0.004)));
      pinchDist = d;
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      rotateCamera(midX - pinchMidX, midY - pinchMidY);
      pinchMidX = midX; pinchMidY = midY;
    }
  }, { passive: true });
  host.addEventListener("touchend", () => { dragging = false; pinchDist = null; });
  host.addEventListener("touchcancel", () => { dragging = false; pinchDist = null; });
}

function pickAt(clientX, clientY) {
  const rect = host.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const meshes = pickables.map((p) => p.mesh);
  const hits = raycaster.intersectObjects(meshes);
  if (!hits.length) return null;
  return pickables.find((p) => p.mesh === hits[0].object) || null;
}

function tickMap3D() {
  requestAnimationFrame(tickMap3D);
  if (!sceneReady) return;
  orbitCam.theta += (orbitGoal.theta - orbitCam.theta) * 0.14;
  orbitCam.phi += (orbitGoal.phi - orbitCam.phi) * 0.14;
  orbitCam.radius += (orbitGoal.radius - orbitCam.radius) * 0.14;
  orbitCam.target.lerp(orbitGoal.target, 0.14);
  applyOrbitCamera();
  // Billboard every sprite (labels, glows) toward the camera every frame —
  // cheap now that renderMap() only builds a body for waypoints an operator
  // would actually act on, and correct regardless of orbit angle.
  bodiesGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  glowGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  starGroup.children.forEach((c) => { if (c.isSprite) c.quaternion.copy(camera.quaternion); });
  // A slow, subtle breathing pulse on the star's glow — the one thing a
  // static sun-shaped sprite can't sell on its own is that it's a light
  // source rather than a painted decal. Small range (±6%/±10%) so it reads
  // as alive without looking like a strobing bug.
  if (starGlowPulse) {
    starGlowPulse.t += 0.012;
    const corePulse = 1 + Math.sin(starGlowPulse.t) * 0.06;
    const coronaPulse = 1 + Math.sin(starGlowPulse.t * 0.7 + 1.1) * 0.1;
    starGlowPulse.core.scale.set(26 * corePulse, 26 * corePulse, 1);
    starGlowPulse.corona.scale.set(70 * coronaPulse, 70 * coronaPulse, 1);
    starGlowPulse.corona.material.opacity = 0.42 + Math.sin(starGlowPulse.t * 0.7) * 0.08;
  }
  // Jump-gate "active portal" pulse: a ring sprite expanding outward from
  // 1x to ~2.6x its base size while fading out, looping continuously. Each
  // gate's own phase (set once in renderMap()) keeps multiple gates in one
  // system out of lockstep.
  const gateCycle = 2.4; // seconds per pulse
  for (const pulse of gatePulses.values()) {
    const t = ((performance.now() / 1000) * (Math.PI * 2 / gateCycle) + pulse.phase) % (Math.PI * 2);
    const frac = t / (Math.PI * 2); // 0 (just spawned) -> 1 (about to loop)
    const scale = pulse.baseSize * (1 + frac * 1.6);
    pulse.sprite.scale.set(scale, scale, 1);
    pulse.sprite.material.opacity = 1 - frac;
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
}

function initMapInteractions() {
  // Scene construction is lazy (first renderMap() call, once #map3d has a
  // real size) rather than here — matches the flat map's own timing, where
  // initMapInteractions() ran once at boot before any data existed.
}

function showWaypointTip(symbol) {
  const tip = $("map-tip");
  const wp = waypoints.find((w) => w.symbol === symbol);
  if (!wp) return;
  const shipsHere = (state?.ships ?? []).filter((s) => s.nav.waypointSymbol === symbol);
  const snaps = marketSnapshots.filter((m) => m.waypointSymbol === symbol);
  const offers = loadoutScores.filter((s) => s.yardSymbol === symbol);
  // marketplace/shipyard sort first so they can never be the ones bumped
  // off the visible list by the +N truncation below — those two are also
  // the traits the dot/ring overlay and the sections further down key off
  // of, so silently hiding them made the tooltip look self-contradictory
  // (dot says market, chip list doesn't).
  const traits = (wp.traits ?? [])
    .map((t) => t.replace(/_/g, " ").toLowerCase())
    .sort((a, b) => (b === "marketplace" || b === "shipyard" ? 1 : 0) - (a === "marketplace" || a === "shipyard" ? 1 : 0));
  const isMarket = traits.includes("marketplace");
  const isYard = traits.includes("shipyard");
  const isAsteroid = ["asteroid", "asteroid field", "engineered asteroid"].includes(wp.type.replace(/_/g, " ").toLowerCase());

  let html = `<h4>${symbol}</h4>`;
  html += `<span class="coords">x ${wp.x} · y ${wp.y}</span>`;
  html += `<div class="tags"><span class="tag type">${wp.type.replace(/_/g, " ").toLowerCase()}</span>`;
  const shownTraits = traits.slice(0, 5);
  for (const t of shownTraits) {
    const cls = t === "marketplace" ? " market" : t === "shipyard" ? " yard" : "";
    html += `<span class="tag${cls}">${t}</span>`;
  }
  if (traits.length > shownTraits.length) html += `<span class="tag more">+${traits.length - shownTraits.length}</span>`;
  html += `</div>`;

  if (shipsHere.length) {
    html += `<div class="sub">Ships here</div>`;
    for (const s of shipsHere) {
      html += `<div class="ship-line"><b>${s.symbol}</b><span>${s.nav.status.replace(/_/g, " ")} · fuel ${s.fuel.current}/${s.fuel.capacity}</span></div>`;
    }
  }

  if (isAsteroid) {
    html += `<div class="survey-sec" data-wp="${symbol}"><div class="empty">Survey data unavailable</div></div>`;
  }

  if (isMarket) {
    const goods = snaps.slice(0, 6);
    if (goods.length) {
      html += `<div style="margin-top:6px">`;
      for (const g of goods) {
        const dir = g.type === "IMPORT" ? " <span class='up'>▲</span>" : g.type === "EXPORT" ? " <span class='down'>▼</span>" : "";
        html += `<div class="row"><span>${g.goodSymbol}${dir}</span><span>buy <b>${g.purchasePrice}</b> · sell <b>${g.sellPrice}</b></span></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="empty">Prices not observed yet — dock a ship here.</div>`;
    }
  }

  if (isYard) {
    if (offers.length) {
      html += `<div style="margin-top:6px">`;
      for (const o of offers.slice(0, 3)) {
        html += `<div class="row"><span>${o.type.replace("SHIP_", "")}</span><span><b>${fmt(o.purchasePrice)}c</b></span></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="empty">Yard inventory not scanned.</div>`;
    }
  }

  tip.innerHTML = html;
  tip.classList.add("visible");

  const surveySec = tip.querySelector(".survey-sec");
  if (surveySec) {
    const wp = surveySec.dataset.wp;
    const cached = surveyCache.get(wp);
    const apply = (surveys) => {
      const sec = $("map-tip").querySelector(".survey-sec");
      if (!sec || sec.dataset.wp !== wp) return;
      if (!surveys.length) {
        sec.innerHTML = `<div class="empty">No active surveys here yet — send the surveyor.</div>`;
        return;
      }
      const html = surveys.map((s) => {
        const left = Math.max(0, Math.floor((new Date(s.expiration).getTime() - Date.now()) / 60000));
        const size = s.size ? ` · ${s.size}` : "";
        return `<div class="row"><span>${s.deposits.join(", ")}${size}</span><span>expires in ${left}m</span></div>`;
      }).join("");
      sec.innerHTML = `<div style="margin-top:6px"><div class="sub">Surveys</div>${html}</div>`;
    };
    if (cached) {
      apply(cached);
    } else {
      fetch(`/api/surveys?waypoint=${encodeURIComponent(wp)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
        .then((d) => { surveyCache.set(wp, d.surveys ?? []); apply(d.surveys ?? []); })
        .catch(() => apply([]));
    }
  }
}

function hideWaypointTip() {
  $("map-tip").classList.remove("visible");
  mapTipFor = null;
}

function openTradePanel(shipSymbol) {
  const ship = (state?.ships ?? []).find((s) => s.symbol === shipSymbol);
  if (!ship) return;
  const wp = ship.nav.waypointSymbol;
  const snaps = marketSnapshots.filter((m) => m.waypointSymbol === wp);
  const cargo = ship.cargo.inventory ?? [];
  const modal = $("trade-modal");
  const backdrop = $("trade-backdrop");

  let html = `<button class="close">Close</button>
    <h3>${shipSymbol}</h3>
    <div class="sub">At ${wp} · cargo ${ship.cargo.units}/${ship.cargo.capacity}</div>`;

  if (snaps.length) {
    html += `<div class="sub">Market prices</div>`;
    for (const g of snaps.slice(0, 12)) {
      const dir = g.type === "IMPORT" ? " ▲" : g.type === "EXPORT" ? " ▼" : "";
      const held = cargo.find((c) => c.symbol === g.goodSymbol);
      const sellBtn = held
        ? `<button class="sell" data-good="${g.goodSymbol}" title="Sell ${held.units}u held">Sell ${held.units}</button>`
        : "";
      html += `<div class="good">
        <span class="name">${g.goodSymbol}${dir}</span>
        <span class="price">buy <b>${g.purchasePrice}</b> · sell <b>${g.sellPrice}</b></span>
        ${held ? `<input type="number" min="1" max="${held.units}" value="${held.units}" data-good="${g.goodSymbol}" />` : ""}
        <button class="buy" data-good="${g.goodSymbol}">Buy</button>
        ${sellBtn}
      </div>`;
    }
  } else {
    html += `<div class="sub">No prices observed at this waypoint — it may not be a market.</div>`;
  }

  if (cargo.length) {
    html += `<div class="cargo-note">Carrying: ${cargo.map((c) => `${c.units}u ${c.symbol}`).join(", ") || "nothing"}</div>`;
  }

  modal.innerHTML = html;
  backdrop.classList.add("open");

  modal.querySelector(".close").addEventListener("click", () => backdrop.classList.remove("open"));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.remove("open"); });

  modal.querySelectorAll(".buy, .sell").forEach((b) => {
    b.addEventListener("click", async () => {
      const good = b.dataset.good;
      const input = modal.querySelector(`input[data-good="${good}"]`);
      const units = Math.max(1, Number(input?.value ?? 1));
      const action = b.classList.contains("buy") ? "buy" : "sell";
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/trade", { shipSymbol, good, units, action });
        await loadState();
        openTradePanel(shipSymbol);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
}



/** Condition/integrity live per-component (frame/engine/reactor) on the raw
 *  ship object — condition (0-1) degrades from mining/navigating and is
 *  repairable; integrity (0-1) is permanent wear, shown but never actionable.
 *  Repair requires DOCKED at a SHIPYARD-trait waypoint, same requirement the
 *  raw API itself enforces (FleetManager.repairShip() checks it again
 *  server-side — this is just so the button reflects reality instead of
 *  bouncing off a 500). */
function conditionSectionHtml(ship, shipSymbol, atYard) {
  const parts = [
    { label: "Frame", c: ship.frame },
    { label: "Engine", c: ship.engine },
    { label: "Reactor", c: ship.reactor },
  ].filter((p) => p.c);
  if (!parts.length) return "";
  const worst = Math.min(...parts.map((p) => p.c.condition ?? 1));
  const docked = ship.nav.status === "DOCKED";
  const canRepair = docked && atYard;
  return `<div class="loadout-section"><h4>Condition</h4>
    ${parts.map((p) => {
      const pct = Math.round(Math.max(0, Math.min(1, p.c.condition ?? 1)) * 100);
      const low = pct < 50;
      return `<div class="loadout-item"><span class="n">${p.label}<span class="meter${low ? " neg" : ""}" style="margin-left:6px"><i style="width:${pct}%"></i></span></span><span class="d">${pct}%</span></div>`;
    }).join("")}
    <div class="jump-row">
      <span class="tgt">${worst < 1
        ? `<b>${Math.round(worst * 100)}% worst component</b> <span class="d" style="color:var(--dim);font-size:9px">${canRepair ? "ready to repair here" : "requires DOCKED at a shipyard"}</span>`
        : `<b>Full condition</b> <span class="d" style="color:var(--dim);font-size:9px">nothing to repair</span>`}</span>
      <button class="repair-now" data-ship="${escapeAttr(shipSymbol)}" ${canRepair && worst < 1 ? "" : "disabled"}>Repair</button>
    </div>
  </div>`;
}

/** Morale reads on a 0-100 scale per the API docs ("a rough measure of the
 *  crew's morale") — clamped defensively since nothing enforces that range
 *  contractually. Read-only everywhere: there's no crew-management endpoint
 *  in the API (rotation/hiring aren't settable), this is purely flavor. */
function crewSectionHtml(crew) {
  if (!crew) return "";
  const pct = Math.max(0, Math.min(100, crew.morale ?? 0));
  const low = pct < 40;
  return `<div class="loadout-section"><h4>Crew</h4>
    <div class="loadout-item"><span class="n">${crew.current}/${crew.capacity} aboard</span><span class="d">min ${crew.required}</span></div>
    <div class="loadout-item"><span class="n">Morale<span class="meter${low ? " neg" : ""}" style="margin-left:6px"><i style="width:${pct}%"></i></span></span><span class="d">${pct}/100</span></div>
    <div class="loadout-item"><span class="n">${crew.rotation === "STRICT" ? "Strict shifts" : "Relaxed shifts"}</span><span class="d">${crew.rotation === "STRICT" ? "sharper, harder on morale" : "easier on morale"}</span></div>
    <div class="loadout-item"><span class="n">Wages</span><span class="d">${fmt(crew.wages)}c/crew/hr · ${fmt(crew.wages * crew.current)}c/hr total</span></div>
  </div>`;
}

function openShipDetails(shipSymbol, opts = {}) {
  const { containerId = "manifest" } = opts;
  const ship = (state?.ships ?? []).find((s) => s.symbol === shipSymbol);
  if (!ship) return;
  if (containerId === "manifest") {
    selectedShip = shipSymbol;
    // #manifest lives inside the desktop Bridge view's left rail, which stays
    // hidden on mobile unless one of the mobile-*-active overlay modes is on
    // (see the Map/Book tab CSS) — without this, every tap from the Bridge
    // hero strip, Fleet tab, or triage list populated #manifest invisibly.
    if (isMobile()) {
      document.body.classList.add("mobile-ship-active");
      // fieldBookMode persists in localStorage independent of which mobile tab
      // is open — if the operator had last used Book mode (desktop toggle or
      // the mobile Book tab), .field-stage.book-mode's CSS sets the rail
      // (which #manifest lives in) to opacity:0/pointer-events:none, so the
      // sheet showed through instead of ship details even though .view-bridge
      // itself was correctly visible. Force back to field mode, same as the
      // Map tab already does in setMobileView().
      if (fieldBookMode !== "field") setFieldBookMode("field");
    }
  }
  // containerId !== "manifest": a second, independent place this exact same
  // content/handlers get rendered — the Fleet page's own tabbed detail pane
  // (see openFleetShipDetail()/tabifyShipDetail()) — which has no Triage rail
  // to overlay-manage and shouldn't touch the Bridge rail's own selection.
  const modal = $(containerId);
  if (!modal) return;
  const shipSystem = ship.nav.systemSymbol;
  const hereWp = waypoints.find((w) => w.symbol === ship.nav.waypointSymbol);
  const atYard = (hereWp?.traits ?? []).some((t) => t === "SHIPYARD");
  const docked = ship.nav.status === "DOCKED";

  const st = (fleetStatus.ships ?? []).find((x) => x.symbol === shipSymbol);
  const isMiner = st?.role === "miner" || st?.role === "surveyor";
  const fields = waypoints.filter((w) => w.type === "ASTEROID_FIELD" || w.type === "ASTEROID" || w.type === "ENGINEERED_ASTEROID");

  const part = (p) => p ? `<div class="loadout-item"><span class="n">${p.name ?? p.symbol}</span><span class="d">${p.symbol}</span></div>` : "";
  const modules = (ship.modules ?? []).map((m) =>
    `<div class="loadout-item"><span class="n">${m.name}</span><span class="d">${m.symbol}</span><button class="rm" data-ship="${shipSymbol}" data-comp="${m.symbol}">Remove</button></div>`
  ).join("");
  const mounts = (ship.mounts ?? []).map((m) =>
    `<div class="loadout-item"><span class="n">${m.name}</span><span class="d">${m.symbol}</span><button class="rm" data-ship="${shipSymbol}" data-comp="${m.symbol}">Remove</button></div>`
  ).join("");

  // Components sitting in cargo that can be installed.
  const cargoComps = (ship.cargo.inventory ?? []).filter((i) => i.symbol.startsWith("MODULE_") || i.symbol.startsWith("MOUNT_"));
  const cargoRows = cargoComps.map((i) =>
    `<div class="jump-row">
      <span class="tgt"><b>${i.symbol}</b> <span class="d" style="color:var(--dim);font-size:9px">${i.units}u in cargo</span></span>
      <button class="install" data-ship="${shipSymbol}" data-comp="${i.symbol}">Install</button>
    </div>`
  ).join("") || `<div class="empty">No modules/mounts in cargo.</div>`;

  // Jump planner: connections originating from this ship's system.
  const jumpRows = jumpConnections
    .filter((c) => c.from.startsWith(shipSystem + "-"))
    .map((c) => {
      const toSystem = c.to.slice(0, c.to.lastIndexOf("-"));
      const toShort = shortWp(c.to);
      const via = shortWp(c.from);
      const inTransit = ship.nav.status === "IN_TRANSIT";
      return `<div class="jump-row">
        <span class="tgt"><b>${toSystem}</b> → ${toShort} <span class="d" style="color:var(--dim);font-size:9px">via ${via}</span></span>
        <button class="jump" data-ship="${shipSymbol}" data-to="${c.to}" ${inTransit ? "disabled" : ""}>Jump</button>
      </div>`;
    }).join("") || `<div class="empty">No jump gates in ${shipSystem}.</div>`;

  let html = `${containerId === "manifest"
      ? `<button class="close" id="manifest-back" title="Back to triage">← Triage</button>
    <h3>${shipSymbol}</h3>`
      : ""}
    <div class="sub">${ship.registration.role} · ${ship.nav.status.replace(/_/g, " ")} · ${shortWp(ship.nav.waypointSymbol)}</div>
    <div class="metric-row">
      <div class="metric-block"><span class="num">${ship.fuel.current}/${ship.fuel.capacity}</span><span class="lbl">fuel</span></div>
      <div class="metric-block"><span class="num">${ship.cargo.units}/${ship.cargo.capacity}</span><span class="lbl">cargo</span></div>
    </div>
    ${conditionSectionHtml(ship, shipSymbol, atYard)}
    ${crewSectionHtml(ship.crew)}
    <div class="loadout-section"><h4>Manual control</h4>
      <div class="jump-row">
        <span class="tgt">${st?.paused
          ? `<b>Held</b> <span class="d" style="color:var(--dim);font-size:9px">parked, ignoring the doctrine</span>`
          : `<b>Under doctrine</b> <span class="d" style="color:var(--dim);font-size:9px">the engine is flying this ship</span>`}</span>
        ${st?.paused
          ? `<button class="release" data-ship="${shipSymbol}">Release</button>`
          : `<button class="hold" data-ship="${shipSymbol}">Hold</button>`}
      </div>
      ${!st?.paused ? `<div class="jump-row">
        <span class="tgt"><b>Send to waypoint</b> <span class="d" style="color:var(--dim);font-size:9px">holds it there until released</span></span>
        <input type="text" class="dispatch-wp" placeholder="e.g. ${shipSystem}-A1" style="width:110px;background:var(--ink);border:1px solid var(--hairline);color:var(--bone);font-family:var(--mono);font-size:10px;padding:4px 6px" />
        <button class="send-wp" data-ship="${shipSymbol}">Go</button>
      </div>` : ""}
      ${ship.nav.status !== "IN_TRANSIT" ? `<div class="jump-row">
        <span class="tgt"><b>${docked ? "Docked" : "In orbit"}</b> <span class="d" style="color:var(--dim);font-size:9px">docking/scrapping/trading here requires DOCKED status</span></span>
        <button class="dock-toggle" data-ship="${shipSymbol}">${docked ? "Undock" : "Dock"}</button>
      </div>
      <div class="jump-row">
        <span class="tgt"><b>${ship.fuel.current}/${ship.fuel.capacity} fuel</b> <span class="d" style="color:var(--dim);font-size:9px">a manual send parks a ship without refueling it</span></span>
        <button class="refuel-now" data-ship="${shipSymbol}">Refuel</button>
      </div>` : ""}
      ${isMiner ? `<div class="jump-row">
        <span class="tgt">${st?.pinnedField
          ? `<b>Pinned to ${shortWp(st.pinnedField)}</b> <span class="d" style="color:var(--dim);font-size:9px">still mining, hauling, selling on its own</span>`
          : `<b>Choosing its own field</b> <span class="d" style="color:var(--dim);font-size:9px">picks the nearest reachable asteroid</span>`}</span>
        ${st?.pinnedField
          ? `<button class="unpin-mine" data-ship="${shipSymbol}">Unpin</button>`
          : ""}
      </div>` : ""}
      ${isMiner && fields.length ? `<div class="jump-row">
        <select class="mine-field" aria-label="Asteroid field" style="flex:1;background:var(--ink);border:1px solid var(--hairline);color:var(--bone);font-family:var(--mono);font-size:10px;padding:4px 6px">
          ${fields.map((f) => `<option value="${escapeAttr(f.symbol)}" ${f.symbol === st?.pinnedField ? "selected" : ""}>${escapeHtml(shortWp(f.symbol))}</option>`).join("")}
        </select>
        <button class="pin-mine" data-ship="${shipSymbol}">Mine here</button>
      </div>` : ""}
    </div>
    <div class="loadout-section"><h4>Role</h4>
      <div class="jump-row">
        <span class="tgt"><b>Current: ${st?.role ?? "idle"}</b> <span class="d" style="color:var(--dim);font-size:9px">${ship.registration.role === "COMMAND" ? "the flagship is never auto-converted — change it manually here" : "manual changes stick — the engine won't auto-reassign this ship"}</span></span>
      </div>
      <div class="jump-row">
        <select class="role-select" aria-label="Role" style="flex:1;background:var(--ink);border:1px solid var(--hairline);color:var(--bone);font-family:var(--mono);font-size:10px;padding:4px 6px">
          ${["trader", "miner", "surveyor", "siphoner", "tour", "explorer", "scout", "keeper"].map((r) => `<option value="${r}" ${r === st?.role ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <button class="set-role" data-ship="${shipSymbol}">Change</button>
      </div>
      <div class="jump-row role-mismatch-warn" style="display:none">
        <span class="tgt" style="color:var(--warn,#e0a030);font-size:9px"></span>
      </div>
      <div class="jump-row role-keeper-market" style="display:none">
        <input type="text" class="role-keeper-wp" placeholder="keeper market waypoint (skip if already there)" style="width:100%;background:var(--ink);border:1px solid var(--hairline);color:var(--bone);font-family:var(--mono);font-size:10px;padding:4px 6px" />
      </div>
    </div>
    ${st?.role === "tour" ? `<div class="loadout-section"><h4>Tour dispatch</h4>
      <div class="jump-row">
        <span class="tgt">${st?.tourDestination
          ? `<b>Walking toward ${st.tourDestination}</b> <span class="d" style="color:var(--dim);font-size:9px">one jump gate hop per tick — stays put once it arrives</span>`
          : `<b>Touring ${shipSystem}</b> <span class="d" style="color:var(--dim);font-size:9px">send it to a remote system to tour there instead</span>`}</span>
      </div>
      <div class="jump-row">${(() => {
        // galaxyOverviewData is the same durable charted-systems list the
        // Sector tab strip and galaxy map use (FleetManager.getChartedSystems()
        // unioned with whatever's currently loaded) — a system this tenant
        // has never actually seen isn't a real dispatch target, so this
        // list is what's offered rather than a free-text field that could
        // typo into a system that doesn't exist or was never charted.
        const options = [...new Set((galaxyOverviewData?.systems ?? []).map((s) => s.symbol))]
          .filter((sym) => sym !== shipSystem)
          .sort();
        if (!options.length) {
          return `<span class="d" style="color:var(--dim);font-size:9px">no other charted systems yet</span>`;
        }
        return `<select class="tour-dispatch-system" style="flex:1;background:var(--ink);border:1px solid var(--hairline);color:var(--bone);font-family:var(--mono);font-size:10px;padding:4px 6px">
            ${options.map((sym) => `<option value="${escapeAttr(sym)}">${escapeHtml(sym)}</option>`).join("")}
          </select>
          <button class="tour-dispatch-go" data-ship="${shipSymbol}">Send</button>`;
      })()}</div>
    </div>` : ""}
    <div class="loadout-section"><h4>Cargo hold</h4>
      ${(ship.cargo.inventory ?? []).length
        ? `<div class="loadout-grid">${(ship.cargo.inventory ?? []).map((i) =>
            `<div class="loadout-item"><span class="n">${i.units}u ${escapeHtml(i.symbol)}</span>
              <button class="jettison-item" data-ship="${escapeAttr(shipSymbol)}" data-good="${escapeAttr(i.symbol)}" data-units="${i.units}" title="Dump ${i.units}u ${escapeAttr(i.symbol)} — cannot be undone">Jettison</button></div>`
          ).join("")}</div>`
        : `<div class="empty">Hold is empty.</div>`}
    </div>
    <div class="loadout-section"><h4>Loadout</h4>
      <div class="loadout-grid">
        ${part(ship.frame)}${part(ship.reactor)}${part(ship.engine)}
      </div>
    </div>
    <div class="loadout-section"><h4>Modules</h4>
      <div class="loadout-grid">${modules || '<div class="empty">No modules</div>'}</div>
    </div>
    <div class="loadout-section"><h4>Mounts</h4>
      <div class="loadout-grid">${mounts || '<div class="empty">No mounts</div>'}</div>
    </div>
    <div class="loadout-section"><h4>Components in cargo</h4>
      ${cargoRows}
    </div>
    <div class="loadout-section"><h4>Jump planner</h4>
      ${jumpRows}
    </div>
    <div class="loadout-section"><h4>Scout & upgrade</h4>
      <div class="jump-row">
        <span class="tgt"><b>Scout connected systems</b> <span class="d" style="color:var(--dim);font-size:9px">surveys markets & shipyards</span></span>
        <button class="scout" data-ship="${shipSymbol}">Scout</button>
      </div>
      ${intel.modules.length ? `<div class="sub" style="margin-top:8px">Buy & install module</div>` : ""}
      ${intel.modules.slice(0, 6).map((m) => `
        <div class="jump-row">
          <span class="tgt"><b>${m.symbol}</b> <span class="d" style="color:var(--dim);font-size:9px">${shortWp(m.waypointSymbol)} · ${m.purchasePrice}c</span></span>
          <button class="buy-install" data-ship="${shipSymbol}" data-comp="${m.symbol}" data-market="${m.waypointSymbol}">Buy+Install</button>
        </div>`).join("")}
    </div>
    <div class="loadout-section"><h4>Scrap</h4>
      <div class="jump-row">
        ${atYard && ship.nav.status !== "IN_TRANSIT"
          ? `<span class="tgt"><b>Scrap this ship</b> <span class="d" style="color:var(--dim);font-size:9px">removes it permanently, returns a portion of its value${docked ? "" : " — docks it first"}</span></span>
        <button class="scrap" data-ship="${shipSymbol}">Scrap</button>`
          : `<span class="tgt"><b>Sell ship</b> <span class="d" style="color:var(--dim);font-size:9px">flies to the nearest known shipyard in this system, then scraps it there — permanent, cannot be undone</span></span>
        <button class="sell-ship" data-ship="${shipSymbol}">Sell</button>`}
      </div>
    </div>`;

  modal.innerHTML = html;
  if (containerId === "manifest") {
    showRailManifest(shipSymbol);
    modal.querySelector(".close")?.addEventListener("click", () => { selectedShip = null; showRailTriage(); });
  } else {
    tabifyShipDetail(modal);
  }
  modal.querySelectorAll(".hold").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/hold", { shipSymbol: b.dataset.ship });
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".release").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/release", { shipSymbol: b.dataset.ship });
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".send-wp").forEach((b) => {
    b.addEventListener("click", async () => {
      const input = modal.querySelector(".dispatch-wp");
      const wp = input?.value.trim();
      if (!wp) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/dispatch", { shipSymbol: b.dataset.ship, waypointSymbol: wp });
        showToastGlobal(`${b.dataset.ship} → ${wp}`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".dock-toggle").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const res = await api("POST", "/api/fleet/dock", { shipSymbol: b.dataset.ship });
        showToastGlobal(`${b.dataset.ship} ${res.status === "DOCKED" ? "docked" : "undocked"}`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".refuel-now").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const res = await api("POST", "/api/fleet/refuel", { shipSymbol: b.dataset.ship });
        showToastGlobal(`${b.dataset.ship} refueled to ${res.fuel}/${res.capacity} (${res.cost}c)`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".role-select").forEach((sel) => {
    const targetShip = (state?.ships ?? []).find((s) => s.symbol === modal.querySelector(".set-role")?.dataset.ship);
    const toggle = () => {
      const row = modal.querySelector(".role-keeper-market");
      if (row) row.style.display = sel.value === "keeper" ? "" : "none";
      const warnRow = modal.querySelector(".role-mismatch-warn");
      const reason = targetShip ? roleMismatchReason(sel.value, targetShip) : null;
      if (warnRow) {
        warnRow.style.display = reason ? "" : "none";
        const span = warnRow.querySelector(".tgt");
        if (span) span.textContent = reason ? `⚠ ${reason} — the ship won't be able to do this role's job` : "";
      }
    };
    sel.addEventListener("change", toggle);
    toggle();
  });
  modal.querySelectorAll(".set-role").forEach((b) => {
    b.addEventListener("click", async () => {
      const select = modal.querySelector(".role-select");
      const role = select?.value;
      const keeperMarket = modal.querySelector(".role-keeper-wp")?.value.trim() || undefined;
      if (!role) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/role", { shipSymbol: b.dataset.ship, role, keeperMarket });
        showToastGlobal(`${b.dataset.ship} → ${role}`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".pin-mine").forEach((b) => {
    b.addEventListener("click", async () => {
      const select = modal.querySelector(".mine-field");
      const wp = select?.value;
      if (!wp) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/mine", { shipSymbol: b.dataset.ship, waypointSymbol: wp });
        showToastGlobal(`${b.dataset.ship} pinned to ${shortWp(wp)}`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".unpin-mine").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/mine", { shipSymbol: b.dataset.ship, clear: true });
        showToastGlobal(`${b.dataset.ship} choosing its own field again`);
        await loadBridge();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".jettison-item").forEach((b) => {
    b.addEventListener("click", async () => {
      const { ship: shipSymbol, good, units } = b.dataset;
      if (!confirm(`Jettison ${units}u ${good} from ${shipSymbol}? This cannot be undone.`)) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/jettison", { shipSymbol, good, units: Number(units) });
        showToastGlobal(`${shipSymbol} jettisoned ${units}u ${good}`);
        await loadBridge();
        openShipDetails(shipSymbol, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".repair-now").forEach((b) => {
    b.addEventListener("click", async () => {
      const shipSymbol = b.dataset.ship;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/repair", { shipSymbol });
        showToastGlobal(`${shipSymbol} repaired`);
        await loadBridge();
        openShipDetails(shipSymbol, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".scout").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/explore", { shipSymbol: b.dataset.ship });
        await loadState();
        await loadIntel();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".buy-install").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/buy-install", { shipSymbol: b.dataset.ship, componentSymbol: b.dataset.comp, marketWaypoint: b.dataset.market });
        await loadState();
        await loadIntel();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".jump").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/jump", { shipSymbol: b.dataset.ship, waypointSymbol: b.dataset.to });
        await loadState();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".tour-dispatch-go").forEach((b) => {
    b.addEventListener("click", async () => {
      const shipSymbol = b.dataset.ship;
      const input = modal.querySelector(".tour-dispatch-system");
      const targetSystem = input?.value.trim().toUpperCase();
      if (!targetSystem) return;
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/tour-dispatch", { shipSymbol, targetSystem });
        showToastGlobal(`${shipSymbol} dispatched to tour ${targetSystem}`);
        await loadState();
        openShipDetails(shipSymbol, { containerId });
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".install").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/install", { shipSymbol: b.dataset.ship, componentSymbol: b.dataset.comp });
        await loadState();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".rm").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/remove-component", { shipSymbol: b.dataset.ship, componentSymbol: b.dataset.comp });
        await loadState();
        openShipDetails(b.dataset.ship, { containerId });
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".scrap").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm(`Scrap ${b.dataset.ship} permanently? This cannot be undone.`)) return;
      b.disabled = true;
      try {
        const res = await api("POST", "/api/fleet/scrap", { shipSymbol: b.dataset.ship });
        await loadState();
        backdrop.classList.remove("open");
        alert(`${b.dataset.ship} scrapped for ${fmt(res.totalPrice)} credits.`);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".sell-ship").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm(`Sell ${b.dataset.ship} permanently? It will fly to the nearest shipyard and be scrapped there. This cannot be undone.`)) return;
      b.disabled = true;
      try {
        const res = await api("POST", "/api/fleet/sell-ship", { shipSymbol: b.dataset.ship });
        await loadState();
        openShipDetails(b.dataset.ship, { containerId });
        alert(`${b.dataset.ship} is flying to ${res.yard} to be scrapped.`);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
}

/**
 * Re-render the open ship sheet when new fleet data lands.
 *
 * The bug this fixes: openShipDetails() ran once, on tap, and then nothing
 * ever called it again except its own action buttons. So the sheet froze at
 * whatever the ship was doing the moment it was opened, while every other
 * panel updated on the five-second poll behind it. Holding a ship and then
 * looking for the Release button showed "Under doctrine" and a Hold button
 * indefinitely — the state was correct in the store and correct in the
 * engine, and the one panel an operator acts from was the only one not
 * subscribed to it. A page refresh "fixed" it because that rebuilt the sheet
 * from scratch.
 *
 * Live re-rendering has to not fight the operator, though, so the two pieces
 * of local state that a rebuild would destroy are carried across it: what is
 * half-typed into the dispatch-waypoint box (with its cursor), and how far
 * the sheet is scrolled. Without that, a sheet that rebuilds every five
 * seconds is worse than one that never does.
 */
function refreshOpenShipDetails() {
  const m = $("manifest");
  if (!m || m.style.display === "none" || !selectedShip) return;
  // Snapshot every input/select/textarea's value (and focus/caret, for
  // whichever one is currently focused) before the panel's full re-render
  // below blows them all away with fresh elements — previously only
  // .dispatch-wp was preserved this way, so any other field in this panel
  // (the keeper-market waypoint, the tour-dispatch system picker, ...) got
  // silently reset mid-edit every time this ran, which is every
  // loadBridge() poll (5s) while the panel is open. That's the "typing
  // resets after a few seconds" bug reported live.
  const fields = [...m.querySelectorAll("input, select, textarea")]
    .filter((el) => el.className)
    .map((el) => ({
      selector: `.${el.className.trim().split(/\s+/).join(".")}`,
      value: el.value,
      focused: document.activeElement === el,
      caret: typeof el.selectionStart === "number" ? el.selectionStart : null,
    }));
  const scroll = m.scrollTop;

  openShipDetails(selectedShip);

  for (const f of fields) {
    const next = m.querySelector(f.selector);
    if (!next || !f.value) continue;
    next.value = f.value;
    if (f.focused) { next.focus(); if (f.caret !== null && next.setSelectionRange) { try { next.setSelectionRange(f.caret, f.caret); } catch (_) {} } }
  }
  m.scrollTop = scroll;
}

// Fleet page's own ship-detail pane (replaces the old standalone Personnel
// pane — see openFleetShipDetail()) tracks its selection independently of
// selectedShip/#manifest, which belongs to the Bridge view's Triage rail.
let fleetDetailShip = null;
let fleetDetailActiveTab = 0;

/** Which of openShipDetails()'s `.loadout-section` blocks (identified by
 *  their own <h4> text — the single source of truth stays in
 *  openShipDetails() itself) belong under which Fleet-page tab. Grouped
 *  rather than one tab per section: the Fleet pane has a full page's width
 *  to work with, not a 260px rail, so a handful of tabs each laid out as a
 *  card grid makes better use of it than eleven tabs of one narrow list
 *  apiece. `includeMetrics` pulls the fuel/cargo stat row in as well —
 *  it isn't a `.loadout-section` itself, just a sibling above them. */
const DETAIL_TAB_GROUPS = [
  { label: "Overview", sections: ["Condition", "Crew", "Manual control", "Role"], includeMetrics: true },
  { label: "Cargo & Loadout", sections: ["Cargo hold", "Loadout", "Modules", "Mounts", "Components in cargo"] },
  { label: "Navigation", sections: ["Jump planner"] },
  { label: "Scout & Upgrade", sections: ["Scout & upgrade", "Scrap"] },
];

/** Turn a rendered ship-detail container's flat list of `.loadout-section`
 *  blocks (plus the .metric-row above them) into a small set of tabs per
 *  DETAIL_TAB_GROUPS, each rendered as a card grid rather than a stacked
 *  list. Used only by the Fleet page's pane; #manifest keeps its original
 *  scrolling rail list untouched. Any section not named in
 *  DETAIL_TAB_GROUPS (a future addition to openShipDetails()) still shows
 *  up, under a catch-all "More" tab, rather than silently vanishing. */
function tabifyShipDetail(container) {
  const sections = Array.from(container.children).filter((el) => el.classList.contains("loadout-section"));
  if (!sections.length) return;
  const metricRow = container.querySelector(":scope > .metric-row");

  const used = new Set();
  const groups = DETAIL_TAB_GROUPS.map((g) => {
    const members = sections.filter((sec) => {
      const h4 = sec.querySelector(":scope > h4");
      return h4 && g.sections.includes(h4.textContent);
    });
    members.forEach((m) => used.add(m));
    return { label: g.label, members, includeMetrics: !!g.includeMetrics };
  }).filter((g) => g.members.length || (g.includeMetrics && metricRow));

  const leftover = sections.filter((s) => !used.has(s));
  if (leftover.length) groups.push({ label: "More", members: leftover });
  if (!groups.length) return;

  const activeIdx = Math.min(fleetDetailActiveTab, groups.length - 1);
  const bar = document.createElement("div");
  bar.className = "detail-tabbar";
  const panels = groups.map(() => {
    const p = document.createElement("div");
    p.className = "detail-grid";
    return p;
  });
  // Insert the (still-empty) bar + panels where the flat section list used
  // to start, before moving the actual content into them — appendChild
  // below relocates each existing node, it doesn't clone it.
  sections[0].before(bar, ...panels);

  groups.forEach((g, i) => {
    const panel = panels[i];
    panel.style.display = i === activeIdx ? "" : "none";
    if (g.includeMetrics && metricRow) panel.appendChild(metricRow);
    g.members.forEach((sec) => {
      const card = document.createElement("div");
      card.className = "detail-card";
      card.appendChild(sec);
      panel.appendChild(card);
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "detail-tab" + (i === activeIdx ? " active" : "");
    btn.textContent = g.label;
    btn.addEventListener("click", () => {
      fleetDetailActiveTab = i;
      bar.querySelectorAll(".detail-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      panels.forEach((p, j) => { p.style.display = j === i ? "" : "none"; });
    });
    bar.appendChild(btn);
  });
}

/** Select a ship in the Fleet page's own detail pane — independent of (and
 *  doesn't disturb) whatever's open in the Bridge view's Triage rail. */
function openFleetShipDetail(shipSymbol) {
  if (fleetDetailShip !== shipSymbol) fleetDetailActiveTab = 0;
  fleetDetailShip = shipSymbol;
  $("fleet-table")?.querySelectorAll("tbody tr").forEach((r) => r.classList.toggle("sel", r.dataset.ship === shipSymbol));
  refreshFleetShipDetail();
}

/** Re-render the Fleet page's detail pane when new fleet data lands — same
 *  reasoning as refreshOpenShipDetails(), just for the second place this
 *  content now lives. Preserves scroll position; the active tab already
 *  survives a rebuild via fleetDetailActiveTab (read by tabifyShipDetail()). */
function refreshFleetShipDetail() {
  const el = $("fleet-detail");
  const titleEl = $("fleet-detail-title");
  if (!el || !titleEl) return;
  if (!fleetDetailShip) {
    titleEl.textContent = "Select a ship";
    el.innerHTML = '<div class="empty">Click a hull above to see its details.</div>';
    return;
  }
  titleEl.textContent = fleetDetailShip;
  const scroll = el.scrollTop;
  openShipDetails(fleetDetailShip, { containerId: "fleet-detail" });
  el.scrollTop = scroll;
}

function renderShipyardIntel() {
  const yards = intel.shipyards ?? [];
  const mods = intel.modules ?? [];
  let html;
  if (!yards.length && !mods.length) {
    html = '<div class="empty">No shipyard/module intel yet — scout systems to expand.</div>';
  } else {
    html = "";
    if (yards.length) {
      html += `<div class="sub" style="margin-bottom:4px">Shipyards</div>`;
      // Grouped by ship type rather than a flat, arbitrarily-cut list of
      // raw waypoint rows — the same item is frequently sold at several
      // scouted yards at different prices, and a flat list either buried
      // that comparison or, worse, showed the same type twice while a
      // cheaper location for it never made the top-12 cut. Cheapest
      // location per type leads; up to 3 others are listed alongside it.
      const byType = new Map();
      for (const y of yards) {
        if (!byType.has(y.shipType)) byType.set(y.shipType, []);
        byType.get(y.shipType).push(y);
      }
      const groups = [...byType.values()]
        .map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice))
        .sort((a, b) => a[0].purchasePrice - b[0].purchasePrice)
        .slice(0, 12);
      for (const rows of groups) {
        const best = rows[0];
        const age = fmtAge(best.timestamp);
        const stale = best.timestamp && (Date.now() - new Date(best.timestamp).getTime()) > 90 * 60_000;
        const others = rows.slice(1, 4);
        html += `<div class="row" style="align-items:center">
          <span class="icon">⛵</span>
          <span class="route"><b>${shortWp(best.waypointSymbol)}</b> · ${best.shipTypeName}<br><span class="note">${best.systemSymbol} · fuel ${best.fuelCapacity} · ${fmt(best.purchasePrice)}c · <span class="${stale ? "stale" : ""}">${age} old</span></span>${others.length ? `<br><span class="note">also: ${others.map((o) => `${shortWp(o.waypointSymbol)} ${fmt(o.purchasePrice)}c`).join(" · ")}</span>` : ""}</span>
          <span class="marg">${fmt(best.purchasePrice)}c</span>
          <button class="buy-ship" data-type="${best.shipType}" data-yard="${best.waypointSymbol}" title="Buy ${best.shipTypeName}">Buy</button>
        </div>`;
      }
    }
    if (mods.length) {
      html += `<div class="sub" style="margin:8px 0 4px">Modules & mounts</div>`;
      const bySymbol = new Map();
      for (const m of mods) {
        if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, []);
        bySymbol.get(m.symbol).push(m);
      }
      const modGroups = [...bySymbol.values()]
        .map((rows) => rows.slice().sort((a, b) => a.purchasePrice - b.purchasePrice))
        .sort((a, b) => a[0].purchasePrice - b[0].purchasePrice)
        .slice(0, 12);
      for (const rows of modGroups) {
        const best = rows[0];
        const others = rows.slice(1, 4);
        html += `<div class="row" style="align-items:center">
          <span class="icon">${best.kind === "module" ? "▣" : "◈"}</span>
          <span class="route"><b>${best.symbol}</b><br><span class="note">${shortWp(best.waypointSymbol)} · ${fmt(best.purchasePrice)}c</span>${others.length ? `<br><span class="note">also: ${others.map((o) => `${shortWp(o.waypointSymbol)} ${fmt(o.purchasePrice)}c`).join(" · ")}</span>` : ""}</span>
          <span class="marg">${fmt(best.purchasePrice)}c</span>
          <button class="buy-mod" data-comp="${best.symbol}" data-market="${best.waypointSymbol}">Buy</button>
        </div>`;
      }
    }
  }

  for (const id of ["shipyard-intel", "mobile-shipyard-intel"]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = html;
    el.querySelectorAll(".buy-ship").forEach((b) => {
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await api("POST", "/api/fleet/buy", { shipType: b.dataset.type, yardSymbol: b.dataset.yard });
          showToastGlobal(`Bought ${b.dataset.type} at ${shortWp(b.dataset.yard)}`);
          await loadState();
          await loadIntel();
        } catch (err) { alert(err.message); b.disabled = false; }
      });
    });
    el.querySelectorAll(".buy-mod").forEach((b) => {
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const ships = (state?.ships ?? []).filter((s) => (s.cargo?.capacity ?? 0) >= 1);
          if (!ships.length) throw new Error("no ship with a cargo hold to install on");
          const shipSymbol = prompt("Install on which ship?", ships[0].symbol);
          if (!shipSymbol) return;
          await api("POST", "/api/fleet/buy-install", { shipSymbol, componentSymbol: b.dataset.comp, marketWaypoint: b.dataset.market });
          showToastGlobal(`Installed ${b.dataset.comp} on ${shipSymbol}`);
          await loadState();
          await loadIntel();
        } catch (err) { if (err.message !== "Prompt aborted") alert(err.message); b.disabled = false; }
      });
    });
  }
}







function showToastGlobal(message, isError = false) {
  let host = document.getElementById("global-toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "global-toast";
    host.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;pointer-events:none;";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = `
    margin-bottom:8px;padding:8px 12px;border-radius:4px;font-size:11px;
    background:${isError ? "rgba(255,107,107,0.18)" : "rgba(139,197,135,0.15)"};
    border:1px solid ${isError ? "var(--red-soft)" : "rgba(139,197,135,0.35)"};
    color:var(--bone);backdrop-filter:blur(4px);opacity:0;transition:opacity 0.2s ease;`;
  host.appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = "1");
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

function renderPriceChart(points, elId = "price-chart-room") {
  const el = $(elId);
  if (!el) return;
  // Gradient ids must be unique per chart or the second chart reuses the first's.
  const gradId = `parea-${elId}`;
  if (!points.length) { el.innerHTML = '<div class="empty">No price history for this good yet.</div>'; return; }
  // The viewBox now matches the container's real size instead of a fixed
  // 320×130 — previously the SVG kept its own hardcoded aspect ratio and
  // letterboxed (default preserveAspectRatio="xMidYMid meet"), leaving empty
  // space on either side of the chart on any container wider than 2.46:1.
  const W = Math.max(120, el.clientWidth || 320), H = Math.max(60, el.clientHeight || 130), P = 12;
  const vals = points.map((p) => Number(p.avg));
  const times = points.map((p) => new Date(p.t).getTime());
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => P + (i / (points.length - 1 || 1)) * (W - P * 2);
  const y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  const lastIdx = points.length - 1;
  let html = `<svg viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(240,71,154,0.35)"/>
      <stop offset="100%" stop-color="rgba(240,71,154,0.02)"/>
    </linearGradient></defs>
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="${P}" x2="${W - P}" y1="${y(min + span * f)}" y2="${y(min + span * f)}" stroke="rgba(148,163,178,0.12)" stroke-width="1"/>`).join("")}
    <path d="${area}" fill="url(#${gradId})"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(lastIdx)}" cy="${y(vals[lastIdx])}" r="2.5" fill="var(--accent)"/>
    <text x="${P}" y="${y(max)}" font-size="8" fill="var(--dim)">${Math.round(max)}</text>
    <text x="${P}" y="${y(min)}" font-size="8" fill="var(--dim)">${Math.round(min)}</text>
    <text x="${P}" y="${H - 2}" font-size="8" fill="var(--dim)">${new Date(times[0]).toLocaleTimeString("en-US", { hour12: false })}</text>
    <text x="${W - P}" y="${H - 2}" font-size="8" fill="var(--dim)" text-anchor="end">${new Date(times[lastIdx]).toLocaleTimeString("en-US", { hour12: false })}</text>
  </svg>`;
  el.innerHTML = html;
}




function addChatMsg(role, text) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  if (role === "assistant") {
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = "co-pilot";
    el.appendChild(t);
    const body = document.createElement("span");
    body.innerHTML = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    el.appendChild(body);
  } else {
    el.textContent = text;
  }
  $("chat-log").appendChild(el);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

async function sendChat() {
  const text = $("chat-input").value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  $("chat-send").disabled = true;
  $("chat-status").textContent = "co-pilot is thinking…";
  $("chat-status").className = "chat-status";
  addChatMsg("user", text);
  $("chat-input").value = "";
  try {
    const res = await api("POST", "/api/chat", { message: text });
    addChatMsg("assistant", res.reply ?? "…");
    $("chat-status").textContent = "";
  } catch (e) {
    $("chat-status").textContent = e.message;
    $("chat-status").className = "chat-status error";
  } finally {
    chatBusy = false;
    $("chat-send").disabled = false;
    $("chat-input").focus();
  }
}

/* ── boot ─────────────────────────────────── */
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString("en-US", { hour12: false }); }, 1000);

// Polling pauses when the tab is hidden — a backgrounded dashboard used to keep
// hammering the server (and, via the shipyard scan, the SpaceTraders rate limit).
// Below the breakpoint the tab-based views (and their currentView-gated
// polling) are hidden entirely in favor of the single mobile page — which
// needs its own data regardless of whatever currentView happens to hold,
// since there's no tab selection driving loadViewData() there.
const mobileMQ = window.matchMedia("(max-width:680px)");
const isMobile = () => mobileMQ.matches;
function loadMobilePanels() {
  loadMarkets(marketSystemFilter);
  loadDispatch();
  loadWarehouse();
  loadProgramme();
  loadDoctrine();
}
mobileMQ.addEventListener("change", (e) => { if (e.matches && authed) loadMobilePanels(); });

const timers = [];
const every = (ms, fn) => timers.push({ ms, fn, last: 0 });
every(5000, loadState);
every(5000, loadBridge);
every(3000, loadActivity);
every(20000, loadApprovals);
every(20000, () => { if (currentView === "markets") loadMarkets(marketSystemFilter); });
every(20000, () => { if (currentView === "tradeops") { loadDispatch(); loadKeepers(); loadWarehouse(); } });
every(20000, () => { if (currentView === "fleet") loadDispatch(); });
every(20000, () => { if (currentView === "ops") loadProgramme(); });
every(30000, () => { if (currentView === "bridge") loadNarrative(); });
every(15000, () => { if (isMobile()) loadMobilePanels(); });
// Ship-position interpolation used to redraw on a flat 1s timer here. That's
// now repositionShips()'s job (see its own comment), self-scheduled via
// requestAnimationFrame from the end of every renderMap() call instead of a
// fixed interval — smoother (every frame, not once a second) and cheaper
// (only touches transform attributes, never rebuilds the SVG).

setInterval(() => {
  if (document.hidden || !authed) return;
  const now = Date.now();
  for (const t of timers) if (now - t.last >= t.ms) { t.last = now; t.fn(); }
}, 1000);
// A backgrounded tab pauses every timer above; coming back should refresh
// whatever view is actually on screen, not just the always-on header data,
// so returning to a stale Markets/Ops/Doctrine tab doesn't need a manual reload.
let mapHiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { mapHiddenAt = Date.now(); return; }
  if (authed) {
    // rAF is throttled/paused while a tab is hidden, so repositionShips()
    // barely (or never) samples during that time. A long enough gap means
    // the first frame after returning would compare a fresh position
    // against a sample point from well before backgrounding — a real but
    // huge jump that then sits in the fixed-size trail buffer looking like
    // one giant streak until enough new (tiny, real-game-speed) samples
    // push it out, so it's worth clearing and starting fresh from "now".
    // But a brief blur (alt-tabbing for a second, clicking another window)
    // doesn't need that: clearing unconditionally on every visibilitychange
    // wiped a perfectly good trail for those too, forcing it to visibly
    // rebuild from nothing while the ship — animated every frame regardless
    // — kept moving, so the trail looked like it was "snapping" to catch up.
    if (mapHiddenAt !== null && Date.now() - mapHiddenAt >= 2000) {
      liveTrails.clear();
      lastTrailSamplePos.clear();
      for (const obj of liveTrailObjects.values()) disposeTrailGroup(obj);
      liveTrailGroup?.clear();
      liveTrailObjects.clear();
    }
    mapHiddenAt = null;
    loadState();
    loadBridge();
    if (isMobile()) loadMobilePanels();
    else loadViewData(currentView);
  }
});

$("price-refresh").addEventListener("click", () => loadPrices(priceGood));
// Read the dropdown's own new value, not the stale closed-over priceGood —
// this listener previously called loadPrices(priceGood) with whatever
// priceGood already was, so picking a different material fetched the same
// good as before and the very next "prices" poll then reset the visible
// selection back to it (renderPriceGoods() recomputes `chosen` from
// priceGood, never from what was actually just clicked). The dropdown
// looked like it "wouldn't let you switch" because nothing ever recorded
// that a switch had happened.
$("price-good").addEventListener("change", (e) => { priceGood = e.target.value; loadPrices(priceGood); });

$("routes-system-filter").addEventListener("change", onMarketSystemFilterChange);
$("snapshots-system-filter").addEventListener("change", onMarketSystemFilterChange);
$("yards-system-filter").addEventListener("change", onMarketSystemFilterChange);

// Dispatch controls: assign a good to a trader, or clear to auto. Shared
// between the desktop toolbar and the mobile page's copy of the same form.
async function dispatchAssign(shipSelId, goodSelId) {
  const ship = $(shipSelId).value;
  const good = $(goodSelId).value;
  if (!ship || !good) return;
  const route = dispatchRoutes.find((r) => r.good === good);
  try {
    await api("POST", "/api/dispatch", {
      shipSymbol: ship, good,
      buyAt: route?.buyAt, sellAt: route?.sellAt,
      buyPrice: route?.buyPrice, sellPrice: route?.sellPrice,
      profitPerTrip: route?.profitPerTrip,
    });
    await loadDispatch();
    showToastGlobal(`Assigned ${good} to ${ship}`);
  } catch (err) { showToastGlobal(err.message, true); }
}
async function dispatchClear(shipSelId) {
  const ship = $(shipSelId).value;
  if (!ship) return;
  try {
    await api("POST", "/api/dispatch", { shipSymbol: ship, clear: true });
    await loadDispatch();
    showToastGlobal(`Auto-assign for ${ship} restored`);
  } catch (err) { showToastGlobal(err.message, true); }
}
$("dispatch-assign").addEventListener("click", () => dispatchAssign("dispatch-ship", "dispatch-good"));
$("dispatch-clear").addEventListener("click", () => dispatchClear("dispatch-ship"));
$("mobile-dispatch-assign").addEventListener("click", () => dispatchAssign("mobile-dispatch-ship", "mobile-dispatch-good"));
$("mobile-dispatch-clear").addEventListener("click", () => dispatchClear("mobile-dispatch-ship"));
$("keeper-save").addEventListener("click", saveKeepers);
$("keeper-cover").addEventListener("click", async () => {
  const next = !keeperCoverList;
  try {
    const res = await api("POST", "/api/keeper/markets", { coverList: next });
    keeperCoverList = res.coverList === true;
    $("keeper-cover").setAttribute("aria-pressed", String(keeperCoverList));
    showToastGlobal(keeperCoverList ? "Covering the full list" : "Keeper count cap respected");
    await loadKeepers();
  } catch (err) { showToastGlobal(err.message, true); }
});
$("keeper-reset").addEventListener("click", async () => {
  try {
    const res = await api("POST", "/api/keeper/markets", { reset: true });
    showToastGlobal(`Keeper list reset to ${res.markets?.length ?? 0} defaults`);
    await loadKeepers();
  } catch (err) { showToastGlobal(err.message, true); }
});

// Warehouse controls: designate/release the parked ship, and manually adjust
// bookkeeping. Shared between the desktop toolbar and the mobile page.
async function warehouseDesignate(shipSelId, waypointInputId) {
  const shipSymbol = $(shipSelId).value;
  const waypointSymbol = $(waypointInputId).value.trim();
  if (!shipSymbol || !waypointSymbol) return;
  try {
    await api("POST", "/api/warehouse/designate", { shipSymbol, waypointSymbol });
    await loadWarehouse();
    showToastGlobal(`${shipSymbol} designated warehouse ship at ${waypointSymbol}`);
  } catch (err) { showToastGlobal(err.message, true); }
}
async function warehouseRelease() {
  try {
    await api("POST", "/api/warehouse/release");
    await loadWarehouse();
    showToastGlobal("Warehouse ship released");
  } catch (err) { showToastGlobal(err.message, true); }
}
async function warehouseAdjust(goodSelId, unitsInputId, priceInputId, directionSelId) {
  const good = $(goodSelId).value;
  const units = Number($(unitsInputId).value);
  const price = Number($(priceInputId).value) || 0;
  const direction = $(directionSelId).value;
  if (!good || !units || units <= 0) return;
  try {
    await api("POST", "/api/warehouse/adjust", { good, units, direction, price });
    await loadWarehouse();
    showToastGlobal(`${direction === "deposit" ? "Deposited" : "Withdrew"} ${units}u ${good}`);
  } catch (err) { showToastGlobal(err.message, true); }
}
$("warehouse-designate").addEventListener("click", () => warehouseDesignate("warehouse-ship", "warehouse-waypoint"));
$("warehouse-release").addEventListener("click", warehouseRelease);
$("warehouse-adjust").addEventListener("click", () => warehouseAdjust("warehouse-good", "warehouse-units", "warehouse-price", "warehouse-direction"));
$("mobile-warehouse-designate").addEventListener("click", () => warehouseDesignate("mobile-warehouse-ship", "mobile-warehouse-waypoint"));
$("mobile-warehouse-release").addEventListener("click", warehouseRelease);
$("mobile-warehouse-adjust").addEventListener("click", () => warehouseAdjust("mobile-warehouse-good", "mobile-warehouse-units", "mobile-warehouse-price", "mobile-warehouse-direction"));

// Curated warehouse target list: which goods the warehouse buys/sells, and
// whether a good is only bought on demand for an active mission.
async function warehouseTargetAdd(goodInputId, unitsInputId, missionCheckboxId) {
  const good = $(goodInputId).value.trim().toUpperCase();
  const target = Number($(unitsInputId).value);
  const forMission = $(missionCheckboxId).checked;
  if (!good || !target || target <= 0) return;
  try {
    await api("POST", "/api/warehouse/targets", { good, target, forMission });
    $(goodInputId).value = "";
    $(unitsInputId).value = "";
    $(missionCheckboxId).checked = false;
    await loadWarehouse();
    showToastGlobal(`${good} added to warehouse targets`);
  } catch (err) { showToastGlobal(err.message, true); }
}
async function warehouseTargetRemove(good) {
  try {
    await api("POST", "/api/warehouse/targets/remove", { good });
    await loadWarehouse();
    showToastGlobal(`${good} removed from warehouse targets`);
  } catch (err) { showToastGlobal(err.message, true); }
}
$("warehouse-target-add").addEventListener("click", () => warehouseTargetAdd("warehouse-target-good", "warehouse-target-units", "warehouse-target-mission"));
$("mobile-warehouse-target-add").addEventListener("click", () => warehouseTargetAdd("mobile-warehouse-target-good", "mobile-warehouse-target-units", "mobile-warehouse-target-mission"));
for (const id of ["warehouse-targets", "mobile-warehouse-targets"]) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-remove-good]");
    if (btn) warehouseTargetRemove(btn.dataset.removeGood);
  });
}

function renderLeaderboard(agents) {
  const el = $("leaderboard-table");
  if (!el) return;
  if (!agents.length) { el.innerHTML = '<tbody><tr><td class="empty">No leaderboard data yet.</td></tr></tbody>'; return; }
  const mySymbol = state?.agent?.symbol;
  el.innerHTML = `
    <thead><tr><th class="num">Rank</th><th>Agent</th><th class="num">Credits</th></tr></thead>
    <tbody>${agents.map((a, i) => `
      <tr class="${a.agentSymbol === mySymbol ? "sel" : ""}">
        <td class="num">${i + 1}</td>
        <td><span class="sym">${escapeHtml(a.agentSymbol)}</span>${a.agentSymbol === mySymbol ? ' <span style="color:var(--accent)">· you</span>' : ""}</td>
        <td class="num">${fmt(a.credits)}c</td>
      </tr>`).join("")}</tbody>`;
}

function renderFactions(factions) {
  const el = $("factions-list");
  const countEl = $("factions-count");
  if (!el) return;
  if (countEl) countEl.textContent = `${factions.length} factions`;
  if (!factions.length) { el.innerHTML = '<div class="empty">No faction data yet.</div>'; return; }
  el.innerHTML = `<div class="loadout-grid">${factions.map((f) => `
    <div class="loadout-item" style="flex-direction:column;align-items:flex-start;gap:2px">
      <span class="n">${escapeHtml(f.name)} <span style="color:var(--dim)">(${escapeHtml(f.symbol)})</span>${f.isRecruiting ? ' <span style="color:var(--green)">· recruiting</span>' : ""}</span>
      <span class="d" style="white-space:normal">${escapeHtml(f.description)}</span>
      <span class="d">${(f.traits ?? []).map((t) => escapeHtml(t.name)).join(", ")}</span>
    </div>`).join("")}</div>`;
}



function renderContracts(list) {
  const countTxt = `${list.length} active`;
  for (const id of ["contract-count", "mobile-contract-count"]) { const el = $(id); if (el) el.textContent = countTxt; }
  // Same cargo-capable-trader candidate list the mission carrier dropdown
  // uses — a contract-buy assignment needs a hold, and traders are the only
  // role the dispatcher's contractBuy route ever hands a good to.
  const traderCandidates = (fleetStatus.ships ?? []).filter((s) => s.role === "trader");
  const html = !list.length ? '<div class="empty">No contracts available.</div>' : list.map((c) => {
    const total = c.onAccepted + c.onFulfilled;
    const accDead = new Date(c.deadlineToAccept ?? c.deadline).getTime();
    const urgent = accDead > 0 && accDead - Date.now() < 3600000;
    const deliverables = (c.deliver ?? []).map((d) => {
      const pct = d.unitsRequired ? Math.round((d.unitsFulfilled / d.unitsRequired) * 100) : 0;
      const done = d.unitsFulfilled >= d.unitsRequired;
      // A manual contractBuy override for this good, if the operator has
      // pinned one — same mechanism dispatchAssignments already tracks for
      // the trade-ops "direct" routes, just filtered to this role/good.
      const pinned = dispatchAssignments.find((a) => a.role === "contractBuy" && a.good === d.tradeSymbol && a.source === "manual");
      const assignRow = c.accepted && !done ? `<div class="ops-head" style="margin-top:2px">
        <select class="assign-contract-carrier" data-good="${escapeAttr(d.tradeSymbol)}" aria-label="Carrier ship for ${escapeAttr(d.tradeSymbol)}">
          <option value="">${pinned ? "reassign to…" : "choose a ship…"}</option>
          ${traderCandidates.map((s) => `<option value="${escapeAttr(s.symbol)}" ${s.symbol === pinned?.shipSymbol ? "selected" : ""}>${escapeHtml(shortWp(s.symbol))}</option>`).join("")}
        </select>
        <button class="btn" data-act="assign-carrier" data-good="${escapeAttr(d.tradeSymbol)}">Assign</button>
        ${pinned ? `<span class="ops-sub">pinned: ${escapeHtml(pinned.shipSymbol)}</span><button class="btn" data-act="clear-carrier" data-ship="${escapeAttr(pinned.shipSymbol)}">Clear</button>` : ""}
      </div>` : "";
      return `<div class="ops-row">
        <span class="ops-title">${escapeHtml(d.tradeSymbol)}</span>
        <span class="ops-sub">→ ${escapeHtml(shortWp(d.destinationSymbol))}</span>
        <span class="fill"></span>
        <span class="ops-sub">${d.unitsFulfilled}/${d.unitsRequired}</span>
        <span>${pct}%</span>
      </div><div class="prog"><i style="width:${pct}%"></i></div>${assignRow}`;
    }).join("");
    const deliv = c.deliver?.length ? deliverables : '<div class="ops-row"><span class="ops-sub">No deliveries listed</span></div>';
    return `<div class="ops-card">
      <div class="ops-head">
        <span class="ops-title">${escapeHtml(c.type)} · ${escapeHtml(c.factionSymbol)}</span>
        <span class="tag ${c.accepted ? "accepted" : ""}">${c.accepted ? "accepted" : "offered"}</span>
        ${c.declined ? '<span class="tag declined">declined</span>' : ""}
        ${c.abandoned ? '<span class="tag declined">not being worked</span>' : ""}
        <span class="fill"></span>
        <span class="ops-sub">+${fmt(c.onAccepted)} / +${fmt(c.onFulfilled)} · ${fmt(total)} total</span>
      </div>
      ${deliv}
      <div class="ops-head" style="margin-top:6px">
        <span class="ops-dead ${urgent && !c.accepted ? "urgent" : ""}">accept by ${countdown(c.deadlineToAccept ?? c.deadline)}</span>
        <span class="fill"></span>
        ${c.accepted
          ? `<span class="ops-sub">deadline ${countdown(c.deadline)}</span>
             ${c.abandoned
               ? `<button class="btn" data-act="resume" data-id="${escapeAttr(c.id)}">Resume work</button>`
               : `<button class="btn" data-act="abandon" data-id="${escapeAttr(c.id)}">Stop working</button>`}`
          : c.declined
            ? `<button class="btn" data-act="undecline" data-id="${escapeAttr(c.id)}">Allow</button>
               <button class="btn pri" data-act="accept" data-id="${escapeAttr(c.id)}">Accept</button>`
            : `<button class="btn" data-act="decline" data-id="${escapeAttr(c.id)}">Decline</button>
               <button class="btn pri" data-act="accept" data-id="${escapeAttr(c.id)}">Accept</button>`}
      </div>
    </div>`;
  }).join("");
  for (const id of ["contracts", "mobile-contracts"]) { const el = $(id); if (el) el.innerHTML = html; }
}

function renderMissions(list) {
  const active = (list ?? []).filter((m) => m.status === "active");
  if (!active.length) {
    const empty = '<div class="empty">No construction missions. Enter a construction waypoint and Start (e.g. the gate X1-BY69-I59).</div>';
    for (const id of ["missions", "mobile-missions"]) { const el = $(id); if (el) el.innerHTML = empty; }
    return;
  }

  // Cargo-capable ships the operator could hand a mission to. A ship already
  // carrying a DIFFERENT mission is excluded — picking it here would strand
  // that other mission's supply run.
  const committedElsewhere = new Set(active.filter((m) => m.assignedShip).map((m) => m.assignedShip));
  const carrierCandidates = (fleetStatus.ships ?? []).filter((s) =>
    (s.role === "miner" || s.role === "trader") && !committedElsewhere.has(s.symbol)
  );

  const html = active.map((m) => {
    const mats = (m.materials ?? []).map((mat) => {
      const pct = mat.required ? Math.round((mat.fulfilled / mat.required) * 100) : 0;
      const done = mat.fulfilled >= mat.required;
      return `<div class="ops-row">
        <span class="ops-title">${escapeHtml(mat.tradeSymbol)}</span>
        <span class="fill"></span>
        <span class="tag ${done ? "done" : ""}">${done ? "supplied" : `${mat.fulfilled}/${mat.required} (${pct}%)`}</span>
      </div><div class="prog"><i style="width:${pct}%"></i></div>`;
    }).join("");
    const allDone = (m.materials ?? []).every((mat) => mat.fulfilled >= mat.required);
    // This mission's own carrier is always selectable even though it's
    // "committed elsewhere" nowhere else — plus every other free candidate.
    const options = carrierCandidates
      .concat(m.assignedShip && !carrierCandidates.some((c) => c.symbol === m.assignedShip) ? [{ symbol: m.assignedShip }] : [])
      .map((s) => `<option value="${escapeAttr(s.symbol)}" ${s.symbol === m.assignedShip ? "selected" : ""}>${escapeHtml(shortWp(s.symbol))}</option>`)
      .join("");
    return `<div class="ops-card">
      <div class="ops-head">
        <span class="ops-title">${escapeHtml(m.targetWaypoint)}</span>
        ${m.paused ? '<span class="tag paused">paused</span>' : `<span class="tag ${allDone ? "done" : ""}">${allDone ? "complete" : "supplying"}</span>`}
        <span class="fill"></span>
        <span class="ops-sub">${m.assignedShip ? `carrier ${escapeHtml(m.assignedShip)}` : "no carrier yet"}</span>
      </div>
      ${mats}
      <div class="ops-head" style="margin-top:6px">
        <select class="assign-carrier" data-wp="${escapeAttr(m.targetWaypoint)}" aria-label="Carrier ship">
          <option value="">${m.assignedShip ? "reassign to…" : "choose a ship…"}</option>
          ${options}
        </select>
        <button class="btn" data-act="assign" data-wp="${escapeAttr(m.targetWaypoint)}">Assign</button>
        <span class="fill"></span>
        ${m.paused
          ? `<button class="btn pri" data-act="resume" data-wp="${escapeAttr(m.targetWaypoint)}">Resume</button>`
          : `<button class="btn" data-act="pause" data-wp="${escapeAttr(m.targetWaypoint)}">Pause</button>`}
      </div>
    </div>`;
  }).join("");
  for (const id of ["missions", "mobile-missions"]) { const el = $(id); if (el) el.innerHTML = html; }
}

async function missionStart(waypointInputId) {
  const wp = $(waypointInputId).value.trim();
  if (!wp) { showToastGlobal("Enter a construction waypoint first", true); return; }
  try {
    await api("POST", "/api/missions/start", { waypoint: wp });
    showToastGlobal(`Mission started for ${wp}`);
    loadProgramme();
  } catch (err) { showToastGlobal(err.message, true); }
}
$("mission-start").addEventListener("click", () => missionStart("mission-waypoint"));
$("mobile-mission-start").addEventListener("click", () => missionStart("mobile-mission-waypoint"));

async function onContractClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id, good, ship } = btn.dataset;
  try {
    if (act === "assign-carrier") {
      const select = btn.closest(".ops-head").querySelector(".assign-contract-carrier");
      const shipSymbol = select?.value;
      if (!shipSymbol) { showToastGlobal("Pick a ship first", true); return; }
      await api("POST", "/api/contracts/assign", { shipSymbol, tradeSymbol: good });
      showToastGlobal(`${shipSymbol} assigned to buy ${good}`);
    } else if (act === "clear-carrier") {
      await api("POST", "/api/contracts/assign", { shipSymbol: ship, clear: true });
      showToastGlobal(`${ship} manual assignment cleared`);
    } else if (act === "accept" || act === "decline" || act === "undecline") {
      const path = act === "accept" ? "/api/contracts/accept" : act === "decline" ? "/api/contracts/decline" : "/api/contracts/undecline";
      await api("POST", path, { contractId: id });
      showToastGlobal(`Contract ${act === "accept" ? "accepted" : act === "decline" ? "declined" : "allowed again"}`);
    } else if (act === "abandon") {
      // Deliberately not called "cancel". The SpaceTraders API has accept,
      // deliver, fulfil and negotiate — and no cancel — so the honest promise
      // is that the fleet stops working it, and the operator is told the rest
      // rather than finding out at the deadline.
      if (!confirm("Stop working this contract?\n\nThe fleet will stop buying for it and release any ship assigned to it.\n\nIt cannot be handed back — there is no cancel in the API. The contract stays accepted and will lapse at its deadline, which costs reputation.")) return;
      const res = await api("POST", "/api/contracts/abandon", { contractId: id });
      const freed = res?.released ?? [];
      showToastGlobal(freed.length ? `Stopped. Released ${freed.join(", ")}` : "Stopped working this contract");
    } else if (act === "resume") {
      await api("POST", "/api/contracts/resume", { contractId: id });
      showToastGlobal("Back in work");
    } else {
      return;
    }
    loadProgramme();
  } catch (err) { showToastGlobal(err.message, true); }
}
$("contracts").addEventListener("click", onContractClick);
$("mobile-contracts").addEventListener("click", onContractClick);

async function onMissionClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, wp } = btn.dataset;
  try {
    if (act === "assign") {
      const select = btn.closest(".ops-head").querySelector(".assign-carrier");
      const shipSymbol = select?.value;
      if (!shipSymbol) { showToastGlobal("Pick a ship first", true); return; }
      await api("POST", "/api/missions/assign", { waypoint: wp, shipSymbol });
      showToastGlobal(`${shipSymbol} assigned to ${wp}`);
    } else {
      await api("POST", `/api/missions/${act}`, { waypoint: wp });
      showToastGlobal(`Mission ${act === "pause" ? "paused" : "resumed"}`);
    }
    loadProgramme();
  } catch (err) { showToastGlobal(err.message, true); }
}
$("missions").addEventListener("click", onMissionClick);
$("mobile-missions").addEventListener("click", onMissionClick);

initViewSwitch();
initModeToggle();
initGalaxyToggle();
initMapInteractions();
initCopilot();
initMobileTabbar();

$("auth-form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  const token = $("auth-token").value.trim();
  if (!token) return;
  $("auth-submit").disabled = true;
  $("auth-err").textContent = "";
  tryLogin(token).finally(() => { $("auth-submit").disabled = false; });
});

$("auth-form-register").addEventListener("submit", (e) => {
  e.preventDefault();
  const agentSymbol = $("reg-symbol").value.trim();
  const faction = $("reg-faction").value.trim() || "COSMIC";
  const accountToken = $("reg-token").value.trim();
  if (!agentSymbol || !accountToken) return;
  $("reg-submit").disabled = true;
  $("reg-err").textContent = "";
  tryRegister(agentSymbol, faction, accountToken).finally(() => { $("reg-submit").disabled = false; });
});

$("auth-show-register").addEventListener("click", () => { $("auth-err").textContent = ""; showRegisterForm(); });
$("auth-show-login").addEventListener("click", () => { $("reg-err").textContent = ""; showLoginForm(); });
$("logout-btn").addEventListener("click", logout);
$("onboard-confirm").addEventListener("click", confirmOnboarding);
$("onboard-retry").addEventListener("click", showOnboarding);

/** First data load once a token is accepted — everything up to here only
 *  wired up event listeners, none of which touch the network. */
function boot() {
  // Tiered rather than firing all seven-plus loads at once: everything here
  // used to start in parallel regardless of whether it was on screen yet,
  // competing for the same handful of browser connections (and, right after
  // a restart or during a SpaceTraders hiccup, retrying tenant boot on every
  // single one of them independently — see tenantRegistry.ts's boot-retry
  // cooldown). Split into tiers by what's actually visible when Bridge
  // first paints, each waiting for the previous to land instead of racing it.
  //
  // Tier 1 — on screen instantly: the ship register (feeds the map + Lanes
  // via loadMarkets) and triage/earnings.
  const tier1 = Promise.all([
    loadState().then(() => { loadMarkets(marketSystemFilter); renderMapLiveOrScrub(); }),
    loadBridge(),
  ]);
  // Tier 2 — also on Bridge, but secondary: the ticker and the Captain's Log.
  const tier2 = tier1.then(() => Promise.all([loadActivity(), loadNarrative()]));
  // Tier 3 — nothing here is visible until the operator leaves Bridge (Ops
  // tab) or opens the scrubber; genuinely fine to trail behind Tier 1/2.
  tier2.then(() => {
    loadDoctrine();
    loadProgramme();
    loadReplay();
    // Previously only fetched on the Galaxy view toggle — but the tour-
    // dispatch system dropdown in a ship's detail panel needs this same
    // charted-systems list, and that panel can open long before the
    // operator ever visits Galaxy view. Trailing Tier 2 like everything
    // else here keeps it off the critical path while still being ready
    // by the time a ship detail panel is likely to open.
    loadGalaxyOverview();
    if (isMobile()) { loadDispatch(); loadWarehouse(); }
  });
  initScrubber();
  initInspectorCrumb();
  // Populate Book's sheet once up front regardless of starting mode — it's
  // also where Discord webhook config now lives, and that must be reachable
  // (its inputs need to exist in the DOM) even for an operator who never
  // switches to Book mode on their own.
  renderBook();
  // Initialize field/book mode for bridge view
  setTimeout(() => {
    const view = $("views").querySelector(".view.on[data-view='bridge']");
    if (view) setFieldBookMode(fieldBookMode);
  }, 0);
}

function initScrubber() {
  $("scrub-play")?.addEventListener("click", scrubTogglePlay);
  $("scrub-speed")?.addEventListener("click", scrubCycleSpeed);
  $("scrub-live")?.addEventListener("click", scrubGoLive);
  $("scrub-track")?.addEventListener("click", (e) => scrubSeek(e.clientX));
}

// Position history keeps growing as the fleet runs — refresh the window
// periodically so the scrubber's "live" end and sparkline stay current.
every(60_000, () => { if (currentView === "bridge") loadReplay(); });

// ── Hue rotation ───────────────────────────────────────────────────
(function initHuePicker() {
  const HUES = [355, 293, 207, 61];
  const STORAGE_KEY = "so-accent-hue";

  function setHue(hue) {
    document.documentElement.style.setProperty("--accent-hue", hue);
    localStorage.setItem(STORAGE_KEY, String(hue));
    updateHueButtonStates(hue);
  }

  function updateHueButtonStates(hue) {
    for (const btn of document.querySelectorAll(".hue-btn")) {
      const btnHue = Number(btn.dataset.hue);
      btn.classList.toggle("active", btnHue === hue);
    }
  }

  // Load saved hue or default to Rubine
  const saved = localStorage.getItem(STORAGE_KEY);
  const initialHue = saved && HUES.includes(Number(saved)) ? Number(saved) : 355;
  setHue(initialHue);

  // Wire up hue picker buttons
  for (const btn of document.querySelectorAll(".hue-btn")) {
    btn.addEventListener("click", () => setHue(Number(btn.dataset.hue)));
  }
})();

// ── Field / Book mode ──────────────────────────────────────────────
let fieldBookMode = localStorage.getItem("field-book-mode") || "field";

function setFieldBookMode(mode) {
  fieldBookMode = mode;
  localStorage.setItem("field-book-mode", mode);
  const stage = $("field-stage");
  if (stage) stage.classList.toggle("book-mode", mode === "book");
  const toggle = $("field-book-toggle");
  if (toggle) {
    toggle.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
  }
  if (mode === "book") renderBook();
}

/** Always visible in the header — same reasoning as the view switcher and
 *  hue picker beside it: a control that only sometimes exists makes the
 *  header itself feel inconsistent between pages. Bridge is the only view it
 *  actually applies to, so clicking it from elsewhere jumps to Bridge first. */
function updateFieldBookToggleVisibility() {
  const view = $("views").querySelector(".view.on");
  if (view?.dataset.view === "bridge") setFieldBookMode(fieldBookMode);
}

// Wire up field/book toggle buttons
const fbToggle = $("field-book-toggle");
if (fbToggle) {
  fbToggle.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (currentView !== "bridge") setView("bridge");
      setFieldBookMode(b.dataset.mode);
    });
  });
}

// Override view switching to update field/book visibility
const viewSwitchOrig = document.querySelector("#view-switch");
if (viewSwitchOrig) {
  viewSwitchOrig.addEventListener("click", (e) => {
    setTimeout(updateFieldBookToggleVisibility, 0);
  });
}

// ESC always returns to the field, matching the book mode hint.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fieldBookMode === "book" && currentView === "bridge") setFieldBookMode("field");
});

// The bug this fixes: the toggle started display:none and only became
// visible on a *later* view-switch click — never on initial page load,
// where bridge is already the default "on" view. Call it once at boot too.
updateFieldBookToggleVisibility();

// Which of the three screens does this load render? Sign-in gate,
// onboarding, or the dashboard — decided from observed state, every time.
async function boot0() {
  // One gate call decides the screen. It answers "is this cookie live" like
  // the old /api/state probe did, and also "does this tenant still owe us
  // onboarding" — which /api/state cannot answer, and which a page load has
  // to ask every time. Before this, onboarding was shown on exactly one
  // edge (the login response's isNewTenant) and skipped forever after: a
  // refresh, a re-login, or a failed catalog fetch all landed on the
  // dashboard with tenants.onboarding_pending still true, which is what
  // re-paused the fleet on every single boot thereafter.
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  if (session.onboardingPending) return showOnboarding();
  hideAuthGate();
  boot();
}
// Before anything else: a remembered choice or an explicit ?ui= may mean
// this document is not the one to render at all.
if (!applyVersionPreference()) mountSwitcher();

/* ── store subscriptions ──────────────────────────────────────
   Each loader used to end by calling the renderers its data fed. Those
   calls live here now: the store announces which slice changed, and this
   version maps slices to its own rendering. The mapping below reproduces
   what each loader called, in the order it called them.

   The currentSystem reconciliation was inside loadState(); it is view
   state (which system this window is looking at), so it belongs on this
   side of the seam. */
/* ── the store's view-specific slices ─────────────────────────
   The loaders these replace used to end by touching the DOM directly —
   loadNarrative() wrote to an element, loadGoods() built a <select>. That
   is exactly what could not be shared, since the element ids and the
   markup are this version's, not the store's. Split in two: the store
   fetches and announces, and these draw. */

/** The price chart's good picker. */
function renderPriceGoods() {
  const sel = $("price-good");
  if (!sel || !priceGoods.length) return;
  // Every "prices" notification rebuilt this <select> from scratch
  // unconditionally, even when the good list hadn't changed at all — this
  // fires on a 20s poll while Markets is open, so a native dropdown
  // mid-interaction (opened, being scrolled) got yanked shut and reset
  // every cycle. Guarded the same way renderMarketSystemFilter() already
  // guards its own dropdown: skip the DOM write entirely when nothing
  // actually changed, and never touch it while it currently has focus —
  // an open dropdown is exactly the moment a "nothing changed" rebuild is
  // most disruptive, since even writing identical innerHTML can force it
  // closed in some browsers.
  if (document.activeElement === sel) return;
  const chosen = priceGoods.includes(priceGood) ? priceGood : priceGoods[0];
  const opts = priceGoods.map((g) =>
    `<option value="${escapeAttr(g)}"${g === chosen ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
  // Only fetch when the selection actually moved. Without the guard this
  // re-enters through the "prices" slice that loadPrices() itself notifies.
  if (chosen !== priceGood) { priceGood = chosen; loadPrices(priceGood); }
}

function renderNarrative() {
  const el = $("narrative");
  if (!el) return;
  el.textContent = narrative || "Awaiting telemetry…";
  // Which voice wrote this is worth knowing but not worth a line of the
  // pane, so it lives in the tooltip — except a failure, which is the one
  // case a tenant has to be told about, since the fallback is otherwise
  // indistinguishable from the feature working.
  const { source, model, error } = narrativeMeta;
  el.title = error
    ? `LLM log failed (${error}) — showing the templated log`
    : source === "llm" ? `Written by ${model ?? "your model"}` : "Templated log — set an LLM key in the Book to have yours written";
  el.classList.toggle("fallback", !!error);
  const warn = $("narrative-warn");
  if (warn) {
    warn.textContent = error ? `Captain's log fell back to the template — ${error}` : "";
    warn.hidden = !error;
  }
}

function renderChatHistory() {
  const log = $("chat-log");
  if (!log || !chatHistory.length) return;
  log.innerHTML = "";
  for (const m of chatHistory) addChatMsg(m.role, m.content);
}

subscribe("dispatch", () => { renderDispatch(); renderFleetTable(); renderMobileFleet(); renderMobileFleetStrip(); });
subscribe("warehouse", renderWarehouse);
subscribe("keepers", renderKeepers);
subscribe("replay", renderScrubTrack);
subscribe("prices", () => {
  renderPriceGoods();
  if (pricePoints.length) renderPriceChart(pricePoints, "price-chart");
});
subscribe("programme", () => { renderContracts(contracts); renderMissions(missions); });
subscribe("approvals", () => { renderApprovalsBanner(); renderApprovals(); });
subscribe("galaxy", () => { renderLeaderboard(leaderboard); renderFactions(factions); });
subscribe("narrative", renderNarrative);
subscribe("chat", renderChatHistory);
subscribe("connection", renderConnectionStatus);

/** The activity rail's collapsible sections.
 *
 *  These were <details>/<summary> and are now plain elements with an
 *  explicit open class, because from Chrome 131 a <details> wraps its
 *  content in a ::details-content anonymous box. That box becomes the flex
 *  item in the section's column, so .rail-b's `flex:1; min-height:0;
 *  overflow-y:auto` no longer constrained anything against the section's
 *  height — a long lane list stopped scrolling and painted over the watch
 *  below it instead. Six lines of JS buys a box tree that cannot change
 *  under us with a browser release. */
function initRailSections() {
  for (const btn of document.querySelectorAll(".rail-sec > .rail-h")) {
    btn.addEventListener("click", () => {
      const sec = btn.parentElement;
      const open = !sec.classList.contains("open");
      sec.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  }
}
initRailSections();

subscribe("state", () => {
  if (!currentSystem && state.systemSymbol) currentSystem = state.systemSymbol;
  if (systems.length && !systems.find((s) => s.symbol === currentSystem)) currentSystem = state.systemSymbol || systems[0].symbol;
  renderTopbar();
  renderSystemStrip();
  renderFleetTable();
  renderMobileFleet();
  renderMobileFleetStrip();
  if (currentView === "bridge") renderMapLiveOrScrub();
});
subscribe("bridge", () => {
  renderTopbar();
  renderStrandedBanner();
  renderTriage();
  renderFleetTable();
  renderMobileFleet();
  renderMobileFleetStrip();
  renderMobileHero();
  renderFleetSummary();
  // The sheet an operator actually acts from — held/released, role, repair —
  // was the one panel missing from this list. See refreshOpenShipDetails().
  refreshOpenShipDetails();
});
subscribe("activity", () => {
  renderMobileActivity();
  renderShiftLog();
});
subscribe("markets", () => {
  renderMarketSystemFilter();
  renderRoutes();
  renderSnapshots();
  renderShipyardIntel();
  renderLanes();
});
subscribe("doctrine", () => {
  renderMobileDoctrine();
  if (fieldBookMode === "book" && currentView === "bridge") renderBook();
});

boot0();

