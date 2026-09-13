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
