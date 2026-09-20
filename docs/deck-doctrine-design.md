# Deck Doctrine — build spec (pass 6, low-context build)

**Audience note**: written to be followed literally, same as the five
specs before it. Every data field named below has been checked against
real code (`public/v6.js`) as of 2026-09-20 — don't re-derive field names
from guessing. If something here is wrong (a function renamed, a field
gone), stop and say so rather than improvising.

## 0. Context

Same situation as Ops (pass 5): **no mockup screen exists for Doctrine**.
The "Deck Command Console" artifact never designed it — it was only ever
a placeholder rail entry. This spec designs it from scratch, reusing
Deck's own `.panel`/`.panel-h`/`.panel-b` pattern.

**What Doctrine covers**: v6 calls this "Book mode" / "standing orders" —
the fleet's own rule engine (`src/engine/doctrine.ts`), a set of named
policies (ship-count caps per hull type, trading/risk/ops toggles) the
fleet's automated controllers check before acting. v6's own render
function for this (grep `public/v6.js` for the function assigned to
`$("book-sheet")`'s `.innerHTML` — its own top comment block, search
"Standing orders — in force") is large and does a lot: toggle switches,
inline numeric-value editors, a collapsible "add a policy" library, plus
unrelated general settings (Discord webhook, co-pilot config, MCP API
keys) that happen to live in the same sheet but are NOT doctrine data.

## 1. Scope of THIS pass

Build, inside the existing `<div class="content" id="view-doctrine" hidden">`
placeholder in `public/deck.html`, a two-panel read-only display:

- **Standing orders panel**: every rule in `doctrineRules[]` (imported
  from `/shared/store.js`, populated by `loadDoctrine()` — same source
  v6's own sheet reads). For each rule: name, enabled/disabled state, and
  its current value. A header line showing `${applied} / ${total} applied`
  (`applied` = count where `r.enabled` is true), matching v6's own "in
  force" line.
- **Recent activity panel**: which rules have actually fired, and when —
  reuse `doctrineFires` (a Map keyed by rule key →
  `{fireCount, lastFired}`) and `doctrineFireShips` (a Map keyed by rule
  key → ship-symbol array), same data v6's own margin notes read. Show
  the top 6 by fire count (descending), each with its name, fire count,
  a relative "last fired" time, and the ship symbols that triggered it
  (plain text, not the hover-pulse-the-map interaction v6 has — no map
  integration this pass).

Both panels are **read-only display only** this pass, matching Ops'
established discipline. No enable/disable toggle, no value editor, no
"add a policy" library, and absolutely none of the Discord/co-pilot/
MCP-key settings blocks — those are general app configuration, not fleet
doctrine, and don't belong on this screen regardless of read-only-ness.

**Cut entirely from this pass** (do not build, do not stub):
- Rule enable/disable toggle switches.
- Inline numeric-value editors (`chip()`/`wireClauseValueEditor()` in
  v6.js — don't port either).
- The "add a policy" collapsible library (`doctrineCatalog[]` — this pass
  doesn't need to import it at all).
- Per-rule custom sentence templates (`CLAUSE_TEXT[r.key]` in v6.js — a
  large lookup table of hand-written phrasings per rule key). For this
  pass, render every rule the same generic way: name + value + enabled
  state. Don't port `CLAUSE_TEXT` or attempt to replicate its per-rule
  wording.
- Map hover-pulse integration on activity rows (no Map screen
  cross-linking this pass).
- Discord webhook / co-pilot / MCP API key settings — not doctrine data,
  out of scope entirely regardless of this pass's read-only status.

## 2. Hard requirement: reuse, don't reinvent

`deck.js` needs to import `doctrineRules`, `doctrineFires`,
`doctrineFireShips` from `/shared/store.js` (confirm exact export names),
plus the `loadDoctrine()` and `loadDoctrineFireShips()` loaders. Call
both when `setView("doctrine")` fires, following the same on-demand-load
pattern Ops/Map already established. `doctrineCatalog` is **not** needed
this pass (§1's cut list) — don't import it.

## 3. Data binding

### Standing orders panel

| Element | Real source |
|---|---|
| Header | `${applied} / ${doctrineRules.length} applied` where `applied = doctrineRules.filter(r => r.enabled).length` |
| Rule row name | `r.name` |
| Rule row enabled state | a simple on/off indicator (reuse `.chip` styling — e.g. `.chip.trader`'s green-ish "on" look vs. a dim "off" look, or just plain text "on"/"off"; this is a cosmetic call, not a data one) |
| Rule row value | `r.value` — display as-is (it may be a number or string depending on the rule; `String(r.value)` is safe) |

Empty state: "No standing orders configured." (a reasonable equivalent —
v6 doesn't have this exact empty case since the fleet always seeds
default rules on boot, but handle it defensively rather than crash on an
empty array).

### Recent activity panel

| Element | Real source |
|---|---|
| Row list | `doctrineRules.map(r => ({r, stats: doctrineFires.get(r.key), ships: doctrineFireShips.get(r.key) ?? []})).filter(x => x.stats && x.stats.fireCount > 0).sort((a,b) => b.stats.fireCount - a.stats.fireCount).slice(0, 6)` — copy this exact derivation from `v6.js`'s own `notes` computation (search for it, cited above) rather than re-deriving it differently |
| Row name | `r.name` |
| Fire count | `stats.fireCount` |
| Last fired | `stats.lastFired` — format with `fmtTime` from `/shared/domain.js` (already imported in `deck.js`); don't port v6's own `relTime()` helper unless it's trivially importable — an absolute timestamp is fine for a first pass |
| Ships | `ships.join(", ")` as plain text, or a comma-separated list — no hover/click interaction this pass |

Empty state: "No rules have fired yet." (shortened from v6's own longer
string, which references "the gutter" — a UI element specific to v6's
own layout that doesn't exist here).

## 4. CSS

No new CSS classes should be needed — reuse `.panel`/`.panel-h`/
`.panel-b` and `.chip` for the enabled/disabled indicator. If a small
new rule-row layout is needed, keep it inline-styled and minimal
(follow the pattern the Ops pass used for its contract/mission cards —
check `renderOps()` in `deck.js` for that exact inline-style convention
before inventing a different one).

## 5. Build sequence

1. In `public/deck.html`, replace the placeholder:
   `<div class="content" id="view-doctrine" hidden><div class="empty">Doctrine — coming soon.</div></div>`
   with a two-panel layout (Standing Orders + Recent Activity), following
   whichever existing Deck two-panel pattern (Ops's `.cols2`, or Markets'
   `.mgrid`) fits two variable-length lists best.
2. In `public/deck.js`: import `doctrineRules`, `doctrineFires`,
   `doctrineFireShips`, `loadDoctrine`, `loadDoctrineFireShips` from
   `/shared/store.js`. Add a `renderDoctrine()` function rendering both
   panels per §3. Wire it into `setView("doctrine")` (calling both
   loaders first, same as Ops's `loadProgramme()` pattern).
3. `node --check public/deck.js`.
4. `npx tsc --noEmit`.

## 6. Definition of done for this pass

- Clicking "Doctrine" shows a Standing Orders panel (every rule, its
  enabled state and value) and a Recent Activity panel (top 6 fired
  rules by count, or the empty-state message).
- No console errors. No dead controls — this pass is read-only, no
  toggles, editors, or add-policy UI.
- `npx tsc --noEmit` and `node --check public/deck.js` both clean.

## 7. What happens after this pass

The command palette (⌘K, from the original mockup) is the last remaining
piece of Deck's originally-scoped work — a separate pass, own spec, not
part of this one.
