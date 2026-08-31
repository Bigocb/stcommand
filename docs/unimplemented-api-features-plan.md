# Unimplemented API features — implementation plans

Scoped from a diff of the live SpaceTraders OpenAPI spec (v2.3.0, matches the
current server) against `src/core/client.ts`. Three features, ranked by
value: ship repair (real degradation mechanic, currently silently ignored),
supply-chain data (better material sourcing), and a leaderboard/factions page
(informational only). Crew (`ShipCrew`) has no endpoints of its own — it's a
read-only field bundled into `GET /my/ships/{symbol}`, folded into the repair
plan's dashboard work below rather than a separate feature.

---

## 1. Ship condition & repair

### Why
Every ship's frame/engine/reactor carries `condition` (0–1, degrades from
mining/navigating, repairable) and `integrity` (permanent wear, non-
repairable — already typed in `schema.d.ts`, confirmed current). Nothing in
the engine reads `condition` at all. A long-running fleet degrades forever
with no visibility and no automatic recovery — the one gap in this audit
that actually costs something over time, not just missing convenience.

### API surface (both untyped-but-generated, unused)
- `GET /my/ships/{shipSymbol}/repair` — preview repair cost, no side effect.
- `POST /my/ships/{shipSymbol}/repair` — repair to full condition. Requires
  `DOCKED` status at a waypoint with the `SHIPYARD` trait.

### Client layer (`src/core/client.ts`)
Two new methods, mirroring `scrapShip()`'s shape:
```ts
getRepairCost(shipSymbol: string) // GET .../repair -> { transaction: { totalPrice, ... } }
repairShip(shipSymbol: string)    // POST .../repair -> { agent, ship, transaction }
```
Thin `SpaceTradersAPI` wrapper pass-throughs, same as every other method.

### Where the decision lives
A per-tick opportunistic check, not a dedicated agent role — repairing isn't
worth interrupting a working ship's route for except when condition is
genuinely bad. Two tiers:

1. **Opportunistic**: any agent that's already `DOCKED` at a shipyard
   waypoint for another reason (touring, keeper duty, buying) checks its own
   condition and repairs if below the doctrine floor, before moving on.
   Cheapest hook: `ShipAgent.ensureDocked()`/`tourScout()`'s existing
   dock step, same pattern as `recordMarket`/`recordShipyard` already firing
   on dock.
2. **Proactive**: `FleetManager`'s per-tick pass (alongside
   `maybeAssignKeepers`/`maybeBuyShip`) — `maybeRepairFleet()` — scans all
   controlled ships each tick; if any ship's worst component condition drops
   below a second, lower "critical" threshold, route it to the nearest known
   shipyard the way `rescueStranded()` routes a tender, since below that
   point waiting for the ship to happen to dock somewhere isn't safe to rely
   on.

Both tiers read the same doctrine value so there's one dial, not two.

### Doctrine
New rule in `DEFAULTS` (`doctrine.ts`), same shape as `marginFloor`:
```ts
{
  key: "repairConditionFloor",
  name: "Repair floor",
  description: "Repair a ship when its worst component's condition drops below this.",
  value: 0.5, min: 0, max: 1, step: 0.05, unit: "",
  enabled: true, enforced: true,
}
```
A second, non-tunable constant (e.g. 0.2) for the "critical — divert now"
tier, defined alongside `minCashReserve`-style constants rather than exposed
as a dial — an operator shouldn't be tuning how bad is too bad to ignore.

### Cost handling
`recordLedger` already has a `"SHIP"` type used for installs/removals/
purchases — reuse it, `tradeSymbol: undefined`, `total: -cost`. No new
ledger type needed.

### Dashboard
- Ship details panel (`v2.html`, same section as Cargo Hold): a "Condition"
  block showing frame/engine/reactor as three small bars or percentages,
  plus a manual **Repair** button (disabled/greyed if not docked at a
  shipyard, mirroring the Jettison button's confirm-and-post pattern).
  This is also where `ShipCrew` (count, morale, wages) gets surfaced —
  read-only, no endpoint needed, just already-fetched data nobody displays.
- `POST /api/fleet/repair` (dashboard.ts), same shape as `/api/fleet/
  jettison`: `{ shipSymbol }`, calls a new `FleetManager.repairShip()`.
- `FleetManager.repairShip(shipSymbol)`: validates docked-at-shipyard,
  calls `api.repairShip()`, records ledger, `onActivity`.

### Tests
- `FleetManager.repairShip`: rejects when not docked at a shipyard-trait
  waypoint; records the ledger entry; updates cached ship condition.
- `maybeRepairFleet()`: opportunistic repair fires only when already docked
  at a shipyard and below the floor; critical-tier diversion only below the
  lower threshold; both respect `isManual()`/`isSuspended()` the same way
  every other fleet-initiated ship action already does (route through
  `availableFor()`/the registry, not a bespoke check).

### Risk
Low. Additive — no existing behavior changes unless a ship is actually
below the floor. The one thing to get right is not fighting `setShipRole()`/
rescue/mission ownership: `maybeRepairFleet()`'s diversion must claim the
ship through `ShipRegistry` the same way `makeRescuePlan()` does, not just
grab it, or it reintroduces this session's earlier partial-handback bug
class.

---

## 2. Supply chain data

### Why
`GET /market/supply-chain` returns which goods are exports/imports of which
— a static-ish graph of the game's production chains (e.g. what feeds
`FAB_MATS`). `discoverMaterialBuyers()` (fleet.ts) currently has no such map:
when a mission needs a good `materialBuyers()` doesn't already know a seller
for, it blind-surveys up to 6 unknown marketplaces per tick hoping one sells
it — pure trial and error, with no way to know in advance the good isn't
produced anywhere reachable at all.

### API surface
`GET /market/supply-chain` — global, not per-system, effectively static
game-design data (doesn't change between ticks, may change between game
updates). One call, cache aggressively.

### Client layer
```ts
getSupplyChain() // GET /market/supply-chain -> { data: { exportToImportMap: {...} } } (exact shape TBD from a live response — spec's schema wasn't in the fetched reference bundle, confirm against schema.d.ts's generated type before writing this)
```

### Storage
Fetch once at boot (or on a long interval — daily, not per-tick) and cache
in memory on `FleetManager`/`GalaxyAtlas`, not the database — this is
global reference data, not per-tenant state, and doesn't need
`Store`'s tenant-scoping machinery at all. A module-level cache shared
across tenants (same shape as the "shared galaxy tables" comment in
`store.ts`, but simpler — pure in-memory, no persistence needed since
re-fetching once per process lifetime is cheap).

### Consumer: mission material sourcing
In `discoverMaterialBuyers()` (fleet.ts:2220): before blind-surveying,
check the supply chain for what exports feed the needed good's production
(or, if the good itself is a raw export, confirm it actually has a producer
type before spending survey calls looking for one). Two concrete wins:
- Skip the survey batch entirely for a good nothing in the known galaxy
  produces — turn a repeating wasted-API-call loop into one log line
  ("no known producer for X").
  a real "why is this materials request stuck" answer for the dashboard,
  instead of `materialBuyers()` just staying empty forever with no
  explanation (ties into the existing X1-TQ19-I55 mission-status question
  from earlier this session).

### Consumer: UI (optional, low priority)
A small "Supply Chain" lookup in the Markets tab — type a good, see what
it's made from / what it feeds into. Pure convenience, not required for the
sourcing improvement above to work.

### Tests
- Cache: only fetches once per process lifetime (or per configured
  interval), not per call.
- `discoverMaterialBuyers()`: skips the survey batch when the supply chain
  shows no producer path for the requested good; unaffected (same behavior
  as today) when the chain does show one.

### Risk
Low. Purely additive optimization on top of an existing fallback path —
worst case (API call fails, chain not loaded yet) is falling back to
today's blind-survey behavior unchanged.

---

## 3. Leaderboard / factions page (informational)

### Why
User-requested visibility into `GET /agents`, `GET /agents/{symbol}`, and
`GET /factions` — competitor standings and the full faction list. No fleet-
ops decision reads this data; it's a dashboard page, not engine logic.

### API surface
- `GET /agents` (paginated) — public agent list: symbol, credits, ship
  count, starting faction. No auth-sensitive fields.
- `GET /agents/{agentSymbol}` — single public agent lookup.
- `GET /factions` (paginated) — full faction roster: symbol, name,
  description, traits, headquarters, whether it's recruiting.

### Client layer
```ts
getAgents(page?: number, limit?: number)   // GET /agents
getAgent(agentSymbol: string)              // GET /agents/{symbol}
getFactions(page?: number, limit?: number) // GET /factions
```

### Server
- `GET /api/leaderboard` (dashboard.ts) — wraps `getAgents()`, sorted by
  credits server-side (the API's own default ordering isn't guaranteed
  credit-sorted — confirm against a live response; sort defensively either
  way). Cached in-memory with a multi-minute TTL (this doesn't need to be
  fresh every poll, and pagination cost adds up across every tenant's
  dashboard if uncached) — a shared cache is fine here since the data
  itself is public/global, not tenant data (same "shared galaxy table"
  reasoning as markets/shipyards).
- `GET /api/factions` — wraps `getFactions()`, same caching approach
  (factions essentially never change).

### Dashboard
A new tab/section (`v2.html`) — "Galaxy" or reuse the Markets tab's space —
with two panels:
- **Leaderboard**: ranked table, agent symbol / credits / ship count /
  faction. Sortable client-side by whichever column, since the payload's
  small.
- **Factions**: a card per faction — name, description, traits, whether
  recruiting. Static reference info, no per-row action.

No write actions anywhere on this page — confirmed no mutation risk.

### Tests
- Route-level: `GET /api/leaderboard`/`GET /api/factions` return the
  wrapped/cached shape; a second call within the TTL window doesn't re-hit
  the API (assert call count via a fake client).

### Risk
Very low — read-only, no engine interaction, no per-tenant state, easy to
revert by deleting the tab.

---

## Suggested build order
Repair first (real, currently-silent problem) → supply-chain (small,
contained win for an existing pain point from earlier this session) →
leaderboard/factions (pure add-on, do whenever, no dependency on the
other two).
