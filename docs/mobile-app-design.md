# Mobile app design — concept & IA

Design discussion from 2026-09-13, capturing the decision to build a
genuinely separate mobile experience rather than continue reflowing the
desktop layout, and the information architecture landed on. No
implementation yet — this is the design record to build from.

## Why this exists

The current mobile mode (`public/v6.html`'s `#mobile-view`) is a
condensed reflow of the desktop layout, not a mobile-first design. It's
already caused a real bug (the Ops tab's Approvals pane was simply
missing from mobile markup — see `CHANGELOG.md`) and doesn't feel native
on iOS: using the PWA shifts the whole page around (keyboard opening,
rubber-band overscroll, address-bar show/hide) because it's built as a
normal scrolling document rather than an app shell.

## Decision: separate route, not a new version number

Considered two shapes:

1. **A new `v7` alongside v2–v6**, routed through the existing version
   switcher (`public/shared/switcher.js`), sharing the same URL space
   and PWA manifest as desktop.
2. **A genuinely separate route** (e.g. `/m`), auto-detected for mobile,
   with its own markup/CSS/JS and its own PWA manifest.

**Decision: separate route.** Reasoning:

- v2–v6 are successive iterations of the *same desktop-shaped app*,
  kept side by side only so old links keep working
  (`uiVersions.ts`'s own stated reasoning) — the implicit contract is
  that they're headed toward eventual retirement. A mobile app isn't a
  "next iteration" of that lineage; it's a parallel product that needs
  to exist alongside whatever desktop version is current. Calling it v7
  bakes in the wrong lifecycle expectation.
- iOS's "Add to Home Screen" reads the manifest/icon of the *current
  URL*. A separate route gets its own manifest — own name, own icon,
  own `display: standalone` — so the home-screen icon and splash screen
  read as a genuinely separate app rather than "the dashboard, zoomed."
- This doesn't mean a separate deploy or server: still one Express app,
  one cookie-based auth/session flow (`resolveTenant.ts` is already
  version-agnostic), and it can still import `public/shared/*.js` for
  every API call exactly like v2–v6 do. What's actually new is the
  markup, layout logic, and manifest.
- Auto-routing: a mobile user agent gets sent to `/m` automatically,
  the same way `applyVersionPreference()` already remembers a desktop
  user's chosen version — this logic is reusable for the mobile
  redirect decision too.

## "Feels native" requirements (app-shell pattern)

Whatever gets built must avoid the current mode's page-shifting
problems from day one, not retrofit them later:

- **Fixed app shell.** A `position: fixed`, full-height container
  (header + tab bar pinned) with only specific inner panels
  `overflow-y: auto` — the document itself never scrolls or bounces.
- **`overscroll-behavior: contain`** on scrollable inner panels so even
  they don't rubber-band past their own edges.
- **`100dvh`**, not `100vh`, for full-screen height — avoids layout
  jumping when the iOS keyboard opens; pair with a `visualViewport`
  resize listener for anything pinned to the bottom edge.
- **`viewport-fit=cover` + `env(safe-area-inset-*)`** padding on the
  shell, so content respects the notch/home-indicator area in
  standalone mode.
- **`user-scalable=no`** and real `<button>` elements with their own
  `:active` states (plus `-webkit-tap-highlight-color: transparent`)
  to kill tap-zoom and the default tap-flash.
- **`display: standalone`** in the manifest — removes Safari's address
  bar entirely, but only takes effect launched from the home-screen
  icon, not previewed in a Safari tab (test via the actual install).

## Hard requirements (operator-stated)

Whatever the IA, it must cover:

- Profitable routes, in some browsable form.
- Shipyards and modules, browsable *and purchasable* — not just a
  read-only mirror of desktop's Yards & outfitting panel.
- Some version of the galaxy/system map.
- Manual per-ship controls — explicitly open to a simpler design than
  desktop's ship-detail sheet ("could be like now, could be a simpler
  design, traffic manager or something").

## Concepts considered

Five distinct shapes were sketched before narrowing down:

1. **Mission Control** — triage-first feed as the home screen; every
   card is something needing a decision (approvals, stranded ships,
   unassigned traders), swipe to act.
2. **Fleet Deck** — each ship as a full-width swipeable card,
   color-coded by status, tap for detail/actions. Most "native app"
   feeling of the five; weaker at scanning many ships' status at once.
3. **Radar** — full-screen map as the primary surface, draggable
   bottom sheet (Maps-app pattern) for ship list/details, collapsible
   to a handle. Leans into "where is everything" as the primary
   question.
4. **Command Line** — single-column, filterable activity inbox, no
   tabs, floating action button for bulk actions. Fastest to build,
   under-serves anything that benefits from a glanceable gauge/table.
5. **Cockpit** — a widget grid home screen (Credits/Rate, Alerts,
   Fleet-health counts, top route), each tile drilling into a focused
   view. Best "glance across many different signal types at once."

**Chosen: 1 + 2 + 5, combined** — Mission Control and Cockpit layer on
the same Home screen rather than compete (Cockpit answers "how are
things," Mission Control answers "what do I do about it," one scroll,
no tab switch); Fleet Deck (concept 2) is the Fleet tab.

## Finalized information architecture

Bottom tab bar: **Home · Fleet · Map · Markets · More**

- **Home** — Cockpit tiles at the top (Credits/Rate, Fleet Health:
  stranded/unassigned/manual-hold counts, Alerts count, a "best route
  right now" preview), followed by the Mission Control triage feed
  (approvals, stranded ships, unassigned traders, anything flagged),
  swipe to act on each card. The main "open app, clear the queue"
  surface.
- **Fleet** — Deck of swipeable per-ship cards (status color, fuel/
  cargo gauges, current job — reusing the Job column concept from the
  desktop Fleet tab's `jobFor()`). Tapping a card opens a
  **traffic-manager action sheet**: large buttons for Send to
  waypoint, Hold/Release, Assign route, Repair, Sell/Scrap — not
  desktop's dense multi-tab ship-detail sheet (Cargo & Loadout /
  Loadout / Mounts / Components-in-cargo). Rarer detail (full
  manifest, mount specifics) lives behind one "Full details" link
  instead of its own row of tabs. **Decided 2026-09-13: deck only, no
  parallel compact-list view** — worth revisiting if deck browsing
  proves too slow for scanning many ships' status at once in practice.
- **Map** — Radar: full-screen system map with a draggable bottom
  sheet. Tapping a charted waypoint surfaces what's there (market
  goods, shipyard stock if any) inline in the sheet — the spatial
  discovery path, complementary to Markets' list view rather than
  duplicating it.
- **Markets** — Segmented control: **Routes** (profitable routes
  ranked by profit/trip, tap to assign to a ship — reusing the same
  computation the desktop Routes panel already does) and **Yards**
  (the grouped-by-item shipyard/module view shipped desktop-side —
  cheapest location per ship type/module, Buy button right there).
  Both segments are "where do I put money to make more" decisions,
  which is why they share a tab rather than living separately.
- **More** — Contracts, construction missions, warehouse, Doctrine
  sliders, keeper stations. Not designed in detail — a simple
  list-of-sections is enough; these are lower-frequency checks, not
  daily-driver surfaces.

## Open questions (not yet decided)

- Whether Fleet ever needs a compact list view alongside the deck (see
  above) — parked, not rejected outright.
- Exact tile layout for Home's Cockpit row (2×2 grid vs. a horizontal
  scroll strip vs. a single row of 3–4).
- Route path/naming (`/m` was used as a placeholder throughout this
  doc — not finalized).
- Whether mobile auto-detection redirects every time or only once,
  mirroring `applyVersionPreference()`'s remember-the-choice behavior
  for desktop versions.

## Visual identity — approved 2026-09-13

Deliberately distinct from the desktop dashboard's look (a starship-
bridge HUD identity) rather than reusing it — this app is a field
terminal, not a shrunk console. Named **Tower**, leaning into the
"Radar"/"Cockpit"/"traffic manager" language the concepts were already
using. Mocked up across all four screens (Home, Fleet, Map, Markets) as
a high-fidelity phone-frame gallery; operator confirmed it's working.

- **Palette**: warm near-black ground (`#0a0908`) with a phosphor-amber
  accent (`#ffb020`, CRT-scope register) as the only rotating/active
  hue; a muted cool ice-blue (`#93a6b4`) for secondary structure; green
  (`#58d68d`)/red (`#ff6152`) held strictly semantic — profit and
  critical-only, never decorative.
- **Type**: Chakra Petch for labels/chrome/headings (condensed,
  technical, uppercase-friendly — distinct from desktop's RBchrome and
  from generic Inter/Space Grotesk defaults), IBM Plex Mono for every
  number (tabular figures throughout).
- **Signature device**: the Map screen renders as a literal radar
  scope (range rings, a sweep wedge, shaped blips per waypoint type)
  with a draggable bottom sheet for the selected waypoint — ties the
  visual identity directly to the "Radar" concept name rather than
  being a generic map tile view.
- Single dark theme only, deliberately — a night-ops field console has
  no real light-mode use case, matching this project's own "commit to
  one visual world" allowance for a design with a definite, singular
  setting.
- Full mockup (not committed to the repo — a design reference, not
  app code): https://claude.ai/code/artifact/d0f61c93-6d09-4be4-bc9d-2ea3bc9e9333

Still open from the visual pass: exact manifest metadata (theme-color
meta tag, apple-touch-icon asset, app short-name for the home-screen
label) needs a real icon asset produced from this identity before it
can be finalized — the mockup establishes the palette/type/device
language but doesn't include an icon design.

## Not yet started

No implementation work has begun. IA and visual identity are both
resolved; next step is to resolve the remaining open questions above
(route naming, tile layout, redirect behavior, manifest icon asset)
and then build Home first — it's the most fully resolved surface on
both fronts.
