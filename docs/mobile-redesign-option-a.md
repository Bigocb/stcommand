# Mobile redesign — Option A ("Bridge") — implementation plan

Implementation spec for replacing the current single-scroll mobile page with
an app-shell: a bottom tab bar and five focused screens, one of which is a
real (if simplified) galaxy map — mobile's current biggest gap versus desktop.

**Read this whole file before editing anything.**

---

## 0. Context you need

**Repo:** `stcommand` — multi-tenant autonomous SpaceTraders fleet engine.
**File you're editing:** `public/v2.html` only. Single file, no build step, no
framework, no bundler. Plain DOM + native `fetch`. Do not add dependencies.

**What exists today.** Below a `680px` viewport width, `public/v2.html`
currently hides the entire desktop tab UI (`main#views > .view`, which
includes the Bridge tab's galaxy map) and shows one separate, single-column,
un-tabbed page instead: `<section class="view-mobile" id="mobile-view">`
(around line 1057). That page is a long vertical scroll of panes — Alerts,
Fleet, Contracts, Missions, Routes, Shipyard intel, Warehouse — built by
reusing desktop CSS classes (`.pane`, `.dispatch-row`, etc.) with touch-sized
overrides in a `@media (max-width:680px)` block starting around line 759.
**The galaxy map is desktop-only.** There is no mobile map at all today.

**What we're building.** Replace `#mobile-view`'s single scroll with a real
app shell:

- A fixed bottom tab bar, 5 tabs: **Bridge**, **Fleet**, **Map**, **Ops**, **Book**.
- One screen visible at a time (like the desktop `#view-switch` pattern, but
  a parallel, independent piece of state — mobile does not share
  `currentView` with desktop, see §1).
- **Bridge** = a hero "what needs you most" card (today's top triage item,
  bigger) + a horizontally-scrolling fleet status strip + recent activity.
- **Fleet** = today's mobile fleet list, unchanged, just moved to its own tab.
- **Map** = the *existing* desktop galaxy map, reused wholesale (not
  reimplemented — see §4), shown fullscreen with touch pan/zoom.
- **Ops** = today's Contracts + Missions + Warehouse content, unchanged,
  moved to one tab instead of being stacked in the long scroll.
- **Book** = the existing `renderBook()` standing-orders view, already
  responsive-ish, given its own tab instead of being unreachable on mobile.

### Hard rules

1. **No new runtime dependencies.** Native DOM/fetch only.
2. **Do not change any `/api/*` route shape.** Everything this plan needs
   already exists in the payloads the page already fetches — see §2. If you
   find yourself wanting a new field or endpoint, stop and report it instead
   of guessing at a shape.
3. **Do not touch `src/engine/*`, `src/http/*`, or any file under `src/`.**
   This is a frontend-only change.
4. **Do not touch the desktop tab UI** (`#view-switch`, `.view-bridge`,
   `.view-fleet`, `.view-markets`, `.view-tradeops`, `.view-ops`, `setView()`,
   `currentView`) except for the one narrow exception in §4 (making the map
   stage reachable from the mobile Map tab). Desktop must work exactly as it
   did before this change, at every step.
5. **Run the syntax check after every phase** (there is no test suite for the
   frontend): extract the `<script>` block and run `node --check` on it.
   ```bash
   node -e "
     const fs = require('fs');
     const html = fs.readFileSync('public/v2.html', 'utf8');
     const m = html.match(/<script>([\s\S]*?)<\/script>/);
     fs.writeFileSync('/tmp/vcheck.js', m[1]);
   "
   node --check /tmp/vcheck.js
   ```
6. **Phases are gates.** Finish and verify each phase before starting the
   next. Each phase leaves the app in a working, shippable state — never
   leave `public/v2.html` mid-broken between sessions.
7. If an instruction here contradicts what you find in the code, **stop and
   report it** rather than guessing.

### Out of scope (do not build)

- Option B ("Briefing", the zero-nav single-scroll alternative) — a
  different, separate plan. Do not blend the two.
- Any change to ship-to-ship travel, dispatch, or doctrine logic. This is
  presentation only.
- A *new*, simplified/from-scratch map renderer. §4 is explicit: reuse the
  existing one. Building a second map system is more code, not less, and
  will drift from the desktop map every time someone touches the real one.

---

## 1. State you need to add

Near the other page-level `let`/`const` globals (search for `let currentView`
— that's the desktop equivalent), add:

```js
let mobileView = "bridge"; // "bridge" | "fleet" | "map" | "ops" | "book"
```

This is **independent of `currentView`**. Desktop's `currentView` continues to
drive desktop's `#view-switch` and desktop polling exactly as today. Mobile
gets its own tiny state machine, driven by the new bottom tab bar, not by
`setView()`. Do not merge the two — they're allowed to disagree (e.g. desktop
sitting on `"markets"` while a phone viewing the same session sits on
`"map"` is fine and expected; they're different tabs/sessions in practice,
but even within one session there's no reason to couple them).

---

## 2. Data you already have — do not add new fetches for these

Everything Option A's Bridge/Fleet/Map screens need is already being polled
today (see the `every(...)` polling block, search for `every(5000, loadState)`
— around line 3475). Confirm each of these exists and reuse it as-is:

| Screen | Needs | Already-existing source |
|---|---|---|
| Bridge hero card | Top triage item | `bridge.triage[0]` — shape: `{ title, detail, severity, costPerHour, engineWillAct, actions: [{kind,label,body}], shipSymbol }`. Full render reference: `renderTriage()`, search for `/* ── BRIDGE: triage ───────────────────────── */`. |
| Bridge header | Credits, net rate, alert count | `state.agent.credits`, `bridge.rate` (credits/hr), `bridge.triage.length`. Reference: `renderTopbar()`, search for `/* ── topbar ───────────────────────────────── */`. |
| Bridge fleet strip | Per-ship role/fuel/cargo/status | `fleetRows()` — already returns exactly `{symbol, role, manual, stranded, net, fuel, fuelCap, cargo, cargoCap, goal, at}` per ship. Search for `function fleetRows()`. |
| Bridge activity feed | Recent fleet activity | `activity` global, already polled every 3s (`every(3000, loadActivity)`). Reference: `renderTicker()`. |
| Fleet tab | Same row data as above | `fleetRows()` again — reuse `renderMobileFleet()` verbatim (search `function renderMobileFleet()`), just move where it's called from. |
| Map tab | Waypoints, ships, glyphs | Everything `renderMap()` already reads: `waypoints`, `state.ships`, `fleetStatus.ships[].role`. See §4 — do not re-fetch, just make the existing map visible. |
| Ops tab | Contracts, missions, warehouse | Already-existing `loadDispatch()`, `loadWarehouse()`, `loadOps()`, and the mobile IDs `#mobile-contracts`, `#mobile-missions`, `#mobile-warehouse-*` — all already built, just currently stacked in the long scroll. Reuse the DOM/JS as-is; only the surrounding shell changes. |
| Book tab | Standing orders prose | `renderBook()` — already called once unconditionally at boot per the Field & Book plan, so its DOM exists; this tab just needs to show it. |

If any row in that table turns out not to match what you find in the code,
**stop and report the discrepancy** — do not invent a replacement.

---

## 3. Ship detail sheet — reuse, do not rebuild

Tapping a ship (from the fleet strip, the fleet tab, or a map glyph) should
open the same modal that already exists: `openShipDetails(shipSymbol)` →
populates `#manifest`, shown inside `.modal-backdrop`/`.modal`. This is
**already touch-styled** — see the comment at the top of the
`@media (max-width:680px)` block: *"Ship-details modal: only reachable from
the mobile fleet list at this width... safe to size it for touch
unconditionally."* Call `openShipDetails(shipSymbol)` from all three tap
sites; do not build a second detail sheet.

---

## 4. The Map tab — reuse the desktop map, don't reimplement it

This is the part most likely to go wrong, so be precise.

The desktop galaxy map lives inside `.view-bridge .field-stage` and is drawn
by `renderMap(ships, trails)` into `<svg id="map">` (search
`function renderMap(ships, trails = new Map())`). It already has everything
Option A's mockup wants: type-based waypoint glyphs (`WP_GLYPH`,
`drawWaypointGlyph()`), role-based ship glyphs (`SHIP_FAMILY`,
`shipGlyphMarkup()`), pan/zoom (`mapZoom`/`mapPanX`/`mapPanY`,
`initMapInteractions()`), a Fit button (`#map-fit` → `resetMapView()`), and
tap/hover tooltips (`showWaypointTip()`).

**Do not write a second, simplified renderer against a small preview `<svg>`.**
Instead:

1. Currently `@media (max-width:680px) { main#views > .view { display:none
   !important; } }` hides `.view-bridge` (and therefore the map) entirely
   below the breakpoint. Change this rule so it only applies when
   `mobileView !== "map"` — e.g. add a class to `<body>` or `<main>` when the
   Map tab is active (`document.body.classList.toggle("mobile-map-active",
   mobileView === "map")`) and scope the existing hide rule off that class,
   or equivalently give `.view-bridge` a `.mobile-map-active .view-bridge {
   display:flex !important; }` override. Pick whichever reads cleaner given
   the surrounding CSS; either is fine as long as `.view-bridge` becomes
   visible exactly when, and only when, `mobileView === "map"`.
2. `.view-bridge` also contains desktop-only chrome sized for a mouse and a
   280px-wide rail (`.rail-l`, plus `.map-hud`/`.system-strip`/`.map-legend`,
   which are positioned with a hardcoded `left:306px` to clear that rail —
   search `left:306px` in the stylesheet). On mobile there is no rail, so:
   - Hide `.rail-l` and `.rail-r` (if present) entirely under
     `.mobile-map-active`.
   - Override `.map-hud`, `.system-strip`, `.map-legend`, `.map-fit-btn` back
     to their un-shifted positions (e.g. `left:12px` instead of `left:306px`)
     under `.mobile-map-active`, sized up slightly for touch (match the
     touch-sizing pattern already used elsewhere in the mobile media query —
     bigger tap targets, `min-height:38-42px` buttons, per the existing
     `.view-mobile button` rules).
   - Leave the ticker/shift-log-drawer hidden on the Map tab — there's no
     room, and Bridge tab already covers activity.
3. When the Map tab is opened, call the same functions desktop calls to
   initialize/refresh the map: `requestAnimationFrame(renderMapLiveOrScrub)`
   (already what `setView("bridge")` does) and ensure
   `initMapInteractions()` has already run once at boot (it should have —
   confirm rather than calling it twice, since it attaches event listeners
   and calling it a second time on the same `<svg>` would double-bind them).
4. Touch panning/zoom: check whether `initMapInteractions()`'s existing
   handlers are mouse-only (`mousedown`/`mousemove`/`wheel`) or already
   handle touch. If mouse-only, add `touchstart`/`touchmove`/`touchend`
   handlers alongside the existing mouse ones (single-finger drag → pan,
   two-finger pinch → zoom), following the same `mapPanX`/`mapPanY`/`mapZoom`
   + `applyMapView()` update pattern the mouse handlers already use — do not
   introduce a separate pan/zoom state.

The `#map-fit` button and `showWaypointTip()` tap-to-show-info behavior
should work unmodified once the map is visible and correctly sized — verify,
don't rebuild.

---

## 5. HTML structure

Inside `<section class="view-mobile" id="mobile-view">`, restructure to:

```html
<section class="view-mobile" id="mobile-view">
  <div class="m-shell">
    <!-- Bridge screen -->
    <div class="m-screen" data-mscreen="bridge">
      <div class="m-topbar">
        <div>
          <div class="m-credits" id="m-credits">—</div>
          <div class="m-rate" id="m-rate">—</div>
        </div>
        <div class="m-alert-badge" id="m-alert-badge">—</div>
      </div>
      <div class="m-body">
        <div class="m-hero" id="m-hero"><!-- top triage item, rendered by JS --></div>
        <div class="m-section-h">Fleet<span id="m-fleet-strip-count">—</span></div>
        <div class="m-fleet-strip" id="m-fleet-strip"></div>
        <div class="m-section-h">Recent</div>
        <div class="m-activity" id="m-activity"></div>
      </div>
    </div>

    <!-- Fleet screen: reuse existing mobile fleet markup/IDs as-is -->
    <div class="m-screen" data-mscreen="fleet">
      <!-- move the existing #mobile-fleet pane header + #mobile-fleet div here -->
    </div>

    <!-- Map screen: intentionally near-empty — it works by revealing
         .view-bridge's real map, not by containing its own -->
    <div class="m-screen" data-mscreen="map"></div>

    <!-- Ops screen: reuse existing #mobile-contracts, #mobile-missions,
         #mobile-warehouse-* panes as-is, just grouped under this tab -->
    <div class="m-screen" data-mscreen="ops">
      <!-- move the existing Contracts / Missions / Warehouse panes here -->
    </div>

    <!-- Book screen -->
    <div class="m-screen" data-mscreen="book" id="m-book-screen"></div>
  </div>

  <nav class="m-tabbar" id="m-tabbar">
    <button data-mtab="bridge" aria-pressed="true">Bridge</button>
    <button data-mtab="fleet">Fleet</button>
    <button data-mtab="map">Map</button>
    <button data-mtab="ops">Ops</button>
    <button data-mtab="book">Book</button>
  </nav>
</section>
```

Keep every existing element `id` that other JS already targets
(`#mobile-fleet`, `#mobile-fleet-count`, `#mobile-triage`,
`#mobile-triage-count`, `#mobile-contracts`, `#mobile-missions`,
`#mobile-warehouse-*`, etc.) — you're moving their container, not renaming
them. Grep for each id before deleting anything to see what already writes
to it, so nothing silently stops updating.

The Bridge screen's hero card (`#m-hero`) is new markup, not a move — see §6
for what renders into it.

---

## 6. JS you need to add

```js
function setMobileView(name) {
  mobileView = name;
  document.querySelectorAll(".m-screen").forEach((s) => s.classList.toggle("on", s.dataset.mscreen === name));
  document.querySelectorAll("#m-tabbar button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mtab === name)));
  document.body.classList.toggle("mobile-map-active", name === "map");
  if (name === "map") requestAnimationFrame(renderMapLiveOrScrub);
  if (name === "book") renderBook();
}

function initMobileTabbar() {
  $("m-tabbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mtab]");
    if (btn) setMobileView(btn.dataset.mtab);
  });
}

/** Bridge screen's hero card: the single highest-priority triage item,
 *  reusing bridge.triage exactly as renderTriage() does, just rendering
 *  only the first entry into #m-hero instead of the whole list. */
function renderMobileHero() {
  const el = $("m-hero");
  if (!el) return;
  const top = (bridge.triage ?? [])[0];
  if (!top) { el.innerHTML = '<div class="empty">Nothing needs you. The engine has it.</div>'; return; }
  el.innerHTML = `
    <div class="m-hero-tag">Needs you first</div>
    <div class="m-hero-headline">${escapeHtml(top.detail)}</div>
    <div class="m-hero-actions">
      ${(top.actions ?? []).map((a) =>
        `<button class="${a.kind === "details" ? "" : "pri"}" data-kind="${escapeAttr(a.kind)}" data-body='${escapeAttr(JSON.stringify(a.body ?? {}))}'>${escapeHtml(a.label)}</button>`).join("")}
    </div>`;
  // same action-button wiring renderTriage() already uses — copy that
  // click handler here (or factor it out into a shared helper both call,
  // if you'd rather not duplicate it) rather than reinventing it.
}

/** Bridge screen's fleet strip: same row data as renderMobileFleet(), laid
 *  out as horizontally-scrolling chips instead of stacked rows. */
function renderMobileFleetStrip() {
  const el = $("m-fleet-strip");
  if (!el) return;
  const rows = fleetRows();
  $("m-fleet-strip-count").textContent = `${rows.length} hulls`;
  el.innerHTML = rows.map((r) => `
    <div class="m-ship-chip" data-ship="${escapeAttr(r.symbol)}">
      <div class="sym">${escapeHtml(r.symbol)}</div>
      <div class="role">${escapeHtml(r.role)}</div>
      <div class="bar f"><i style="width:${r.fuelCap ? (r.fuel / r.fuelCap) * 100 : 0}%"></i></div>
      <div class="bar"><i style="width:${r.cargoCap ? (r.cargo / r.cargoCap) * 100 : 0}%"></i></div>
    </div>`).join("");
  el.querySelectorAll(".m-ship-chip").forEach((c) => c.addEventListener("click", () => openShipDetails(c.dataset.ship)));
}
```

Wire both new render functions into the same places the data they read is
already refreshed — do not add new polling intervals:

- `renderMobileHero()` and `renderMobileFleetStrip()` should run wherever
  `renderTriage()` and `renderMobileFleet()` currently run (same call sites —
  triage/fleet data updates on the existing 5s/15s cadence already).
- Extend `loadMobilePanels()` (search `function loadMobilePanels()`) if the
  new screens need any additional load call — but per §2, they shouldn't;
  everything is already fetched.
- Call `initMobileTabbar()` once at boot, alongside the existing
  `initViewSwitch()` call.

Header (`#m-credits`, `#m-rate`, `#m-alert-badge`): update these from the
same place `renderTopbar()` runs (that function already recomputes credits/
rate/triage-count on every poll) — either extend `renderTopbar()` itself to
also write these three mobile elements, or add a small
`renderMobileTopbar()` called right alongside it. Prefer extending
`renderTopbar()` — it's one function already responsible for "header from
state+bridge," and a second copy of that logic is exactly the kind of drift
this plan is trying to avoid (see §4's warning about not duplicating the
map).

---

## 7. CSS you need to add

Reuse the existing design tokens (`var(--accent)`, `var(--panel-2)`,
`var(--hairline)`, `var(--chrome)`, `var(--mono)`, etc. — defined in `:root`
near the top of the file) for everything. Do not introduce new colors.

Needed, scoped under the existing `@media (max-width:680px)` block:

- `.m-shell` — flex column, full height, `.m-tabbar` pinned to the bottom
  (`position:sticky` or a flex layout with the tab bar as a fixed-height
  last child — match whatever `.app`'s existing flex-column structure makes
  simplest).
- `.m-screen { display:none; }` / `.m-screen.on { display:flex; flex-direction:column; }`
  (mirrors `.view`/`.view.on` from the desktop pattern — same idea, parallel
  implementation, since `mobileView` is a separate state machine from
  `currentView` per §1).
- `.m-topbar`, `.m-credits`, `.m-rate`, `.m-alert-badge` — visually similar
  weight to the existing desktop `.stat`/`#credits`/`#rate` header elements;
  reuse those rules as a starting point rather than inventing new type scale.
- `.m-hero`, `.m-hero-tag`, `.m-hero-headline`, `.m-hero-actions` — a
  bordered card, left accent border in `var(--accent)`, matching the visual
  weight of `.alert.sev*` (search that class) since it's showing the same
  underlying data, just the top item at hero size.
- `.m-fleet-strip { display:flex; gap:8px; overflow-x:auto; }` +
  `.m-ship-chip` (fixed width ~90-100px card: symbol, role, two thin gauge
  bars for fuel/cargo — reuse `.meter`/`.meter i` styles already defined for
  the desktop fleet table's gauges instead of writing new bar CSS).
- `.m-tabbar { display:flex; }` + 5 buttons, `flex:1` each, icon + label,
  `[aria-pressed="true"]` styled in `var(--accent)` (mirror
  `#view-switch button[aria-pressed="true"]`'s existing rule).
- The map-tab visibility overrides from §4 step 1-2.

Minimum touch target height throughout: match the existing mobile-media
convention already in the file (`min-height:38-42px` on buttons — search
`min-height:42px` for the existing precedent).

---

## 8. Implementation order

1. Add `mobileView` state (§1). Add `setMobileView()`/`initMobileTabbar()`
   (§6) but don't wire them to any markup yet. Syntax-check.
2. Add the tab bar + screen-container HTML (§5), moving (not duplicating)
   the existing Fleet/Ops/Book content into their new screen containers.
   Wire up `initMobileTabbar()`. At this point Bridge/Map screens can be
   empty placeholders — verify tab switching works and nothing else broke.
3. Build the Bridge screen: `#m-hero`, `#m-fleet-strip`, `#m-activity`,
   header elements, and their render functions (§6). Verify against real
   data — trigger a triage item, confirm it shows in the hero card; confirm
   the fleet strip scrolls and matches the Fleet tab's data.
4. Build the Map screen per §4. This is the highest-risk phase — do it last,
   and test thoroughly (see §9) before considering the redesign done.
5. Final CSS pass (§7) — spacing, touch targets, visual consistency with the
   existing Rubine palette.

---

## 9. Acceptance checklist

Test at a `<680px` viewport (e.g. Playwright with `viewport: {width: 390,
height: 844}`), authenticated with a real agent token:

- [ ] All 5 tabs switch correctly; exactly one `.m-screen.on` at a time.
- [ ] Bridge hero card shows the real top triage item (or the empty state
      when triage is clear) and its action buttons actually work (same
      network calls `renderTriage()`'s buttons make today).
- [ ] Bridge fleet strip shows all ships, scrolls horizontally, tapping a
      chip opens `#manifest` with that ship's real detail.
- [ ] Fleet tab is unchanged in content/behavior from before this redesign
      (just relocated under its own tab).
- [ ] Map tab shows the real galaxy map: waypoint glyphs, ship glyphs,
      `#map-fit` works, tap-to-tooltip works, pan/zoom works with touch
      gestures (not just mouse events simulated in a test).
- [ ] Ops tab shows Contracts/Missions/Warehouse content unchanged.
- [ ] Book tab shows standing-orders prose.
- [ ] **Desktop is unaffected**: load the same page at ≥680px width and
      confirm `#view-switch`, all five desktop tabs, and the desktop map
      still work exactly as before. This is the most important check — a
      regression here fails the whole change regardless of how good mobile
      looks.
- [ ] No new console errors on either viewport size.
- [ ] `node --check` on the extracted script block passes.
