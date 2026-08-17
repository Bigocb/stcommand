# Field & Book — implementation plan

Implementation spec for the "Field & Book" frontend redesign of Standing Orders
Command, plus the Rubine colour system.

**Read this whole file before editing anything.**

---

## 0. Context you need

**Repo:** `stcommand` — multi-tenant autonomous SpaceTraders fleet engine.
**Frontend:** `public/index.html` — a single 2,891-line file (CSS ~513 lines,
markup ~290, JS ~2,060). No build step, no framework, no dependencies. Served
statically by `src/cli/index.ts`.

**What we are building.** The dashboard currently has four peer tabs
(Bridge / Doctrine / Markets / Ops). We are replacing that with two *modes*:

- **The field** — a full-bleed system map. Panels become translucent rails
  docked to the edges. Selecting a ship re-focuses the whole HUD on it.
- **The book** — standing orders rendered as an editable prose document over a
  dimmed field. Policy only; data stays on the field.

Plus **Rubine**, a new colour system where hue carries meaning: one accent for
attention, one for structure, and a semantic band (gain/loss/warning) that never
moves.

### Hard rules

1. **No new runtime dependencies.** No framework, no bundler, no npm packages
   for the frontend. Native ES modules and plain DOM only.
2. **Do not change any `/api/*` route shape** except where a phase explicitly
   says to. The engine and its tests depend on them.
3. **Run `npm test` and `npm run typecheck` after every phase.** Both must pass
   before you move on. Tests live in `tests/` and use `node --test`.
4. **Phases are gates.** Finish and verify a phase before starting the next.
   Each phase leaves the app in a working, shippable state.
5. **Do not touch the engine** (`src/engine/*`) except in Phase 0, and there
   only in the specific places named.
6. **Preserve accessibility that already exists**: `aria-pressed` on toggles,
   `:focus-visible` outlines, and the `prefers-reduced-motion` block at the end
   of the stylesheet.
7. If an instruction here contradicts what you find in the code, **stop and
   report it** rather than guessing.

### Out of scope

- **The replay scrubber.** It needs ship position history that does not exist
  (see Phase 0 notes). Do not build it. Do not add a scrubber UI.
- Deleting the mobile duplicate page, SSE, and splitting the file into modules.
  These are real and wanted but are separate work.

---

## Phase 0 — Backend prerequisites

Two features in later phases need data the engine does not currently record.
This phase adds it. It is small.

### 0.1 — Attribute activity rows to real ships

**Problem.** Every activity row is written with a hardcoded ship symbol.

`src/engine/tenantRegistry.ts` line ~173:

```ts
onActivity: (kind, detail, credits) =>
  store.recordActivity(tenantId, { timestamp: new Date().toISOString(), shipSymbol: "fleet", kind, detail, credits }),
```

Every row lands as `shipSymbol: "fleet"`. The per-ship identity only exists
inside the free-text `detail` string, inconsistently.

**Change.** Widen the `onActivity` callback to take a ship symbol.

1. In every file declaring
   `onActivity?: (kind: string, detail: string, credits?: number) => void`,
   change the signature to:
   ```ts
   onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
   ```
2. There are **60 call sites across six files**:

   | File | Call sites | Has a ship symbol? |
   |---|---|---|
   | `src/engine/fleet.ts` | 28 | **No** — fleet-level events. Leave unchanged. |
   | `src/engine/trader.ts` | 10 | Yes — pass `this.symbol` |
   | `src/engine/agent.ts` | 8 | Yes — pass `this.symbol` |
   | `src/engine/mission.ts` | 6 | Check — pass the ship symbol in scope, if any |
   | `src/engine/scout.ts` | 5 | Yes — pass `this.symbol` |
   | `src/engine/siphoner.ts` | 3 | Yes — pass `this.symbol` |

   Find them with `grep -rn "onActivity?.(" src/engine/`.

   **`fleet.ts` is the exception and matters.** `FleetManager` is not a ship —
   its 28 events are genuinely fleet-level (purchases, promotions, doctrine
   actions). Leave those call sites alone so they keep falling back to
   `"fleet"`, which is correct for them. Only per-ship classes gain the argument.

   Do not change the `kind` or `detail` strings — other code and the UI ticker
   read them.
3. In `tenantRegistry.ts`, use the passed symbol with the old value as fallback:
   ```ts
   onActivity: (kind, detail, credits, shipSymbol) =>
     store.recordActivity(tenantId, {
       timestamp: new Date().toISOString(),
       shipSymbol: shipSymbol ?? "fleet",
       kind, detail, credits,
     }),
   ```

**Do not** change the `ActivityEntry` interface, the database schema, or
`recordActivity`. The column already exists and already accepts any string.

**Verify.** `npm test && npm run typecheck` pass. Existing activity rows keep
working (fallback preserves old behaviour).

### 0.2 — Instrument doctrine rule firings

**Problem.** Nothing anywhere counts how often a doctrine rule fired or what it
cost. The book's margin gutter needs this.

**Change.** Add a lightweight in-memory counter on the `Doctrine` class in
`src/engine/doctrine.ts`.

1. Add a private field and two methods to the `Doctrine` class:
   ```ts
   /** Rolling record of rule firings this process. Not persisted — the gutter
    *  shows "this watch", and a restart legitimately starts a new watch. */
   private fires = new Map<string, { count: number; credits: number; last: string }>();

   /** Called by engine code when a rule actually changed a decision. */
   recordFire(key: string, credits = 0): void {
     const cur = this.fires.get(key) ?? { count: 0, credits: 0, last: "" };
     this.fires.set(key, {
       count: cur.count + 1,
       credits: cur.credits + credits,
       last: new Date().toISOString(),
     });
   }

   /** Firing stats keyed by rule, for the dashboard. */
   fireStats(): Record<string, { count: number; credits: number; last: string }> {
     return Object.fromEntries(this.fires);
   }
   ```

2. Add a route in `src/http/dashboard.ts`, next to the existing
   `router.get("/doctrine", ...)`:
   ```ts
   router.get("/doctrine/stats", (req, res) => {
     const w = worker(req);
     if (!w) return res.status(503).json({ error: "engine not ready" });
     res.json({ stats: w.fleet.doctrine.fireStats() });
   });
   ```

3. **Call `recordFire` from exactly three places** to start. Do not try to
   instrument all thirteen rules — three proves the mechanism and the rest can
   follow later.
   - Wherever `marginFloor` causes a route to be rejected.
   - Wherever `snapshotMaxAgeMin` causes a price to be treated as stale.
   - Wherever `maxLossPct` blocks a sale.

   Find these by grepping for the rule keys:
   ```
   grep -rn "marginFloor\|snapshotMaxAgeMin\|maxLossPct" src/engine/
   ```
   Add `this.doctrine.recordFire("marginFloor")` (etc.) at the rejection branch.
   Pass a credits delta only where a real credit amount is at hand.

**Verify.** `npm test && npm run typecheck` pass. `GET /api/doctrine/stats`
returns `{"stats":{}}` on a cold engine and gains keys as the fleet runs.

**Gate:** do not start Phase 1 until both tests and typecheck are green.

---

## Phase 1 — The Rubine colour system

Pure CSS/JS token work. No layout changes, no new features. The app should look
recoloured and otherwise identical when this phase ends.

### Current state (measured, do not re-derive)

- `public/index.html` line 10 is `<style>`, line 523 is `</style>`.
- The `:root` block is **lines 11–22**, defining **19 tokens**.
- The stylesheet has **355 `var()` references** and only **21 hardcoded colour
  literals outside `:root`** — it is already ~94% tokenised.
- **Every colour written from JS already resolves through a token.** The map,
  sparkline and price chart re-theme for free. Do not change them.

### 1.1 — Split `--amber` into `--accent` and `--warn`

`--amber` currently does two jobs: brand accent (39 rules) and warning semantic
(7 rules). They must separate before the hue can rotate, or warnings rotate with
the brand.

**These 7 rules are WARNING. Change `var(--amber)` → `var(--warn)` in each:**

| Line | Selector |
|------|----------|
| 127 | `.keeper-row .cover.missing` |
| 157 | `.dispatch-row .tag.manual` |
| 170 | `.ops-card .ops-dead` |
| 177 | `.ops-card .tag.declined` |
| 178 | `.ops-card .tag.paused` |
| 223 | `.alert.sev2` |
| 377 | `.callout.warn b` |

**Every other `var(--amber)` / `var(--amber-soft)` reference is BRAND.** Rename
those to `var(--accent)` / `var(--accent-soft)`.

Line numbers shift as you edit. Safest order:
1. First change the 7 warning sites above (match on the full selector text, not
   the line number).
2. Then global-replace the remainder: `var(--amber-soft)` → `var(--accent-soft)`,
   then `var(--amber)` → `var(--accent)`.
3. Confirm zero remain: `grep -c "\-\-amber" public/index.html` should print `0`
   once the `:root` definition is also replaced in 1.2.

**Also update these two JS sites** (they use the token in template strings):
- Line ~1456 — `<span style="color:var(--amber)">·M</span>` → `var(--accent)`
- Lines ~2426–2427 — the price chart's `stroke="var(--amber)"` and
  `fill="var(--amber)"` → `var(--accent)`

**Do not** rename the CSS class `.stat .v.amber` or the markup
`<span class="v amber" id="credits">`. That is a class name, not a token.
Only the `color:` value inside it changes.

### 1.2 — Rewrite `:root` in OKLCH

Replace the whole `:root` block (lines 11–22) with the block below.

Why OKLCH: in HSL, equal lightness across hue is a lie — yellow at 50% L is far
brighter than blue at 50% L, so a naive hue rotation makes some options glow and
others go muddy. OKLCH lightness is perceptually uniform, so the accent holds its
weight at every hue. Support is fine (Chrome 111+, Safari 15.4+, Firefox 113+).

```css
  :root {
    /* ── the one variable the hue picker moves ─────────────── */
    --accent-h: 355;              /* Rubine. See --hue-options below. */

    /* ── ground & structure (never rotate) ─────────────────── */
    --void:#0a0a12; --ink:#101019;
    --panel:rgba(14,14,23,0.82); --panel-2:rgba(18,18,29,0.92);
    --glass:rgba(148,155,178,0.06); --hairline:rgba(148,155,178,0.15);
    --bone:#e8e8f0; --ice:#969cb0; --dim:#5e6478;

    /* ── the accent: attention, selection, live ────────────── */
    --accent:      oklch(66% 0.21 var(--accent-h));
    --accent-soft: oklch(66% 0.21 var(--accent-h) / 0.18);
    --accent-line: oklch(66% 0.21 var(--accent-h) / 0.40);

    /* ── structure hue: places, waypoints, stations ────────── */
    --buff:#cba97e; --buff-soft:rgba(203,169,126,0.18);

    /* ── semantic band: NEVER rotates, never reused as accent ─ */
    --red:#ff5b5b;   --red-soft:rgba(255,91,91,0.14);
    --green:#45bd8b; --green-soft:rgba(69,189,139,0.14);
    --warn:#e3a840;  --warn-soft:rgba(227,168,64,0.16);

    /* ── retained data hues (map/system labels only) ───────── */
    --teal:#4fd1c5; --violet:#a78bfa;

    --disp:"Anton", ui-sans-serif, system-ui, sans-serif;
    --mono:"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
```

**Note the ground got darker and slightly indigo** (`#0a0a12` vs `#05070a`) and
bone got cooler. That is intentional — rubine needs an indigo-biased ground to
sit on. Do not "fix" it back.

### 1.3 — Replace the 21 stray literals

These are hardcoded colours outside `:root`. Several are drift — they do not
match any token. Replace each with the token named.

| Literal | Occurrences | Replace with |
|---|---|---|
| `rgba(233,196,106,0.4)` | 3 | `var(--warn-soft)` |
| `rgba(79,209,197,0.35)` | 3 | `rgba(79,209,197,0.35)` — keep, it is teal data |
| `rgba(157,187,142,0.4)` | 1 | `var(--green-soft)` |
| `rgba(139,197,135,0.4)` | 1 | `var(--green-soft)` |
| `rgba(255,107,107,0.3)` | 1 | `var(--red-soft)` |
| `#ff6b6b` | 1 | `var(--red)` |
| `rgba(148,163,178,0.16)` | 1 | `var(--hairline)` |

`rgba(233,196,106,…)` was an amber that never matched `--amber` (`#ff9f43`), and
there were two different greens, neither matching `--green`. That is palette rot;
this table fixes it.

Leave the teal/violet literals used for map gradients and system badges alone —
they are data hues, not accent tints.

### 1.4 — The hue picker

**Do not build a free hue slider.** At hue 24 the accent *is* the loss colour, at
162 it is the gain colour, at 78 it is the warning. Ship a curated set.

The four options, with their measured minimum OKLCH hue distance from any
semantic colour:

| Label | `--accent-h` | Nearest semantic | Note |
|---|---|---|---|
| Rubine | `355` | 29° (loss) | Default. Separates by role and chroma. |
| Violet | `293` | 90° | Safest by a wide margin. |
| Ice | `207` | 45° | Comfortable. |
| Amber | `61` | 17° (warning) | Closest to today's look; label the tradeoff. |

**Markup.** Add to the Doctrine view's right-hand pane in `public/index.html`,
directly after the existing Discord `<div class="relay">…</div>` block:

```html
<div class="pane-h" style="border-bottom:none;padding-left:0;padding-right:0;margin-top:10px">Accent</div>
<div class="hue-picker" id="hue-picker" role="group" aria-label="Accent colour">
  <button type="button" data-hue="355" aria-pressed="true">Rubine</button>
  <button type="button" data-hue="293" aria-pressed="false">Violet</button>
  <button type="button" data-hue="207" aria-pressed="false">Ice</button>
  <button type="button" data-hue="61"  aria-pressed="false">Amber</button>
</div>
```

**CSS.** Add near the other Doctrine styles (around line 332):

```css
  .hue-picker { display:flex; gap:5px; margin-top:6px; }
  .hue-picker button {
    flex:1; background:var(--ink); border:1px solid var(--hairline); cursor:pointer;
    font-family:var(--mono); font-size:9.5px; letter-spacing:0.08em; padding:5px 4px;
    color:var(--dim); border-bottom:2px solid oklch(66% 0.21 var(--h));
  }
  .hue-picker button[data-hue="355"] { --h:355; }
  .hue-picker button[data-hue="293"] { --h:293; }
  .hue-picker button[data-hue="207"] { --h:207; }
  .hue-picker button[data-hue="61"]  { --h:61; }
  .hue-picker button[aria-pressed="true"] { color:var(--bone); background:var(--accent-soft); }
```

**JS.** Add near `initDiscord()` (around line 1572), and call it from `boot()`:

```js
/* Accent hue. A display preference, so it lives in localStorage rather than
   tenant doctrine — it is not fleet policy and does not need to survive a
   device change. Only the accent rotates; the semantic band never does. */
const HUES = ["355", "293", "207", "61"];
function applyHue(h) {
  if (!HUES.includes(h)) h = "355";
  document.documentElement.style.setProperty("--accent-h", h);
  $("hue-picker").querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.hue === h)));
  try { localStorage.setItem("so.accentHue", h); } catch {}
}
function initHuePicker() {
  let saved = "355";
  try { saved = localStorage.getItem("so.accentHue") ?? "355"; } catch {}
  applyHue(saved);
  $("hue-picker").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hue]");
    if (b) applyHue(b.dataset.hue);
  });
}
```

Apply the saved hue **before first paint** to avoid a flash — read
`localStorage` and set the property in an inline `<script>` in `<head>`, then let
`initHuePicker()` wire the buttons on boot.

**Verify Phase 1.**
- `grep -c "\-\-amber" public/index.html` prints `0`.
- Every view renders; nothing is invisible or unstyled.
- Switching hue recolours buttons, focus rings, map markets/ships/routes, the
  sparkline and the price chart — and does **not** recolour sev-2 alerts, paused
  tags, gains or losses.
- Choice survives a reload.
- `npm test && npm run typecheck` pass.

**Gate:** Phase 1 is independently shippable. Commit before Phase 2.

---

## Phase 2 — The book

Doctrine rendered as an editable prose document. Ships against the existing
`GET`/`POST /api/doctrine` — no route changes.

### 2.1 — Clause copy

The rules live in `src/engine/doctrine.ts` as `{key, name, description, value,
min, max, step, unit, enabled}`. Nine of the thirteen descriptions already read
as sentences with the number cut out ("Ignore market prices older than **this**").
Four do not and need the copy below.

**Use this table verbatim.** `{v}` is where the editable value chip goes. Do not
write your own copy.

| key | Clause text |
|---|---|
| `cashFloor` | Never let the balance fall below **{v}** when buying ships or modules. |
| `marginFloor` | Ignore arbitrage routes whose per-unit margin is below **{v}**. |
| `maxLossPct` | Refuse to sell cargo at more than **{v}** loss against its cost basis. |
| `minerTarget` | Grow the drone fleet until **{v}** miners are active. |
| `promoteAtMiners` | Promote the biggest-hold miner to trader once **{v}** miners exist. |
| `shipBudget` | Only consider buying a ship when credits exceed the cash floor by **{v}**. |
| `snapshotMaxAgeMin` | Ignore market prices older than **{v}**. *Both the dispatcher and the traders read this, so they always agree on which routes exist.* |
| `keeperCount` | Station **{v}** ships as market keepers so prices never go stale. |
| `sensorScanIntervalMin` | Run a sensor scan every **{v}** once there is nothing left to chart. *Off by default — this changes the auto-buyer's spending.* |
| `siphonTarget` | Grow the fleet until **{v}** gas siphoners are active. |
| `warehouseTarget` | Route trade through the warehouse. *Which goods, and how much of each, is set per-good in the Warehouse pane.* |
| `warehouseMax` | Never hold more than **{v}** of any one good in the warehouse. |
| `warehouseMinMargin` | Only sell out of the warehouse when the live price clears cost basis by **{v}** per unit. |

Text in *italics* is a trailing note — render it dimmed, at the same size, after
the sentence. `warehouseTarget` has **no value chip**: its value is unused (see
its description in the source). Render it as a clause with only an on/off state.

Append `unit` to the value: `c` → `20,000c`, `%` → `15%`, `m` → `90m`, empty
→ bare number. Format thousands with commas.

### 2.2 — Rendering and editing

Add a `renderBook()` function. Requirements:

- One `<p class="clause">` per rule, in the order returned by `/api/doctrine`.
- The value is an inline `<button class="cval">` — it must look editable and be
  keyboard-reachable. Clicking swaps it for an `<input type="number">` with the
  rule's `min`, `max`, `step`. Commit on Enter or blur; cancel on Escape.
- Commit `POST`s to `/api/doctrine` with the existing body shape. Reuse the
  existing `saveRule(key, patch)` function at line ~1516 — **do not write a new
  save path.**
- A disabled rule (`enabled: false`) renders struck through and dimmed, with the
  same toggle affordance the current `.rule` cards use.
- Set the document measure to ~62 characters. Use a serif for clause text —
  the stylesheet already loads Source Serif 4 for `.narrative`.

### 2.3 — The margin gutter

A right-hand column, ~240px, carrying evidence for each clause.

- Fetch `GET /api/doctrine/stats` (built in Phase 0.2) alongside `/api/doctrine`.
- For each rule with a `stats` entry, render a note: fire count, credit total if
  non-zero, and relative time since `last`.
- **Rules with no stats entry render no note.** Do not invent placeholder text
  and do not show zeros — only three rules are instrumented in Phase 0.2 and the
  rest legitimately have nothing to say yet.

**Verify Phase 2.** All 13 clauses render with correct values and units. Editing
a value persists across reload and is reflected in `GET /api/doctrine`. Toggling
enabled works. Gutter notes appear only for instrumented rules.

**Gate:** commit. The book is usable inside the existing tab layout at this
point — you can ship here and stop if Phase 3 runs long.

---

## Phase 3 — The field

The map-first shell. **Do this last.** It is the largest change and the only one
that is hard to reverse.

### 3.1 — Mode switch

Replace the four-tab `#view-switch` with a two-mode switch: **Field** and
**Book**. Keep the existing keyboard handler pattern in `initViewSwitch()`
(line ~962) — remap `1`/`2` to the two modes and keep `Escape` closing the
co-pilot.

### 3.2 — The field layout

- The map (`#map-wrap`, `.map-wrap`) becomes full-bleed: it fills the viewport
  below the top bar.
- Panels become absolutely-positioned translucent rails over it, using the
  existing `.pane` visual language: a left rail and a right rail, each
  collapsible.
- **Left rail = the selected ship.** When no ship is selected, show triage
  instead. The ship modal `openShipDetails()` (line ~2004, ~290 lines) already
  carries twelve write actions — `hold`, `release`, `dispatch`, `role`, `mine`,
  `explore`, `jump`, `install`, `remove-component`, `buy-install`, `scrap`, plus
  `trade` via `openTradePanel()`. **Move that content into the rail. Do not
  rewrite the handlers** — they already work; they just need a new container.
- **Right rail = lanes**, from the existing `renderRoutes()` data.
- Clicking a ship on the map or in the fleet list sets `selectedShip` and
  re-renders the left rail. `selectedShip` already exists as a global.

### 3.3 — Where the remaining controls go

Every mutating control must remain reachable. Current write surface is 30
actions. Placement:

| Shape | Actions | Goes to |
|---|---|---|
| Per-ship (13) | hold, release, dispatch, role, mine, explore, jump, install, remove-component, buy-install, scrap, trade, refuel | Left rail |
| Per-row (8) | contracts accept/decline/undecline, missions start/pause/resume/assign, shipyard buy, dispatch assign/clear | Right rail, as card rows |
| Standing (9) | 13 doctrine rules, keeper list, warehouse designate/release, curated goods targets, Discord webhook, global pause | The book (Phase 2) |
| Transaction (1) | `warehouse/adjust` | Left rail, with the warehouse hull selected — it is a trade, not a rule |

Two server routes have **no UI caller at all** today: `POST /api/fleet/dock` and
`POST /api/fleet/transfer`. Cargo transfer between hulls is built and
unreachable. Add both to the left rail.

**Verify Phase 3.** Every one of the 30 actions is reachable and still works.
Nothing regressed against `npm test`.

---

## Definition of done

- `npm test` and `npm run typecheck` pass.
- `grep -c "\-\-amber" public/index.html` prints `0`.
- Four hue options work, persist, and never recolour the semantic band.
- All 13 doctrine clauses render, edit, and persist.
- All 30 mutating actions reachable; `fleet/dock` and `fleet/transfer` newly so.
- No new npm dependencies. `git diff --stat package.json` shows no change.

## If you get stuck

Report which phase and task, what you expected, and what you found. Do not
work around a contradiction between this document and the code by guessing —
the code is the truth, and a mismatch means this plan needs correcting.
