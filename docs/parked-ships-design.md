# Parked ships — design (2026-10-19)

**Status:** design settled 2026-10-19 (all decisions in §10 resolved).
Implemented 2026-10-22: slices 1 to 3 (schema and boot restore, `parkShip` / `unparkShip`,
the exclusions) and the MCP half of slice 4 (`stcommand_park_ship`, `stcommand_unpark_ship`,
ops `parked`). Not built: the HTTP routes, the Deck park/unpark buttons and the
"calls saved" counter, and the live one-hour verification (slice 5).

Two additions beyond the original design, made when parking was put to use on keepers:
a parked keeper remembers its market (`fleet_state.keeper_market`, kept while parked) and
still counts as covering it, so the keeper queue does not buy a second probe for it, while it
no longer counts against `keeperMaxTotal` or polls; and the reset wind-down never scraps a
parked hull, which means a parked hull is lost at the reset unless it is unparked first.

A mode for hulls we do not want to sell or scrap yet, that should sit still and
cost as few game-API calls as possible.

## 1. Problem, stated in calls

The tenant shares one `RateLimiter` at **1.5 req/s** (`src/core/client.ts:509`,
`src/engine/tenantRegistry.ts:122`) — roughly **90 calls/min, 5,400/hour** for
the whole fleet.

Today there are three ways a hull can be "not doing work", and only one of them
is cheap:

| State today | Calls/ship/hour | What it actually costs |
|---|---|---|
| In a role map, working | bursts; bounded by the scheduler budget | fine, it earns |
| **Operator hold** (`holdShip`) | **~120** | a `getShip` every 30 s, forever |
| `idleShips` (no agent) | 0 | **not persisted, not protected** |

The hold is expensive because a held ship is still an agent with a live task
chain: `runHoldGoal()` opens with `await this.refresh()` (`shipProxy.ts:753`) —
one `GET /my/ships/:id` — then reports "no work", and the chain re-arms 30 s
later (`trader.ts:3156`, `agent.ts:2216`). It also re-docks at a market every
15 min to re-record prices (`shipProxy.ts:792`).

So 10 hulls kept as holds burn **~1,200 calls/hour — 23% of the entire tenant
budget** — doing nothing, *and* each one is a priority-2 task re-admitted into
`Scheduler.runOnce()` every 30 s, competing with real trading work.

`idleShips` is the opposite extreme: zero calls because there is no agent at
all. But it is the wrong shelf to park things on deliberately:

- **Nothing persists.** Roles are not stored for idle ships, so on the next boot
  `init()` calls `assignRole(ship)` on anything it cannot derive a role for
  (`fleet.ts:827-829`) and the hull is re-hulled into miner/trader/keeper.
- **No protection.** It is not in `manualRoleShips`, so promotion, keeper
  conversion and `autoExplore` borrowing all consider it fair game.
- **Not visible.** `getShipStatuses()` reports idle ships with a synthetic
  `status: "IDLE"` and no waypoint, fuel or cargo (`fleet.ts:7230`).

Parked is the missing middle: **an operator decision that persists, is visible,
is protected from every automatic controller, and costs zero calls.**

## 2. What "parked" means

Non-goals first, because they define the mechanism:

- **Not a hold.** A hold still runs an agent, on purpose: it flies the hull to
  the target waypoint and keeps re-checking. Parked never flies and never
  re-checks.
- **Not a sale.** Nothing is scrapped, sold or jettisoned. The hull stays owned.
- **Not suspension.** `suspended` is a subsystem's temporary borrow
  (mission/feed/rescue); parked is an operator's standing decision.

Definition:

> A parked ship has **no agent, no task chain, and no claim of its own on any
> automatic system**. It stays where it is, keeps whatever is in its hold, and
> costs no game-API calls until it is unparked.

Parking is always reversible and never lossy: unpark restores the role the hull
had when it was parked.

## 3. Representation

**One source of truth: `fleet_state.role = 'parked'`.**

`fleet_state` (`migrations/001_init.sql:169`) already exists, is tenant-scoped
with RLS, is written by `setShipRole()` (`fleet.ts:4512`) and is replayed at
boot by `restorePersistedManualRoles()` (`fleet.ts:2764`). Membership in
`MANUAL_ROLES` (`fleet.ts:225`) is what makes a persisted role survive both
`init()`'s hasty `assignRole()` pass (`fleet.ts:817`) and the "anything still
idle gets a derived role" sweep (`fleet.ts:827`).

So adding `"parked"` to `ManualRole` gives us persistence, boot restore and
repurposing protection from machinery that already exists and is already
tested. No second flag, no parallel bookkeeping.

Two supporting pieces:

- `parkedShips: Map<string, Ship>` in `FleetManager` — the last-known ship
  object, so the dashboard can show waypoint/fuel/cargo without an API call.
  This replaces the agent as the owner of that snapshot.
- `fleet_state.parked_from text` (new column, migration `057`) — the role to
  restore on unpark. Null-tolerant: a row with no `parked_from` unparks through
  `assignRole(ship)` like a fresh hull.

## 4. Lifecycle

### park(shipSymbol, { dock = true })

1. Resolve the ship: `shipFor()` if it has an agent, else `parkedShips`, else
   one `getShip` (only case that costs a call).
2. **Refuse** if it is currently a live rescue tender (`rescuePlans`) — that is
   a hull in flight under a subsystem's direct control, and pulling it mid-trip
   strands whoever it was going to help. Refuse with a clear message.
3. **Release it from any crew that drives it by raw API calls**: a feed carrier
   (`feeds.removeCarrier` / `fleet.removeFeedCarrier`, `fleet.ts:6267`) and a
   mission carrier (`missions.removeCarrier`, `mission.ts:462`). These two
   subsystems do not go through role maps at all — clearing role maps alone
   leaves the feed still driving the ship. Report what was released.
4. **Clear the manual state** for this ship (`updateShipManualState` with
   `holdWaypoint`, `minePin`, `scrapAt`, `tourDestination` all null). This is
   load-bearing: `init()` replays `holdWaypoint` at boot (`fleet.ts:912`) and
   would re-hold a parked ship, and a stale `scrapAt` would send it to a yard.
5. `clearRoleMaps(shipSymbol)` — stops the agent and drops its dispatcher route
   the same way a role change does (`fleet.ts:2791`).
6. `parkedShips.set(symbol, snapshot)`; `shipRegistry.claim(symbol, "operator",
   "parked", ..., { preempt: true })`.
7. Persist `fleet_state` = `{ role: 'parked', parked_from: roleOf(ship) }`.
8. If `dock` and the hull is `IN_ORBIT` at a market or shipyard, one `dock`
   call. That is the **only** API call parking ever makes. Skipped when
   `IN_TRANSIT` (see §6) or already docked.
9. `updateShipState(..., "parked", waypoint)`, log, and record an
   `operator_actions` row so it shows on the timeline.

**In transit:** allowed. The hull finishes the leg the game already started,
lands, and stays there in orbit. Zero calls. The UI says
`parked at <waypoint> (in orbit)`. Refusing would be worse: the operator would
have to wait for an arrival they cannot control, and the alternative — parking
after arrival — needs a live task chain, i.e. exactly the calls we are removing.

**With cargo:** allowed, and reported (`{"cargoUnits": 80, "cargoValue": …}`).
The hold is frozen; nothing sells it. That is the operator's call, but it must
be said out loud rather than discovered later.

### unpark(shipSymbol, role?)

1. Forget the parked snapshot; clear the registry claim.
2. Target role = explicit `role` argument, else `parked_from`, else
   `assignRole(ship)`.
3. `installRoleAgent(ship, target)` + `manualRoleShips.add` (when the role was
   explicit or remembered), persist `fleet_state` back to that role, clear
   `parked_from`, and enqueue the agent's first task if the fleet is running —
   the same tail `setShipRole()` already runs (`fleet.ts:4516`).
4. Refuse with guidance if `parked_from` is `warehouse`/`keeper` and the
   market/binding is gone — fall back to derived role rather than throwing.

`unpark` costs **one** `getShip` if the snapshot is older than the park (it is
not, unless the game moved the hull; a parked hull cannot move), so in practice
zero.

## 5. Every place a parked ship must be excluded

This is the real work. Each row is a subsystem that could otherwise act on a
hull with no agent, and the mechanism that already exists to exclude it:

| Subsystem | Where | How parked is excluded |
|---|---|---|
| Route dispatch | `dispatcherTraders()` `fleet.ts:1433` | not in `this.traders` |
| Mission carrier pick | `availableFor("mission")` `fleet.ts:6461` | registry claim `operator` outranks `mission` |
| Feed carrier pick | `availableFor("feed")` | same |
| Keeper conversion | `availableFor("keeper")` `fleet.ts:8502` | same |
| Rescue tender pick | `availableFor("rescue")` `fleet.ts:9098` | same |
| Stranded detection | `getStrandedShips()` `fleet.ts:7891` | iterates role maps only |
| Repair routing | `availableFor("repair")` `fleet.ts:8755` | same as rescue |
| autoExplore borrow | tour/scout maps | not in either |
| Role promotion at boot | `fleet.ts:831,846` | filtered by `persistedRoleOverrides` |
| **Reset wind-down scrap** | `shipsToRetire()` `windDownScrap.ts:62` | **needs an explicit `role !== "parked"`** |
| Boot hold replay | `fleet.ts:912` | manual state is cleared on park |
| Claim mirror | `syncShipClaims()` owner derivation, `fleet.ts:7699` | **needs `s.role === "parked" → "operator"`, or the mirror relabels it `auto` every tick** |
| Fleet status | `getShipStatuses()` `fleet.ts:7218` | **new parked branch, with real nav from `parkedShips`** |
| Ship state row | `syncShipStates()` `fleet.ts:7464` | **new `"parked"` state** |
| Attention feed | `attention.ts:82` | parked not in `ACTIVE_ROLES` → no "quiet"/"no_route"; add a `parked` info reason and suppress `low_fuel` |

The wind-down row is the one that would hurt most: `shipsToRetire()` currently
queues everything whose role is not `trader`, and the only thing that saves a
deliberately held hull is `if (this.operatorHolds.has(symbol)) continue`
(`fleet.ts:8721`). A parked ship has no `operatorHolds` entry, so without an
explicit exclusion **the reset would sell the ships the operator parked to keep.**

## 6. Operator surface

MCP (new, unambiguous pair — deliberately *not* a new value on
`stcommand_set_ship_role`, because parking has side effects that tool must not
trigger silently):

- `stcommand_park_ship(shipSymbol, dock?)` → `{ parked, at, docked, released:{feeds,missions}, cargoUnits, cargoValue }`
- `stcommand_unpark_ship(shipSymbol, role?)` → `{ unparked, role }`

HTTP + dashboard (`public/deck.js`):

- `POST /api/park` `{ shipSymbol, dock }` and `POST /api/unpark` `{ shipSymbol, role }`
  in `src/http/dashboard.ts`, following `/api/role`'s existing shape.
- Fleet table: a `parked` badge, a **Park** action next to Hold/Release, and an
  **Unpark** action that names the role it will restore ("Unpark → miner").
- Header counter: `N parked · ~X calls/hr saved` — the number is
  `parkedCount × 120 + dockRescans`, computed, not a guess.
- The role `<select>` does **not** gain `parked`; parking is the button.

## 7. Failure modes to design against

1. **Parked but still driven.** A feed/mission crew member keeps buying and
   selling because crews bypass role maps. → step 4 of park releases crews, and
   the response names what was released.
2. **Parked but scrapped at reset.** → explicit `parked` exclusion in
   `shipsToRetire()`, unit-tested.
3. **Parked but re-hulled on restart.** → `fleet_state.role`, `MANUAL_ROLES`.
   Verified by a boot test, not by inspection.
4. **Parked but claimed `auto`.** → `syncShipClaims()` branch; otherwise the
   dashboard's owner column lies and a later phase that trusts the registry
   would treat it as free.
5. **Parked but flagged "quiet"/"stranded" every hour.** → attention + stranded
   exclusions above, or the operator learns to ignore the attention feed.
6. **Unpark restores a role that no longer makes sense** (keeper with no market,
   warehouse binding sold). → fall back to `assignRole()`, log why.

## 8. Slices (tracer bullets)

1. **Schema + persistence**: `"parked"` in `ManualRole`/`ShipRole`, migration
   `057` (`parked_from`), `installRoleAgent` case, `roleOf`, `restorePersistedManualRoles`
   handling, `parkedShips` map. Boot test: park → restart → still parked.
2. **Engine park/unpark**: `parkShip`/`unparkShip` with crew release + manual
   state clear + optional dock; `getShipStatuses`/`syncShipStates`/`syncShipClaims`
   branches.
3. **Exclusions**: `shipsToRetire`, attention, stranded — each with a unit test.
4. **Surface**: MCP tools, HTTP routes, deck buttons, saved-calls counter.
5. **Verification**: the call-count test below, then a live park of one hull for
   an hour with the ledger showing 0 calls from it.

## 9. Test plan

- **Unit**: pure helpers — `shipsToRetire` with a parked role; the new claim
  derivation (table-driven over `{role, paused, committed…}`); `parked_from`
  unpark resolution.
- **Integration**: fake API + scheduler; park a trader, run 20 ticks, assert
  `api.getCallCount()` does not increase **and** the scheduler has no task for
  that symbol. This is the actual promise of the feature and it is measurable.
- **Boot**: `fleet_state` row `parked` → `init()` → `roleOf === "parked"`,
  no agent, no chain, `parked_from` intact.
- **Regression**: wind-down with a parked hull → not in `retireQueue`, not sold.
- **Live**: park one hull, watch `ops_instances`/ledger call counts for an hour,
  confirm zero calls attributable to it, unpark, confirm it resumes its role.

## 10. Decisions (settled 2026-10-19)

| # | Question | Decision |
|---|---|---|
| D1 | Dock on park, or never dock? | **Dock** when the hull is `IN_ORBIT` at a market or shipyard — one call, and a docked hull is unambiguous. Nothing is called when it is already docked or in transit. |
| D2 | Remember `parked_from`, or re-derive on unpark? | **Remember.** "Unpark" means "resume", not "guess". `assignRole()` is only the fallback when `parked_from` is null or no longer resolvable (a keeper whose market is gone). |
| D3 | Park a hull carrying cargo? | **Allow**, and report `cargoUnits` + `cargoValue` in the park response. The hold is frozen; nothing sells it. |
| D4 | Park a hull mid-feed/mission crew? | **Allow**, release it from the crew, and report what was released. These subsystems drive ships through raw API calls, so clearing role maps alone would leave the feed still steering it. |
| D5 | Park a hull in transit? | **Allow.** The game finishes the leg it already started, the hull lands and sits in orbit. Zero calls, and no task chain is needed to make that happen. |
| D6 | Do parked hulls still count toward fleet credits/cargo value? | **Yes** — they are capital, not deleted. Surface them separately ("N parked, Xc idle") rather than folding them into working-fleet totals. |

A park that hits a live rescue tender is the one refusal: that hull is mid-trip
under a subsystem's direct control, and pulling it strands whoever it was going
to help. Everything else is reversible and reported.
