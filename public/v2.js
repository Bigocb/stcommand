import {
  worstConditionPct,
  shipHeadingDeg,
  shipTransitLerp,
  systemOf,
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
import { api, nativeFetch, onUnauthorized } from "/shared/api.js";
import {
  state, systems, jumpConnections, bridge, fleetStatus, activity,
  marketSnapshots, marketRoutes, marketSystems, tradeRoutes, intel,
  doctrineRules, doctrineCatalog, doctrineFires, doctrineFireShips,
  loadState, loadBridge, loadActivity, loadMarkets, loadDoctrine,
  loadDoctrineFires, loadDoctrineFireShips, setDoctrine, subscribe,
  dispatchRoutes, dispatchAssignments, warehouseState, keeperMarketsCfg, keeperStationsCfg, keeperCoverList,
  replayByShip, replayT0, replayT1, priceGoods, pricePoints, contracts,
  missions, leaderboard, factions, narrative, chatHistory,
  loadDispatch, loadWarehouse, loadKeepers, loadReplay, loadGoods,
  loadPrices, loadProgramme, loadGalaxy, loadNarrative, loadChatHistory,
} from "/shared/store.js";
import {
  login, register as registerAgent, logout as endSession,
  fetchOnboardingCatalog, completeOnboarding,
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
    const { isNewTenant } = await login(token);
    if (isNewTenant) showOnboarding();
    else { hideAuthGate(); boot(); }
  } catch (err) {
    $("auth-err").textContent = err.message || "Could not reach the server.";
  }
}

/** Register a brand-new SpaceTraders agent, then sign in as it. */
async function tryRegister(agentSymbol, faction, accountToken) {
  try {
    const { isNewTenant } = await registerAgent(agentSymbol, faction, accountToken);
    if (isNewTenant) showOnboarding();
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
  try {
    renderOnboarding(await fetchOnboardingCatalog());
  } catch (_) {
    $("onboard-list").innerHTML = "";
    $("onboard-err").textContent = "Could not load standing orders — the fleet may still be starting up. Try refreshing in a few seconds.";
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
/* Map view state and caches used by the preserved chart renderer. */
// Ship/waypoint cluster ring-offsets (renderMap()'s shipsByCoord/byCoord
// grouping) are computed in pre-scale coordinate space and grow with
// mapZoom, so a denser cluster genuinely does keep separating as this
// ceiling is raised — confirmed on a live 15-ship fleet where the old cap
// of 8 still left a busy hub (several ships + several close waypoints)
// overlapping even at max zoom, with no further room to separate them.
const MAX_MAP_ZOOM = 24;
let mapZoom = 1, mapPanX = 0, mapPanY = 0, dragState = null;
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
  else {
    // Defense in depth alongside the drawer's own positioning fix: never
    // leave it open while looking at a different view.
    $("shift-log-drawer")?.classList.remove("open");
    $("ticker-expand")?.setAttribute("aria-expanded", "false");
  }
}

function loadViewData(name) {
  // Fleet needs no fetch of its own — fleetRows() reads state/bridge/
  // fleetStatus, already kept current by the 5s polling loop — just render
  // what's already there on entry.
  if (name === "fleet") renderFleetTable();
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
  for (const id of ["routes-system-filter", "snapshots-system-filter"]) {
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
  if (!doctrineRules.length) await loadDoctrine();
  await loadDoctrineFireShips();

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
  const title = $("rail-left-title");
  if (title) title.textContent = "Triage";
  const items = bridge.triage ?? [];
  const n = $("rail-left-n");
  if (n) n.textContent = items.length ? String(items.length) : "clear";
}

function showRailManifest(shipSymbol) {
  const t = $("triage"), m = $("manifest");
  if (t) t.style.display = "none";
  if (m) m.style.display = "";
  const title = $("rail-left-title");
  if (title) title.textContent = "Manifest";
  const n = $("rail-left-n");
  if (n) n.textContent = shipSymbol;
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

function fleetRows() {
  const ships = state?.ships ?? [];
  const earnBy = new Map((bridge.earnings ?? []).map((e) => [e.shipSymbol, e.net]));
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
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
      <span class="route-txt">${escapeHtml(r.goal)}${r.at ? ` · ${escapeHtml(shortWp(r.at))}` : ""}${fmTag(r.flightMode)}</span>
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
 *  desktop ticker shows, as a vertical list. */
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
      <tr class="${r.stranded ? "warn " : ""}${selectedShip === r.symbol ? "sel" : ""}" data-ship="${escapeAttr(r.symbol)}">
        <td><span class="sym">${escapeHtml(shortWp(r.symbol))}</span></td>
        <td>${escapeHtml(r.role)}${r.manual ? ' <span style="color:var(--accent)">·M</span>' : ""}</td>
        <td class="num ${r.net > 0 ? "rate-up" : r.net < 0 ? "rate-down" : "rate-zero"}">${r.net ? signed(r.net) : "0"}</td>
        <td class="gauge"><span class="meter"><i style="width:${r.fuelCap ? (r.fuel / r.fuelCap) * 100 : 0}%"></i></span>${r.fuel}</td>
        <td class="gauge"><span class="meter c"><i style="width:${r.cargoCap ? (r.cargo / r.cargoCap) * 100 : 0}%"></i></span>${r.cargoCap ? `${r.cargo}/${r.cargoCap}` : "—"}</td>
        <td class="gauge"><span class="meter${r.condition < 50 ? " neg" : ""}"><i style="width:${r.condition}%"></i></span>${r.condition}%</td>
        <td class="gauge">${r.crewCapacity ? `<span class="meter${r.morale < 40 ? " neg" : ""}"><i style="width:${Math.max(0, Math.min(100, r.morale))}%"></i></span>${r.crewCurrent}/${r.crewCapacity}` : "—"}</td>
        <td><span class="goal">${escapeHtml(r.goal)}${r.at ? ` · ${escapeHtml(shortWp(r.at))}` : ""}${fmTag(r.flightMode)}</span></td>
      </tr>`).join("")}</tbody>`;

  el.querySelectorAll("th[data-key]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key;
    fleetSort = { key: k, dir: fleetSort.key === k ? -fleetSort.dir : -1 };
    renderFleetTable();
  }));
  el.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => {
    selectedShip = tr.dataset.ship;
    openShipDetails(selectedShip);
    setView("bridge");
  }));
  renderCrewRoster();
}

/** Fleet-wide personnel roster — same data as each ship's own Crew section
 *  (openShipDetails' crewSectionHtml), rolled up into one page instead of
 *  clicking through every hull. Purely informational: there's no crew-
 *  management endpoint in the API, so nothing here is actionable. */
function renderCrewRoster() {
  const el = $("crew-roster");
  if (!el) return;
  const ships = (state?.ships ?? []).filter((s) => s.crew);
  const countEl = $("crew-count");
  if (!ships.length) {
    if (countEl) countEl.textContent = "—";
    el.innerHTML = '<div class="empty">No crewed hulls in the register.</div>';
    return;
  }
  const totalCurrent = ships.reduce((sum, s) => sum + (s.crew.current ?? 0), 0);
  const totalWages = ships.reduce((sum, s) => sum + (s.crew.wages ?? 0) * (s.crew.current ?? 0), 0);
  const avgMorale = Math.round(ships.reduce((sum, s) => sum + (s.crew.morale ?? 0), 0) / ships.length);
  if (countEl) countEl.textContent = `${totalCurrent} crew`;

  const rows = ships
    .map((s) => ({ s, role: (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol)?.role ?? "—" }))
    .sort((a, b) => (a.s.crew.morale ?? 0) - (b.s.crew.morale ?? 0));

  el.innerHTML = `
    <div class="fleet-summary" style="margin-bottom:10px">
      <span class="fs-chip"><b>${totalCurrent}</b><i>total crew</i></span>
      <span class="fs-chip${avgMorale < 40 ? " warn" : ""}"><b>${avgMorale}</b><i>avg morale</i></span>
      <span class="fs-chip"><b>${fmt(totalWages)}c</b><i>wages/hr</i></span>
    </div>
    <div class="loadout-grid">${rows.map(({ s, role }) => {
      const c = s.crew;
      const pct = Math.max(0, Math.min(100, c.morale ?? 0));
      const low = pct < 40;
      return `<div class="loadout-item crew-row" data-ship="${escapeAttr(s.symbol)}" style="cursor:pointer">
        <span class="n">${escapeHtml(shortWp(s.symbol))} <span style="color:var(--dim)">· ${escapeHtml(role)}</span></span>
        <span class="d">${c.current}/${c.capacity} · <span class="meter${low ? " neg" : ""}"><i style="width:${pct}%"></i></span> ${pct} · ${c.rotation === "STRICT" ? "strict" : "relaxed"}</span>
      </div>`;
    }).join("")}</div>`;

  el.querySelectorAll(".crew-row[data-ship]").forEach((row) => row.addEventListener("click", () => {
    selectedShip = row.dataset.ship;
    openShipDetails(selectedShip);
    setView("bridge");
  }));
}

function renderTicker() {
  const el = $("ticker");
  if (!activity.length) { el.innerHTML = '<span>Waiting for fleet activity.</span>'; return; }
  el.innerHTML = activity.slice(0, 12).map((a) => {
    const c = a.credits;
    return `<span><span style="color:var(--dim)">${fmtTime(a.timestamp)}</span> ${escapeHtml(a.detail)}${
      c == null ? "" : ` <b class="${c < 0 ? "neg" : ""}">${signed(c)}</b>`}</span>`;
  }).join("");
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
          <div class="r2">${escapeHtml(shortWp(r.buyAt))} <b>${r.buyPrice}c</b> → ${escapeHtml(shortWp(r.sellAt))} <b>${r.sellPrice}c</b> · ${r.volume}u${r.crossSystem
            ? ` <span class="sysbadge">${escapeHtml(systemOf(r.buyAt))} <span class="arr">→</span> ${escapeHtml(systemOf(r.sellAt))}</span>`
            : ""}</div>
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
      <div class="h"><span><b>${escapeHtml(shortWp(wp))}</b> <span class="sys">${escapeHtml(systemOf(wp))}</span></span>
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





/** The ships array and sx/sy scale functions from the most recent renderMap()
 *  call, reused by repositionShips() so per-frame animation never recomputes
 *  view bounds or drifts from what was actually drawn — see that function's
 *  own comment for why it can't just read state.ships directly (replay scrub
 *  draws a synthetic ship list renderMap() was actually called with, not
 *  live state). */
let lastRenderedShips = [];
let mapScale = null;
let shipAnimHandle = null;
/** Live motion-trail state (repositionShips()'s own — distinct from the
 *  replay scrubber's waypoint-history trails passed into renderMap()).
 *  shipSymbol -> recent screen positions, oldest first, sampled by on-screen
 *  distance moved (not a fixed time cadence) and capped short: this is a
 *  "yes, it's really moving" cue for a transit whose per-frame pixel
 *  displacement is otherwise too small to notice at real game speed, not a
 *  flight-path record. Distance-based sampling (rather than the original
 *  fixed-interval one) matters because a 200ms tick of real flight time is
 *  often a fraction of a pixel at real game speed — a time-based sample was
 *  visually indistinguishable from a solid dot. Sampling by distance instead
 *  guarantees every recorded segment is actually long enough to see,
 *  independent of ship speed or zoom level. */
let liveTrails = new Map();
let lastTrailSamplePos = new Map();
const TRAIL_SAMPLE_MIN_PX = 4;
const TRAIL_MAX_POINTS = 10; // ~40px of trail at the sample distance above — longer reads as more deliberate motion than the original 6

function renderMap(ships, trails = new Map()) {
  const svg = $("map");
  const w = svg.clientWidth || 800;
  const h = svg.clientHeight || 600;
  const sys = currentSystem || state.agent.headquarters.slice(0, state.agent.headquarters.lastIndexOf("-"));
  $("map-hud").innerHTML = `Sector <b>${sys}</b>`;

  // A docked/orbiting ship in a different system already silently dropped
  // here (its waypoint symbol just never matches anything in `waypoints`
  // below) — but an in-transit one didn't: shipTransitLerp() computes a
  // position purely from that ship's own route's raw world coordinates,
  // with no system check, so a foreign system's ship mid-flight got its
  // completely unrelated coordinates run through *this* system's scale
  // functions and landed somewhere on the wrong map. Filtering the whole
  // list once up front, before any of that math (or lastRenderedShips,
  // which repositionShips() below reads on every live-scrub frame using
  // this same system's mapScale) runs, is the one fix that covers every
  // case instead of patching shipTransitLerp() for just this one leak.
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
    waypoints = [...seen.entries()].map(([symbol, p]) => ({ symbol, x: p.x, y: p.y }));
  }

  const bySymbol = new Map(waypoints.map((p) => [p.symbol, p]));

  // Frame the whole system by default — not just "active" waypoints (ships,
  // headquarters, trade route endpoints). Cropping to active-only used to
  // leave most of a system permanently out of view whenever ships happened
  // to cluster in one area, with no way to see the rest since zoom couldn't
  // go below 1x either (fixed below).
  const pool = waypoints;
  const xs = pool.map((p) => p.x);
  const ys = pool.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const pad = 60;
  if (spanX > spanY) {
    const extra = (spanX - spanY) / 2;
    minY -= extra; maxY += extra;
  } else {
    const extra = (spanY - spanX) / 2;
    minX -= extra; maxX += extra;
  }
  const sx = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (w - pad * 2);
  const sy = (y) => pad + ((y - minY) / (maxY - minY || 1)) * (h - pad * 2);
  // Cache these exact closures (not a recomputed copy) for repositionShips()
  // to reuse every frame — guarantees it can never drift from the scale this
  // render actually used, and costs nothing extra to compute.
  mapScale = { sx, sy };

  // SpaceTraders routinely puts several waypoints at the exact same x/y — a
  // gas giant and the stations orbiting it share one coordinate. Left as-is
  // they'd render as one stacked, unreadable blob. Each member of a shared
  // coordinate gets a small ring offset instead, computed in this pre-scale
  // coordinate space — since #map-view (below) gets scale(mapZoom) applied
  // as one group, that fixed offset grows right along with everything else
  // as the operator zooms in, so a cluster that reads as one dot at a
  // distance visibly separates into its real members up close, with no
  // separate zoom-aware logic needed here.
  const byCoord = new Map();
  for (const p of waypoints) {
    const key = `${p.x},${p.y}`;
    if (!byCoord.has(key)) byCoord.set(key, []);
    byCoord.get(key).push(p);
  }
  // labelDir mirrors each waypoint's cluster-ring angle (or "straight right"
  // for an unclustered point) so its label radiates outward in the same
  // direction as its glyph offset — fanning labels around a cluster instead
  // of stacking them all to the right, where they'd overlap.
  const posBySymbol = new Map();
  const labelDir = new Map();
  // A rotated square's corners reach further than its nominal r (roughly
  // r*sqrt(2)), so a diamond/gate needs more breathing room than a circle of
  // the same r or its members visibly overlap — derive spacing from each
  // waypoint's real glyph footprint rather than a flat constant. Shared by
  // the ring-offset step below and the general relaxation pass after it.
  const effR = (p) => {
    const wg = WP_GLYPH[p.type] ?? WP_GLYPH.__default;
    return wg.shape === "diamond" || wg.shape === "gate" ? wg.r * 1.45 : wg.r;
  };
  for (const group of byCoord.values()) {
    const baseX = sx(group[0].x), baseY = sy(group[0].y);
    if (group.length === 1) {
      posBySymbol.set(group[0].symbol, { x: baseX, y: baseY });
      labelDir.set(group[0].symbol, { dx: 1, dy: 0 });
      continue;
    }
    const maxEffR = Math.max(...group.map(effR));
    const ringR = maxEffR * 1.7 + Math.min(group.length, 6) * 1.4;
    group.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      posBySymbol.set(p.symbol, { x: baseX + ringR * dx, y: baseY + ringR * dy });
      labelDir.set(p.symbol, { dx, dy });
    });
  }

  // General relaxation pass: the ring-offset above only ever considered a
  // waypoint's own same-coordinate siblings, so two *different* clusters (or
  // a cluster and a lone waypoint) sitting near each other could still end
  // up visibly overlapping — confirmed live (A1's cluster reaching into
  // CZ5C). A closed-form cap tried to prevent that by shrinking ring radius
  // near a neighbor and consistently broke the common case instead (see git
  // history) — a cluster's own internal spacing and its distance to
  // unrelated neighbors are two different constraints that don't reduce to
  // one number. This instead runs a handful of iterations over *every*
  // waypoint pair, nudging any two that are still overlapping apart along
  // their connecting line — self-correcting for whatever density a given
  // system actually has, rather than a formula trying to predict it.
  // O(n^2) per iteration but n is a waypoint count (tens, not thousands),
  // so a few iterations is trivial even at the 1s map redraw cadence.
  const relaxEntries = waypoints.map((p) => ({ symbol: p.symbol, r: effR(p), ...posBySymbol.get(p.symbol) }));
  const displacement = new Map(relaxEntries.map((e) => [e.symbol, { dx: 0, dy: 0 }]));
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < relaxEntries.length; i++) {
      for (let j = i + 1; j < relaxEntries.length; j++) {
        const a = relaxEntries[i], b = relaxEntries[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + 1.5;
        if (dist >= minDist) continue;
        if (dist < 0.01) { dx = 1; dy = 0; dist = 1; } // coincident — pick a direction
        const push = ((minDist - dist) / dist) * 0.5;
        const ox = dx * push, oy = dy * push;
        a.x -= ox; a.y -= oy;
        b.x += ox; b.y += oy;
        const da = displacement.get(a.symbol), db = displacement.get(b.symbol);
        da.dx -= ox; da.dy -= oy;
        db.dx += ox; db.dy += oy;
      }
    }
  }
  for (const e of relaxEntries) {
    posBySymbol.set(e.symbol, { x: e.x, y: e.y });
    const d = displacement.get(e.symbol);
    const mag = Math.hypot(d.dx, d.dy);
    // Only re-point the label if relaxation actually moved this waypoint by
    // more than a rounding error — an untouched point keeps whichever
    // direction the ring-offset step (or its "straight right" default) gave
    // it, rather than snapping to an arbitrary near-zero vector.
    if (mag > 0.5) labelDir.set(e.symbol, { dx: d.dx / mag, dy: d.dy / mag });
  }

  let out = `<g id="map-view">`;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  out += `<text class="syslabel" x="${sx(cx)}" y="${sy(cy)}" text-anchor="middle" dominant-baseline="middle">${sys}</text>`;

  for (const c of jumpConnections) {
    const a = posBySymbol.get(c.from);
    const b = posBySymbol.get(c.to);
    if (a && b) {
      out += `<path class="jump" d="M ${a.x} ${a.y} L ${b.x} ${b.y}"></path>`;
    }
  }

  const routes = tradeRoutes.slice(0, 6);
  routes.forEach((r, i) => {
    const a = posBySymbol.get(r.cheapestMarket);
    const b = posBySymbol.get(r.expensiveMarket);
    if (!a || !b) return;
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const off = Math.min(len * 0.2, 42);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const cx2 = mx - (dy / len) * off, cy2 = my + (dx / len) * off;
    out += `<path class="route${i === 0 ? " active" : ""}" d="M ${ax} ${ay} Q ${cx2} ${cy2} ${bx} ${by}"></path>`;
  });

  for (const p of waypoints) {
    const isMarket = p.traits && p.traits.includes("MARKETPLACE");
    const isYard = p.traits && p.traits.includes("SHIPYARD");
    const pos = posBySymbol.get(p.symbol);
    const g = WP_GLYPH[p.type] ?? WP_GLYPH.__default;
    out += drawWaypointGlyph(g, pos, p.symbol, isMarket, isYard);
    if (isMarket || isYard || g.labeled) {
      const dir = labelDir.get(p.symbol) ?? { dx: 1, dy: 0 };
      const off = g.r + 5;
      const anchor = dir.dx < -0.15 ? "end" : dir.dx > 0.15 ? "start" : "middle";
      out += `<text class="wplabel" x="${pos.x + dir.dx * off}" y="${pos.y + dir.dy * off + 3}" text-anchor="${anchor}">${shortWp(p.symbol)}</text>`;
    }
  }
  // Scrubbing draws each ship's recent path as a fading trail — real
  // movement history, not the static trade lanes above. Segments nearer the
  // ship's current position are more opaque than older ones, so the trail
  // reads as a direction of travel, not just a static line.
  for (const [, trail] of trails) {
    for (let i = 1; i < trail.length; i++) {
      const a = posBySymbol.get(trail[i - 1]);
      const b = posBySymbol.get(trail[i]);
      if (!a || !b) continue;
      const frac = i / (trail.length - 1);
      const opacity = (0.1 + frac * 0.4).toFixed(2);
      out += `<line class="ship-trail" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" opacity="${opacity}"></line>`;
    }
  }

  shipScreenPos.clear();
  // nav.waypointSymbol is already the *destination* the instant a ship
  // departs — SpaceTraders doesn't wait for arrival to update it — so an
  // in-transit ship drawn at posBySymbol.get(waypointSymbol) has always
  // just sat at its destination for the whole flight instead of visibly
  // traveling. route.departureTime/arrival/origin/destination are on every
  // ship object untouched (confirmed: listAllShips() -> state.update()
  // does no narrowing), so a straight lerp between them — no speed or
  // flight-mode math needed, whatever mode was used already shaped the
  // arrival timestamp — gives a real interpolated position instead.
  const rawShipPos = new Map();
  for (const s of ships) {
    const worldPos = shipTransitLerp(s);
    const pos = worldPos ? { x: sx(worldPos.x), y: sy(worldPos.y) } : posBySymbol.get(s.nav.waypointSymbol);
    if (pos) rawShipPos.set(s.symbol, pos);
  }
  // Same fix as the waypoint coordinate-clustering above, for the same
  // reason: several ships docked/orbiting at one waypoint (or, rarer,
  // mid-transit ships that happen to land on the same interpolated point)
  // land on the exact same screen coordinate and stack into one
  // indistinguishable blob. Ring them apart instead. Ships are now a single
  // shared shape/size (see shipGlyphMarkup), so unlike the waypoint version
  // this doesn't need a per-glyph effective-radius lookup — one fixed ring
  // size for every cluster.
  // Two stationary ships at the same waypoint should always land in the same
  // cluster, but grouping by a *rounded* screen pixel can split them apart:
  // a ship that just arrived is drawn via shipTransitLerp() at frac≈1, whose
  // lerp arithmetic (origin + (destination-origin)*1) isn't always bit-
  // identical to the destination's own cached posBySymbol value, so a tiny
  // floating-point epsilon can land the two ships' *rounded* coordinates on
  // opposite sides of a rounding boundary. Grouping stationary ships by
  // their actual waypoint symbol sidesteps that entirely; only genuinely
  // in-transit ships (no shared waypoint identity to key off — they're
  // literally between two points) fall back to the rounded-pixel grouping,
  // for the much rarer case of two flights coinciding mid-route.
  const shipsByCoord = new Map();
  for (const s of ships) {
    const pos = rawShipPos.get(s.symbol);
    if (!pos) continue;
    const key = s.nav.status === "IN_TRANSIT" ? `xy:${Math.round(pos.x)},${Math.round(pos.y)}` : `wp:${s.nav.waypointSymbol}`;
    if (!shipsByCoord.has(key)) shipsByCoord.set(key, []);
    shipsByCoord.get(key).push(s.symbol);
  }
  const clusteredShipPos = new Map();
  for (const group of shipsByCoord.values()) {
    const base = rawShipPos.get(group[0]);
    if (group.length === 1) { clusteredShipPos.set(group[0], base); continue; }
    const ringR = 4 + Math.min(group.length, 6) * 1.3;
    group.forEach((sym, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      clusteredShipPos.set(sym, { x: base.x + ringR * Math.cos(angle), y: base.y + ringR * Math.sin(angle) });
    });
  }

  for (const s of ships) {
    const pos = clusteredShipPos.get(s.symbol);
    if (!pos) continue;
    const { x, y } = pos;
    shipScreenPos.set(s.symbol, { x, y });
    const docked = s.nav.status === "DOCKED";
    const sel = s.symbol === selectedShip;
    const role = (fleetStatus.ships ?? []).find((r) => r.symbol === s.symbol)?.role;
    const heading = shipHeadingDeg(s, sx, sy);
    // The selection halo lives *inside* the ship's own <g> now, at local
    // (0,0), instead of as a sibling circle positioned with its own cx/cy —
    // so it rides along with the ship's transform for free (repositionShips()
    // only ever touches the <g>'s transform, never re-renders these circles).
    out += `<g class="ship ${docked ? "docked" : ""}${sel ? " selected" : ""}" transform="translate(${x} ${y})" data-wp="${s.nav.waypointSymbol}" data-ship="${s.symbol}">
      ${sel ? `<circle class="sel-halo" cx="0" cy="0" r="22"></circle><circle class="sel-ring" cx="0" cy="0" r="22"></circle>` : ""}
      ${shipGlyphMarkup(role, docked, heading)}<title>${s.symbol} — ${s.nav.status}</title>
    </g>`;
  }
  svg.innerHTML = out + `</g>`;
  svg.querySelectorAll("[data-wp]").forEach((el) => {
    el.addEventListener("mouseenter", () => showWaypointTip(el.dataset.wp));
    el.addEventListener("mouseleave", hideWaypointTip);
  });
  // Tap-to-inspect for touch: mouseenter/mouseleave above never fire on a
  // touchscreen, so a waypoint's info (ships docked there, market prices,
  // shipyard offers) was completely unreachable on mobile — the only way in
  // was hovering with a mouse. Scoped to plain waypoint glyphs (excludes
  // ships, which carry data-wp too but already have their own tap handler
  // just below, opening ship details instead) so the two never fight over
  // the same tap. Second tap on the same waypoint closes it, matching the
  // toggle behavior a touch UI needs in place of mouseleave.
  svg.querySelectorAll("[data-wp]:not([data-ship])").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wp = el.dataset.wp;
      if (mapTipFor === wp) hideWaypointTip();
      else { showWaypointTip(wp); mapTipFor = wp; }
    });
  });
  // Selection replaces navigation: clicking a hull on the map re-focuses the
  // whole HUD on it (fills the left rail), the same as picking it from triage.
  svg.querySelectorAll("[data-ship]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); openShipDetails(el.dataset.ship); });
  });
  applyMapView();
  // Restart the per-frame ship animation against the DOM this call just
  // built. Cancel any chain from a previous render first — otherwise a full
  // rebuild mid-animation would leave two rAF chains racing the same nodes.
  // Skipped entirely while scrubbing: repositionShips() would just no-op on
  // every frame anyway (see its own guard), so don't bother scheduling one.
  if (shipAnimHandle) cancelAnimationFrame(shipAnimHandle);
  if (scrubLive) shipAnimHandle = requestAnimationFrame(repositionShips);
}

/** Per-frame ship-motion animation, replacing the old fixed 1s redraw timer.
 *  Only ever touches each in-transit ship's own <g transform> (translate +
 *  the hull's rotate) — never rebuilds the map SVG, so this is cheap enough
 *  to run every frame instead of once a second. Self-terminates (no
 *  reschedule) the moment there's nothing to animate; the next full
 *  renderMap() call (from a real data poll, a view switch, or a scrub frame)
 *  restarts it. See docs/smooth-ship-flying.md for the full design.
 *
 *  Reads `lastRenderedShips`, not `state.ships` — during replay scrub,
 *  renderMap() is called with a synthetic historical ship list that has no
 *  route timing at all, and state.ships (live data) would be a completely
 *  different set of ships than what's actually on screen. The scrubLive
 *  guard below means this never actually runs during a scrub either way,
 *  but reading the cached array (rather than state.ships) keeps this
 *  correct even if that guard is ever relaxed. */
function repositionShips() {
  shipAnimHandle = null;
  const mapVisible = (!isMobile() && currentView === "bridge") || (isMobile() && mobileView === "map");
  if (!mapVisible || !scrubLive || !mapScale || !lastRenderedShips.length) return;
  const svg = $("map");
  const inTransitSymbols = new Set(lastRenderedShips.filter((s) => s.nav.status === "IN_TRANSIT").map((s) => s.symbol));
  // Prune trail state for any ship that isn't in transit *right now* before
  // anything else, including the early return just below for "nothing to
  // animate" — otherwise the pass where the last in-transit ship of the
  // whole fleet arrives never reaches this at all (anyTransit was false, so
  // the old code bailed above the loop this used to live at the bottom of),
  // leaving that ship's sample buffer stale forever. Harmless in the
  // moment (bounded by fleet size), but a real bug the moment that same
  // ship starts a new transit later: its old trail would still be sitting
  // in liveTrails, so the new transit's first few points would jump from
  // the previous leg's stale tail instead of starting fresh.
  for (const symbol of [...liveTrails.keys()]) {
    if (inTransitSymbols.has(symbol)) continue;
    liveTrails.delete(symbol);
    lastTrailSamplePos.delete(symbol);
    svg.querySelector(`[data-trail-for="${symbol}"]`)?.remove();
  }
  if (inTransitSymbols.size === 0) return;
  const view = svg.querySelector("#map-view");
  const { sx, sy } = mapScale;
  for (const s of lastRenderedShips) {
    if (s.nav.status !== "IN_TRANSIT") continue;
    const world = shipTransitLerp(s);
    if (!world) continue; // stale/missing route data — leave it at its last drawn position
    const g = svg.querySelector(`[data-ship="${s.symbol}"]`);
    if (!g) continue; // not on the currently-viewed system's map
    const x = sx(world.x), y = sy(world.y);
    g.setAttribute("transform", `translate(${x} ${y})`);
    const heading = shipHeadingDeg(s, sx, sy);
    g.querySelector(".hull")?.setAttribute("transform", `rotate(${heading ?? 45})`);

    // Subtle motion trail: sampled by on-screen distance moved, not every
    // frame and not on a fixed timer (at 60fps, or at 200ms real-game-speed
    // ticks, consecutive points would sit fractions of a pixel apart —
    // indistinguishable from a solid line, and pointless overhead). Reuses
    // the scrub trail's own .ship-trail line style for a consistent visual
    // language, just at a lower opacity ceiling — this is a background
    // motion cue, not something meant to be read the way a reviewed replay
    // path is.
    if (view) {
      const points = liveTrails.get(s.symbol) ?? [];
      const lastPos = lastTrailSamplePos.get(s.symbol);
      if (!lastPos || Math.hypot(x - lastPos.x, y - lastPos.y) >= TRAIL_SAMPLE_MIN_PX) {
        points.push({ x, y });
        if (points.length > TRAIL_MAX_POINTS) points.shift();
        liveTrails.set(s.symbol, points);
        lastTrailSamplePos.set(s.symbol, { x, y });
      }
      if (points.length > 1) {
        let trailGroup = svg.querySelector(`[data-trail-for="${s.symbol}"]`);
        if (!trailGroup) {
          // Lazily (re)created here rather than in renderMap()'s own markup:
          // a full rebuild wipes the whole #map-view subtree (svg.innerHTML
          // reassignment), but liveTrails' sample data lives outside the DOM
          // and survives that — this just re-attaches a home for it,
          // trail continuity across a real data poll is preserved for free.
          trailGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
          trailGroup.setAttribute("data-trail-for", s.symbol);
          view.insertBefore(trailGroup, g); // directly before this ship's own <g> — renders underneath it
        }
        let segments = "";
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          // 0.32 max (matched to the replay scrub trail's own subtlety) read
          // as invisible in practice — even the newest segment barely
          // registered. 0.25-0.7 keeps a real fade from tail to head while
          // making sure no segment is ever too faint to notice.
          const opacity = (0.25 + (i / (points.length - 1)) * 0.45).toFixed(2);
          segments += `<line class="ship-trail live" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" opacity="${opacity}"></line>`;
        }
        trailGroup.innerHTML = segments;
      }
    }
  }
  shipAnimHandle = requestAnimationFrame(repositionShips);
}

/** Book mode's clause hover: ring the real hulls a rule fired against this
 *  watch, at their real map positions. Ships not currently on the visible
 *  map (different system, or not yet loaded) are silently skipped — there's
 *  nowhere on this chart to point at them. */
function pulseHulls(shipSymbols) {
  clearHullPulse();
  const view = document.querySelector("#map-view");
  if (!view) return;
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("id", "hull-pulse-group");
  for (const sym of shipSymbols) {
    const p = shipScreenPos.get(sym);
    if (!p) continue;
    g.insertAdjacentHTML("beforeend",
      `<circle class="hull-pulse" cx="${p.x}" cy="${p.y}" r="15" opacity="0.9"></circle>
       <circle class="hull-pulse" cx="${p.x}" cy="${p.y}" r="26" opacity="0.35"></circle>`);
  }
  view.appendChild(g);
}

function clearHullPulse() {
  document.querySelector("#hull-pulse-group")?.remove();
}

function applyMapView() {
  const view = document.querySelector("#map-view");
  if (!view) return;
  view.setAttribute("transform", `translate(${mapPanX} ${mapPanY}) scale(${mapZoom})`);
  const svg = $("map");
  svg.style.setProperty("--map-zoom", mapZoom.toFixed(2));
  svg.setAttribute("data-zoom-high", mapZoom > 1.6 ? "true" : "false");
}

function resetMapView() {
  mapZoom = 1; mapPanX = 0; mapPanY = 0;
  applyMapView();
}

function initMapInteractions() {
  const svg = $("map");
  const wrap = svg.parentElement;

  $("map-fit")?.addEventListener("click", resetMapView);

  // Tap-to-inspect's counterpart: dismiss the open tip on a tap anywhere
  // else on the map. Per-waypoint click handlers (renderMap()) call
  // stopPropagation(), so this only ever fires for a tap that missed every
  // waypoint/ship glyph — exactly "tap elsewhere to close." Attached once
  // here rather than in renderMap() (which re-runs on every poll) since the
  // svg element itself, unlike its children, survives each rebuild.
  svg.addEventListener("click", () => { if (mapTipFor) hideWaypointTip(); });

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    // Floor lowered from 1 to 0.5 — the default view now already fits the
    // whole system at 1x (see renderMap()'s pool comment), so this is just
    // breathing room for zooming out a bit further, not the fix itself.
    const next = Math.min(MAX_MAP_ZOOM, Math.max(0.5, mapZoom * factor));
    mapPanX = mx - ((mx - mapPanX) / mapZoom) * next;
    mapPanY = my - ((my - mapPanY) / mapZoom) * next;
    mapZoom = next;
    applyMapView();
  }, { passive: false });

  svg.addEventListener("mousedown", (e) => {
    dragState = { x: e.clientX, y: e.clientY, px: mapPanX, py: mapPanY };
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragState) return;
    mapPanX = dragState.px + (e.clientX - dragState.x);
    mapPanY = dragState.py + (e.clientY - dragState.y);
    applyMapView();
  });
  window.addEventListener("mouseup", () => { dragState = null; });
  wrap.addEventListener("dblclick", resetMapView);

  // Touch: single-finger drag pans, two-finger pinch zooms — same
  // mapPanX/mapPanY/mapZoom + applyMapView() state the mouse handlers use.
  let touchState = null; // { mode:"pan", x, y, px, py } | { mode:"pinch", d0, z0, cx, cy, px, py }
  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchState = { mode: "pan", x: t.clientX, y: t.clientY, px: mapPanX, py: mapPanY };
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      const rect = wrap.getBoundingClientRect();
      touchState = { mode: "pinch", d0, z0: mapZoom, cx: cx - rect.left, cy: cy - rect.top, px: mapPanX, py: mapPanY };
    }
  }, { passive: true });
  wrap.addEventListener("touchmove", (e) => {
    if (!touchState) return;
    e.preventDefault();
    if (touchState.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      mapPanX = touchState.px + (t.clientX - touchState.x);
      mapPanY = touchState.py + (t.clientY - touchState.y);
      applyMapView();
    } else if (touchState.mode === "pinch" && e.touches.length === 2) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = Math.min(MAX_MAP_ZOOM, Math.max(0.5, touchState.z0 * (d / touchState.d0)));
      mapPanX = touchState.cx - ((touchState.cx - touchState.px) / touchState.z0) * next;
      mapPanY = touchState.cy - ((touchState.cy - touchState.py) / touchState.z0) * next;
      mapZoom = next;
      applyMapView();
    }
  }, { passive: false });
  wrap.addEventListener("touchend", () => { touchState = null; });
  wrap.addEventListener("touchcancel", () => { touchState = null; });
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

function openShipDetails(shipSymbol) {
  const ship = (state?.ships ?? []).find((s) => s.symbol === shipSymbol);
  if (!ship) return;
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
  const modal = $("manifest");
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

  let html = `<button class="close" id="manifest-back" title="Back to triage">← Triage</button>
    <h3>${shipSymbol}</h3>
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
          ${["trader", "miner", "surveyor", "siphoner", "tour", "scout", "keeper"].map((r) => `<option value="${r}" ${r === st?.role ? "selected" : ""}>${r}</option>`).join("")}
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
    ${atYard && ship.nav.status !== "IN_TRANSIT" ? `<div class="loadout-section"><h4>Scrap</h4>
      <div class="jump-row">
        <span class="tgt"><b>Scrap this ship</b> <span class="d" style="color:var(--dim);font-size:9px">removes it permanently, returns a portion of its value${docked ? "" : " — docks it first"}</span></span>
        <button class="scrap" data-ship="${shipSymbol}">Scrap</button>
      </div>
    </div>` : ""}`;

  modal.innerHTML = html;
  showRailManifest(shipSymbol);
  modal.querySelector(".close").addEventListener("click", () => { selectedShip = null; showRailTriage(); });
  modal.querySelectorAll(".hold").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/hold", { shipSymbol: b.dataset.ship });
        await loadBridge();
        openShipDetails(b.dataset.ship);
      } catch (err) { showToastGlobal(err.message, true); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".release").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/release", { shipSymbol: b.dataset.ship });
        await loadBridge();
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(shipSymbol);
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
        openShipDetails(shipSymbol);
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
        openShipDetails(b.dataset.ship);
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
        openShipDetails(b.dataset.ship);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".jump").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/jump", { shipSymbol: b.dataset.ship, waypointSymbol: b.dataset.to });
        await loadState();
        openShipDetails(b.dataset.ship);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".install").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/install", { shipSymbol: b.dataset.ship, componentSymbol: b.dataset.comp });
        await loadState();
        openShipDetails(b.dataset.ship);
      } catch (err) { alert(err.message); b.disabled = false; }
    });
  });
  modal.querySelectorAll(".rm").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/api/fleet/remove-component", { shipSymbol: b.dataset.ship, componentSymbol: b.dataset.comp });
        await loadState();
        openShipDetails(b.dataset.ship);
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
      for (const y of yards.slice(0, 12)) {
        const age = fmtAge(y.timestamp);
        const stale = y.timestamp && (Date.now() - new Date(y.timestamp).getTime()) > 90 * 60_000;
        html += `<div class="row" style="align-items:center">
          <span class="icon">⛵</span>
          <span class="route"><b>${shortWp(y.waypointSymbol)}</b> · ${y.shipTypeName}<br><span class="note">${y.systemSymbol} · fuel ${y.fuelCapacity} · ${y.purchasePrice}c · <span class="${stale ? "stale" : ""}">${age} old</span></span></span>
          <span class="marg">${fmt(y.purchasePrice)}c</span>
          <button class="buy-ship" data-type="${y.shipType}" data-yard="${y.waypointSymbol}" title="Buy ${y.shipTypeName}">Buy</button>
        </div>`;
      }
    }
    if (mods.length) {
      html += `<div class="sub" style="margin:8px 0 4px">Modules & mounts</div>`;
      for (const m of mods.slice(0, 12)) {
        html += `<div class="row" style="align-items:center">
          <span class="icon">${m.kind === "module" ? "▣" : "◈"}</span>
          <span class="route"><b>${m.symbol}</b><br><span class="note">${shortWp(m.waypointSymbol)} · ${m.purchasePrice}c</span></span>
          <span class="marg">${fmt(m.purchasePrice)}c</span>
          <button class="buy-mod" data-comp="${m.symbol}" data-market="${m.waypointSymbol}">Buy</button>
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
every(20000, () => { if (currentView === "markets") loadMarkets(marketSystemFilter); });
every(20000, () => { if (currentView === "tradeops") { loadDispatch(); loadKeepers(); loadWarehouse(); } });
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
      document.querySelectorAll("#map [data-trail-for]").forEach((el) => el.remove());
    }
    mapHiddenAt = null;
    loadState();
    loadBridge();
    if (isMobile()) loadMobilePanels();
    else loadViewData(currentView);
  }
});

$("price-refresh").addEventListener("click", () => loadPrices(priceGood));
$("price-good").addEventListener("change", () => loadPrices(priceGood));

$("routes-system-filter").addEventListener("change", onMarketSystemFilterChange);
$("snapshots-system-filter").addEventListener("change", onMarketSystemFilterChange);

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
        <span class="fill"></span>
        <span class="ops-sub">+${fmt(c.onAccepted)} / +${fmt(c.onFulfilled)} · ${fmt(total)} total</span>
      </div>
      ${deliv}
      <div class="ops-head" style="margin-top:6px">
        <span class="ops-dead ${urgent && !c.accepted ? "urgent" : ""}">accept by ${countdown(c.deadlineToAccept ?? c.deadline)}</span>
        <span class="fill"></span>
        ${c.accepted
          ? `<span class="ops-sub">deadline ${countdown(c.deadline)}</span>`
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

/** First data load once a token is accepted — everything up to here only
 *  wired up event listeners, none of which touch the network. */
function boot() {
  loadState().then(() => { loadMarkets(marketSystemFilter); renderMapLiveOrScrub(); });
  loadBridge();
  loadActivity();
  loadDoctrine();
  loadNarrative();
  loadProgramme();
  loadReplay();
  if (isMobile()) { loadDispatch(); loadWarehouse(); }
  initScrubber();
  initShiftLogDrawer();
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

function initShiftLogDrawer() {
  const btn = $("ticker-expand");
  const drawer = $("shift-log-drawer");
  if (!btn || !drawer) return;
  btn.addEventListener("click", () => {
    const open = !drawer.classList.contains("open");
    drawer.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
  });
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

// Probe for an existing, still-valid session cookie before showing the
// gate — a returning visit with a live cookie skips straight to the
// dashboard; a missing/expired one 401s and the gate takes over.
async function boot0() {
  try {
    const res = await nativeFetch("/api/state");
    if (res.ok) { hideAuthGate(); return boot(); }
  } catch (_) { /* fall through to the gate */ }
  showAuthGate();
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
  const chosen = priceGoods.includes(priceGood) ? priceGood : priceGoods[0];
  sel.innerHTML = priceGoods.map((g) =>
    `<option value="${escapeAttr(g)}"${g === chosen ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
  // Only fetch when the selection actually moved. Without the guard this
  // re-enters through the "prices" slice that loadPrices() itself notifies.
  if (chosen !== priceGood) { priceGood = chosen; loadPrices(priceGood); }
}

function renderNarrative() {
  const el = $("narrative");
  if (el) el.textContent = narrative || "Awaiting telemetry…";
}

function renderChatHistory() {
  const log = $("chat-log");
  if (!log || !chatHistory.length) return;
  log.innerHTML = "";
  for (const m of chatHistory) addChatMsg(m.role, m.content);
}

subscribe("dispatch", renderDispatch);
subscribe("warehouse", renderWarehouse);
subscribe("keepers", renderKeepers);
subscribe("replay", renderScrubTrack);
subscribe("prices", () => {
  renderPriceGoods();
  if (pricePoints.length) renderPriceChart(pricePoints, "price-chart");
});
subscribe("programme", () => { renderContracts(contracts); renderMissions(missions); });
subscribe("galaxy", () => { renderLeaderboard(leaderboard); renderFactions(factions); });
subscribe("narrative", renderNarrative);
subscribe("chat", renderChatHistory);

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
});
subscribe("activity", () => {
  renderTicker();
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

