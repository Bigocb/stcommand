# Deck Ops — build spec (pass 5, low-context build)

**Audience note**: written to be followed literally, same as the four
specs before it. Every data field named below has been checked against
real code (`public/v6.js`) as of 2026-09-20 — don't re-derive field names
from guessing. If something here is wrong (a function renamed, a field
gone), stop and say so rather than improvising.

## 0. Context

**No mockup screen exists for this one.** The original "Deck Command
Console" artifact (`https://claude.ai/artifact/VrRF7Uucw4MqZGGdD93VyV`)
designed Overview/Fleet/Markets/Map/Command-palette — five screens. "Ops"
and "Doctrine" were only ever placeholder rail entries from pass 1
(Overview), never designed. This spec designs Ops from scratch, reusing
Deck's own established visual system (the same `.panel`/`.panel-h`/
`.panel-b` structure every other screen already uses) rather than
inventing new components — there is nothing to port from a mockup here,
so match the *shape* of Deck's existing screens, not any external
reference.

**What Ops covers**: v6's own separate "Ops" tab (`public/v6.js`, `if
(name === "ops") loadProgramme();`) shows contracts and construction
missions — real fleet data, not a placeholder. That's the real content
this pass surfaces, adapted to Deck's two-panel layout convention (same
`.mgrid`-style split Markets pass 3 used, or a simple `.cols2` split like
Overview's — either is fine, pick whichever fits two roughly-equal panels
best).

## 1. Scope of THIS pass

Build, inside the existing `<div class="content" id="view-ops" hidden>`
placeholder in `public/deck.html`, two panels:

- **Contracts**: every contract in `contracts[]` (imported from
  `/shared/store.js`, populated by `loadProgramme()` — same source
  `v6.js`'s `renderContracts()` reads). For each: type, faction, status
  (accepted/offered/declined/not-being-worked), payout
  (`onAccepted`/`onFulfilled`), and each deliverable's progress
  (`unitsFulfilled`/`unitsRequired` as a fraction and a percentage).
- **Missions**: every *active* construction mission in `missions[]`
  (same loader), filtered to `status === "active"` — matches
  `renderMissions()`'s own filter. For each: target waypoint, paused/
  supplying/complete status, assigned carrier ship (or "no carrier yet"),
  and each material's fulfilled/required progress.

Both panels are **read-only display only** this pass — matching the same
discipline Markets pass 3 used for its first look at real data. No
accept/decline/abandon/resume buttons, no carrier-assignment dropdowns.
v6's own Ops tab has all of that; none of it is in scope here.

**Cut entirely from this pass** (do not build, do not stub):
- Contract accept/decline/abandon/resume actions.
- Contract-carrier and mission-carrier assignment dropdowns/buttons.
- Any mutation — this screen only reads `contracts`/`missions`, it never
  calls an API endpoint.

## 2. Hard requirement: reuse, don't reinvent

`deck.js` needs to import `contracts` and `missions` from
`/shared/store.js` (confirm the exact export names in that file — these
are what `v6.js` imports) plus the `loadProgramme()` loader. Call
`loadProgramme()` when `setView("ops")` fires, following the exact same
on-demand-load pattern the Markets pass established for `loadGalaxy()`
(not polled — a fetch-on-view-select, matching `v6.js`'s own `if (name
=== "ops") loadProgramme();`). Wire a `renderOps()` function into
`subscribe("programme", ...)` — check whether `public/shared/store.js`
already fires a `"programme"` subscription event (`v6.js` has
`subscribe("programme", () => { renderContracts(contracts);
renderMissions(missions); });` — mirror that).

## 3. Data binding

### Contracts panel

| Element | Real source |
|---|---|
| Card title | `${c.type} · ${c.factionSymbol}` |
| Status tag | `c.accepted ? "accepted" : c.declined ? "declined" : c.abandoned ? "not being worked" : "offered"` |
| Payout | `+${fmt(c.onAccepted)} / +${fmt(c.onFulfilled)}` |
| Deliverable rows | one per `c.deliver[]`: `${d.tradeSymbol} → ${d.destinationSymbol}` with `${d.unitsFulfilled}/${d.unitsRequired}` and a percentage bar (reuse the `.meter`/`.meter i` CSS Fleet's own detail panel already added — `width:${pct}%`) |
| Deadline | `c.deadline` — display as a plain formatted string (import `fmtTime` from `/shared/domain.js`, already used elsewhere in `deck.js`); don't port `v6.js`'s `countdown()` live-ticking helper unless it's trivially importable — a static timestamp is fine for a first pass |

Empty state: "No contracts available." (matches `v6.js`'s own string).

### Missions panel

| Element | Real source |
|---|---|
| Card title | `m.targetWaypoint` |
| Status tag | `m.paused ? "paused" : (all materials fulfilled ? "complete" : "supplying")` |
| Carrier | `m.assignedShip ? `carrier ${m.assignedShip}` : "no carrier yet"` |
| Material rows | one per `m.materials[]`: `mat.tradeSymbol` with `${mat.fulfilled}/${mat.required}` and a percentage bar, same `.meter` pattern as Contracts |

Empty state: "No construction missions." (a shortened form of `v6.js`'s
own string — drop the "Enter a construction waypoint and Start" part,
since that instruction refers to a write-capable control this read-only
pass doesn't have).

## 4. CSS

No new CSS classes should be needed — reuse `.panel`/`.panel-h`/
`.panel-b` (from Overview), `.meter`/`.meter i` (from Fleet), and `.chip`-
style tags if you want status pills (from Fleet/Markets). If a genuinely
new class is unavoidable (e.g. a two-line card layout for each contract/
mission), keep it minimal and consistent with Deck's existing spacing/
color tokens (`var(--panel)`, `var(--hair)`, `var(--amber)`, etc. — check
`deck.css`'s `:root` custom properties before inventing a new color).

## 5. Build sequence

1. In `public/deck.html`, replace the placeholder:
   `<div class="content" id="view-ops" hidden><div class="empty">Ops — coming soon.</div></div>`
   with a two-panel layout (Contracts left/top, Missions right/bottom —
   your call on exact arrangement, following whichever existing Deck
   layout pattern reads best for two panels of variable-length cards).
2. In `public/deck.js`: import `contracts`, `missions`, `loadProgramme`
   from `/shared/store.js`. Add a `renderOps()` function rendering both
   panels per §3. Wire it into `setView("ops")` (calling `loadProgramme()`
   first) and into `subscribe("programme", ...)`.
3. `node --check public/deck.js`.
4. `npx tsc --noEmit`.

## 6. Definition of done for this pass

- Clicking "Ops" shows a Contracts panel and a Missions panel, both
  populated from real fleet data (or their correct empty-state message).
- No console errors. No dead buttons — this pass is read-only.
- `npx tsc --noEmit` and `node --check public/deck.js` both clean.

## 7. What happens after this pass

Doctrine (the fleet's standing-order rules, v6's own "Doctrine" tab) is
the last remaining placeholder rail item without a Deck implementation,
followed by the command palette (⌘K) from the original mockup — separate
passes, own specs, not part of this one.
