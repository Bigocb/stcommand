# Changelog

Every notable change, newest first. One entry per merged change, written
for someone who wasn't in the room — what changed and why, not just what
the commit touched. Decisions with lasting architectural weight get their
own ADR in `docs/adr/` (see `docs/adr/README.md`) instead of just a line
here; link it from the entry when that happens.

Backfilled from git history starting 2026-09-12 going back far enough to
be useful context; not a complete project history — see `git log` for that.

## Unreleased

- Nothing pending yet — add entries here as work lands, then move them
  under a dated heading below on the next meaningful checkpoint.

## 2026-09-13 (Tower Fleet List: sheet only opens on tap, with a close button)

Operator feedback (with a screenshot) right after the List view shipped:
switching to List immediately popped the action sheet open for whichever
ship happened to be selected, with no way to dismiss it — defeating the
point of a scan view.

- `public/m.html`/`m.css`/`m.js` — a new ✕ close button in the sheet
  header (own `.sheet-head` flex row alongside the ship name), shown
  only in List view. A new `sheetOpen` flag: List starts with the sheet
  closed and only opens it when a roster row is tapped; Deck ignores the
  flag entirely and keeps its existing always-shown-for-the-front-card
  behavior, since closing it there wouldn't mean anything (the next
  card just replaces it).

Typechecked N/A (no `.ts` touched); syntax-checked; audited against the
`[hidden]`-vs-`display` bug from the previous commit — `.sheet-close`
deliberately has no explicit `display` property, so the browser's
built-in `[hidden]` default just works without needing an override.

## 2026-09-13 (Fix: Deck/List toggle didn't actually switch — a CSS gap)

Operator sent a screen recording: tapping "List" correctly highlighted
the button, but the deck stayed on screen underneath it. Root cause:
`.deck` and `.roster` each set `display: flex` directly in their own
class rule; an *author* stylesheet rule always beats the browser's
built-in `[hidden] { display: none }` default regardless of
specificity, so `element.hidden = true` on either container did
nothing visually — no error, no console warning, just silently inert.
Tower already had the right fix pattern in three other places
(`.sheet[hidden]`, `.map-sheet[hidden]`, `.app[hidden]`/
`.auth-gate[hidden]`) — the two new containers from the List-view
commit just didn't get it, and neither, it turned out, did an existing
one.

- `public/m.css` — added `.deck[hidden]`, `.roster[hidden]`, and
  `.grid5[hidden]` (the sheet's own action-button grid, whose "collapse"
  handle tap had the exact same latent bug — never reported because
  nobody had gone looking for it, but confirmed the same root cause on
  inspection). All three now explicitly `display: none`, overriding
  their own class's `display` property the way `[hidden]` is supposed
  to.

Audited every other `element.hidden = ...` call site in `m.js` against
its CSS — everything else either already had a matching `[hidden]` rule
or had no competing `display` property to override in the first place,
so this closes the whole class of bug, not just the one reported.

## 2026-09-13 (Tower Fleet: a List view — see every ship's job in one place)

Operator feedback: seeing who's assigned to what route required
swiping through the deck one card at a time — no way to scan the whole
fleet at once. Also asked what happens at ~25 ships.

- `public/m.html`/`m.css`/`m.js` — a Deck/List segmented control above
  the Fleet screen. List renders every ship as one compact row (symbol,
  role, job/route — reusing the same `jobLabel()` vocabulary the deck
  cards already use — fuel%, hull%, a colored left-stripe for stranded/
  unassigned), tap a row to open the same traffic-manager sheet the deck
  uses. Both views share one `fleetIndex` and one sheet, so switching
  views mid-flow (e.g. open a card in Deck, flip to List to check
  someone else, flip back) doesn't lose the selected ship or reset any
  open form. `renderFleetView()` is now the one call site every mutation
  handler refreshes through — it always keeps the deck's internal state
  correct and additionally re-renders List when that's the active view.
- Answering "what happens at 25 ships": Deck was the one part of Tower
  that didn't scale (a 25-card swipe queue) — List fixes exactly that by
  scrolling instead of paging. Home's tiles/triage feed, Map's blips,
  and Markets/More are all already fleet-size-agnostic (aggregated
  counts, one small dot per ship, or unrelated to ship count), so
  nothing else needed a change.

Typechecked clean; syntax-checked.

## 2026-09-13 (Fix: "New agent" landed on the already-logged-in tenant)

Operator report: clicking "+ New agent" opened `/` in a new tab, but
since session auth is one cookie per browser (shared across every tab),
a tab that already has a live session for some tenant skips straight to
that tenant's dashboard — the sign-in form the button was supposed to
reach never showed.

- `public/v6.js`/`m.js` — `boot0()` now checks for `?login=1` first and,
  if present, force-shows the sign-in form regardless of any existing
  session cookie (then strips the param from the URL bar). Pasting a
  token there works exactly like any other login — it's only the
  "already authenticated, skip to the dashboard" shortcut that's
  bypassed.
- `public/admin.html` — the "+ New agent" link now points to
  `/?login=1`.
- `public/shared/mobileRedirect.js` — forwards the rest of the query
  string (not just its own `?ui=`) when it sends a mobile UA to `/m`, so
  `?login=1` survives that redirect too instead of being silently
  dropped.

**Worth knowing, not a bug**: logging in as a new agent from this link
overwrites the browser's one shared session cookie, same as any normal
login — if another tab in the same browser already has a tenant's
dashboard open, that tab will flip to the new agent on its next request
too. `docs/TODO.md`'s multi-tenant note covers the real fix (separate
per-tab credentials); "View as"/"+ New agent" both work within that
same-cookie constraint for now.

## 2026-09-13 (Admin page: visual pass + "New agent" + Cartography link)

Operator called "View as" a likely primary entry point going forward, so
the admin page got a design pass to match — plus two more one-click
paths that were missing.

- `public/admin.html` — full visual pass: a command-bar header ("Fleet
  Command"), Chakra Petch/IBM Plex Mono type (matching Tower's own
  identity choice, distinct from desktop's), a subtle radial-gradient
  background, glowing status-badge dots, refined table/button/panel
  styling. No functional/JS changes needed — every element ID stayed the
  same, so `admin.js` only needed two small markup tweaks (the `.dot`
  span the new badge CSS expects, and an `.agent-cell` class).
- `public/admin.html` — two new header links, both opening in a new tab:
  **+ New agent** (`/`, the normal sign-in/register page — the operator
  can add a tenant without leaving the admin page or hunting for the
  URL) and **Cartography** (`/cartography`, the public galaxy map).

No server-side changes. Visual-only + two static links; nothing to
typecheck differently, but worth a live look given how much of this is
CSS.

## 2026-09-13 ("View as": multi-tenant switching without logging out/in)

Operator has multiple tenants (THEO, THEO-1, soon THEO-2 for A/B play-
style comparison) and had to log out and back in with a different
SpaceTraders token every time they wanted to check a different one.

- `src/http/gate.ts` — exported `cookieOpts` (was module-private) so
  admin.ts can set the exact same session cookie shape a real login
  would.
- `src/http/admin.ts` — `POST /tenants/:id/impersonate` mints a session
  for the given tenant via the same `createSession()` gate.ts's own
  `/login` uses, and sets the signed cookie — no SpaceTraders token
  involved at all. The `ADMIN_KEY` this route already sits behind (same
  as tenant delete and reset-cleanup) IS the authorization; this is
  deliberately admin-issuing-a-session-for-someone-else, not a new login
  path, and only reachable by whoever holds that key.
- `public/admin.html`/`admin.js` — a "View as" button per tenant row;
  clicking it calls the endpoint, then navigates to `/` already logged
  in as that tenant.

Typechecked clean. `tests/admin.test.ts` couldn't run against the remote
test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this
session, retried twice) — worth a real run, and a live click-through,
next time either is reachable.

## 2026-09-13 (Play-style tracking: a profile label + a manual-override log)

Operator wants to compare "baseline automation" against their own manual
play across tenants — e.g. THEO (overrode automation early: command ship
→ tour, approved two miners, bought and converted a third to trader) vs
THEO-1 (just approving whatever the automation asks for). Landed the
foundation for that as an A/B-style tracking system, not just a one-off
note.

- `migrations/019_operator_actions.sql` — `tenants.play_profile` (a
  free-text label, e.g. "baseline"/"manual") and a new `operator_actions`
  table (tenant-scoped, RLS) logging deliberate operator interventions.
  Both are deliberately **excluded** from the reset-cleanup tool's
  tenant-data wipe (`Store.TENANT_GAME_TABLES`) — a role change from a
  dead universe is still a real data point for comparing play styles
  across resets, same reasoning as leaving `doctrine`/`chat_messages`
  alone. See `CLAUDE.md`'s reset section.
- `src/db/store.ts` — `recordOperatorAction()`/`listOperatorActions()`.
- `src/db/tenants.ts` — `setTenantPlayProfile()`; `listAllTenantsAdmin()`
  now also returns `playProfile`.
- `src/http/dashboard.ts` — `POST /fleet/role` and `POST /fleet/buy` now
  log a `role_change`/`manual_buy` operator action on success. Logged at
  the HTTP route specifically, not inside `FleetManager`'s shared
  `setShipRole()`/`buyShip()` — the engine's own autonomous calls
  (`maybeBuyShip()`, the new `maybeBuyScout()`/`maybeBuySiphoner()`
  approval-gated buys, auto-role-assignment) go straight through those
  methods and must never show up in this log as if the operator had done
  them.
- `src/http/admin.ts` — `PATCH /tenants/:id/profile` (set the label),
  `GET /tenants/:id/actions` (the log), `POST /tenants/:id/checkpoint` (a
  free-text manual note — if the tenant is currently booted in this
  process, its live role counts and credits are captured into the note's
  metadata automatically, so a "here's the current state" checkpoint
  doesn't need the operator to type role counts out by hand).
- `public/admin.html`/`admin.js` — a Profile column (inline-editable) per
  tenant row, and a "Play style" toggle that expands an inline panel:
  the action log plus a textarea to log a checkpoint.

Typechecked clean. Not yet run against a live tenant — the operator still
needs to log THEO's own early manual-override history by hand (see
`docs/TODO.md`), since it predates this feature and can't be
reconstructed automatically.

## 2026-09-13 (Three more approval gates: scout, siphoner, scanner buys)

Follow-up to the "set up more approval gates" TODO item. Investigated
which of the currently-automatic engine spends actually warrant a human
in the loop, and gated the ones that do.

- `src/engine/fleet.ts` — `maybeBuyScout()`, `maybeBuySiphoner()`, and
  `maybeInstallScanner()` now request operator approval (`buyScout`,
  `buySiphoner`, `installScanner`) before spending, via the same
  `ApprovalGate` pattern `maybeBuyShip()` already uses: a pending/denied
  request is just a guard clause (the function reruns every tick
  regardless), and an unanswered request auto-approves after 2h,
  matching each purchase's own prior fully-automatic behavior.
- **Deliberately left alone**: ship repairs (`maybeRepairFleet()`) — too
  cheap/frequent, and gating one risks losing the ship to a failure
  while waiting on a decision, the opposite of what a gate is for.
- **Investigated, found already covered**: ship sell/scrap. `sellShip()`
  only ever runs from an explicit operator "Sell" click
  (`POST /api/fleet/sell-ship`, desktop and Tower both); the `scrapHere`
  callback every `ShipAgent` role carries is plumbed but never actually
  invoked autonomously anywhere in the engine (confirmed by searching
  every call site) — so there was no automatic scrap decision to gate in
  the first place.

Typechecked clean. `tests/fleet.test.ts` couldn't run against the remote
test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this
session, retried once) — worth a real run next time it's reachable.

## 2026-09-13 (Tower: fix — sheets couldn't scroll, so long content was just cut off)

Operator report with a screenshot: "Full details" opened and showed the
"Cargo hold" heading, then nothing below it — no scrollbar, no way to
reach the rest. Root cause: `.body` clips anything past its own bounds
(`overflow: hidden`, so the deck above never bounces past its edge), and
neither `.sheet` (Fleet's traffic-manager sheet) nor `.map-sheet` had a
max-height or their own scroll — expanding one past the remaining space
just clipped the overflow into nothing, with no way to reach it. Ship
details' own inner `max-height: 46vh; overflow-y: auto` (from the earlier
commit below) never got a chance to run, since its parent was already
clipped shut.

- `public/m.css` — `.sheet` and `.map-sheet` now get `max-height: 62vh;
  overflow-y: auto; overscroll-behavior: contain` (and `flex: 0 1 auto`
  so they can actually shrink to fit) — the sheet itself scrolls as one
  unit now, so "Full details," a long ship-pick/route-pick list, or a
  waypoint with many shipyard listings are all reachable by scrolling
  instead of silently cut off.
- Removed `.ship-details`' own now-redundant inner scroll — nesting two
  independently-scrolling regions was more confusing than useful once the
  outer sheet scrolls correctly.

## 2026-09-13 (Tower Fleet: full ship details — cargo, loadout, modules, mounts)

Second half of the Fleet sheet's "coming soon" placeholder — role
assignment (below) covered one of the two, this covers the other:
"Full details" now expands rather than sitting disabled.

- `public/m.html`/`m.css`/`m.js` — `renderShipDetails()` renders cargo
  hold (with Jettison), loadout (frame/reactor/engine names), modules and
  mounts (with Remove), and components sitting in cargo ready to install
  (with Install) — the same fields desktop's ship-detail sheet shows,
  condensed into one scrollable block instead of desktop's row of
  sub-tabs. Calls the same `/api/fleet/jettison`,
  `/api/fleet/remove-component`, and `/api/fleet/install` endpoints
  desktop already uses. Nothing left placeholder on the Fleet sheet.

## 2026-09-13 (Tower Fleet: assign/switch ship role)

Operator feedback: the Fleet sheet's "Full details — coming soon"
placeholder was standing in for role assignment, which they needed now,
not later.

- `public/m.html`/`m.css`/`m.js` — "Change role" on the ship detail sheet
  expands a role picker (same 8 roles desktop offers), a live mismatch
  warning (`roleMismatchReason()` from `shared/domain.js` — e.g. "no
  mining laser mounted" for `miner`), and a keeper-market waypoint field
  when switching to `keeper`, matching desktop's own role-change UI.
  Calls the same `POST /api/fleet/role` endpoint. Full manifest/mount
  detail remains the one still-placeholder link.

## 2026-09-13 (Tower Map: pinch-zoom/pan, real ship movement, multi-system)

Follow-up to the asteroid-declutter pass below — operator still found it
cluttered (overlapping labels in dense clusters) and asked for pinch-zoom/
pan, plus flagged two things Map needed eventually: ship movement like
desktop's map, and a plan for multiple systems.

- `public/m.html`/`m.css`/`m.js` — **pinch-zoom + pan**: Pointer Events on
  a new `#scope-view` wrapper (one finger pans, two pinch-zooms, clamped
  1x-4x) drive a CSS transform on `#scope-field`, kept as a separate
  element from the field so the pan/zoom viewport never has to be
  threaded through the percentage-based blip coordinate math. A small
  reset button (⟲, top-right) snaps back to 1x/centered.
- `public/m.js` — **label decluttering**: a waypoint's symbol label now
  only renders when the system has ≤10 chartable waypoints, the scope is
  zoomed past 1.6x, or it's the selected waypoint — a dense system shows
  clean icons by default instead of the overlapping-text pile-up a tight
  cluster produced, and labels reveal themselves as you zoom in.
- `public/m.js` — **ship movement**: reuses `shared/domain.js`'s
  `shipTransitLerp()`/`shipHeadingDeg()`, the same functions desktop's
  own map already uses, so an in-transit ship now animates smoothly
  between origin and destination and renders as a small triangle rotated
  to its real heading instead of a static dot.
- `public/m.html`/`m.css`/`m.js` — **multi-system**: a chip row above the
  scope lists every charted system (from `state.systems`, the same
  `GalaxyAtlas.listSystems()` data desktop's galaxy overview already
  reads — no new server endpoint) and switches which one Map is showing.
  Purely a viewing choice; doesn't touch which system fleet/dispatch
  actions operate on. A zoomed-out galaxy view with jump-gate lines
  (like desktop has) was considered and deliberately deferred — this
  picker is the smaller step, worth revisiting only if system-hopping on
  Map turns out to be frequent.

Typechecked (`npx tsc --noEmit`, clean) and syntax-checked; not yet
verified live against a real phone's touch gestures.

## 2026-09-13 (Tower Map: drop asteroid clutter, zoom in on real destinations)

Operator feedback: the radar scope was too zoomed out because it plotted
every waypoint in the system, including asteroid fields and other
decorative bodies that outnumber the actual destinations (markets,
shipyards, jump gates).

- `public/m.js` — `isChartable(wp)` (market/shipyard trait, or a jump
  gate) now filters what `renderScope()` draws *and* what
  `computeMapProjection()` uses to compute the zoom extent — previously
  every waypoint's x/y fed the min/max span, so a handful of asteroids at
  the system's edge flattened every real destination into a tight cluster
  in the middle. A ship still renders even when parked at an excluded
  waypoint (e.g. mining an asteroid) — it's projected with the same
  transform as everything chartable, just not drawn as its own blip.
- The system header's charted count now reflects chartable waypoints
  (markets/yards/gates), not the raw waypoint total.

## 2026-09-13 (Tower: start/stop missions and contracts from More)

Follow-up to the Markets/More ship below — operator wanted the same
start/stop control desktop's Ops tab has for missions and contracts, not
just the read-only progress More shipped with initially.

- `public/m.html`/`m.js` — a "start a construction mission" row (waypoint
  input + Start button, `POST /api/missions/start`) above the missions
  list; each active mission card now has a Stop (`/api/missions/pause`,
  confirmed — releases the carrier ship) or Resume
  (`/api/missions/resume`) button instead of read-only progress only.
- `public/m.js` — contracts' "Stop working" (abandon) action now confirms
  first, matching desktop's warning (no cancel in the SpaceTraders API —
  the contract stays accepted and lapses at its deadline, costing
  reputation).
- Same `/api/missions/*`/`/api/contracts/*` endpoints desktop already
  calls — no new server-side surface.

## 2026-09-13 (Tower: Markets and More tabs — 5-tab IA complete)

Fourth and fifth screens of Tower (`/m`, the separate mobile app — see
`docs/mobile-app-design.md`), following Home/Fleet/Map: Markets and More,
completing the originally-designed 5-tab IA (Home · Fleet · Map ·
Markets · More).

- `public/m.html`/`m.css`/`m.js` — **Markets**: a Routes/Yards segmented
  control. Routes lists the top profitable routes by profit/trip (same
  computation `/api/markets` already returns); tapping "Assign a ship"
  expands an inline picker of trader ships rather than a separate sheet,
  calling the same `/api/dispatch` endpoint the Fleet deck's route-pick
  already uses. Yards groups shipyard/module intel by item (cheapest
  location leading, up to 2 alternates noted) with a direct Buy button —
  the same grouping desktop's Yards & outfitting panel uses, reading
  `intel.shipyards`/`intel.modules` from the shared store.
- `public/m.html`/`m.css`/`m.js` — **More**: a plain scroll of lower-
  frequency sections, per the design doc's own "a simple list-of-sections
  is enough" framing rather than a sub-tab bar. Contracts (accept/
  decline/undecline/abandon/resume with delivery progress bars, same
  `/api/contracts/*` endpoints desktop uses), Construction missions
  (read-only progress — starting a *new* mission stays desktop-only),
  Warehouse (stationed ship, total value, top goods held — full ledger/
  targets editing stays desktop-only), and Doctrine (on/off toggles only,
  no threshold sliders — mirrors the existing "mobile doctrine" pattern
  already shipped on desktop's own `#mobile-view`, same `/api/doctrine`
  endpoint).
- No new server-side surface — both screens read/write the same
  `/api/markets`, `/api/dispatch`, `/api/fleet/buy`, `/api/contracts/*`,
  `/api/missions`, `/api/warehouse`, and `/api/doctrine` endpoints every
  other UI version already calls, through the same `public/shared/
  store.js` loaders.

Typechecked (`npx tsc --noEmit`, clean — no `.ts` files touched) and
syntax-checked (`node --check public/m.js`); not yet verified live against
a real phone — see `docs/TODO.md`'s Tower verification item, now covering
all 5 tabs.

## 2026-09-13 (recover from a live SpaceTraders universe reset)

A real SpaceTraders weekly universe reset hit mid-session — every ship
across every tenant (DRAGOM, EWOK, CARO) started failing with `agent
token is from a previous server reset`, and the public cartography
page kept showing the now-defunct pre-reset galaxy. Operator
re-registered a fresh agent (THEO) and asked for a repeatable way to
clean up after this, since it'll happen again (SpaceTraders resets
weekly).

- `src/db/store.ts` — `truncateSharedGalaxyTables()` (every galaxy-wide
  table each already documents as "static for the life of a server
  reset": `galaxy_systems`, `galaxy_factions`, `galaxy_crawl_state`,
  `market_snapshots`, `market_latest`, `shipyard_inventory`,
  `module_catalog`, `galaxy_jump_costs`, `galaxy_gate_construction`)
  and `wipeTenantGameData(tenantId)` (per-tenant tables naming
  something from the dead universe — ships, contracts, missions,
  warehouse, financial history — deliberately excluding operator
  config like `doctrine` and login `sessions`, neither of which the
  reset makes wrong).
- `src/engine/galaxyCrawler.ts` — `resetCrawlState()`, so the
  background galaxy-wide crawl restarts from page 1 immediately in the
  current process rather than only on the next full restart.
- `src/http/admin.ts` — `POST /reset-cleanup` (wipes every tenant not
  named in `keepTenantIds`, always truncates the shared tables, resets
  the crawler); `GET /tenants` now also surfaces each tenant's
  `deadTokenReason` (client.ts's existing reactive `TOKEN_RESET_
  MISMATCH` detection was already there — just never surfaced past the
  app logs before this).
- `public/admin.html`/`admin.js` — a "After a server reset" panel: a
  banner when any tenant shows a dead token, a per-tenant checklist
  (defaulting to whichever tenants are currently dead-tokened), and the
  cleanup button.
- `CLAUDE.md` (new) — durable documentation of the whole scenario, the
  recovery procedure, and an open idea (not built) for detecting a
  reset proactively via SpaceTraders' own public status endpoint
  instead of waiting for a tenant's own call to fail first.

Typechecked clean. `tests/admin.test.ts` updated for the new
`createAdminRouter()` parameter (a `GalaxyCrawler` instance) but
couldn't be run against the remote test Postgres — same intermittent
timeout as earlier this session, retried once. Verifying live: about
to run the real cleanup now (DRAGOM/EWOK/CARO, keeping THEO).

## 2026-09-13 (Tower: Map — a literal radar scope)

Third Tower screen: the current system rendered as a real radar scope
rather than a generic map-tile view, per the approved design — ties
the visual identity directly to the "Radar" concept name.

- `public/m.html`/`m.css`/`m.js` — range rings, a sweep wedge, and
  shaped blips per waypoint type (triangle = jump gate, square =
  shipyard, diamond = market, dot = anything else, plus a small white
  dot per ship currently in-system), positioned from real waypoint x/y
  (`state.waypoints`) normalized into the scope's circular field.
  Tapping a waypoint opens a bottom sheet showing whatever shipyard/
  module intel is already known for it (`intel.shipyards`/
  `intel.modules`, populated via `loadMarkets()`), with a direct **Buy**
  for a ship — no ship-context needed, unlike installing a module onto
  a specific hull, which stays read-only from this screen for now.
- Current system only this pass — cross-system navigation isn't built
  yet.
- No new server-side surface: `/api/fleet/buy` is the same endpoint
  desktop's Yards & outfitting panel already calls.

Typechecked clean (no server-side changes), `m.js` syntax-checked,
`m.html` div-tag-balance sanity-checked. Not run against a local
server — verifying live post-deploy.

## 2026-09-13 (Tower: Fleet — the ship-card deck)

Second Tower screen after Home: a swipeable ship-card deck replacing
the desktop Fleet tab's sortable table for this mobile app, per the
approved design (`docs/mobile-app-design.md`).

- `public/m.html`/`m.css`/`m.js` — a stack of hull cards (front + a
  peek of the next 1-2 behind it), navigable by swipe or Prev/Next
  buttons. Each card shows role, job (reusing the desktop Fleet tab's
  `jobFor()`/Job-column vocabulary — route/contract/mission/warehouse
  buy-sell/unassigned), fuel/cargo/hull-condition gauges, and current
  position — stranded ships get a red border, unassigned traders amber.
- A traffic-manager action sheet underneath the deck, always targeting
  the front card's ship: **Send to waypoint** (inline text input),
  **Hold/Release** (toggles based on current state), **Assign route**
  (a short picker over the top 4 computed routes by profit), **Repair**,
  **Sell/Scrap** (with the same confirm-dialog wording desktop uses),
  and a disabled **Full details — coming soon** placeholder for
  anything rarer (full manifest, mount specifics) — deliberately not
  porting desktop's dense multi-tab ship-detail sheet, per the design
  doc's own call for a simpler mobile control surface.
- No new server-side surface: every action calls the same
  `/api/fleet/*`/`/api/dispatch` endpoints the desktop dashboard
  already uses.

Typechecked clean (no server-side changes this pass), `m.js`
syntax-checked, `m.html` div-tag-balance sanity-checked. Not run
against a local server — verifying live post-deploy.

## 2026-09-13 (Tower: a genuinely separate mobile app, Home only)

First implementation pass on the mobile app design (`docs/
mobile-app-design.md`, approved earlier today): a real `/m` route, not
another entry in the v2-v6 desktop version lineage — own manifest, own
app-shell CSS, own visual identity ("Tower": near-black ground,
phosphor-amber accent, Chakra Petch + IBM Plex Mono).

- `public/m.html`/`m.css`/`m.js` — the app shell (fixed, `100dvh`,
  `overscroll-behavior:contain`, `env(safe-area-inset-*)`, `viewport-
  fit=cover` + `user-scalable=no`) and the Home screen: Cockpit tiles
  (credits, rate, fleet health, best route) plus a Mission Control
  triage feed (pending approvals, stranded ships, unassigned traders),
  wired to the same `public/shared/*.js` store every desktop version
  already uses — no new data layer. Fleet/Map/Markets/More exist as
  tab targets with a "coming soon" placeholder; not built this pass.
- `public/shared/mobileRedirect.js` — sends a mobile User-Agent from
  `/` to `/m` automatically (own `localStorage` key, `?ui=desktop`/
  `?ui=m` escape hatches). Deliberately a plain classic script, not an
  ES module — a `type="module"` script is deferred past first paint,
  which would flash the desktop layout before redirecting; loaded as
  the very first thing in `v6.html`'s `<head>`, before any stylesheet.
- `public/manifest-tower.webmanifest` + `public/icons/tower-*.png` —
  Tower's own PWA identity (`scope: "/m"`, own name/icons/theme-color),
  distinct from the existing desktop manifest. Icons are a placeholder
  mark (radar rings + a blip, in the Tower palette) generated
  programmatically via Python/Pillow — real brand artwork can replace
  them later without touching anything else.
- `src/cli/index.ts` — new `/m` route, same free-standing pattern as
  `/admin`/`/cartography` (unauthenticated HTML; the page does its own
  client-side session auth). `src/http/uiVersions.ts`'s `cacheHeaders()`
  extended to give `m.css`/`m.js` the same 5-minute cache policy v2-v6
  already get.

Typechecked clean, `m.js`/`mobileRedirect.js` syntax-checked, manifest
JSON validated. Not run against a local server (would require the
production `DATABASE_URL`) — verifying live post-deploy instead, per
this session's established pattern.

## 2026-09-13 (architecture overview doc)

Added `docs/architecture-overview.md` — a system-by-system breakdown
(tenancy, `FleetManager`/roles, dispatcher, intent board, scheduler,
approval gate, galaxy knowledge, persistence, HTTP/dashboard layer,
frontend versions, doctrine) for anyone picking the codebase up cold.
Closes the long-parked TODO item asking for this to be saved somewhere
durable instead of only ever having existed conversationally.

## 2026-09-13 (Fleet tab: a Job column, so an unassigned trader stands out)

Operator request: at a glance on the Fleet tab, know whether each ship
is on a route, a mission, or a contract — so an idle trader that could
be reassigned isn't buried in a column of nav status text.

The data already existed (`RouteDispatcher.list()`, already used by
Trade Ops' Dispatch panel) but the Fleet tab never fetched or rendered
it — its "Doing" column only ever showed live nav status (docked/in
orbit/transit), not what the ship is actually working toward.

- New "Job" column (`public/v6.js`'s `jobFor()`) translates a trader's
  `TraderAssignment` into operator vocabulary: `route: GOOD`,
  `contract: GOOD`, `mission: GOOD`, `warehouse buy/sell: GOOD`, or
  `unassigned` (highlighted in accent color) when a trader has no
  assignment at all — the ships worth looking at first. Every other
  role shows "—": their Doctrine/Doing columns already say what
  they're doing.
- `dispatchAssignments` (`/api/dispatch`) was previously only fetched
  while on the Trade Ops tab; now also fetched on entering the Fleet
  tab and every 20s while it's open, and the Fleet table (desktop and
  both mobile fleet views) re-renders whenever dispatch data changes.

Syntax-checked with `node --check`; no server-side changes, so
`npx tsc --noEmit` is the only relevant check (clean). No automated UI
test coverage in this codebase for table rendering — worth a manual
glance next deploy to confirm the Job column populates correctly and
"unassigned" traders are visually distinct.

## 2026-09-13 (root-caused: approved keeper-probe purchase never bought)

Reproduced live: operator approved a `buyKeeperProbe` request (probe at
`X1-C59-D15X` for 26,261c) on the dashboard; ~12 minutes later, no
"purchasing SHIP_PROBE" log line had appeared at all — the decision just
sat in the DB, unread. This is the exact bug flagged in `docs/TODO.md`
after an earlier occurrence.

Root cause: `maybeRequestKeeperProbe()` — which both requests a new
approval AND reads back a decided one via `ApprovalGate.request()` — only
ever runs from `recordShipyardSnapshot()`, itself only reachable when some
ship physically docks at that exact shipyard again. Unlike `maybeBuyShip()`
(called unconditionally every tick, so a decision is always picked up
within one tick), an operator who approves a keeper-probe request while no
ship happens to be revisiting that waypoint has no path back to the
engine ever noticing — `ApprovalGate.request()` only detects a decided row
the next time it's called with that same `kind`, and nothing was calling
it.

Fix: split the purchase-execution half of `maybeRequestKeeperProbe()` into
`purchaseKeeperProbe()`, and added `resolvePendingKeeperProbeApproval()` —
called every tick, unconditionally — which re-issues the same
`"buyKeeperProbe"` kind through `ApprovalGate.request()` using the
cost/detail already stored on the pending row (no fresh shipyard scan
needed) and completes the purchase the moment a decision shows up.

`tests/fleet.test.ts` adds three cases: approves-and-buys with no
revisit (reproduces the live bug directly), still-pending is a no-op,
and denies-with-no-revisit. Typechecked clean. Could not run the new
tests against the remote test Postgres — same intermittent timeout as
earlier this session, retried once. Verifying live: watching for the
`X1-C59-D15X` probe purchase to actually go through on DRAGOM's next
tick after this deploys.

## 2026-09-13 (keeper-probe fix, take two: don't consume an approval SpaceTraders will reject)

The keeper-probe fix above shipped, and its very first live approval
(the same `X1-C59-D15X` request) immediately surfaced a second, real
bug: it correctly noticed the operator's approval this time, but the
purchase itself failed — `"Failed to purchase ship. Your agent must
have at least one ship available at the purchase location
(X1-C59-D15X)."` SpaceTraders requires one of the agent's own ships to
be physically docked at a shipyard to buy there. The old code got this
for free (it only ever ran mid-scan, while a ship was already
standing there); `resolvePendingKeeperProbeApproval()` deliberately
doesn't have that guarantee, and by the time the operator approved
(12+ minutes later), the triggering ship had moved on. Consuming the
approval and then failing the purchase is worse than the original bug
— now the decision is gone too, silently.

Fixed: `resolvePendingKeeperProbeApproval()` now checks
`fleetStatusSummary()` for a ship currently at the target waypoint
before letting `ApprovalGate.request()` consume an approve-bound
decision (explicitly approved, auto-approved, or a pending row past
its timeout with `onTimeout: "approve"`). A denial still processes
immediately regardless — no purchase needed, so no reason to wait.
`tests/fleet.test.ts` covers both: waits when no ship is present, then
buys once one shows up.

Typechecked clean. Could not run the new/updated tests against the
remote test Postgres — same intermittent timeout as earlier this
session, retried once. Watching live for the next `buyKeeperProbe`
approval to confirm the full round-trip (wait for ship → buy) works.

## 2026-09-13 (mobile Ops tab was missing Approvals entirely)

Operator report: the global "N approvals awaiting your decision" banner
showed on mobile and tapping it landed on the Ops tab, but nothing was
there to approve.

Root cause: mobile runs its own independent screen markup/state machine
(`#mobile-view`'s `.m-screen[data-mscreen=...]`, driven by
`setMobileView()`) rather than reusing the desktop `.view` sections
`setView()` drives — confirmed by reading both mobile's ops screen and
`renderApprovalsBanner()`'s comment claiming "clicking jumps to Ops,
where the actual Approve/Deny controls live," which was only true on
desktop. Two compounding bugs:
1. The banner's click handler only called `setView("ops")`, which has no
   effect on mobile's separate screen state at all.
2. Even ignoring that, mobile's Ops screen (`public/v6.html`) had no
   Approvals pane in its markup to begin with — `renderApprovals()` only
   ever wrote to the desktop `#approvals`/`#approval-count` elements,
   same shape as the `renderContracts()` bug this fixes: dashboard.ts
   already returns fresh approvals, they just had nowhere to render on a
   phone.

Fixed: added a mobile Approvals pane (`#mobile-approvals`/
`#mobile-approval-count`) as the first pane in mobile's Ops screen,
mirroring `renderContracts()`'s existing dual-render pattern;
`renderApprovals()` now writes to both desktop and mobile elements and
wires the Approve/Deny buttons on both; the banner's click handler now
also calls `setMobileView("ops")` when `isMobile()`.

Syntax-checked with `node --check`; no automated test coverage for
mobile DOM rendering in this codebase, so this needs a manual check on
a phone (or narrow viewport) next: confirm the banner navigates to Ops
and the approval actually renders with working Approve/Deny buttons.

## 2026-09-13 (Yards & outfitting: system filter + per-item pricing)

Operator request: shipyard/module intel should carry the same
`?system=` filter the Routes and Prices & snapshots panels already have
in the Markets view, and should compare prices for the same item across
locations rather than an arbitrary flat list.

Previously `GET /api/markets` ignored `?system=` for `shipyards`/`modules`
entirely (only `snapshots`/`routes` respected it), and the client rendered
the first 12 raw scan rows in whatever order the store returned them — so
the panel could show the same ship type or module twice at different
waypoints while a cheaper listing for it never made the cut, with no way
to scope it to one system.

- `src/http/dashboard.ts`'s `/markets` route now filters `shipyards`/
  `modules` by `systemFilter` the same way `snapshots` already does.
- `public/v6.html`/`v6.js`: added a `yards-system-filter` select next to
  the other two Markets-tab system filters, wired into the same
  `marketSystemFilter`/`loadMarkets()` plumbing.
- `renderShipyardIntel()` now groups shipyard rows by ship type and
  module rows by symbol, sorts each group by price, and shows the
  cheapest location plus up to 3 other locations for that same item —
  real per-item price comparison instead of a flat cut.

Typechecked clean; `public/v6.js` syntax-checked with `node --check`.
Not verified against `tests/dashboard.test.ts` — hit the same
intermittent `ETIMEDOUT`/timeout connecting to the remote test Postgres
seen earlier this session (retried once per the established policy, no
luck either time). Worth a manual pass in the live dashboard next
deploy: pick a system in the new Yards & outfitting filter and confirm
only that system's shipyards/modules show, and that a ship type or
module scouted at two locations shows both under one grouped entry.

## 2026-09-13 (persist gate-construction cache too)

- **Persisted `GalaxyAtlas`'s gate-construction cache**, the other half of
  the cross-system-routes-never-fire bug — the jump-cost persistence
  shipped earlier today only fixed the pricing side. `canJump()` (which
  `RouteDispatcher.recompute()` requires to be `true` before it will ever
  assign a cross-system `direct` route — see `dispatcher.ts:497`) reads
  from `gateConstruction`, a plain in-memory `Map`, also wiped on every
  restart. Confirmed live immediately after the jump-cost fix went out:
  the dispatch log showed real, correctly-computed cross-system candidates
  (`ELECTRONICS@X1-YB82-BD9F=44976`, `ANTIMATTER@X1-RN95-F13B=15480`) but
  DRAGOM-1 stayed assigned a same-system `FUEL` leg worth only `286`/trip
  — the gate-confirmation cache had reset on the last deploy, and nothing
  had freshly re-checked that exact pair yet this process lifetime, even
  though the fleet's own explorers had already jumped through it
  successfully before. Same shape as the jump-cost fix: new shared table
  `galaxy_gate_construction` (migration 018, no tenant_id — a gate's
  construction status is a fact about the galaxy), `Store.recordGalaxyGateConstruction()`/
  `getAllGalaxyGateConstruction()`, `GalaxyAtlas.loadGateConstruction()`
  (called at boot alongside `loadJumpCosts()`) — careful not to let a
  stale loaded "incomplete" downgrade a gate this process already
  confirmed complete live, matching `canJump()`'s existing one-way
  semantics. `tests/galaxy.test.ts` covers it directly.

## 2026-09-13 (persist learned jump costs)

- **Persisted `GalaxyAtlas`'s learned per-gate-pair jump cost average**,
  closing the real reason cross-system routes never fired even after the
  earlier jump-cost bootstrap fix: `jumpCosts` lived only in a plain
  in-memory `Map`, wiped on every process restart. With deploys happening
  several times a day, a learned cost never survived long enough to
  replace `CROSS_SYSTEM_JUMP_COST_ESTIMATE`'s flat 5,000c placeholder —
  every cross-system leg was priced against the placeholder forever
  regardless of how many real jumps actually happened. New shared (no
  tenant_id — a jump's real cost is a fact about the galaxy's gate
  network, not about who paid for it, so one tenant's real jump now
  helps every tenant converge faster) table `galaxy_jump_costs`
  (migration 017), `Store.recordGalaxyJumpCost()`/`getAllGalaxyJumpCosts()`,
  and `GalaxyAtlas.loadJumpCosts()` (called once at boot, `fleet.ts`'s
  `init()`) to seed the in-memory average instead of starting cold.
  `recordJumpCost()` stays synchronous at every call site — the durable
  write fires in the background and swallows its own errors, so a slow or
  failed persistence call never blocks a ship's own tick.
  `tests/galaxy.test.ts` covers the new persistence/seeding behavior
  directly against a fake store. **Not yet verified against the real
  database** — this session's sandbox hit the same intermittent
  `ETIMEDOUT` connecting to the remote test Postgres seen earlier
  (2026-09-12's auto-keeper-probe entry has the same note); the migration
  itself is simple, standard SQL and runs automatically on every boot
  (`cli/index.ts` calls `runMigrations()` before serving), so it should
  apply cleanly on the next real deploy — worth a quick log check
  afterward (a `dispatch recompute` line naming a cross-system leg with a
  learned, non-5000 fuel cost) to see it working live.

## 2026-09-13 (two live bugs: tour/keeper fuel estimate, stranded-rescue retry loop)

- **Fixed the dashboard's manual "Send to waypoint" reporting "needs
  Infinity fuel" for a perfectly healthy ship.** Found live: DRAGOM-14,
  300/300 fuel, a `tour` ship. `FleetManager.shipWaypoint()`/`cachedShip()`
  enumerated miners/traders/surveyors/scouts/siphoners/explorers but never
  `this.tours` or `this.keepers` — any ship in either role fell through to
  `idleShips` (empty, since the ship was actively working) and resolved to
  an unknown `""` position, which `estimatedFuelTo()` can only answer as
  `Infinity`. This blocked manual dispatch for every tour/keeper ship,
  which is exactly the tool an operator reaches for when trying to
  manually rescue one that's stuck. `tests/fleetNonBlocking.test.ts`
  covers both helpers directly for tour and keeper ships.
- **Fixed `escapeByJump()` (the stranded-ship rescue path) retrying an
  identical doomed jump forever.** Same bug shape as the `autoExplore()`
  fix from 2026-09-12 — a protection that existed on `exploreSystem()`
  (check the remote gate's construction status, record a skip, never
  retry the same doomed target) was never applied to this sibling
  jump-planning path. Found live: DRAGOM-14, stranded at X1-S84's own
  jump gate, retried a jump to X1-YB72-I62 every scheduler cycle
  (~5-6s) nonstop, each attempt failing with "Destination jump gate ...
  is under construction." `escapeByJump()` now filters candidate systems
  against the same `gateConstructionSkipUntil` skip-list and checks the
  remote gate before attempting, falling through to the fuel-tender
  rescue path (and remembering not to retry) instead of hammering the
  same doomed jump. `tests/fleetNonBlocking.test.ts` covers it directly.

## 2026-09-13 (per-tenant proxy support)

- **Added optional per-tenant forward-proxy support**, so a tenant can get
  its own dedicated public IP instead of sharing this process's one IP
  (and its one SpaceTraders 2 req/s ceiling) with every other tenant.
  Operator request, after confirming SpaceTraders rate-limits by source
  IP, not by agent token — running multiple agents "without sharing a
  rate limit" genuinely requires separate egress IPs, which neither
  Render nor Vercel provide per-service by default. Set
  `PROXY_URL_<AGENTSYMBOL>` (e.g. `PROXY_URL_DRAGOM=http://user:pass@host:port`)
  and that tenant's `Client` routes every request through it and gets its
  own private rate limiter instead of drawing from the shared one — see
  `.env.example`.
  - New `Client` option `proxyUrl`, using `undici`'s own `fetch` +
    `ProxyAgent` for the proxied path only. Confirmed directly (not just
    assumed) that mixing a `ProxyAgent` built from the separately
    npm-installed `undici` package with Node's *global* `fetch` — which is
    backed by its own internal, differently-versioned copy of undici — is
    unreliable: it throws outright when the two copies' majors differ,
    and silently hangs forever even when their minor versions are close.
    The unproxied path (every tenant without a `PROXY_URL_*`, and every
    existing test that mocks `globalThis.fetch`) is completely untouched.
  - `tests/clientProxy.test.ts` covers the real thing end to end: a real
    CONNECT-tunneling forward proxy in front of a real HTTPS target (the
    actual mechanism a dedicated datacenter proxy provides for reaching
    SpaceTraders' HTTPS-only API), confirming a proxied request genuinely
    tunnels through it and an unproxied one never touches it.

## 2026-09-12 (route planner prefers real scan data when it fully covers a route)

- **The Route Planner now tries the real scanned jump-gate graph first**,
  falling back to the physical-proximity estimate only when no fully
  scanned path exists between the two systems. So once tenants' fleets
  scan enough gates to connect two systems for real, the planner
  automatically starts returning that as a "confirmed" route instead of
  an "(estimated)" one — no separate wiring needed, since it reads the
  same `lastConnections` data the map's connection-line layer already
  refreshes every 30s. Answers an operator question about whether newly
  scanned connections would be picked up.

## 2026-09-12 (route planner: proximity estimate instead of scan-only)

- **Reworked the Route Planner to always produce a route**, instead of
  coming up empty for the (very common) case where no tenant has ever
  scanned a gate connecting two systems. Operator request, after
  confirming a real assumption gap: not every system has a jump gate at
  all (`JUMP_GATE` is one waypoint type among several — a system may
  simply have none), so real gate connectivity can never be fully known
  without scanning every system. Per operator direction, the planner now
  deliberately assumes every system has a gate and estimates connectivity
  by physical proximity — each system links to its 6 nearest neighbors by
  raw galaxy x/y — then runs the same breadth-first shortest-hop search
  over that graph. Results are labeled "(estimated)" and the panel says
  plainly that it isn't confirmed against any tenant's scan data. The
  map's own jump-gate connection-line layer is unaffected — still real
  scanned data only, unchanged.

## 2026-09-12 (cartography bookmarks, connections, route planner)

- **Added system bookmarks to `/cartography`**, listed under the Activity
  card. Since this is a public, no-login page there's no account to hang
  a bookmark list off, so it's stored in the viewer's own browser
  (`localStorage`) — private to that browser, doesn't follow across
  devices, but that's the honest tradeoff for staying login-free. A ☆/★
  button next to the search box bookmarks whatever system is currently
  highlighted; clicking a bookmark jumps the map straight to it.
- **Added subtle jump-gate connection lines**, drawn between systems once
  zoomed in enough to read as structure rather than a solid mess (same
  zoom-threshold approach as the symbol labels). A connection where both
  endpoints are marked "explored" draws in blue instead of the default
  muted gray, to call out routes that are actually usable today (both
  ends known well enough to know they connect) versus a route only known
  from one side's scan. New `Store.listGalaxyJumpConnections()` and
  `GET /api/cartography/connections`, both deriving system-to-system
  pairs from `galaxy_systems.jump_gates` (again tenant-exploration data,
  never the crawler's own).
- **Added a Route Planner tab.** Two system inputs and a breadth-first
  search over the same jump-gate connection graph — hop-count-shortest,
  not cost-shortest, since real per-jump fuel costs only ever live in a
  tenant's own in-memory `GalaxyAtlas` and are never persisted anywhere
  this public page can read. "Show on map" switches back to the map tab,
  fits the view to the route's systems, and draws it as a dashed violet
  line with its hop systems outlined to match.

## 2026-09-12 (cartography tenant-exploration layer + labels)

- **Added the tenant-exploration layer to `/cartography`**, the piece
  explicitly deferred when the page first shipped. A system is marked
  "explored" once *some* tenant's own fleet has actually visited it and
  populated its waypoints (`galaxy_systems.waypoints` non-empty) — the
  crawler alone only ever learns coordinates/type, never waypoint detail,
  so this is the one bit of real fleet activity visible on the otherwise
  tenant-agnostic crawl map. Explored systems get a subtle green outline
  on the map, toggleable via a checkbox, plus their own "Explored" stat
  tile. New `Store.listGalaxySystemPositions()` field `explored` (a cheap
  `jsonb_array_length(waypoints) > 0` check, not the waypoint blob itself).
- **Added system-symbol labels near each dot once zoomed in far enough**
  that they'd actually be legible — hidden entirely at the whole-galaxy
  view where thousands of overlapping labels would just be noise, shown
  past a zoom threshold (also whenever a search zooms in on a match).
  Same DOM-reuse approach as the dots: each system gets a paired `<text>`
  element once, and only its position/font-size/visibility are touched on
  zoom/pan, not a full rebuild.

## 2026-09-12 (cartography search + zoom)

- **Added system search and zoom controls to `/cartography`'s galaxy map.**
  Typing a system symbol and hitting Go (or Enter) jumps the map to that
  system's neighborhood; unobtrusive +/- buttons and a fit-whole-galaxy
  reset sit in the map's corner, alongside mouse-wheel zoom and click-drag
  panning. Switched the map's dots from being rescaled to fit a fixed
  0-800 box to being drawn at their raw galaxy x/y with the SVG `viewBox`
  doing all the zoom/pan work — panning or zooming no longer re-lays-out
  any dots, only moves the viewBox and rescales dot radius to match.

## 2026-09-12 (public cartography page)

- **Added a public, no-login galaxy map at `/cartography`.** Operator
  request, inspired by another developer's public SpaceTraders cartography
  tool. Built around `GalaxyCrawler`'s existing systems+factions crawl (the
  comprehensive, tenant-agnostic data source) rather than any one tenant's
  own partial exploration — shows a scatter-plot map of every crawled
  system colored by star type, a factions table, live crawl-progress stats
  (systems mapped vs. the galaxy's real total, now tracked via the API's
  own pagination total instead of just counting rows), and a scrolling
  activity log of crawl milestones. New `GET /api/cartography/{systems,
  factions,progress,activity}` endpoints, mounted ahead of `resolveTenant`
  in `src/cli/index.ts` (same pattern as `/api/gate`/`/api/admin`) since
  none of this is tenant-scoped. `GalaxyCrawler` now keeps an in-memory
  ~50-entry activity ring buffer and tracks the galaxy's total system count
  via a new `Client.getSystemsPage()` (captures the SpaceTraders pagination
  `meta.total`, which the generic `get()` helper used to discard). Added
  `Store.listGalaxySystemPositions()`, a lean read (no jsonb waypoint/
  jump-gate blobs) for the map's scatter plot. Tenant-exploration detail
  (markets/shipyards) was considered as a secondary data layer but not
  built in this pass — the crawler's systems+factions data was confirmed as
  the starting point.

## 2026-09-12 (auto keeper probes)

- **A tour ship (or any ship) visiting a shipyard with no keeper
  stationed there now requests to buy a probe on the spot to become
  one.** Operator request. A probe has no fuel and can never move, so
  buying one at that exact waypoint is the only way to plant a keeper
  there at all — this closes the gap where keeper coverage previously
  only ever came from converting an idle miner/shuttle onto a manually
  curated market list, never from a shipyard discovered opportunistically.
  Goes through the same operator approval gate as any other autonomous
  purchase. New doctrine switch `autoKeeperProbes`, on by default —
  turn off in the Book if unwanted. See `docs/TODO.md` for a test-infra
  note (one new test case couldn't be verified live in this session due
  to a transient connection timeout to the remote test database).

## 2026-09-12 (input-reset fixes)

- **Fixed Book page inputs resetting mid-edit too** — same root cause
  as the Markets/ship-detail fix below: `renderBook()` unconditionally
  rebuilds its whole sheet's innerHTML whenever it re-renders for any
  reason, wiping the Discord webhook URL field, co-pilot settings
  fields, and any in-progress numeric policy-value edit. Now skips the
  render entirely while a value chip's click-to-edit input is open (it
  isn't part of the template, so nothing could restore it anyway), and
  snapshots/restores every other input the same way
  `refreshOpenShipDetails()` already does.
- **Fixed inputs resetting mid-edit on Markets and in ship detail
  panels**, on both mobile and desktop (v5/v6). Two separate bugs:
  the price chart's material dropdown's `change` handler read a stale
  closed-over variable instead of the event's actual new value, so
  picking a different material didn't register at all — the next 20s
  poll just restored the old selection, looking like a revert; and
  `refreshOpenShipDetails()` only ever preserved one specific field
  (`.dispatch-wp`) across its full re-render (every 5s while a panel is
  open), so every other input — keeper-market waypoint, the tour-
  dispatch system picker — reset mid-edit on that same cycle. Both
  fixed: the dropdown now reads `e.target.value` and skips unnecessary
  rebuilds, and the ship-detail preservation now covers every input/
  select/textarea in the panel generically instead of one hardcoded
  field.

## 2026-09-12 (autoExplore retry-loop fix)

- **Fixed `autoExplore()` retrying a doomed jump forever.** Found live:
  `DRAGOM-C` retried the identical jump to `X1-YB72` (remote gate under
  construction) every few minutes for 45+ minutes straight. Same bug
  shape as the `exploringEnabled` bypass fixed earlier this session — a
  protection (`exploreSystem()`'s remote-gate construction check and
  skip-list) existed on the dedicated-explorer path but was never
  applied to `autoExplore()`, the parallel path that opportunistically
  borrows an idle tour/scout ship. `canJump()` only validates the local
  gate, so nothing stopped the same unreachable target from being
  reselected pass after pass. `autoExplore()` now filters against
  `gateConstructionSkipUntil` and checks+records the remote gate's
  status before ever proposing the jump, mirroring `exploreSystem()`
  exactly. `tests/fleetNonBlocking.test.ts` covers it directly.

## 2026-09-12 (jump-cost fix + health check)

- **Fixed the cross-system jump-cost bootstrap gap.** `GalaxyAtlas.recordJumpCost()`
  now also fires from `shipProxy.ts`'s shared explore-jump path (the one
  every tour ship and explorer actually uses), not just trader/fleet-
  manager jumps. Previously a real jump's cost — like DRAGOM-D's actual
  jump to X1-RN95 — never lowered `crossSystemLegCost()`'s estimate for
  that gate pair, so every cross-system leg stayed priced against the
  flat 5,000-credit placeholder forever, a closed loop that meant no
  cross-system route could ever become profitable enough to fly and
  correct the estimate. `tests/shipProxy.test.ts` covers the fix
  directly (asserts `recordJumpCost` fires with the local gate,
  destination system, and real transaction price from the JUMP phase).
- **What "tour more systems" actually takes today**, for reference: a
  tenant assigns/buys a Light Shuttle into the `tour` role, then either
  dispatches it to a specific system via the dashboard's Tour Dispatch
  panel (multi-hop auto-jump toward the target, one gate at a time) or
  just lets it roam — `marketTourTargets()`/`shipyardTourTargets()`
  already trait-scan every charted system, not just home. The one hard
  constraint: a tenant can't dispatch its last home-system tour ship
  away (`fleet.ts`'s `dispatchTourShip()` refuses) — keepers only cover
  the home system's big markets, the smaller ones rely on a tour ship
  passing through.
- **Added `GET /healthz`**, mounted ahead of every other route in
  `src/cli/index.ts`, so Render can be pointed at a real health check
  instead of having none configured at all. Existence alone is the
  signal — it always returns 200. Needs the Render dashboard's Health
  Check Path field set to `/healthz` by hand (no API/MCP tool exposes
  that field on an existing service) before it actually changes deploy
  behavior — see `docs/TODO.md`.

## 2026-09-12 (multi-tenant market scoping + UI)

- **Scoped market data and dispatch routes to systems a tenant has
  actually charted.** `market_latest` is a shared table across every
  tenant on this server reset (deliberate — a market's price is a fact
  about the server, not the observer). Nothing filtered reads from it,
  though: DRAGOM's Markets tab was showing prices and "same-system"
  routes for `X1-QV71`/`X1-CN35`, systems it has never sent a ship near,
  priced entirely off other tenants' exploration. `computeDispatchRoutes()`
  and the `/markets`/`/intel` dashboard endpoints now filter to this
  tenant's own `chartedSystems` record. The home system is charted at
  boot, so no regression there.
- **Waypoint labels through the UI now include their system** (e.g.
  "S84-A1" instead of a bare "A1") — now that cross-system operation is
  real, a local waypoint code alone is ambiguous (multiple systems can
  have a waypoint named the same thing). Dropped the now-redundant
  separate system badge next to it in `v5`/`v6`.
- **Root-caused why cross-system trade routes never fly**, even once
  connectivity and cross-system market data both genuinely exist:
  `GalaxyAtlas.recordJumpCost()` — which lowers the estimated cost of a
  cross-system leg once a real jump's price is known — is only wired
  into the trader's and fleet-manager's own jump paths, not the shared
  explore/tour jump path every tour ship and explorer actually uses.
  So every cross-system leg gets priced against a flat, deliberately
  conservative 5,000-credit placeholder forever, which nothing has
  cleared yet — a closed loop, since no cross-system route can become
  profitable enough to fly and record a real, lower cost. Not fixed yet;
  see `docs/TODO.md`.

## 2026-09-12 (live-ops)

- **Lowered DRAGOM's `marginFloor` doctrine value from 20c to 10c**
  (operator change, not a code change). DRAGOM-1's trader had been
  flapping on its own FUEL route for over an hour — the route's real
  margin sat right at 19-20c, so it bounced between viable and rejected
  on every live price tick. Verified via live logs: after the change,
  DRAGOM-1 went from mostly-stuck to 11 successful route pickups across
  FUEL/FOOD/MEDICINE in the following 51 minutes, with zero margin-floor
  rejections and no new failure mode introduced by the looser floor.

## 2026-09-12

- **Documented four API-governance gaps** found while comparing this
  app's rate-limiting design against another developer's SpaceTraders
  app: per-request priority never reaches the shared HTTP rate limiter,
  the limiter's queue has no cap/shedding, mutating API calls have no
  ambiguous-failure/reconciliation safety net, and API capacity isn't a
  doctrine-tunable resource the way credits are. See
  `docs/api-request-priority-plan.md`, `docs/rate-limiter-saturation-plan.md`,
  `docs/ambiguous-mutation-safety-plan.md`, `docs/api-capacity-doctrine-plan.md`.
  Not implemented — proposals only.
- **Explored (and closed) a Kubernetes pod-per-tenant migration.**
  Conclusion: doesn't hold up on cheap managed K8s tiers, since they
  don't solve the actual constraint (SpaceTraders rate-limits by source
  IP, not tenant token) and would replace the in-process priority-queue
  rate limiter with a harder distributed version of the same problem.
  See `docs/k8s-pod-per-tenant-exploration.md`.
- Started this changelog, `docs/TODO.md`, and `docs/adr/README.md` to
  keep multi-threaded work organized going forward.

## 2026-09-11 and earlier (recent highlights)

- `8cd04f0` Rescue stranded ships by jumping when a fuel tender could
  never work — closes a real incident where DRAGOM-C/14 got stuck with
  no reachable fuel tender.
- `7ac2fcc` Tour ships top off fuel at every market, not just when running
  low.
- `e41e648` Fix stranded tour ships never getting rescued — `ShipAgent`
  never self-flagged as stranded in the first place.
- `e416ed4` Fix cross-system holds getting permanently stuck, quietly
  draining tour coverage.
- `db3c473` Fix `autoExplore()` skipping real jump gates it never
  actually loaded.
- `293c504` Fix two exploring-switch bugs: `autoExplore()` bypass and an
  unadopted default.
- `46de3aa` Add operator approval gate MVP, wired into autonomous ship
  buying — a human-in-the-loop gate for consequential engine decisions.
- `5494f03` Block dispatching the last home-system tour ship.
- `3b963b8` Fix vanished sector tabs: union charted systems into
  `/api/state` too.
- `5b0373d` Fix exploring master switch: check `isEnabled()`, not
  `value() === 0`.
- `ec03b9d` Add remote tour ship dispatch: multi-hop auto-jump toward a
  target system.
- `042a33e` Add doctrine controls to pause expensive explorer jumps.
- Persisted open trade positions (`heldRoute`/`heldCost`) across restarts
  and closed a multi-tenant boot-priority gap — see
  `docs/architecture-plan.md` and the held-route persistence work
  (migration `013_held_route.sql`).

For anything before this, `git log` is the record until it's worth
backfilling further.
