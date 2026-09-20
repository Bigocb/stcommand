# Deck Map — build spec (pass 4, low-context build)

**Audience note**: written to be followed literally, same as the three
specs before it (`docs/deck-desktop-design.md`, `docs/deck-fleet-design.md`,
`docs/deck-markets-design.md`). Every data field named below has been
checked against real code (`public/v6.js`, `public/shared/store.js`) as of
2026-09-20 — don't re-derive field names from the mockup's static numbers.
If something here is wrong (a function renamed, a field gone), stop and
say so rather than improvising.

## 0. Context

Deck's Overview, Fleet and Markets screens have shipped. The design
mockup (`https://claude.ai/artifact/VrRF7Uucw4MqZGGdD93VyV`, "Deck Command
Console") has a Map screen (screen 04): a system chip row, a flat 2D
chart of one system's waypoints with jump-gate/ship blips, a legend, and
a docked detail panel for a selected waypoint. The mockup's own
description of this screen is explicit about the target: "v6's own map,
functionally, restyled in Deck's palette as a plotted chart rather than
v6's 3D/bloom starfield." **Do not port v6's Three.js scene** — `v6.js`'s
`renderMap()` (search for it) is a full 3D engine with coincident-waypoint
fan-out, relaxation passes, and transit-position lerping; none of that is
in scope here. This pass is a plain 2D scatter plot built from real
waypoint x/y coordinates, positioned with CSS absolute percentages inside
a `<div>` — the same visual language the mockup itself uses (`.blip`
elements with `top`/`left` percentages).

## 1. Scope of THIS pass

Build, inside the existing `<div class="content" id="view-map" hidden>`
placeholder in `public/deck.html`:

- A **system chip row** (mockup's `.chiprow`/`.syschip`, already added to
  `deck.css` by the Fleet pass — reuse those classes verbatim). Chips:
  the agent's home system (`state.agent.headquarters`'s system — derive
  with `headquarters.slice(0, headquarters.lastIndexOf("-"))`) plus every
  other system where the fleet currently has a ship (derive from
  `fleetRows()`'s own `at` field, same helper already duplicated into
  `deck.js` for Fleet — a ship's system is
  `at.slice(0, at.lastIndexOf("-"))`). Default selection: home system.
  Clicking a chip re-renders the chart for that system.
- A **flat chart panel** (mockup's `.chart` + `.blip`/`.blabel`): every
  known waypoint in the selected system, plotted by real `x`/`y`
  coordinates normalized into a 0-100% range (see §3's exact formula),
  colored/shaped by type per the mockup's existing `.blip.<kind>` CSS
  classes (already in `deck.css`? check — if the Fleet/Overview passes
  didn't add `.blip`/`.chart`/`.blabel`/`.legend` rules, add them from the
  mockup CSS verbatim, see §4). Ships currently **docked or in orbit** in
  this system (not in transit — see §3 for why) render as `.blip.ship`
  (or `.blip.shipwarn` for a stranded ship) at their current waypoint's
  position.
- A **legend** (mockup's `.legend`, static — market/gate/asteroid/fuel/
  station/ship/stranded swatches, matching whichever blip kinds this pass
  actually renders).
- A **detail panel** for whichever waypoint was last clicked (mockup's
  right-hand `.panel` in `.mapstage`): that waypoint's market goods
  (buy/sell price per good, from `marketSnapshots` — see §3), if any are
  recorded for it. No waypoint selected on load: placeholder text
  ("Click a waypoint to see its market.").
- A **leaderboard mini-panel** at the bottom of the detail panel (mockup
  shows this under the selected-market panel on screen 04): top 3 agents
  by credits, reusing the same real `leaderboard` data
  `renderLeaderboard()` in `v6.js` already reads (see §3) — this is
  genuine data (`GalaxyCrawler`'s public `/agents` crawl), not invented,
  so it stays in scope unlike Overview's cut "Forgone" KPI.

**Cut entirely from this pass** (do not build, do not stub):
- Jump-gate connection lines (mockup's `.chartlines` SVG lines from the
  gate to nearby waypoints). A jump gate's real connections
  (`jumpConnections`/`JumpGate.connections`) are cross-**system** links —
  they point at gates in *other* systems, which have no coordinate in
  *this* system's 2D scatter, so there is no real same-system line to
  draw. The mockup's lines are a visual flourish with no backing data;
  drawing them would mean inventing positions. Skip the `<svg
  class="chartlines">` entirely.
- v6's coincident-waypoint fan-out (several waypoints sharing one exact
  x/y, e.g. a gas giant and its orbiting stations) and relaxation-pass
  de-overlap. A real system can have this; for a first pass, plot raw
  normalized coordinates and accept that a tight cluster overlaps
  visually. Note it in your final report if you see it happen on a real
  system, but don't build the fan-out algorithm this pass.
- In-transit ship position interpolation (v6's `shipTransitLerp()` —
  don't port it). A ship whose `nav.status` is `IN_TRANSIT` is skipped
  entirely from this map's blips this pass, rather than guessing a
  midpoint position.
- Multi-system view / galaxy-wide zoom-out (mockup doesn't show this for
  Map anyway — it's per-system chips, not a zoomed-out overview).
- Any click-to-act control (dispatch a ship from the map, etc.) — display
  only, same read-only discipline as the Markets pass.

## 2. Hard requirement: reuse, don't reinvent

Same rule as passes 1-3. This needs three more reactive values from
`public/shared/store.js` beyond what Overview/Fleet/Markets already
import into `deck.js` — confirm their exact export names in that file
before using them (the names below are what `v6.js` imports):

- `state.waypoints` and/or `state.systems` — waypoint list with `x`/`y`/
  `type`/`traits`, per system. Check `stcommand_get_state`'s own schema
  (documented inline in the MCP tool's error/description text elsewhere
  in this codebase) or just read `state.systems[].waypoints[]` directly —
  `v6.js`'s own `renderMap()` reads `systems.find((s) => s.symbol ===
  sys)?.waypoints`, so mirror that lookup exactly.
- `marketSnapshots` — flat array of `{waypointSymbol, goodSymbol,
  purchasePrice, sellPrice, timestamp, ...}`, the same data `v6.js`'s
  `renderSnapshots()` (search for it) reads. Already loaded by the
  `markets`/`goods` loader Markets pass 3 already wired in — check before
  adding a second load call.
- `leaderboard` — array of `{agentSymbol, credits}`, populated by
  `loadGalaxy()` (see `v6.js`'s `if (name === "galaxy") loadGalaxy();`
  view-switch wiring). Add a `loadGalaxy()` call when the Map view is
  selected, mirroring that same pattern — it's a fetch-on-demand-not-
  polled load in `v6.js`, so don't add it to a periodic poll loop, just
  call it from `setView("map")`.

## 3. Data binding

### System chip row

| Mockup element | Real source |
|---|---|
| Chip label (`X1-BY69`) | System symbol, derived per §1 |
| Active chip | The currently-selected system (state local to `deck.js`, default home) |

### Chart panel — waypoint blips

For the selected system, read its waypoint list (§2). For each waypoint,
compute `left`/`top` percentages:

```js
function normalizeCoords(waypoints) {
  const xs = waypoints.map((w) => w.x), ys = waypoints.map((w) => w.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  // 10-90% range, not 0-100%, so a waypoint at the extreme edge of the
  // system doesn't render its blip half-clipped by the chart's own border.
  return (w) => ({
    left: 10 + ((w.x - minX) / spanX) * 80,
    top: 10 + ((w.y - minY) / spanY) * 80,
  });
}
```

| Mockup blip class | Real condition |
|---|---|
| `.blip.gate` | `waypoint.type === "JUMP_GATE"` |
| `.blip.market` | `waypoint.traits` includes `{symbol: "MARKETPLACE"}` (and not already a gate — gate takes precedence, matching `v6.js`'s own "marketplace/shipyard sort first ... can never be the ones bumped" comment around `v6.js:4564`, adapted here as "gate beats market/shipyard visually since it's the rarer, more structurally important waypoint") |
| `.blip.fuel` | `waypoint.traits` includes `{symbol: "FUEL_STATION"}` (also gate/market-precedence as above) |
| `.blip.asteroid` | `waypoint.type` is `ASTEROID_FIELD` or `ENGINEERED_ASTEROID` |
| `.blip.station` | `waypoint.type` is `ORBITAL_STATION` |
| `.blip.planet` | fallback — anything not matched above (e.g. `PLANET`, `MOON`, `GAS_GIANT`) |

Label each blip with its short symbol (the part after the system prefix,
e.g. `X1-BY69-D46` → `D46`) using `.blabel`, same as the mockup.

For ships: filter `fleetRows()` (already in `deck.js` from the Fleet
pass) to ships whose derived system matches the selected one AND whose
live `nav.status` is not `IN_TRANSIT` (check `state.ships[]`'s own
`nav.status` field directly — `fleetRows()`'s own `goal` field is a
lowercased/humanized string, not the raw status enum, so read `nav.status`
from `state.ships` directly for this exact check rather than string-
matching `goal`). Render each as `.blip.ship` at its current waypoint's
normalized position, `.blip.shipwarn` instead if `row.stranded` is true.

### Detail panel — selected waypoint's market

On blip click, store the clicked waypoint symbol and re-render the detail
panel: filter `marketSnapshots` to that `waypointSymbol`, list each
`{goodSymbol, purchasePrice, sellPrice}` as a `.goodrow` (reuse the CSS
class Markets pass 3 already added). If no snapshots exist for that
waypoint (never scanned), show "No market data for this waypoint yet."

### Leaderboard mini-panel

| Mockup element | Real source |
|---|---|
| Rank rows (top 3) | `leaderboard` sorted by `credits` descending (check whether it's pre-sorted already — `v6.js`'s `renderLeaderboard()` doesn't re-sort before slicing to top-3-equivalent display, so it may already arrive sorted; sort defensively if unsure), `slice(0, 3)` |
| Agent name | `a.agentSymbol` |
| Credits | `fmt(a.credits)` |
| "you" marker | highlight the row where `a.agentSymbol === state.agent.symbol`, per `v6.js`'s own pattern |

## 4. CSS to add to `public/deck.css`

Check first whether any of these were already added by an earlier pass
(unlikely, but Fleet's spec did add `.syschip`/`.chiprow` — don't
duplicate those two rules if already present). Add whatever's missing
from this list, copied verbatim from the mockup:

```css
.mapstage{flex:1;display:grid;grid-template-columns:1fr 320px;gap:14px;min-height:0}
.chart{position:relative;flex:1;overflow:hidden;min-height:0;
  background-color:var(--sunken);
  background-image:
    linear-gradient(rgba(147,166,180,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(147,166,180,.05) 1px, transparent 1px);
  background-size:28px 28px;
}
.blip{position:absolute;border-radius:50%;transform:translate(-50%,-50%);cursor:pointer}
.blip.planet{width:8px;height:8px;background:var(--ice)}
.blip.station{width:8px;height:8px;border-radius:2px;background:var(--bone)}
.blip.market{width:7px;height:7px;background:var(--ice)}
.blip.asteroid{width:6px;height:6px;border-radius:2px;transform:translate(-50%,-50%) rotate(45deg);background:var(--dim2)}
.blip.fuel{width:7px;height:7px;background:var(--green)}
.blip.gate{width:0;height:0;border-radius:0;background:none;
  border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid var(--amber);
  filter:drop-shadow(0 0 4px var(--amber-glow))}
.blip.ship{width:0;height:0;border-radius:0;background:none;
  border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:8px solid var(--green);
  filter:drop-shadow(0 0 4px var(--green))}
.blip.shipwarn{border-bottom-color:var(--red);filter:drop-shadow(0 0 5px var(--red))}
.blabel{position:absolute;font-family:var(--mono);font-size:8.5px;color:var(--dim);white-space:nowrap;transform:translate(7px,-6px);pointer-events:none}
.legend{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--hair);font-family:var(--mono);font-size:9.5px;color:var(--dim);flex-wrap:wrap}
.legend span{display:flex;align-items:center;gap:5px}
.legend i.sw-gate{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid var(--amber)}
.legend i.sw-ship{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid var(--green)}
.legend i.sw-asteroid{border-radius:2px;transform:rotate(45deg)}
.legend i.sw-station{border-radius:2px}
.legend i{width:8px;height:8px;border-radius:50%;display:block}
```

`.chiprow`/`.syschip` and `.goodrow` should already exist from the Fleet
and Markets passes — reuse, don't redefine.

## 5. Build sequence

1. In `public/deck.html`, replace the placeholder:
   `<div class="content" id="view-map" hidden><div class="empty">Map — coming soon.</div></div>`
   with: a `.chiprow` (system chips), a `.mapstage` containing the chart
   panel (with an inner `.chart` div for blips + a `.legend` below it) and
   a detail `.panel` (market goods + leaderboard mini-section).
2. Add the CSS from §4 (whatever's not already present).
3. In `public/deck.js`: add the `normalizeCoords()` helper (§3), a
   `renderMap()` function that renders the chip row, the chart's blips
   (with click handlers setting the selected waypoint and re-rendering the
   detail panel), the legend, and the leaderboard mini-panel. Call
   `loadGalaxy()` once when `setView("map")` fires (not polled). Wire
   `renderMap()` into `subscribe(...)` for whatever reactive values it
   reads (state/galaxy), following the pattern the Fleet/Markets passes
   already established.
4. `node --check public/deck.js`.
5. `npx tsc --noEmit`.

## 6. Definition of done for this pass

- Clicking "Map" shows a system chip row (home system active by default),
  a 2D scatter of that system's waypoints with correctly-typed blips, a
  legend, and a detail panel showing a "click a waypoint" placeholder.
- Clicking a different system chip re-plots the chart for that system.
- Clicking a waypoint blip shows its recorded market goods (or a "no
  data" message) in the detail panel.
- A leaderboard mini-panel shows the top 3 agents by credits, with the
  operator's own row highlighted if present.
- No console errors. No dead controls.
- `npx tsc --noEmit` and `node --check public/deck.js` both clean.

## 7. What happens after this pass

The command palette (mockup screen 05, ⌘K) is the last of the five
originally-scoped Deck screens/features — a separate pass, own spec, not
part of this one.
