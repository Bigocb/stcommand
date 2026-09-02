// App state + every load*()/save*() network call, with subscribe() as the
// seam back into each version's own render layer (which can't be imported
// here without a circular dependency — see docs/ui-versions-plan.md §3).
//
// A version's bootstrap code calls subscribe(event, fn) once per event,
// before boot() ever runs, registering the exact render calls that used to
// follow each load inline. Emitting an event with no subscriber is a no-op,
// matching how an unused load path behaved before this split (it just never
// rendered anything either).

import { api } from "./api.js";
import { fmt, escapeAttr, escapeHtml } from "./domain.js";

const $ = (id) => document.getElementById(id);

const listeners = {};
export function subscribe(event, fn) {
  (listeners[event] ??= []).push(fn);
}
function emit(event, payload) {
  for (const fn of listeners[event] ?? []) fn(payload);
}

export function showToastGlobal(message, isError = false) {
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

export let state = null;
export let bridge = { triage: [], earnings: [], shipStatus: [], stranded: [], series: [] };
export let fleetStatus = { paused: false, ships: [], stranded: [], summary: [] };
export let systems = [];
export let jumpConnections = [];
export let currentSystem = "";
export function setCurrentSystem(s) { currentSystem = s; }
export let marketSnapshots = [];
export let marketRoutes = [];
export let marketSystems = [];
export let marketSystemFilter = "";
export let intel = { shipyards: [], modules: [] };
export let activity = [];
export let doctrineRules = [];
export let doctrineCatalog = [];
export let doctrineFires = {};
export let doctrineFireShips = new Map();
export let tradeRoutes = [];
export let dispatchRoutes = [];
export let dispatchAssignments = [];
export let warehouseState = { ship: null, goods: [], totalValue: 0, ledger: [], targets: [] };
export let keeperMarketsCfg = [];
export let keeperStationsCfg = [];
export let keeperCoverList = false;
export let replayByShip = new Map(); // shipSymbol -> [{t, waypointSymbol, status}] sorted by t
export let replayT0 = 0, replayT1 = 0;
export let priceGood = "";
export let lastPricePoints = [];

/* ── loaders ──────────────────────────────── */

export async function loadState() {
  try {
    const res = await fetch("/api/state");
    state = await res.json();
    systems = state.systems ?? [];
    jumpConnections = state.jumpConnections ?? [];
    if (!currentSystem && state.systemSymbol) currentSystem = state.systemSymbol;
    if (systems.length && !systems.find((s) => s.symbol === currentSystem)) currentSystem = state.systemSymbol || systems[0].symbol;
    emit("state");
  } catch (e) { console.error(e); }
}

export async function loadBridge() {
  try {
    const res = await fetch("/api/bridge");
    if (!res.ok) return;
    const data = await res.json();
    if (data.error) return;
    bridge = data;
    fleetStatus = { paused: data.paused, ships: data.shipStatus ?? [], stranded: data.stranded ?? [], summary: data.summary ?? [] };
    emit("bridge");
  } catch (e) { console.error(e); }
}

export async function loadActivity() {
  try {
    const res = await fetch("/api/activity");
    activity = (await res.json()).activity ?? [];
    emit("activity");
  } catch (e) { console.error(e); }
}

export async function loadMarkets() {
  try {
    const qs = marketSystemFilter ? `?system=${encodeURIComponent(marketSystemFilter)}` : "";
    const res = await fetch(`/api/markets${qs}`);
    const data = await res.json();
    if (data.error) return;
    marketRoutes = data.routes ?? [];
    // The chart highlights lanes that are currently worth flying; it reads the
    // older {cheapestMarket, expensiveMarket} shape.
    tradeRoutes = marketRoutes.map((r) => ({ cheapestMarket: r.buyAt, expensiveMarket: r.sellAt }));
    marketSnapshots = data.snapshots ?? [];
    marketSystems = data.systems ?? [];
    intel = { shipyards: data.shipyards ?? [], modules: data.modules ?? [] };
    emit("markets");
  } catch (e) { console.error(e); }
}

export const loadIntel = loadMarkets;

export function onMarketSystemFilterChange(e) {
  marketSystemFilter = e.target.value;
  loadMarkets();
}

export async function loadDispatch() {
  try {
    const res = await fetch("/api/dispatch");
    if (!res.ok) return;
    const data = await res.json();
    dispatchRoutes = data.routes ?? [];
    dispatchAssignments = data.assignments ?? [];
    emit("dispatch");
  } catch (e) { console.error(e); }
}

export async function loadWarehouse() {
  try {
    const res = await fetch("/api/warehouse");
    if (!res.ok) return;
    warehouseState = await res.json();
    emit("warehouse");
  } catch (e) { console.error(e); }
}

export async function loadKeepers() {
  try {
    const res = await fetch("/api/keeper/markets");
    if (!res.ok) return;
    const data = await res.json();
    keeperMarketsCfg = data.markets ?? [];
    keeperStationsCfg = data.stations ?? [];
    keeperCoverList = data.coverList === true;
    emit("keepers");
  } catch (e) { console.error(e); }
}

export async function saveKeepers() {
  const lines = $("keeper-markets").value.split("\n").map((l) => l.trim().toUpperCase()).filter((l) => l.length);
  try {
    const res = await api("POST", "/api/keeper/markets", { markets: lines });
    keeperMarketsCfg = res.markets ?? [];
    showToastGlobal(`Keeper list: ${keeperMarketsCfg.length} markets`);
    await loadKeepers();
  } catch (err) { showToastGlobal(err.message, true); }
}

export async function loadDoctrine() {
  try {
    const res = await fetch("/api/doctrine");
    if (!res.ok) return;
    const data = await res.json();
    doctrineRules = data.rules ?? [];
    doctrineCatalog = data.catalog ?? [];
    await loadDoctrineFires();
    emit("doctrine");
  } catch (e) { console.error(e); }
}

export async function loadDoctrineFires() {
  try {
    const res = await fetch("/api/doctrine/stats");
    if (!res.ok) return;
    doctrineFires = new Map((await res.json()).stats?.map((s) => [s.ruleKey, s]) ?? []);
  } catch (e) { console.error(e); }
}

/** Real per-ship attribution for "this watch" (default 2h) — which hulls
 *  actually fired each rule, not just the count. This is what Book mode's
 *  clause hover pulses on the map; doctrineFires (above) stays the all-time
 *  aggregate the gutter's fire-count numbers come from. */
export async function loadDoctrineFireShips() {
  try {
    const res = await fetch("/api/doctrine/fire-ships?hours=2");
    if (!res.ok) return;
    doctrineFireShips = new Map((await res.json()).ships?.map((s) => [s.ruleKey, s.ships]) ?? []);
  } catch (e) { console.error(e); }
}

export async function saveRule(key, patch) {
  try {
    const res = await api("POST", "/api/doctrine", { key, ...patch });
    doctrineRules = res.rules ?? doctrineRules;
    emit("doctrine");
    const r = res.rule;
    showToastGlobal(`${r.name}: ${r.enabled ? `${fmt(r.value)}${r.unit}` : "off"}`);
  } catch (err) { showToastGlobal(err.message, true); loadDoctrine(); }
}

export async function saveAdopted(key, adopted, value) {
  try {
    const res = await api("POST", "/api/doctrine/adopt", { key, adopted, value });
    doctrineRules = res.rules ?? doctrineRules;
    doctrineCatalog = res.catalog ?? doctrineCatalog;
    emit("doctrine");
    showToastGlobal(adopted ? `${res.rule?.name ?? key} added to standing orders` : `${key} removed from standing orders`);
  } catch (err) { showToastGlobal(err.message, true); loadDoctrine(); }
}

export async function loadReplay() {
  try {
    const res = await fetch("/api/replay?hours=12");
    if (!res.ok) return;
    const data = await res.json();
    const samples = data.samples ?? [];
    replayByShip = new Map();
    for (const s of samples) {
      const t = new Date(s.timestamp).getTime();
      if (!replayByShip.has(s.shipSymbol)) replayByShip.set(s.shipSymbol, []);
      replayByShip.get(s.shipSymbol).push({ t, waypointSymbol: s.waypointSymbol, status: s.status });
    }
    for (const arr of replayByShip.values()) arr.sort((a, b) => a.t - b.t);
    if (samples.length) {
      const allT = samples.map((s) => new Date(s.timestamp).getTime());
      replayT0 = Math.min(...allT);
      replayT1 = Math.max(...allT);
    } else {
      replayT0 = replayT1 = Date.now();
    }
    emit("replay");
  } catch (e) { console.error(e); }
}

export async function loadNarrative() {
  try {
    const res = await fetch("/api/narrative");
    $("narrative").textContent = (await res.json()).log ?? "Awaiting telemetry…";
  } catch (e) { console.error(e); }
}

export async function loadOps() {
  try {
    // dispatchAssignments feeds the "pinned carrier" display in
    // renderContracts(), so refresh it here too — otherwise it's only ever
    // current if the operator has also visited the trade-ops view.
    const [cres, mres] = await Promise.all([fetch("/api/contracts"), fetch("/api/missions"), loadDispatch()]);
    const cdata = cres.ok ? await cres.json() : { contracts: [] };
    const mdata = mres.ok ? await mres.json() : { missions: [] };
    emit("ops", { contracts: cdata.contracts ?? [], missions: mdata.missions ?? [] });
  } catch (e) { console.error(e); }
}

export async function loadGalaxy() {
  try {
    const [board, factions] = await Promise.all([api("GET", "/api/leaderboard"), api("GET", "/api/factions")]);
    emit("galaxy", { agents: board.agents ?? [], factions: factions.factions ?? [] });
  } catch (e) { console.error(e); }
}

export async function loadGoods() {
  try {
    const { goods } = await (await fetch("/api/goods")).json();
    if (!goods?.length) return;
    if (!priceGood || !goods.includes(priceGood)) priceGood = goods[0];
    $("price-good").innerHTML = goods.map((g) =>
      `<option value="${escapeAttr(g)}"${g === priceGood ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
    await loadPrices();
  } catch (e) { console.error(e); }
}

export async function loadPrices() {
  const sel = $("price-good");
  priceGood = sel.value || priceGood;
  if (!priceGood) return;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  try {
    const res = await fetch(`/api/prices?good=${encodeURIComponent(priceGood)}&since=${encodeURIComponent(since)}`);
    lastPricePoints = (await res.json()).points ?? [];
    emit("prices", lastPricePoints);
  } catch (e) { console.error(e); }
}

export async function loadChatHistory() {
  try {
    const res = await fetch("/api/chat/history");
    const { messages } = await res.json();
    if (!messages?.length) return;
    emit("chatHistory", messages);
  } catch (e) { console.error(e); }
}

export function loadMobilePanels() {
  loadMarkets();
  loadDispatch();
  loadWarehouse();
  loadOps();
  loadDoctrine();
}
