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

/* ── subscriptions ────────────────────────────────────────── */

/** slice -> callbacks. Slices: state, bridge, activity, markets, doctrine. */
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
