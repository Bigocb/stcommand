# Deck — remaining build passes (handoff spec)

**Audience note, read this first**: this doc is written for a *different,
lower-context coding model* picking up work on `/deck` cold. Follow it
literally. Every file path, function name, and endpoint below was checked
against the real code as of 2026-09-20 (commit range ending `cc3cba4` on
`claude/stcommand-ui-parallel-versions-fd5p9q`) — do not re-derive names by
guessing at what "should" exist. If something here turns out to be wrong
(a function renamed, a field that no longer exists), **stop and say so**
rather than improvising a replacement. This mirrors the discipline
`docs/deck-desktop-design.md` (Deck's original build spec) already
establishes — read that file too, once, for the project's visual identity
and hard rules (reuse `public/shared/*.js`, no new backend unless a table
in this doc explicitly says so, dual-push to `main` *and*
`claude/stcommand-ui-parallel-versions-fd5p9q` per `CLAUDE.md`, typecheck
before every commit).

**Also read the per-screen build specs this doc supersedes the "what's
next" of**: `docs/deck-fleet-design.md`, `docs/deck-markets-design.md`,
`docs/deck-map-design.md`, `docs/deck-ops-design.md`,
`docs/deck-doctrine-design.md`. Each one's own §7 ("What happens after
this pass") only ever pointed to the *next originally-scoped screen* —
Fleet→Markets→Map→Ops→Doctrine→command palette. That original 5-screens-
plus-palette scope is now **fully built** (confirmed in §0 below), so
none of those docs' §7 sections point anywhere further — this doc is the
first to define what comes after all of them. Each of those docs' own §1
also explicitly *deferred* several things as deliberate, reasoned scope
cuts for their pass — not oversights. Two matter directly here and are
worth reading before starting:
- `deck-fleet-design.md`'s §1 cut "Assign route / Send fuel tender / Full
  details" buttons from the ship detail panel, reasoning "no existing
  endpoint backs 'send fuel tender' as a one-click action." That reasoning
  is still correct for *fuel tender* specifically (no such endpoint
  exists) but was **never actually true** for hold/release/role/repair/
  sell/jettison/install/remove-component — those endpoints existed in
  `dashboard.ts` even at the time that doc was written; Tower's own
  ship-detail sheet was already using them. Pass A below builds those.
- `deck-markets-design.md`'s §1 cut dispatch-assignment and warehouse-
  designation forms with the reasoning "ship first with plain display,
  same discipline as Fleet pass 2" — a sequencing choice, not a missing-
  endpoint one; the endpoints it names as v6-only already existed then
  too. Pass B below builds those.

## 0. What's already built (verified, not assumed)

Deck (`/deck`: `public/deck.html`, `public/deck.js`, `public/deck.css`) has
six screens, all wired to live data: **Overview**, **Fleet**, **Markets**,
**Map**, **Ops**, **Doctrine**. Also built: a command palette (⌘K,
navigation-only — jumps to a screen or a ship by symbol, no actions), and
a right-hand Signal rail (Approvals + Activity) present on every screen.

What each screen actually does today, confirmed by reading `deck.js`:

- **Overview** (`renderTopbar`, `renderKPIs`, `renderMinimap`,
  `renderWantsDoing`): KPI row, a home-system mini-map, and the
  Wants-vs-Doing table. Full CRUD-free read view plus the AUTO/HALT toggle
  (`POST /api/fleet/pause` / `/api/fleet/resume`).
- **Fleet** (`renderFleet`, ~line 389): a table + detail-split layout
  (`.fleetsplit`, `#fleet-table`, `#fleet-detail-head`,
  `#fleet-detail-body`) grouped by system with clickable chips. Clicking a
  row shows cargo/frame/fuel/wants-doing in the detail pane. Pass A now
  also renders a full per-ship action sheet (`renderFleetActions`) inside
  that pane — see §1, now built.
- **Markets** (`renderMarkets`, ~line 518): Routes, Yards & outfitting, a
  **read-only** Warehouse panel (goods + total value), and a **read-only**
  top-5 dispatch-assignments readout. No write actions.
- **Map** (`renderMap`, `renderMapDetail`, `renderMapLeaderboard`): a
  spatial chart of the home system plus a compact top-3 leaderboard
  snippet. **No Factions list, no System Agents panel, no replay/scrub.**
- **Ops** (`renderOps`, `renderManipulationRoutes`,
  `loadAndRenderManipulationHistory`): Approvals-adjacent contract/mission
  panels plus the full Manipulation Routes finder (Assign/Hold, History
  toggle, refining warnings) — this one is fully-featured, built and
  fixed across several passes this session, nothing to do here.
- **Doctrine** (`renderDoctrine`, ~line 856): Standing Orders list and
  recent activity, **read-only** — no enable/disable toggle wired.

Explicitly **not built anywhere in Deck**: warehouse designate/release,
dispatch assign/clear, keeper station config, a Factions list, a System
Agents (+running credits tally) panel, co-pilot chat/narrative, Map
replay/scrub, and Fleet bulk-select / cross-system rollup (the original
design doc's own deferred "screens 6–7"). Per-ship action controls were
the largest gap and **are now built** — see §1's status line.

## 1. Pass A — Fleet ship-action sheet (highest priority) — BUILT 2026-09-20

**Status**: shipped. See the CHANGELOG entry of the same date. Implemented
in `public/deck.js` as `renderFleetActions()` + `renderShipDetails()` +
`roleLabel()`/`SHIP_ROLES`/`resetFleetActionForms()`, with two delegated
listeners bound to `#fleet-detail-body`. One deviation from §1c's literal
wording: the `#fleet-detail-actions` container is created by `renderFleet()`
rather than declared in `deck.html`, because it would otherwise be wiped by
the `innerHTML` assignment each render; listeners bind to the stable parent
instead, same one-handler-keyed-off-`data-act` pattern. `.field-select` and
`.field-input` were added to `deck.css` per §1d. No backend change, as
§1b predicted. Live verification still pending (no DB/token in the build
environment).

The sections below are retained as the build record.

**Why first**: this is the single largest functional gap. An operator can
*see* every ship in Deck's Fleet screen but cannot act on one — no hold,
no role change, no repair, nothing. Tower (`public/m.js`) already has a
fully-built, working reference implementation of exactly this — port its
shape, don't redesign it.

### 1a. New imports this pass needs

Verified against `deck.js`'s current import block (top of the file, as
quoted in full in §0's own note above): it imports `dispatchAssignments`
but **not** `dispatchRoutes` (needed for the Assign-route picker below),
and its `/shared/domain.js` import (`fmt, signed, escapeHtml, fmtTime,
shortWp`) does **not** include `roleMismatchReason` (needed for the role-
change mismatch warning below). Add both to `deck.js`'s existing import
statements — don't add new `import` lines for them.

### 1b. Reference implementation to copy from

Read `public/m.js` lines ~355–560 in full before writing anything —
specifically the `sheet-actions` rendering block and its click handler.
It implements, in order:
- **Send to waypoint** (toggles an inline waypoint input + Go button) →
  `POST /api/fleet/dispatch` with `{ shipSymbol, waypointSymbol }`.
- **Hold** / **Release** (button label flips based on current paused
  state) → `POST /api/fleet/hold` / `POST /api/fleet/release`, both take
  `{ shipSymbol }`.
- **Dock** / **Orbit** toggle → `POST /api/fleet/dock` with just
  `{ shipSymbol }` (verified against `src/http/dashboard.ts`: the server
  itself flips docked↔orbiting based on the ship's current
  `nav.status`, no action field to pass — it 400s if the ship is
  `IN_TRANSIT`, response is `{ ok, shipSymbol, status }`).
- **Assign route** (toggles a picker showing the top 4 profitable routes
  from `dispatchRoutes`, sorted by `profitPerTrip` descending) → same
  `/api/dispatch` endpoint as §2 below, `{ shipSymbol, good, buyAt,
  sellAt, buyPrice, sellPrice, profitPerTrip }` (fields come off the
  matched `dispatchRoutes` entry).
- **Repair** → `POST /api/fleet/repair` with `{ shipSymbol }`.
- **Sell / Scrap** button, labeled that but only ever calls one endpoint
  (verified against `m.js`'s handler): a `confirm()` dialog ("Sell
  `<ship>` permanently? It will fly to the nearest shipyard and be
  scrapped there. This cannot be undone."), then
  `POST /api/fleet/sell-ship` with `{ shipSymbol }`. `/api/fleet/scrap`
  exists as a separate endpoint but Tower's sheet doesn't call it from
  this button — don't wire a second action here without a reason to
  diverge from the reference implementation.
- **Change role** (toggles a role `<select>` + Set button; shows a
  keeper-market-waypoint input only when `keeper` is selected; shows a
  mismatch warning via `roleMismatchReason()` from `/shared/domain.js`
  when the selected role doesn't fit the ship's mounts) →
  `POST /api/fleet/role` with `{ shipSymbol, role, keeperMarket }`
  (`keeperMarket` only when role is `keeper`).
- **Full details** (toggles `renderShipDetails()`): cargo hold with
  per-item **Jettison** (`POST /api/fleet/jettison` with
  `{ shipSymbol, good, units }`), Loadout (frame/reactor/engine, display
  only), Modules/Mounts each with **Remove**
  (`POST /api/fleet/remove-component` with `{ shipSymbol, componentSymbol
  }` — verified against `dashboard.ts`, note the field is
  `componentSymbol`, not `component`), and "Components in cargo" with
  **Install** (`POST /api/fleet/install` with `{ shipSymbol,
  componentSymbol }`, same field name; there's a separate
  `POST /api/fleet/buy-install` with `{ shipSymbol, componentSymbol,
  marketWaypoint }` for buying-then-installing in one call from a
  shipyard — Tower's sheet uses the plain `install` endpoint for a
  component already in cargo, which is the one this pass needs).

All of these endpoints already exist in `src/http/dashboard.ts` (grep for
`router.post("/fleet/` — the full list as of this doc: `pause`, `resume`,
`dispatch`, `hold`, `release`, `role`, `mine`, `dock`, `transfer`, `buy`,
`refuel`, `scrap`, `sell-ship`, `jump`, `tour-dispatch`, `explore`,
`buy-install`, `install`, `remove-component`, `trade`, `jettison`,
`repair`). **Do not add any new backend route for this pass** — every
action Tower's sheet exposes already has a working endpoint; if you find
one that seems missing, re-check `dashboard.ts`'s router list before
concluding it doesn't exist.

### 1c. Where it goes in Deck's markup

`public/deck.html`'s Fleet screen already has `#fleet-detail-head` and
`#fleet-detail-body` (see `.fleetsplit`, around line 78–102). Add the
action buttons as a new block, e.g. `#fleet-detail-actions`, rendered
inside `renderFleet()`'s existing `if (selectedFleetShip)` branch (deck.js
~line 460), right after the existing cargo/frame/fuel detail body. Wire a
single delegated click listener on that container (same pattern Tower
uses: `$("sheet-actions").addEventListener("click", ...)`, one handler
keyed off `e.target.closest("button[data-act]")` and `b.dataset.act`) —
don't attach a separate listener per button.

### 1d. Styling — Deck has no form-input classes yet

`deck.css` has `.btn`/`.btn.pri`/`.btn.deny` already (reuse these
directly, same as every other Deck action button). It has **no**
`<select>`/`<input>` styling class — the one existing precedent
(Manipulation Routes' ship picker, deck.js ~line 767) uses an inline
`style="background:var(--sunken);border:1px solid var(--hair);color:var(--bone);border-radius:4px;font-size:10px;padding:2px 4px"`
on the `<select>` directly. For a form-heavy sheet like this one, it's
worth adding two small reusable classes to `deck.css` instead of
repeating that inline style everywhere — e.g.:

```css
.field-select, .field-input {
  background:var(--sunken); border:1px solid var(--hair-hi); color:var(--bone);
  font-family:var(--mono); font-size:11px; padding:8px 10px; border-radius:4px;
}
```

Use these for every new `<select>`/`<input>` this pass adds (the ship
picker, the role picker, the keeper-waypoint input, the send-to-waypoint
input). This keeps future passes (§2, §4) from re-inventing the same
inline style a third and fourth time.

### 1e. Verification

- `npx tsc --noEmit` (should stay clean — this pass touches no `.ts`
  files at all if the endpoints truly all already exist, which §1b
  documents).
- `node --check public/deck.js` and `node --check public/deck.html`
  (html can't be `node --check`ed — visually inspect instead).
- Manual: sign in, open Fleet, click a ship, exercise every action button
  at least once against a real tenant if a live DB/token is available in
  the environment; if not, say so plainly rather than claiming it was
  verified (same rule the original Deck spec's §7 step 11 already states).

## 2. Pass B — Trade Ops actions (dispatch + warehouse)

**Why second**: Deck's Markets screen already *shows* warehouse and
dispatch data — this pass is "make the read-only panels write", not new
screens. Endpoints already exist and are already documented precisely in
§1b's sibling calls; see `public/v6.js` lines ~5817–5885 for the exact,
already-working implementation to port (`dispatchAssign`, `dispatchClear`,
`warehouseDesignate`, `warehouseRelease`). This pass needs the same
`dispatchRoutes` import called out in §1a — add it once, use it in both
passes.

Add to Deck's Markets screen (`renderMarkets`, deck.js ~line 518):

- **Dispatch toolbar**: a ship `<select>` (traders only —
  `fleetStatus.ships.filter(s => s.role === "trader")`), a good `<select>`
  (from `dispatchRoutes`, distinct `.good` values), an **Assign** button
  (`POST /api/dispatch` — see §1b's Assign-route body shape) and a
  **Auto** button (`POST /api/dispatch` with `{ shipSymbol, clear: true }`).
  Reuse `.field-select` from §1d.
- **Warehouse toolbar**: a ship `<select>`, a waypoint text `.field-input`,
  a **Designate** button (`POST /api/warehouse/designate` with
  `{ shipSymbol, waypointSymbol }`) and a **Release** button
  (`POST /api/warehouse/release`, no body).

Lower priority within this same pass, only if time allows — do not let
these block shipping the two toolbars above:
- Warehouse manual adjust (`POST /api/warehouse/adjust` — deep-dive
  `v6.js` ~line 5886 for the exact field set: `good`, `units`, `price`,
  `direction`) and warehouse sell-targets
  (`POST /api/warehouse/targets` / `/api/warehouse/targets/remove`).
- Keeper station config (`POST /api/keeper/markets` — three distinct
  calls in `v6.js`: `{ markets: lines }` to save the full list,
  `{ coverList: bool }` to toggle full-list coverage,
  `{ reset: true }` to restore defaults — see `v6.js` ~line 610–632 and
  ~5849–5865 for both the save-form and the two toggle buttons).

## 3. Pass C — Galaxy data (Factions + System Agents w/ running tally)

**Why this is fully speced already**: the System Agents panel with a
running credits tally was just built for `v6.js` this session (commit
`cc3cba4`, "Add a running credits tally for agents in the home system")
— the backend is 100% done, nothing new to add there. This pass is purely
"port the existing v6.js rendering into Deck's Map screen."

Deck has no dedicated Galaxy tab (only a top-3 leaderboard snippet on
Map, `renderMapLeaderboard`) — the design call already made for this repo
is to extend the **Map** screen's right-hand area with Factions + System
Agents rather than add a seventh rail item. Follow that, don't add a new
nav item unless the operator asks for one.

### Data already loaded

`deck.js`'s `subscribe("galaxy", ...)` (line ~1164) already fires on
every `loadGalaxy()` call and already re-renders `renderMap`,
`renderMapDetail`, `renderMapLeaderboard` when the Map screen is visible
— `loadGalaxy()` itself (in `public/shared/store.js`) already fetches
`factions`, `leaderboard`, `systemAgents`, **and now also
`systemAgentsHistory`** (added this session) in one call. No new fetch
needed — just import and render.

### What to add to `deck.js`

Import `factions`, `systemAgents`, `systemAgentsHistory` from
`/shared/store.js` — verified against `deck.js`'s current import block
(top of the file): it already imports `leaderboard` but **not**
`factions`, `systemAgents`, or `systemAgentsHistory`, so add all three
to the existing `import { ... } from "/shared/store.js"` block rather
than adding a second import statement.

1. **Factions list** — port `v6.js`'s `renderFactions()` (search
   `function renderFactions` in `v6.js`) directly: one row per faction,
   `symbol`/`name`/`description`/`isRecruiting`/`traits`. Style with
   Deck's own `.panel`/`.panel-h`/`.panel-b` (not v6's `.loadout-grid` —
   that class doesn't exist in `deck.css`; use a simple flex column with
   inline styles matching the rest of Deck's Map/Ops screens' pattern, or
   add small `.faction-row`/`.faction-name` classes to `deck.css` if that
   reads cleaner).

2. **System Agents + running tally** — port `v6.js`'s
   `renderSystemAgents(agents, history)` (search `function
   renderSystemAgents` in `v6.js`, just updated this session — read it in
   full, it's short). Key logic to preserve exactly:
   - Group `history` (an array of `{ agentSymbol, credits, shipCount,
     timestamp }`) by `agentSymbol` into a `Map`.
   - For each agent in `agents` (the current snapshot), find their
     history points; if there are **2 or more** points, compute
     `delta = currentCredits - firstPoint.credits` and show it as a
     signed value (`signed()` from `/shared/domain.js`) colored green
     (positive), red (negative), or dim (zero) — a single point is *not*
     a trend, don't compute a delta from it.
   - Mark the tenant's own agent (`state?.agent?.symbol`) distinctly, same
     as v6 does with `· you`.

### New endpoint used (already built, no backend work)

`GET /api/agents-in-system/history` — returns
`{ system, history: [{ agentSymbol, credits, shipCount, timestamp }] }`,
oldest-first per agent. `public/shared/store.js`'s `loadGalaxy()` already
calls this; Deck gets it for free once it imports `systemAgentsHistory`.

## 4. Pass D — Doctrine write actions

Deck's Doctrine screen (`renderDoctrine`, deck.js ~line 856) renders
Standing Orders read-only. `public/m.js`'s `renderMoreDoctrine()` +
its click handler (search `more-doctrine` in `m.js`) is the reference:
each rule row has a toggle switch, `aria-pressed` reflecting
`rule.enabled`, click handler calls `POST /api/doctrine` with
`{ key: rule.key, enabled: !currentlyEnabled }`, then re-fetches via
`loadDoctrine()` (already imported/used in `deck.js` for the read side)
and re-renders. Port the toggle control and its handler; the list
rendering itself Deck already has, don't rebuild it from scratch.

## 5. Deferred — lower priority, do not start before A–D above

These were explicitly out of scope for every prior Deck pass too, and
still are unless the operator asks for one specifically:

- **Fleet bulk-select + cross-system rollup** (the original design doc's
  mockup screens 6–7) — needs its own spec once Pass A's per-ship actions
  are live and proven; bulk-acting on ships nobody can yet act on
  individually is the wrong order.
- **Map replay/scrub** — v6.js has `replayByShip`/`replayT0`/`replayT1`
  and a scrub track (`renderScrubTrack`); porting this to Deck's spatial
  chart is a real feature, not a quick add — scope it separately.
- **Co-pilot chat / narrative** — v6.js's Bridge tab has a chat panel
  (`sendChat()`, `addChatMsg()`, `POST /api/chat`) and an AI-generated
  narrative log (`loadNarrative()`). Nothing in Deck today reads
  `narrative`/`chatHistory` at all. Worth a dedicated pass with its own
  UI decision (where does a chat panel live in Deck's layout?) rather
  than bolting it onto an existing screen.
- **Command palette actions** — today it only navigates (§0). Wiring
  actions into it (e.g. "hold THEO-1" typed and executed) was explicitly
  deferred by every prior spec doc for this exact reason; don't add it
  as a side effect of Pass A just because the endpoints now exist in the
  palette's own file.

## 6. After each pass — repo housekeeping (per `CLAUDE.md`)

For every pass above, once it ships:
- `npx tsc --noEmit` clean, `node --check public/deck.js` clean.
- Commit with a message describing *why*, not just what (this repo's own
  convention — see recent commits on `claude/stcommand-ui-parallel-versions-fd5p9q`
  for the expected tone/depth).
- **Push to both `main` and `claude/stcommand-ui-parallel-versions-fd5p9q`**
  — Render only auto-deploys from `main`; pushing only to the feature
  branch strands the commit and nothing deploys. If a push is rejected
  as non-fast-forward, `git fetch` both branches and merge before
  retrying — never force-push.
- Add one `CHANGELOG.md` entry per shipped pass (written for someone who
  wasn't in the room) and update this doc's own §0 "what's already built"
  section to reflect the new reality, so the *next* pass's author isn't
  reading a stale snapshot the way this doc itself replaces one
  (`docs/deck-desktop-design.md`'s own §9 "what happens after" was never
  updated past its original Overview-only pass — don't repeat that gap
  here).
