# Deck Fleet — build spec (pass 2, low-context build)

**Audience note**: written to be followed literally, same as
`docs/deck-desktop-design.md` (pass 1, Overview). Every data field named
below has been checked against real code (`public/v6.js`,
`public/shared/store.js`, `public/shared/domain.js`) as of 2026-09-19 —
don't re-derive field names from the mockup's static numbers. If something
here is wrong (a function renamed, a field gone), stop and say so rather
than improvising.

## 0. Context

Deck's Overview screen shipped (`fd14598`, then a CSS fix `0b87865` — see
`docs/deck-desktop-design.md`). Its own §9 named Fleet as the next natural
screen. The design mockup (`https://claude.ai/artifact/VrRF7Uucw4MqZGGdD93VyV`,
"Deck Command Console") has three Fleet-relevant screens: 02 (dense table +
split detail panel), 06 (all-systems rolled up into per-system summary
cards when the fleet has spread across several systems), 07 (the same
table/detail scoped to one system, reached by clicking a system card/chip).
This pass builds a **combined, simplified** version of all three — see §1
for what's deliberately cut.

## 1. Scope of THIS pass

Build, inside the existing `<div class="content" id="view-fleet" hidden>`
placeholder in `public/deck.html`:

- A **system-scope chip row** (mockup screens 06/07's `.chiprow`/`.syschip`):
  "All systems · N" plus one chip per system that has ships, each labeled
  `${systemSymbol} · ${count}`. Clicking a chip scopes the table below to
  just that system; "All systems" (default, active on load) shows every
  ship across every system in one table — **not** rolled-up summary cards.
  Cut from scope: screen 06's per-system KPI/summary-card grid and its
  "Why the cluster" narrative panel — there's no real data source for a
  narrative explanation, and the summary cards duplicate what the plain
  "All systems" table view already shows. If you want a system's ship
  count visible at a glance, the chip label itself (`X1-VJ42 · 11`) already
  provides it.
- A **dense sortable-by-click-not-required table** (mockup screen 02's
  `.fleetsplit` left panel), one row per ship, columns: Ship, Role, Job
  (dispatch assignment, blank/— for non-traders), Status, Fuel %, Cargo,
  Location. Row click selects that ship and populates the detail panel.
- A **detail panel** (mockup screen 02's right `.panel` in `.fleetsplit`,
  minus the `.subtabs` — Cargo & Loadout only, no Mounts/Components tabs
  this pass): selected ship's symbol, role chip, Wants/Doing
  (`.wantsdo`/`.wd`), cargo rows with a meter bar, frame, fuel.
- No selection on load: detail panel shows a placeholder
  ("Select a ship to see details.").

**Cut entirely from this pass** (do not build, do not stub as "coming
soon" — just omit the markup):
- Multi-select checkboxes / bulk hold-and-reassign bar (`.bulkbar`, `.cb`).
  No backend endpoint exists for a bulk role/hold change; building the UI
  for it would be decorative.
- Compact/Touch density toggle (`.density`). Pick **Compact** (the plain
  `<table>`, not `.touch`) permanently for this pass — Deck is desk-first,
  and a toggle with only one wired option is worse than no toggle.
- The search input (`.search`, showed a static "THEO-" value in the
  mockup — there's no real fleet-symbol-prefix search need distinct from
  the role filter chips already in Overview's own vocabulary. Skip it.
- Role filter chips (mockup's `.fchip` row: "All / Trader / Miner / …").
  Adds real complexity (another filter dimension composed with the system
  scope) for a first pass — the system-scope chips alone already solve
  "what's happening where," which is what screens 06/07 were built to
  answer. Add role filtering in a later pass if the operator asks for it.
- Mounts/Components detail subtabs — Cargo & Loadout only.
- "Assign route" / "Send fuel tender" / "Full details" buttons in the
  detail panel — decorative in the mockup (no click handler shown), and no
  existing endpoint backs "send fuel tender" as a one-click action. Omit
  the buttons entirely rather than render dead ones.

## 2. Hard requirement: reuse, don't reinvent

Same rule as pass 1. All data comes through what `deck.js` already
imports from `/shared/store.js` (`state`, `fleetStatus`, `dispatchAssignments`,
`subscribe`, `loadState`, `loadDispatch`) — these are already loaded by
Overview's boot sequence, so Fleet needs no new fetch calls, just new
rendering off state that's already arriving. Do not add a new loader.

## 3. Data binding — mirror `public/v6.js`'s own Fleet tab exactly

`public/v6.js` already computes precisely this row shape for its own
desktop Fleet tab, in a function called `fleetRows()` (search for it — it's
a private function in that file, not exported/shared, so this pass
**duplicates it into `deck.js`** rather than importing it; it's ~15 lines
and doctrine here is "don't refactor `v6.js`/shared modules unless the new
screen's data needs genuinely require it" — a straight copy is the
smaller, safer change):

```js
function jobFor(shipSymbol, role) {
  if (role !== "trader") return "—";
  const a = dispatchAssignments.find((x) => x.shipSymbol === shipSymbol);
  if (!a) return "unassigned";
  if (a.role === "direct") return `route: ${a.good}`;
  if (a.role === "contractBuy") return `contract: ${a.good}`;
  if (a.role === "haul") return `mission: ${a.good}`;
  if (a.role === "buy") return a.missionBuy ? `mission: ${a.good}` : `warehouse buy: ${a.good}`;
  if (a.role === "sell") return `warehouse sell: ${a.good}`;
  return a.good;
}

function fleetRows() {
  const ships = state?.ships ?? [];
  const strandedBy = new Set((fleetStatus.stranded ?? []).map((s) => s.symbol));
  return ships.map((s) => {
    const st = (fleetStatus.ships ?? []).find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      role: st?.role ?? "—",
      job: jobFor(s.symbol, st?.role),
      stranded: strandedBy.has(s.symbol),
      fuel: s.fuel?.current ?? 0, fuelCap: s.fuel?.capacity ?? 0,
      cargo: s.cargo?.units ?? 0, cargoCap: s.cargo?.capacity ?? 0,
      goal: strandedBy.has(s.symbol) ? "stranded" : st?.paused ? "manual hold" : (s.nav?.status ?? "").replace(/_/g, " ").toLowerCase(),
      at: s.nav?.waypointSymbol ?? "",
      frame: s.frame?.symbol ?? "",
      cargoInventory: s.cargo?.inventory ?? [],
    };
  });
}
```

(`escapeHtml`/`escapeAttr` are already imported in `deck.js` from
`/shared/domain.js` per Overview's own imports — use them exactly as
`v6.js` does when interpolating any of these strings into HTML.)

Two fields above (`frame`, `cargoInventory`) aren't in `v6.js`'s own
`fleetRows()` — they're added here because the detail panel needs them and
`v6.js`'s own ship-detail modal (`openShipDetails()`) reads them a
different way this pass doesn't need to duplicate. Confirm `s.frame.symbol`
and `s.cargo.inventory` (array of `{symbol, units}`) exist on `state.ships[]`
entries before relying on them — they're the same raw SpaceTraders `Ship`
shape `v6.js`'s own modal already reads from, so they should be present,
but verify against a live `state` payload if unsure rather than guessing.

**System grouping**: derive a ship's system from its waypoint the same way
the rest of this codebase does — `waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"))`
(e.g. `X1-VJ42-A1` → `X1-VJ42`). A ship with no waypoint yet (`at === ""`)
falls under an "Unknown" bucket — don't crash on it, just group it there.

| Mockup element | Real source |
|---|---|
| Chip row counts (`X1-VJ42 · 11`) | Count of `fleetRows()` entries whose derived system matches, computed client-side in `deck.js` — no new backend field. |
| Table `Ship` | `row.symbol` |
| Table `Role` chip | `row.role`, styled with the existing `.chip.<role>` classes already defined in `deck.css` (trader/miner/scout/explorer/tour/keeper — `.chip.scout,.chip.explorer,.chip.tour` share one style per the existing CSS, already correct, don't add new variants) |
| Table `Job` | `row.job` |
| Table `Status` | `row.goal`, colored green in-transit/hauling-like states, red for `stranded`, dim otherwise — reuse the color logic pattern from `renderFleetSummary()` in `v6.js` (`doing === "stranded"` → warn color) rather than inventing a new mapping |
| Table `Fuel` | `row.fuelCap ? Math.round((row.fuel / row.fuelCap) * 100) : 0` + `%` |
| Table `Cargo` | `${row.cargo}/${row.cargoCap}` |
| Table `Loc` | `row.at` (full waypoint symbol — the mockup showed a shortened form like "D46"; don't attempt to replicate that shortening logic, showing the full symbol is correct and simpler) |
| Detail panel Wants | `row.job` if a trader with a route; for a non-trader role, there's no per-ship "wants" string computed anywhere in this codebase — show the row's `role` capitalized instead (e.g. "Miner") rather than inventing a wants sentence |
| Detail panel Doing | `row.goal` |
| Detail panel Cargo rows | one `.cargorow` per `row.cargoInventory[]` entry: `{good: item.symbol, qty: `${item.units} / ${row.cargoCap}`}`, with a `.meter` bar width `${(item.units / row.cargoCap) * 100}%` |
| Detail panel Frame | `row.frame` |
| Detail panel Fuel | `${row.fuel} / ${row.fuelCap}` |

## 4. CSS to add to `public/deck.css`

These classes exist in the mockup's stylesheet but not yet in
`public/deck.css` (Overview's pass only pulled in what Overview itself
needed). Copy verbatim — they're self-contained, no dependency on the
cut-from-scope density/checkbox/subtabs features beyond the class
definitions themselves being harmless to include unused:

```css
.chiprow{display:flex;gap:6px;flex:0 0 auto}
.syschip{font-family:var(--mono);font-size:10.5px;padding:5px 11px;border-radius:4px;border:1px solid var(--hair-hi);color:var(--dim);background:var(--panel);cursor:pointer}
.syschip.on{color:var(--amber);border-color:var(--amber-glow);background:var(--amber-dim)}

table{width:100%;border-collapse:collapse;font-size:11.5px}
th{text-align:left;font-family:var(--chrome);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim2);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--hair);position:sticky;top:0;background:var(--panel)}
td{padding:7px 8px;border-bottom:1px solid rgba(255,199,120,.06);vertical-align:middle}
tr:hover td{background:var(--raised)}
tr.sel td{background:var(--amber-dim)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.shipsym{font-family:var(--mono);color:var(--bone);font-weight:600;cursor:pointer}
.chip{font-family:var(--chrome);font-size:9px;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:10px;display:inline-block}
.chip.trader{background:rgba(147,166,180,.16);color:var(--ice)}
.chip.miner{background:rgba(255,176,32,.14);color:var(--amber)}
.chip.scout,.chip.explorer,.chip.tour{background:rgba(147,166,180,.1);color:var(--dim)}
.chip.keeper{background:rgba(88,214,141,.12);color:var(--green)}
.chip.surveyor,.chip.siphoner{background:rgba(147,166,180,.1);color:var(--dim)}

.fleetsplit{flex:1;display:grid;grid-template-columns:1.5fr 1fr;gap:14px;min-height:0}
.detailhead{display:flex;flex-direction:column;gap:8px;padding:14px;border-bottom:1px solid var(--hair)}
.detailhead .name{font-family:var(--chrome);font-size:17px;color:var(--bone);display:flex;align-items:center;gap:8px}
.wantsdo{display:flex;gap:10px;margin-top:4px}
.wd{flex:1;background:var(--sunken);border-radius:4px;padding:9px 11px;border-left:2px solid var(--ice)}
.wd.bad{border-color:var(--red)}
.wd .l{font-family:var(--chrome);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim2)}
.wd .v{font-size:12px;margin-top:3px;color:var(--bone)}
.wd.bad .v{color:var(--red)}
.cargorow{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,199,120,.06);font-size:11.5px}
.cargorow .g{font-family:var(--mono);color:var(--ice)}
.meter{height:5px;border-radius:3px;background:var(--sunken);overflow:hidden;margin-top:3px}
.meter i{display:block;height:100%;border-radius:3px}
```

Two roles used in this codebase (`surveyor`, `siphoner`) aren't in the
mockup's own `.chip.*` set (it only showed trader/miner/scout/explorer/
tour/keeper) — added above sharing the dim/neutral style the mockup gives
scout/explorer/tour, so every real role in `src/engine/doctrine.ts`'s role
vocabulary has a chip style and none falls through unstyled.

## 5. Build sequence

1. In `public/deck.html`, replace the placeholder line:
   `<div class="content" id="view-fleet" hidden><div class="empty">Fleet — coming soon.</div></div>`
   with the real markup: a `.chiprow` (empty at first, populated by JS), a
   `.fleetsplit` with the table panel (left) and detail panel (right,
   showing the "Select a ship" placeholder initially).
2. Add the CSS from §4 to `public/deck.css`.
3. In `public/deck.js`: add `jobFor()`/`fleetRows()` (§3), a `renderFleet()`
   function that (a) computes system groups and renders the chip row, (b)
   filters `fleetRows()` to the selected system (or all, if "All systems"
   is active), (c) renders the table, (d) re-renders the detail panel for
   whichever ship is currently selected (or the placeholder). Wire chip
   clicks to change the selected system and re-render. Wire table row
   clicks to change the selected ship and re-render just the detail panel.
   Call `renderFleet()` from `setView("fleet")` and from the existing
   `subscribe(...)` calls so it stays live — check how Overview's own
   render functions are wired into `subscribe("state", ...)` /
   `subscribe("dispatch", ...)` in the existing `deck.js` and follow the
   same pattern (likely needs `subscribe("state", renderFleet)` and
   `subscribe("dispatch", renderFleet)` added alongside whatever Overview
   already subscribes to).
4. `node --check public/deck.js`.
5. `npx tsc --noEmit` (no TS files touched, but confirms nothing else broke).

## 6. Definition of done for this pass

- Clicking "Fleet" in the rail shows a system chip row, a ship table
  (all ships, all systems, by default), and a detail placeholder.
- Clicking a system chip filters the table to that system's ships only,
  and the chip row shows which one is active.
- Clicking a ship row shows that ship's Wants/Doing, cargo, frame and
  fuel in the detail panel, and highlights the selected row.
- No console errors. No dead buttons (per §1, buttons with no backing
  action are omitted, not rendered disabled).
- `npx tsc --noEmit` and `node --check public/deck.js` both clean.

## 7. What happens after this pass

Markets and Map are next (mockup screens 3 and 4), same as Overview's own
§9 named Fleet as its successor — separate passes, own specs, not part of
this one.
