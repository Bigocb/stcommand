# Smooth ship flying — continuous animation upgrade

Implementation plan for upgrading the map's already-working ship-motion
interpolation from a 1-second stepped redraw to true per-frame animation.

**Read §1 before proposing any of this as new work — most of "smooth ship
flying" is already built.** This doc exists to close the specific,
narrower gap that's left, not to reintroduce interpolation from scratch.

---

## 0. Context you need

**File you're editing:** `public/v2.html` only. This is the dashboard
`src/cli/index.ts` actually serves (`express.static(PUBLIC_DIR, { index:
"v2.html" })`) — not `public/index.html`, an older file that predates the
lerp/heading/replay work below and should not be used as a reference for
"what the dashboard currently does." Single file, no build step, no
framework, no bundler, plain DOM + native `fetch` — match that; do not add
a rendering library or dependency for this.

---

## 1. What already exists (don't rebuild this)

- **`shipTransitLerp(ship)`** (`v2.html:2904`) — for an `IN_TRANSIT` ship,
  linearly interpolates world position between `nav.route.origin` and
  `nav.route.destination` by elapsed fraction of `departureTime`→`arrival`.
  No speed/flight-mode modeling needed — whichever flight mode (drift/
  cruise/burn) the game actually used already shaped the arrival timestamp,
  so a straight time-based lerp tracks it for free.
- **`shipHeadingDeg(ship, sx, sy)`** (`v2.html:2887`) — real direction of
  travel in *screen* space (projected through the map's own `sx`/`sy` scale
  functions, not raw world coordinates, since the two axes aren't
  necessarily scaled equally). The ship glyph (`shipGlyphMarkup`,
  `v2.html:2874`) rotates to actually point along its route.
- **A 1-second redraw timer**, gated to only run while the relevant view is
  on screen (`v2.html:4075`):
  ```js
  every(1000, () => { if ((!isMobile() && currentView === "bridge") || (isMobile() && mobileView === "map")) renderMapLiveOrScrub(); });
  ```
- **A 12-hour replay scrubber** (`renderScrubFrame`, `v2.html:1490`) that
  draws historical ship positions from `GET /api/replay`'s recorded
  samples, through the *same* `renderMap()` — no separate historical
  drawing path.
- Waypoint/ship coordinate **clustering** so multiple hulls at one point
  (or two flights momentarily crossing) don't collapse into one
  indistinguishable blob (`v2.html:3126-3162`).

This is a genuinely correct, already-shipped implementation of "ships
glide instead of snap." The gap is narrower than it sounds:

## 2. What's actually left

**1 Hz stepped motion, not continuous.** `renderMapLiveOrScrub()` only
runs once a second. `shipTransitLerp()`'s math is correct at any instant
it's called, but between those instants nothing moves — a ship visibly
advances in small jumps once per second rather than gliding continuously.
At typical zoom this reads as "smooth-ish"; zoomed in on a single ship it
reads as a stutter.

**Full-SVG rebuild per redraw.** `renderMap()` (`v2.html:2918`) rebuilds
the *entire* map — every waypoint, every route arc, every label, every
ship — into one `out` string and reassigns `svg.innerHTML = out + ...`
(`v2.html:3180`) on every call, including the trail lines and clustering
math. At 1 Hz this is cheap enough to not matter. It is not something you
can naively call at 60 Hz — the DOM rebuild and event-listener
re-attachment (`svg.querySelectorAll("[data-wp]").forEach(...)`,
`v2.html:3181-3184`) cost would dominate the frame budget for no visual
benefit, since waypoints/routes/labels never need to move within a single
transit.

## 3. The design: `requestAnimationFrame` + a cheap ship-only fast path

Two redraw paths, not one:

1. **Full `renderMap()`** — unchanged, called on real state changes (a new
   `/api/bridge`/`/api/state` poll landing, a view switch, a scrub
   position change). Still rebuilds everything; this is correct and cheap
   enough at the poll cadences those already run at (5s/20s — see
   `every(5000, loadBridge)` and the state-refresh interval).
2. **A new `repositionShips()` fast path** — runs every animation frame
   while any ship is `IN_TRANSIT` and the map is on screen. Does *not*
   touch `svg.innerHTML`. Instead, for each `<g class="ship" ...
   data-ship="SYMBOL">` element already in the DOM (rendered once by the
   last full `renderMap()` call), recompute `shipTransitLerp()` +
   `shipHeadingDeg()` and write only:
   - `transform="translate(x y)"` on the `<g>` itself
   - the inner glyph's own `transform="rotate(deg)"`

   No `querySelectorAll` re-scan, no innerHTML, no event re-attachment —
   just two attribute writes per in-transit ship per frame. Docked/orbiting
   ships (no motion) are skipped entirely; `repositionShips()` should exit
   immediately (not schedule another frame) once no ship is `IN_TRANSIT`,
   so an idle fleet costs nothing.

```js
let shipAnimHandle = null;

function repositionShips() {
  shipAnimHandle = null;
  if (!state?.ships?.length) return;
  const anyTransit = state.ships.some((s) => s.nav.status === "IN_TRANSIT");
  if (!anyTransit) return; // nothing to animate; next full renderMap() call restarts this naturally
  const svg = $("map");
  // sx/sy must be the *same* scale functions the last renderMap() call used —
  // factor them out of renderMap() into a shared helper (or cache them on
  // the last renderMap() call) rather than recomputing bounds here, since
  // this path must never change the map's pan/zoom/fit — only reposition.
  for (const s of state.ships) {
    if (s.nav.status !== "IN_TRANSIT") continue;
    const g = svg.querySelector(`[data-ship="${s.symbol}"]`);
    if (!g) continue; // not on the current system's map, or view hasn't rendered yet
    const world = shipTransitLerp(s);
    if (!world) continue;
    g.setAttribute("transform", `translate(${sx(world.x)} ${sy(world.y)})`);
    const heading = shipHeadingDeg(s, sx, sy);
    g.querySelector(".hull")?.setAttribute("transform", `rotate(${heading ?? 45})`);
  }
  shipAnimHandle = requestAnimationFrame(repositionShips);
}
```

**Starting the loop:** call `repositionShips()` once at the end of
`renderMap()` itself (so every full rebuild re-arms the fast path against
the fresh DOM it just built) instead of from the `every(1000, ...)` timer.
Remove that timer's `renderMapLiveOrScrub()` call once this lands — the
1 Hz tick becomes redundant, since animation now runs every frame and full
rebuilds still happen on their own data-driven triggers (`loadBridge`,
state refresh, view switch, scrub).

**Guard against a double loop:** `renderMap()` must cancel any
still-running `shipAnimHandle` (`cancelAnimationFrame`) before starting a
new one — otherwise a full rebuild mid-animation leaves two competing
`requestAnimationFrame` chains racing against the same DOM nodes.

**Backgrounded tabs are already covered for free.** Browsers throttle
`requestAnimationFrame` to near-zero in a hidden/backgrounded tab on their
own; combined with the existing `document.hidden` check in the polling
loop (`v2.html:4078`) and the `currentView`/`mobileView` gate this design
keeps from the old timer, there's no separate "pause when not visible"
logic to write.

## 4. Edge cases

- **Clock skew / a redraw landing exactly at or past `arrival`.**
  `shipTransitLerp()` already clamps `frac` to `[0, 1]` (`v2.html:2911`) —
  no change needed; the fast path just keeps calling the same function.
- **A ship whose route data is stale or missing** (an older cached
  snapshot from before a fresh `nav`) — `shipTransitLerp()` already
  returns `null` for this (`v2.html:2907`); `repositionShips()` must skip
  that ship for the frame rather than writing a bad transform, same as the
  full renderer already does via its `worldPos ? ... : posBySymbol...`
  fallback (`v2.html:3123`).
- **A ship that isn't in the currently-viewed system.** `querySelector`
  simply won't find its `<g>` (it was never rendered by the last full
  `renderMap()` call) — `repositionShips()`'s `if (!g) continue` already
  handles this; no special-casing needed.
- **Selection halo / ring** (`sel-halo`/`sel-ring`, `v2.html:3172`) is
  drawn as separate `<circle>` elements at the ship's *screen* position,
  not nested inside the ship's own `<g>`. If the selected ship is
  in-transit, the fast path needs to reposition that circle too, or the
  halo will visibly detach from a moving selected ship. Either nest the
  halo inside the ship's `<g>` (transforms with it for free — the cleaner
  fix) or add it to `repositionShips()`'s per-frame write list.

## 5. Verification

No automated test covers rendering in this codebase (`public/*.html` is
untested by the Node test suite). Verify by hand: `npm run migrate && npm
run dev`, log in, dispatch a ship on a multi-minute route, and watch the
Bridge map — motion should read as continuous, not once-a-second, and a
selected/highlighted ship's halo should track it. Confirm CPU stays flat
when no ship is in transit (the animation loop should simply not be
running) and when the tab is backgrounded.
