# Deck Markets — build spec (pass 3, low-context build)

**Audience note**: written to be followed literally, same as
`docs/deck-desktop-design.md` (pass 1, Overview) and
`docs/deck-fleet-design.md` (pass 2, Fleet). Every data field named below
has been checked against real code (`public/v6.js`,
`public/shared/store.js`) as of 2026-09-19 — don't re-derive field names
from the mockup's static numbers. If something here is wrong (a function
renamed, a field gone), stop and say so rather than improvising.

## 0. Context

Deck's Overview and Fleet screens have shipped. The design mockup
(`https://claude.ai/artifact/VrRF7Uucw4MqZGGdD93VyV`, "Deck Command
Console") has a Markets & Trade screen (screen 03) that merges v6's
separate Markets tab and Trade Ops tab into one four-panel workspace:
Routes, Yards & outfitting, Warehouse, Dispatch. This pass builds that.

## 1. Scope of THIS pass

Build, inside the existing `<div class="content" id="view-markets" hidden>`
placeholder in `public/deck.html`, a 2x2 grid (mockup's `.mgrid`, already
un-added to `deck.css` — add it, see §4) of four read-only panels:

- **Routes**: the fleet's current best profitable routes, one row per
  good, sorted by profit-per-trip (highest first).
- **Yards & outfitting**: cheapest known price per ship type across every
  scouted shipyard.
- **Warehouse**: goods currently on the warehouse's books, with total
  value.
- **Dispatch**: which trader is running which route right now.

All four panels are **read-only display** this pass — no buy/assign/edit
actions, no dropdowns, no forms. v6's Markets/Trade Ops tabs have buy
buttons, dispatch-assignment forms, and warehouse ship designation
controls; none of that is in scope here. This mirrors Fleet pass 2's own
discipline (cut multi-select/bulk actions, ship first with plain display).

**Cut entirely from this pass** (do not build, do not stub):
- Buy-ship / buy-module buttons (Yards panel in v6 has these; Deck's
  version is informational only this pass).
- Manual dispatch-assignment form (ship/good dropdowns + assign button).
- Warehouse ship designation control.
- The mockup's implied but non-interactive route/good click-through (no
  detail drill-down panel this pass — that's what Fleet's own detail
  panel pattern would extend to on a later pass, not this one).

## 2. Hard requirement: reuse, don't reinvent

Same rule as passes 1-2. `deck.js` already imports `state`, `bridge`,
`subscribe`, `loadState`, `loadBridge`, `loadApprovals`, `loadDispatch`,
`loadActivity` from `/shared/store.js` for Overview, and `dispatchAssignments`
was added for Fleet. This pass needs three more reactive values that
`public/shared/store.js` already exports (confirm the exact export names
in that file before using them — check it directly, the names below are
what `v6.js` imports, not necessarily the literal `shared/store.js` export
names verbatim):

- `marketRoutes` — the fleet's scored trade routes (same data v6.js's own
  `renderRoutes()` at `public/v6.js:1937` reads).
- `intel` — an object carrying `intel.shipyards[]` (same data v6.js's
  `renderShipyardIntel()` at `public/v6.js:5441` reads).
- `warehouseState` — `{ship, totalValue, goods[]}` (same data v6.js's
  `renderWarehouse()` at `public/v6.js:529` reads).

Check `public/v6.js`'s own top-of-file import block (search for where it
imports `marketRoutes`, `intel`, `warehouseState`) to find which loader
function(s) populate them (likely `loadGoods()` for routes/intel,
`loadWarehouse()` for warehouse state) and add those loader calls to
`deck.js`'s boot sequence and/or its `subscribe(...)` wiring, following
whatever pattern Overview/Fleet already established for `loadDispatch()`.
Do not add a new loader function of your own — call the existing ones.

## 3. Data binding — mirror `public/v6.js`'s own render functions

### Routes panel

Reuse `marketRoutes[]` directly (no need to duplicate `renderRoutes()`'s
full logic — its cross-system/misleading-margin callouts are v6-specific
extras, not needed here). For each of the top 5 entries (sorted by
`profitPerTrip` descending — `marketRoutes` is very likely already sorted
this way per `renderRoutes()`'s own "top route gets the hot glow" comment
at `v6.js:458`, but sort defensively rather than assume):

| Mockup element | Real source |
|---|---|
| Good name | `r.goodSymbol` |
| Route (`D46 → I59`) | `${r.buyAt} → ${r.sellAt}` (full waypoint symbols — don't attempt v6's `shortWp()` abbreviation helper unless it's trivially importable from `shared/domain.js`; check first, use full symbols if not) |
| Profit | `signed(r.profitPerTrip)` (import `signed` from `/shared/domain.js`, already used elsewhere in this codebase for signed currency) |

### Yards & outfitting panel

Reuse `intel.shipyards[]`. Group by `shipType`, take the cheapest
(`purchasePrice` ascending) entry per type, sort groups by that cheapest
price ascending, show the top 5 groups:

| Mockup element | Real source |
|---|---|
| Ship type name | `best.shipTypeName` |
| Location | `best.waypointSymbol` |
| Price | `fmt(best.purchasePrice)` + "c" (import `fmt` from `/shared/domain.js`) |

Drop v6's "also: 3 alternate locations" sub-line and its buy buttons —
just the cheapest location per type, per §1's read-only scope.

### Warehouse panel

Reuse `warehouseState` directly:

| Mockup element | Real source |
|---|---|
| Panel subtitle (`X1-BY69-D46 · 4 goods`) | `${warehouseState.ship?.waypointSymbol ?? "no ship designated"} · ${warehouseState.goods.length} goods` |
| Good rows | one per `warehouseState.goods[]` entry: `{name: g.goodSymbol, qty: ...}` — check the exact field `v6.js`'s `renderWarehouse()` uses for quantity (grep for `warehouseState.goods` around `v6.js:570-583`) rather than guessing a `units`/`quantity` field name |
| Total value | `fmt(warehouseState.totalValue)` + "cr" |

If `warehouseState.ship` is null/undefined, still render the goods list
(per v6's own behavior — bookkeeping-only goods still display, just with
a caveat) but skip the mockup's warning callout — that's an editorial
addition v6 makes for its own writable warehouse-ship-picker flow, not
needed for a read-only display.

### Dispatch panel

Reuse `dispatchAssignments[]` (already imported in `deck.js` per pass 2's
Fleet work):

| Mockup element | Real source |
|---|---|
| Ship | `a.shipSymbol` |
| Job text | reuse Fleet's own `jobFor(a.shipSymbol, "trader")`-equivalent logic, OR simpler: derive directly from `a.role`/`a.good` the same way `jobFor()` already does (it's already duplicated into `deck.js` from pass 2 — call it, don't re-derive) |

Show up to 5 rows. If `dispatchAssignments` is empty, show
"No traders assigned routes yet." (matches v6's own empty-state string at
`v6.js:505`).

## 4. CSS to add to `public/deck.css`

```css
.mgrid{flex:1;display:grid;grid-template-columns:1.3fr 1fr;grid-template-rows:1fr 1fr;gap:14px;min-height:0}
.goodrow{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,199,120,.06);font-size:11.5px}
.goodrow .name{font-family:var(--mono);color:var(--bone)}
.goodrow .route{font-size:10px;color:var(--dim)}
.profit{font-family:var(--mono);font-weight:600;color:var(--green)}
```

(`.panel`/`.panel-h`/`.panel-b` already exist in `deck.css` from Overview
— reuse them for each of the four Markets panels, same as Overview's own
two `cols2` panels.)

## 5. Build sequence

1. In `public/deck.html`, replace the placeholder line:
   `<div class="content" id="view-markets" hidden><div class="empty">Markets — coming soon.</div></div>`
   with a `.mgrid` containing four `.panel` blocks (Routes, Yards &
   outfitting, Warehouse, Dispatch), each with a `.panel-h` title and a
   `.panel-b` body populated by JS.
2. Add the CSS from §4 to `public/deck.css`.
3. In `public/deck.js`: confirm which loader(s) populate `marketRoutes`/
   `intel`/`warehouseState` (per §2) and call them from wherever Overview's
   boot sequence and `subscribe(...)` calls already live, following the
   same pattern. Add a `renderMarkets()` function that renders all four
   panels per §3's binding tables. Call it from `setView("markets")` and
   wire it into `subscribe(...)` the same way `renderFleet()` was wired
   for Fleet's own data sources.
4. `node --check public/deck.js`.
5. `npx tsc --noEmit`.

## 6. Definition of done for this pass

- Clicking "Markets" in the rail shows four panels: Routes, Yards &
  outfitting, Warehouse, Dispatch, each populated from real fleet data.
- An empty state (no routes / no shipyard intel / no warehouse goods / no
  dispatch assignments) renders a plain "No X yet" message per panel,
  never a blank panel or a JS error.
- No console errors. No dead buttons — this pass is read-only, so no
  buttons should be rendered at all in these four panels.
- `npx tsc --noEmit` and `node --check public/deck.js` both clean.

## 7. What happens after this pass

Map (mockup screen 04) is next, followed by the command palette (screen
05) — separate passes, own specs, not part of this one.
