/**
 * Server state and the fetches that fill it, shared by every UI version.
 *
 * The exported bindings are live: an importer writing
 * `import { state } from "/shared/store.js"` sees each new value as the
 * loaders assign it, with no getter call and no change at the ~200 read
 * sites across a version's render layer. That is the whole reason the state
 * moved here as bindings rather than behind an accessor object.
 *
 * The corollary is that importers cannot *assign* them — ES live bindings
 * are read-only outside their module. Everything that mutates this state
 * therefore lives here too, which is the discipline that keeps four UIs
 * from drifting: a version can read and can ask for a reload, but cannot
 * quietly hold its own copy.
 *
 * ── Why subscribe() rather than calling renderers directly ──
 *
 * In v2 every loader ended by calling the specific renderers its data fed —
 * loadState() alone called six. Those names mean nothing to v3/v4/v5, which
 * draw the same data completely differently. So loaders announce *which
 * slice changed* and each version maps slices to its own rendering.
 *
 * Slices are typed rather than one global "something changed" for a
 * concrete reason: a single notification would make every version re-render
 * everything on every poll, which is both more work and a behaviour change.
 * The slice names below preserve v2's existing mapping exactly.
 *
 * ── What deliberately is not here ──
 *
 * View state — which system you are looking at, which tab is open, the
 * Markets system filter — stays with the version. It is a property of the
 * window, not of the fleet, and two versions open side by side would
 * legitimately disagree about it. Where a loader needs it (the Markets
 * filter becomes a query parameter) it is passed in as an argument.
 */

/* ── server state ─────────────────────────────────────────── */

export let state = null;
export let systems = [];
export let jumpConnections = [];

export let bridge = { triage: [], earnings: [], shipStatus: [], stranded: [], series: [] };
export let fleetStatus = { paused: false, ships: [], stranded: [], summary: [] };

export let activity = [];

export let marketSnapshots = [];
export let marketRoutes = [];
export let marketSystems = [];
export let tradeRoutes = [];
export let intel = { shipyards: [], modules: [] };

export let doctrineRules = [];
export let doctrineCatalog = [];
export let doctrineFires = new Map();
export let doctrineFireShips = new Map();

/* The view-specific state. These arrived here late: the seven loaders
   above were extracted in Phase 0, and the ten below stayed behind in
   every version's own file — so by the time v5 and v4 existed, each of
   them was duplicated four times over. The duplication was invisible
   while it was one file, and unmaintainable the moment it was four. */

export let dispatchRoutes = [];
export let dispatchAssignments = [];

/* The same empty shape the renderers assume, not null: they read
   .goods/.ledger/.targets directly, and a null here would make the first
   paint before any fetch throw rather than draw an empty warehouse. */
export let warehouseState = { ship: null, goods: [], totalValue: 0, ledger: [], targets: [] };

export let keeperMarketsCfg = [];
export let keeperStationsCfg = [];
export let keeperCoverList = false;

/** shipSymbol -> [{t, waypointSymbol, status}], sorted by time. */
export let replayByShip = new Map();
export let replayT0 = 0;
export let replayT1 = 0;

export let priceGoods = [];
export let pricePoints = [];

export let contracts = [];
export let missions = [];

export let leaderboard = [];
export let factions = [];

export let narrative = "";
export let chatHistory = [];

/* ── subscriptions ────────────────────────────────────────── */

/** slice -> callbacks.
 *
 * Slices: state, bridge, activity, markets, doctrine, dispatch, warehouse,
 * keepers, replay, prices, programme, galaxy, narrative, chat. */
const subscribers = new Map();

/** Register `cb` to run after `slice` is refreshed. Returns an unsubscribe. */
export function subscribe(slice, cb) {
  if (!subscribers.has(slice)) subscribers.set(slice, new Set());
  subscribers.get(slice).add(cb);
  return () => subscribers.get(slice)?.delete(cb);
}

/**
 * One subscriber throwing must not stop the others — they are independent
 * render paths, and a broken panel should not blank the rest of the page.
 */
function notify(slice) {
  for (const cb of subscribers.get(slice) ?? []) {
    try { cb(); } catch (err) { console.error(`subscriber for "${slice}" failed`, err); }
  }
}

/* ── loaders ──────────────────────────────────────────────── */

export async function loadState() {
  try {
    const res = await fetch("/api/state");
    state = await res.json();
    systems = state.systems ?? [];
    jumpConnections = state.jumpConnections ?? [];
    notify("state");
  } catch (e) { console.error(e); }
}

export async function loadBridge() {
  try {
    const res = await fetch("/api/bridge");
    if (!res.ok) return;
    const data = await res.json();
    if (data.error) return;
    bridge = data;
    fleetStatus = {
      paused: data.paused,
      ships: data.shipStatus ?? [],
      stranded: data.stranded ?? [],
      summary: data.summary ?? [],
    };
    notify("bridge");
  } catch (e) { console.error(e); }
}

export async function loadActivity() {
  try {
    const res = await fetch("/api/activity");
    activity = (await res.json()).activity ?? [];
    notify("activity");
  } catch (e) { console.error(e); }
}

/**
 * `systemFilter` is the version's own Markets filter, passed in rather than
 * read from here — see the header. Empty string means every system.
 */
export async function loadMarkets(systemFilter = "") {
  try {
    const qs = systemFilter ? `?system=${encodeURIComponent(systemFilter)}` : "";
    const res = await fetch(`/api/markets${qs}`);
    const data = await res.json();
    if (data.error) return;
    marketRoutes = data.routes ?? [];
    // The map's lane overlay reads the older {cheapestMarket, expensiveMarket}
    // shape; derived here so every version gets it without repeating the map.
    tradeRoutes = marketRoutes.map((r) => ({ cheapestMarket: r.buyAt, expensiveMarket: r.sellAt }));
    marketSnapshots = data.snapshots ?? [];
    marketSystems = data.systems ?? [];
    intel = { shipyards: data.shipyards ?? [], modules: data.modules ?? [] };
    notify("markets");
  } catch (e) { console.error(e); }
}

export async function loadDoctrine() {
  try {
    const res = await fetch("/api/doctrine");
    if (!res.ok) return;
    const data = await res.json();
    doctrineRules = data.rules ?? [];
    doctrineCatalog = data.catalog ?? [];
    await loadDoctrineFires();
    notify("doctrine");
  } catch (e) { console.error(e); }
}

export async function loadDoctrineFires() {
  try {
    const res = await fetch("/api/doctrine/stats");
    if (!res.ok) return;
    doctrineFires = new Map((await res.json()).stats?.map((s) => [s.ruleKey, s]) ?? []);
  } catch (e) { console.error(e); }
}

export async function loadDoctrineFireShips() {
  try {
    const res = await fetch("/api/doctrine/fire-ships?hours=2");
    if (!res.ok) return;
    doctrineFireShips = new Map((await res.json()).ships?.map((s) => [s.ruleKey, s.ships]) ?? []);
  } catch (e) { console.error(e); }
}

/* ── view-specific loaders ────────────────────────────────────
   Same contract as the seven above: fetch, assign, announce a slice.
   Each of these was defined identically in v2.js, v3.js, v4.js and
   v5.js, which is the exact duplication the plan's definition of done
   forbids — the ones extracted in Phase 0 were only the ones the Bridge
   happened to need. */

export async function loadDispatch() {
  try {
    const res = await fetch("/api/dispatch");
    if (!res.ok) return;
    const data = await res.json();
    dispatchRoutes = data.routes ?? [];
    dispatchAssignments = data.assignments ?? [];
    notify("dispatch");
  } catch (e) { console.error(e); }
}

export async function loadWarehouse() {
  try {
    const res = await fetch("/api/warehouse");
    if (!res.ok) return;
    warehouseState = await res.json();
    notify("warehouse");
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
    notify("keepers");
  } catch (e) { console.error(e); }
}

export async function loadReplay() {
  try {
    const res = await fetch("/api/replay?hours=12");
    if (!res.ok) return;
    const samples = (await res.json()).samples ?? [];
    replayByShip = new Map();
    for (const s of samples) {
      const t = new Date(s.timestamp).getTime();
      if (!replayByShip.has(s.shipSymbol)) replayByShip.set(s.shipSymbol, []);
      replayByShip.get(s.shipSymbol).push({ t, waypointSymbol: s.waypointSymbol, status: s.status });
    }
    for (const arr of replayByShip.values()) arr.sort((a, b) => a.t - b.t);
    if (samples.length) {
      const allT = samples.map((x) => new Date(x.timestamp).getTime());
      replayT0 = Math.min(...allT);
      replayT1 = Math.max(...allT);
    } else {
      replayT0 = replayT1 = Date.now();
    }
    notify("replay");
  } catch (e) { console.error(e); }
}

/** The list of tradeable goods, for the price chart's picker. */
export async function loadGoods() {
  try {
    const { goods } = await (await fetch("/api/goods")).json();
    if (!goods?.length) return;
    priceGoods = goods;
    notify("prices");
  } catch (e) { console.error(e); }
}

/**
 * The 48-hour price series for one good.
 *
 * `good` is passed in rather than read from a select element: which good
 * is charted is view state — a property of the window, not of the fleet —
 * and reading it from the DOM here would tie the store to one version's
 * markup. Same reasoning as loadMarkets()' systemFilter.
 */
export async function loadPrices(good) {
  if (!good) return;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  try {
    const res = await fetch(`/api/prices?good=${encodeURIComponent(good)}&since=${encodeURIComponent(since)}`);
    pricePoints = (await res.json()).points ?? [];
    notify("prices");
  } catch (e) { console.error(e); }
}

/**
 * Contracts and missions.
 *
 * Also refreshes dispatch, because the pinned-carrier display in the
 * contracts panel reads dispatchAssignments — without this it is only ever
 * current if the operator has already visited Trade Ops.
 */
export async function loadProgramme() {
  try {
    const [cres, mres] = await Promise.all([
      fetch("/api/contracts"), fetch("/api/missions"), loadDispatch(),
    ]);
    contracts = cres.ok ? (await cres.json()).contracts ?? [] : [];
    missions = mres.ok ? (await mres.json()).missions ?? [] : [];
    notify("programme");
  } catch (e) { console.error(e); }
}

export async function loadGalaxy() {
  try {
    const [board, facs] = await Promise.all([
      fetch("/api/leaderboard").then((r) => r.json()),
      fetch("/api/factions").then((r) => r.json()),
    ]);
    leaderboard = board.agents ?? [];
    factions = facs.factions ?? [];
    notify("galaxy");
  } catch (e) { console.error(e); }
}

export async function loadNarrative() {
  try {
    const res = await fetch("/api/narrative");
    narrative = (await res.json()).log ?? "";
    notify("narrative");
  } catch (e) { console.error(e); }
}

export async function loadChatHistory() {
  try {
    const { messages } = await (await fetch("/api/chat/history")).json();
    chatHistory = (messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
    notify("chat");
  } catch (e) { console.error(e); }
}

/**
 * Adopt the doctrine a mutation just returned, without a second round trip.
 *
 * POST /api/doctrine and /api/doctrine/adopt both answer with the full
 * updated rule set, so a version's save handler can hand it straight back
 * instead of re-fetching. It exists because the live bindings above are
 * read-only to importers: the save handler owns the toast and the
 * re-render, but not the state.
 */
export function setDoctrine(rules, catalog) {
  if (rules) doctrineRules = rules;
  if (catalog) doctrineCatalog = catalog;
  notify("doctrine");
}
