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
import {
  state, bridge, fleetStatus, approvals, dispatchAssignments, dispatchRoutes, intel,
  subscribe, loadState, loadBridge, loadApprovals, loadDispatch, loadMarkets,
} from "/shared/store.js";
import { fmt, signed, escapeHtml, countdown, shortWp, worstConditionPct } from "/shared/domain.js";

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
    await login(token);
    hideAuthGate();
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
function setTab(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name));
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "fleet") renderDeck();
  if (name === "map") { loadMarkets(); renderScope(); }
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

/* ── home: cockpit tiles ──────────────────── */
function unassignedTraders() {
  const roleBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s.role]));
  return (state?.ships ?? []).filter(
    (s) => roleBy.get(s.symbol) === "trader" && !dispatchAssignments.some((a) => a.shipSymbol === s.symbol),
  );
}

function renderTiles() {
  const ships = state?.ships ?? [];
  const stranded = fleetStatus.stranded?.length ?? 0;
  const unassigned = unassignedTraders().length;
  const bestRoute = [...dispatchAssignments].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0))[0];
  const rate = bridge.rate ?? 0;

  $("home-tiles").innerHTML = `
    <div class="tile"><div class="k">Credits</div><div class="v">${fmt(state?.agent?.credits ?? bridge.credits ?? 0)}</div></div>
    <div class="tile"><div class="k">Rate</div><div class="v ${rate >= 0 ? "green" : "red"}">${signed(rate)}<span class="sub"> /hr</span></div></div>
    <div class="tile"><div class="k">Fleet</div><div class="v">${ships.length}<span class="sub"> hulls</span></div><div class="sub">${stranded} stranded · ${unassigned} unassigned</div></div>
    <div class="tile"><div class="k">Best route</div><div class="v amber">${bestRoute ? signed(bestRoute.profitPerTrip) : "—"}</div><div class="sub">${bestRoute ? escapeHtml(bestRoute.good) : "none yet"}</div></div>
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

subscribe("state", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); if (mapTabActive()) renderScope(); });
subscribe("bridge", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); });
subscribe("dispatch", () => { renderTiles(); renderTriage(); if (fleetTabActive()) renderDeck(); });
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

function jobLabel(assignment) {
  if (!assignment) return null;
  const good = assignment.good;
  if (assignment.role === "direct") return `route: ${good}`;
  if (assignment.role === "contractBuy") return `contract: ${good}`;
  if (assignment.role === "haul") return `mission: ${good}`;
  if (assignment.role === "buy") return assignment.missionBuy ? `mission: ${good}` : `warehouse buy: ${good}`;
  if (assignment.role === "sell") return `warehouse sell: ${good}`;
  return good;
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const statusBy = new Map((fleetStatus.ships ?? []).map((s) => [s.symbol, s]));
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = statusBy.get(s.symbol);
    const assignment = dispatchAssignments.find((a) => a.shipSymbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      manual: !!st?.paused,
      job: st?.role === "trader" ? (jobLabel(assignment) ?? "unassigned") : null,
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      condition: worstConditionPct(s) ?? 100,
      waypoint: s.nav?.waypointSymbol ?? "",
      nav: s.nav?.status ?? "",
      stranded: strandedBy.has(s.symbol),
    };
  });
}

function hullCard(row, extraClass) {
  const cls = row.stranded ? " crit" : row.job === "unassigned" ? " warn" : "";
  return `
    <div class="hull ${extraClass}${extraClass === "front" ? cls : ""}">
      <div class="hd"><span class="sym">${escapeHtml(row.symbol)}</span><span class="role">${escapeHtml(row.role)}</span></div>
      ${row.job ? `<div class="job">${row.job === "unassigned" ? "unassigned" : "→ " + escapeHtml(row.job)}</div>` : ""}
      <div class="gauges">
        <div class="gauge-row"><span class="g-k">Fuel</span><div class="g-track"><div class="g-fill${row.fuelCap && row.fuel / row.fuelCap < 0.25 ? " red" : ""}" style="width:${row.fuelCap ? (row.fuel / row.fuelCap) * 100 : 0}%"></div></div><span class="g-v">${row.fuel}/${row.fuelCap}</span></div>
        <div class="gauge-row"><span class="g-k">Hold</span><div class="g-track"><div class="g-fill amber" style="width:${row.cargoCap ? (row.cargo / row.cargoCap) * 100 : 0}%"></div></div><span class="g-v">${row.cargoCap ? `${row.cargo}/${row.cargoCap}` : "—"}</span></div>
        <div class="gauge-row"><span class="g-k">Hull</span><div class="g-track"><div class="g-fill${row.condition < 50 ? " red" : ""}" style="width:${row.condition}%"></div></div><span class="g-v">${row.condition}%</span></div>
      </div>
      <div class="at">${row.stranded ? "STRANDED · " : ""}${escapeHtml(shortWp(row.waypoint))} · ${escapeHtml((row.nav || "idle").replace(/_/g, " ").toLowerCase())}</div>
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

  renderSheet(rows[fleetIndex]);
}

function renderSheet(row) {
  sheetShip = row.symbol;
  $("fleet-sheet").hidden = false;
  $("sheet-who").textContent = row.symbol;
  $("sheet-sub").textContent = `${row.role} · ${(row.nav || "idle").replace(/_/g, " ").toLowerCase()} · ${shortWp(row.waypoint)}`;

  const holdBtn = row.manual
    ? `<button class="btn" data-act="release">Release</button>`
    : `<button class="btn" data-act="hold">Hold</button>`;
  let extra = "";
  if (sendFormOpen) {
    extra += `<div class="sheet-inline-form"><input id="send-wp-input" placeholder="Waypoint, e.g. X1-A-B2" /><button class="btn pri" data-act="send-go">Go</button></div>`;
  }
  if (routePickerOpen) {
    const top = [...dispatchRoutes].sort((a, b) => (b.profitPerTrip ?? 0) - (a.profitPerTrip ?? 0)).slice(0, 4);
    extra += `<div class="route-pick">${
      top.length
        ? top.map((r) => `<button data-act="route-pick" data-good="${escapeHtml(r.good)}"><span>${escapeHtml(r.good)}</span><b>${signed(r.profitPerTrip)}/trip</b></button>`).join("")
        : '<div class="empty">No profitable routes right now.</div>'
    }</div>`;
  }
  $("sheet-actions").innerHTML = `
    <button class="btn" data-act="send-toggle">Send to waypoint</button>
    ${holdBtn}
    <button class="btn" data-act="route-toggle">Assign route</button>
    <button class="btn" data-act="repair">Repair</button>
    <button class="btn deny" data-act="sell">Sell / Scrap</button>
    <button class="btn ghost full" disabled>Full details — coming soon</button>
    ${extra}
  `;
}

$("sheet-actions").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const ship = sheetShip;

  if (act === "send-toggle") { sendFormOpen = !sendFormOpen; routePickerOpen = false; return renderDeck(); }
  if (act === "route-toggle") { routePickerOpen = !routePickerOpen; sendFormOpen = false; return renderDeck(); }

  if (act === "send-go") {
    const wp = $("send-wp-input")?.value.trim();
    if (!wp) return;
    b.disabled = true;
    try {
      await api("POST", "/api/fleet/dispatch", { shipSymbol: ship, waypointSymbol: wp });
      sendFormOpen = false;
      await loadBridge();
    } catch (err) { alert(err.message); }
    return renderDeck();
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
    return renderDeck();
  }
  if (act === "hold" || act === "release") {
    b.disabled = true;
    try { await api("POST", `/api/fleet/${act}`, { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
  if (act === "repair") {
    b.disabled = true;
    try { await api("POST", "/api/fleet/repair", { shipSymbol: ship }); await loadBridge(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
  if (act === "sell") {
    if (!confirm(`Sell ${ship} permanently? It will fly to the nearest shipyard and be scrapped there. This cannot be undone.`)) return;
    b.disabled = true;
    try { await api("POST", "/api/fleet/sell-ship", { shipSymbol: ship }); await loadState(); }
    catch (err) { alert(err.message); }
    return renderDeck();
  }
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
  sendFormOpen = false;
  routePickerOpen = false;
  renderDeck();
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

/* ── Map: a literal radar scope ─────────────
 * Current system only, this pass — see docs/mobile-app-design.md. Real
 * waypoint x/y (state.waypoints) normalized into the scope's circular
 * field; tapping a waypoint opens a bottom sheet with whatever shipyard/
 * module intel is already known for it (intel.shipyards/intel.modules,
 * the same data desktop's Yards & outfitting panel groups — see
 * jobFor()'s sibling there). Buying a ship works directly from the
 * sheet (no ship-context needed); installing a module does, so that
 * stays read-only here for now.
 */
let selectedWaypoint = null;

function blipClass(wp) {
  if (wp.type === "JUMP_GATE") return "gate";
  if ((wp.traits ?? []).includes("SHIPYARD")) return "yard";
  if ((wp.traits ?? []).includes("MARKETPLACE")) return "mkt";
  return "other";
}

/** Real x/y (arbitrary system-coordinate units) centered and scaled to
 *  fit within ~80% of the scope's radius, one shared span for both axes
 *  so the layout isn't stretched. */
function computeMapPositions(waypoints) {
  const pos = new Map();
  if (!waypoints.length) return pos;
  const xs = waypoints.map((w) => w.x), ys = waypoints.map((w) => w.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  for (const w of waypoints) {
    pos.set(w.symbol, { x: 50 + ((w.x - cx) / span) * 80, y: 50 - ((w.y - cy) / span) * 80 });
  }
  return pos;
}

function renderScope() {
  const waypoints = state?.waypoints ?? [];
  $("scope-hd").textContent = state?.systemSymbol
    ? `${state.systemSymbol} · ${waypoints.length} charted`
    : "no system charted yet";

  const pos = computeMapPositions(waypoints);
  const shipsHere = (state?.ships ?? []).filter((s) => s.nav?.systemSymbol === state?.systemSymbol);

  let html = `<div class="ring" style="width:40%;height:40%"></div><div class="ring" style="width:65%;height:65%"></div><div class="ring" style="width:88%;height:88%"></div><div class="sweep"></div>`;
  for (const w of waypoints) {
    const p = pos.get(w.symbol);
    if (!p) continue;
    const sel = selectedWaypoint === w.symbol ? " sel" : "";
    html += `<button class="blip${sel}" style="top:${p.y}%;left:${p.x}%" data-wp="${escapeHtml(w.symbol)}"><span class="mk ${blipClass(w)}"></span><span class="tg">${escapeHtml(shortWp(w.symbol))}</span></button>`;
  }
  for (const s of shipsHere) {
    const p = pos.get(s.nav.waypointSymbol);
    if (!p) continue;
    html += `<div class="blip" style="top:${p.y}%;left:${p.x}%"><span class="mk ship"></span><span class="tg">${escapeHtml(s.symbol)}</span></div>`;
  }
  $("scope-field").innerHTML = html;

  if (selectedWaypoint) renderMapSheet(selectedWaypoint);
}

function renderMapSheet(wpSymbol) {
  const wp = (state?.waypoints ?? []).find((w) => w.symbol === wpSymbol);
  if (!wp) { $("map-sheet").hidden = true; return; }
  $("map-sheet").hidden = false;
  const kind = blipClass(wp);
  const label = kind === "gate" ? "JUMP GATE" : kind === "yard" ? "SHIPYARD" : kind === "mkt" ? "MARKET" : wp.type;
  $("map-loc").innerHTML = `${escapeHtml(wpSymbol)}<small>${escapeHtml(label)}</small>`;

  const yards = intel.shipyards.filter((y) => y.waypointSymbol === wpSymbol);
  const mods = intel.modules.filter((m) => m.waypointSymbol === wpSymbol);
  if (!yards.length && !mods.length) {
    $("map-yards").innerHTML = '<div class="empty">No shipyard/module intel for this waypoint yet.</div>';
    return;
  }
  $("map-yards").innerHTML = [
    ...yards.map((y) => `<div class="yline"><span class="yn">${escapeHtml(y.shipTypeName)}</span><span class="yp">${fmt(y.purchasePrice)}c</span><button class="btn pri" data-buy-ship="${escapeHtml(y.shipType)}" data-yard="${escapeHtml(y.waypointSymbol)}">Buy</button></div>`),
    ...mods.map((m) => `<div class="yline"><span class="yn">${escapeHtml(m.symbol)}</span><span class="yp">${fmt(m.purchasePrice)}c</span></div>`),
  ].join("");
}

$("scope-field").addEventListener("click", (e) => {
  const b = e.target.closest("button.blip[data-wp]");
  if (!b) return;
  selectedWaypoint = b.dataset.wp;
  renderScope();
});
$("map-sheet-close").addEventListener("click", () => {
  selectedWaypoint = null;
  $("map-sheet").hidden = true;
});
$("map-yards").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-buy-ship]");
  if (!b) return;
  b.disabled = true;
  try {
    await api("POST", "/api/fleet/buy", { shipType: b.dataset.buyShip, yardSymbol: b.dataset.yard });
    await loadState();
  } catch (err) { alert(err.message); b.disabled = false; }
});

function mapTabActive() {
  return document.querySelector('.screen[data-screen="map"]')?.classList.contains("on") ?? false;
}
subscribe("markets", () => { if (mapTabActive()) renderScope(); });

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
  renderStatusbar();
}
setInterval(() => {
  if (!authed || document.hidden) return;
  loadState(); loadBridge(); loadApprovals(); loadDispatch();
  if (mapTabActive()) loadMarkets();
}, 15_000);

(async function boot0() {
  const session = await probeSession();
  if (!session.authenticated) return showAuthGate();
  hideAuthGate();
  boot();
})();
