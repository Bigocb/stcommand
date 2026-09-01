# Three parallel UIs: v3, v4, v5

Implementation plan for shipping the three design directions
(`docs/ui-redesign-concepts` — the redesign board) as real, switchable
interfaces alongside the current one.

| Version | Design | Stance |
|---|---|---|
| `v2` | current | unchanged, stays the default until a successor earns it |
| `v3` | Refined Bridge | evolution of v2 — elevation scale, merged activity rail |
| `v4` | Deep Field | No Man's Sky HUD — map is the room, floating modules |
| `v5` | Mission Control | light console — nav spine, KPI band, dark sector display |

Precedent already exists: `public/index.html` (the v1 UI, 153KB) still sits
beside `public/v2.html` and neither breaks the other. This plan makes that
arrangement deliberate rather than accidental.

---

## 1. What v2 actually is today

Measured, not estimated:

| | lines | notes |
|---|---:|---|
| `<style>` | 1,033 | includes 9 `@font-face` blocks, base64-inlined |
| markup | 397 | six views + rails + gates |
| `<script>` | 3,844 | 136 named functions |
| **total** | **5,295** | **408KB**, mostly the base64 fonts |

Coupling surface: 68 `innerHTML` assignments, 124 distinct element IDs,
113 `addEventListener` calls, **zero inline `onclick=` handlers**.

That last number is the one that matters — nothing depends on functions
being in global scope, so converting to ES modules is a safe mechanical
change rather than a rewrite.

## 2. The central problem

Copying `v2.html` three times gives four copies of 3,844 lines of
JavaScript. Every bug fix then has to be made four times, and it will not
be — this codebase has already been bitten by exactly that failure mode
(the ~10 duplicated `credits < price + minCashReserve()` checks that
`canAfford()` replaced, where several copies had silently drifted or were
never written at all).

So **Phase 0 is not optional and nothing else starts until it lands.**

The JS splits into three layers:

| Layer | Functions | Design-coupled? |
|---|---|---|
| Transport / session | `api`, `load*`, `try{Login,Register}`, `boot` | no |
| Domain / formatting | `shipTransitLerp`, `worstConditionPct`, `systemOf`, `relTime`, `countdown`, `roleMismatchReason`… | no |
| Render | `render*`, `draw*` (39 fns) | **yes — this is the only part that forks** |

Roughly 60% of the file is shared, 40% forks per design.

### The fiddly part, stated up front

A handful of functions sit between layers because they compute *and* emit
markup: `chip()`, `fmTag()`, `shipGlyphMarkup()`, `conditionSectionHtml()`,
`crewSectionHtml()`, `clauseForRule()`, `drawWaypointGlyph()`, possibly
`fleetRows()`. Each needs a judgement call during extraction — either split
the computation out and leave the markup in the version, or accept it as
version-owned. Budget real time for this; it is where the extraction will
actually be slow.

## 3. Target layout

No build step exists for the frontend and none is being added — `public/`
is served raw by `express.static`, and native ES modules work in every
browser this targets.

```
public/
  fonts/                    ← 9 woff2 files, extracted from base64
  shared/
    api.js                  ← fetch wrapper, error handling, toasts
    session.js              ← login/register/logout/onboarding *logic*
    store.js                ← app state + every load*() + mutations, with subscribe()
    domain.js               ← pure computation & formatting, no DOM, no HTML
    mapmath.js              ← projection, scale, transit lerp, heading — no DOM
    fonts.css               ← the @font-face blocks, pointing at ../fonts/
    switcher.js             ← the version picker, injected into all four
  index.html                ← v1, untouched
  v2.html                   ← current, converted to import shared/*
  v3.html  v3.css  v3.js    ← Refined Bridge
  v4.html  v4.css  v4.js    ← Deep Field
  v5.html  v5.css  v5.js    ← Mission Control
```

Each `vN.js` owns only its render layer and DOM wiring, and imports
everything else. Expected size per version: **~800–1,200 lines of JS**,
not 3,844.

## 4. Phases

### Phase 0 — Extract the shared core *(prerequisite, zero visual change)*

1. Pull the 9 `@font-face` base64 blobs into `public/fonts/*.woff2` and
   `shared/fonts.css`. This alone takes `v2.html` from 408KB to roughly
   60KB and makes the fonts cacheable across all four versions.
2. Move transport/session/domain/mapmath into `shared/*.js` as ES modules.
3. Convert `v2.html` to `<script type="module">` and import them.
4. Leave every `render*` function in `v2.html`. v2 is not being redesigned.

**Acceptance:** v2 is byte-for-byte identical in behaviour. Walk all six
views, the Book sheet, the replay scrubber, ship dispatch, warehouse
adjust, and the co-pilot. No console errors. Ship this as its own commit
with nothing else in it, so a regression is trivially bisectable.

**Risk:** highest of any phase — it touches everything and has no visible
payoff. Mitigation is the isolation above plus the fact that there are no
inline handlers to break.

### Phase 1 — Version routing and the switcher

Backend, `src/cli/index.ts` — currently one line:

```js
app.use(express.static(PUBLIC_DIR, { index: "v2.html" }));
```

Add explicit routes before it:

```js
for (const v of ["v3", "v4", "v5"]) {
  app.get(`/${v}`, (_req, res) => res.sendFile(resolve(PUBLIC_DIR, `${v}.html`)));
}
```

- `/` keeps serving v2. The default does not move until a successor is
  chosen deliberately.
- `shared/switcher.js` renders a small picker in every version's chrome and
  writes the choice to `localStorage`; `?ui=v4` forces one for a session.
- Sessions are cookie-based and shared, so switching never re-authenticates.
- Set `Cache-Control: no-cache` on the HTML and a long max-age on
  `fonts/` and `shared/`, or the shared modules will go stale in browsers
  after a deploy.

Optionally later: a `tenants.ui_version` column so the choice follows the
account across devices, mirroring how `discord_enabled` and
`onboarding_pending` already work. Not needed for v1 of this work.

**PWA note:** `manifest.webmanifest` has `start_url: "/"`. Installed
instances keep landing on v2, which is correct for now. Revisit only when
the default changes.

### Phase 2 — `v3` Refined Bridge *(smallest)*

Mostly CSS, one structural move.

- Four-token elevation scale (`--ground / --panel / --card / --raised`)
  replacing the current flat surfaces. This is the actual fix for the
  contrast complaint that started this.
- Meters get a dark track behind a lit fill instead of one flat tone.
- **Structural:** delete the bottom ticker bar; fold Lanes + The Watch into
  one right-hand activity rail. Map gains ~90px of height and the same
  events stop scrolling past in two places.
- Left rail becomes an inspector: triage → manifest with a breadcrumb back
  and collapsible sections.

Reuses v2's render layer almost wholesale — mostly class-name and
container changes. The five non-Bridge views inherit v2's panes restyled by
the new tokens.

### Phase 3 — `v5` Mission Control *(largest, most reusable)*

- Nav spine with live counts, grouped Operate / Programme / Policy.
- KPI band: credits, forgone, fleet condition, active lanes.
- **Sector display** — full-width hero, ~360px, a dark instrument screen
  inset into the light console: graticule, dashed range rings, viewport
  corner ticks, type-coded glyphs, glowing lane arcs, dotted tracks,
  arrowheads on real bearings, dimmed uncharted waypoints, gate outbound
  route, corner readouts and a range scale.
- Table/card/chip/mini-bar primitives.

Built second on purpose: its table and card primitives are the ones
Fleet, Markets, Trade Ops and Ops need in **every** version, so this phase
produces the most reusable output.

### Phase 4 — `v4` Deep Field *(most bespoke, highest risk)*

- Full-bleed map with floating translucent HUD modules, clipped hex corners.
- Segmented 12-cell gauges.
- Tracking reticle drawn on the map for the selected hull.
- Segmented scanner nav strip instead of tabs.
- Strict two-colour semantics: cyan = telemetry, orange = actionable.

Last on purpose — it is the least forgiving layout (absolutely-positioned
modules over a live map need care at every breakpoint) and benefits most
from a shared core that three other UIs have already proven.

## 5. What is *not* designed yet

**The mockups cover the Bridge only.** Each version also needs Fleet,
Markets, Trade Ops, Ops and Galaxy. Honest read:

| View | v3 | v5 | v4 |
|---|---|---|---|
| Bridge | designed | designed | designed |
| Fleet | inherit v2, restyled | natural fit (tables) | **needs design** — dense tables fight the HUD idiom |
| Markets | inherit v2, restyled | natural fit | **needs design** |
| Trade Ops | inherit v2, restyled | natural fit | **needs design** |
| Ops | inherit v2, restyled | natural fit | needs design |
| Galaxy | inherit v2, restyled | natural fit | needs design |

v4's non-Bridge views are the single biggest unknown in this plan. Options
when we get there: accept a more conventional panel treatment inside the
HUD chrome, or have v4 hand those views off to v5's layout.

**Mobile:** v3 inherits v2's existing mobile rendering. v5 is naturally
responsive (spine collapses, cards stack). v4 is genuinely hard — propose
desktop-only initially, redirecting narrow viewports to v5.

## 6. Backend work

Near zero, which is the point — the API is already fully shared and
version-agnostic.

- Phase 1's static routes (~5 lines).
- `GET /api/markets?system=` — **already shipped**.
- v5's KPI band wants an "idle > 20 min" count. Derivable client-side from
  `/api/bridge`'s `shipStatus`; add a server-side field only if that proves
  awkward.
- v5's sector display needs waypoint types/traits and ship positions —
  `/api/system/:symbol/waypoints` and `/api/state` already carry both.
- Optional `tenants.ui_version` column (one migration) if the preference
  should follow the account rather than the browser.

## 7. Sequencing and effort

| Phase | Work | Rough size |
|---|---|---|
| 0 | Shared core extraction | L — the risky one |
| 1 | Routing + switcher | S |
| 2 | v3 Refined Bridge | M |
| 3 | v5 Mission Control | XL |
| 4 | v4 Deep Field | XL, plus undesigned views |

Sizes are relative, not calendar estimates. Phase 0 gates everything;
Phases 2–4 are independent of each other once it lands and could be
reordered or dropped individually without stranding the others.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Phase 0 regresses v2 with no visible upside | Ship it alone, verify all six views by hand, keep it bisectable |
| Render layer drifts across four versions anyway | Only `render*` may fork; anything computational belongs in `shared/` — enforce in review |
| v4's dense views never get designed | Decide the fallback (v5 handoff) before starting Phase 4, not during |
| Shared modules cached stale after deploy | Cache headers in Phase 1, or a build-stamp query string |
| Four UIs to keep working as the engine changes | The switcher makes divergence visible; treat v1/`index.html` as frozen and delete it once v3 lands |

## 9. Definition of done

- `/`, `/v3`, `/v4`, `/v5` all serve working UIs against one shared session.
- No `load*`, `api*`, or domain function exists in more than one file.
- `public/v2.html` is under ~80KB with fonts served separately and cached.
- Switching versions preserves login and lands on the equivalent view.
- Each version's Bridge matches its mockup; non-Bridge views are at minimum
  usable and consistent within that version.
