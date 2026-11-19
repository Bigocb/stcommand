# Doctrine organization: inventory, taxonomy, UI and migration proposal

Status: steps 1-6 BUILT 2026-11-19 on the feature branch (see the CHANGELOG entry of that date); the keeper spend cap (section 10) is not built. Original status: PROPOSAL, written 2026-11-17 for the operator. Nothing in this document was built then. No source file was changed, nothing was committed or pushed, and the live fleet and the Tailwinds/stcommand tools were not touched (the stcommand MCP server also failed to connect with a 401 during this investigation, so no live value was read). All counts below come from the code in this checkout, not from the running box.

Scope (operator correction, 2026-11-17): the UI part of this proposal covers ONLY the doctrine settings screen (how clauses are listed, grouped, searched, filtered and edited) plus the MCP `get_doctrine` / `set_doctrine` arguments. It does not propose any change to other screens, navigation or visual identity. Where the doctrine screen lives inside a larger page, only that part is named.

## 1. Summary

- There are **119 clauses** in `POLICY_CATALOG` (`src/engine/doctrine.ts`, lines 67-906, exported as `DOCTRINE_CATALOG` at line 1207). Three are retired and hidden (`warehouseTarget`, `warehouseMax`, `warehouseMinMargin`), so **116 are visible**, plus dynamic `shipCap:<HULL_TYPE>` rules that exist once per hull type the fleet owns (their count depends on the live fleet; not knowable offline).
- The four existing `category` values are too coarse to find anything: `ops` holds 46 clauses (38.7%) and `trading` 42 (35.3%). Keeper clauses, fresh-system clauses and API-budget clauses are all just `ops`.
- Neither Deck nor Tower can search, group or filter, and neither shows a clause's description, default, range or whether it was changed. The MCP `get_doctrine` returns about 152 KB (compact) to 176 KB (the tool pretty-prints with 2-space indent) because it sends every clause twice, with full descriptions, in `rules` and again in `catalog`.
- Proposal: 13 operator-task groups plus a hidden "Retired" group (section 4), kept as code metadata next to the catalog so nothing stored changes. `category` keeps working. No database migration. Existing keys are NOT renamed (they are stored in doctrine rows, saved opening templates and week-over-week run results).
- One batch, in the 2026-11-21 pre-freeze window, every step reversible by `git revert` (section 9).

## 2. Inventory (verified from code)

Method: `POLICY_CATALOG` was imported with `tsx` into a throwaway script in the scratchpad (outside the repo) and counted; references were found with `grep` over `src/`, `public/`, `tests/`, `migrations/`.

### 2.1 Counts

| Measure | Result |
|---|---|
| Clauses declared in `POLICY_CATALOG` | 119 (119 unique keys; all camelCase) |
| Retired (hidden by `catalog()`/`list()`, `RETIRED_POLICIES`, line 949) | 3 |
| Visible in `catalog()` | 116 |
| Dynamic `shipCap:<type>` rules (created by `ensureShipTypeRule()`, category forced to `fleet`) | unknown offline (one per owned hull type) |
| `enabled: true` by default | 73 on, 46 off |
| `defaultAdopted: true` | 116; `false`: 3 (`exploringEnabled`, `explorerCreditFloor`, `scoutCreditFloor`) |
| `enforced: true` | 119 of 119 (the field carries no information today; Tower still prints "applied / not wired" from it) |
| Clauses with no `category` | 0 (the field is a required union, `PolicyCategory`, line 55) |
| Catch-all category | `ops` (46) and `trading` (42) |
| Value outside its own min/max | 0 |
| Clauses whose min equals max (value is meaningless, only the switch matters) | 3: `routeHoldAware`, `remoteSurveyIntake`, `freshIdleHoldBound` |
| Switch-like clauses with range 0..1 (value duplicates the enabled flag) | 15 (`chainCircuitCrossSystem`, `marketSnapshotReuse`, `avoidStrippedFields`, `fieldSpreadEnabled`, `avoidDriftFields`, `protectChainGoods`, `autoKeeperProbes`, `autoBuyShips`, `autoKeeperGoodSystems`, `autoCrossSystemRoutes`, `warpTours`, `tourHopPriority`, `exploringEnabled`, `openingAutomation`, retired `warehouseTarget`) |
| Description length | median 459 chars, max 1,035, 48 of 119 over 500, 7 over 800; 54,500 chars in total |
| Descriptions containing dated incident evidence ("2026-...") | 46 |
| Descriptions ending in a "Takes effect ..." line | 74 |
| Names containing a colon prefix ("Fresh systems: ...") | 55 of 119 (a hand-made grouping already: Fresh systems 15, Keepers 10, Thin markets 5, Explorer 3, Slow hulls 3, ...) |
| Names over 60 characters | 4 (`keeperYardGapRatio` 69, `freshGate` 65, `keeperTopUpMaxPending` 66, `releaseOnTourPct` 61) |

### 2.2 Per existing `category`

| category | clauses | enabled by default | off by default | defaultAdopted false |
|---|---|---|---|---|
| trading | 42 | 23 | 19 | 0 |
| ops | 46 | 28 | 18 | 0 |
| fleet | 21 | 17 | 4 | 1 |
| risk | 10 | 5 | 5 | 2 |
| **total** | **119** | **73** | **46** | **3** |

### 2.3 Where `category` already lies

Cross-tabulating the old category against the proposed group (section 5) shows clauses in the wrong bucket: `keeperYardWaitMin` is `trading`; `keeperDeliveryHops` and `keeperYardGapRatio` are `fleet`; `routePriceSanityPct` is `ops` though it is route selection; `explorerCreditFloor` and `scoutCreditFloor` are `risk` though they govern exploring; `arrivalSurveyMaxAgeMin` is `fleet` though it saves API calls; the nine keeper-coverage clauses, sixteen fresh-system clauses and eight API clauses are all just `ops`.

### 2.4 Where clauses are declared and consumed

- Declared: only `src/engine/doctrine.ts` (the catalog). Per-tenant state: table `doctrine (tenant_id, key, value, enabled, updated_at, adopted)` (`migrations/001_init.sql` line 160; `migrations/008_doctrine_adopted.sql` adds `adopted`). Fire counters: `doctrine_fires` (006) and `doctrine_fire_log` (007). The doctrine table is deliberately NOT wiped at a reset (CLAUDE.md "Deliberately not included"; `Store.TENANT_GAME_TABLES`), so stored rows persist across weeks.
- Read by the engine: every one of the 119 keys has at least one reader outside `doctrine.ts` (grep found no unreferenced key; retired `warehouseMax`/`warehouseMinMargin` are still read in `fleet.ts` but inert). Almost all readers are in `src/engine/fleet.ts`; exceptions: `keeperLaneWorkers` and `apiLaneProxy` in `src/engine/tenantRegistry.ts`, `jevRouter` in `src/engine/copilotRouterLive.ts`.
- Keys are also persisted or referenced elsewhere, which is why they must not be renamed: saved opening tasks/templates call "set a doctrine value" by key (`src/engine/openingTasks.ts` validates `doctrine key must be 1-60 chars`; `openingTemplates.ts`), starter templates by home-system archetype (`DOCTRINE_TEMPLATES` in `src/engine/systemClassifier.ts` lines 59-89, applied by `POST /tenants/:id/apply-template` in `src/http/admin.ts` lines 224-232), the end-of-week `run_results` row stores the doctrine as a key->{value,enabled} map (`src/db/store.ts` ~4600), `action_events` stores every change as `doctrine:<key>` (`src/engine/fleet.ts` line 755), and `docs/`, `CHANGELOG.md`, the journals and the `ops` tool descriptions (`src/ops/catalog.ts`) name keys in prose.
- Tests: `tests/doctrine.test.ts` (17 tests; needs Postgres) and `tests/doctrineRetired.test.ts` (4).

## 3. How doctrine is shown and edited today

### 3.1 HTTP (src/http/dashboard.ts)

- `GET /api/doctrine` (line 908) returns `{ rules: doctrine.list(), catalog: doctrine.catalog() }`. `list()` is the adopted clauses (113 at defaults) and carries no `category`; `catalog()` is every visible clause with `category`, `defaultAdopted`, `adopted`. Both carry the full description. No query arguments.
- `POST /api/doctrine` (line 917) `{key, value?, enabled?}` -> `Doctrine.set()`, which silently clamps to the clause's min/max.
- `POST /api/doctrine/adopt` (936), `POST /api/doctrine/onboard` (954), `GET /api/doctrine/stats` (975, fire counts), `GET /api/doctrine/fire-ships` (989, hulls that fired a rule in the last N hours).
- Not exposed anywhere: the catalog default for each clause as a comparable field, `updated_at` (stored but `Store.getDoctrine`, `src/db/store.ts` line 1627, selects only key/value/enabled/adopted), and the change history (it exists as `action_events` rows, kind `config_change`, subject `doctrine:<key>`, with before/after; written by `Doctrine.onChange`).

### 3.2 UIs

| UI | Files | What the doctrine view does | Gaps |
|---|---|---|---|
| **Deck** (`/` and `/deck`, the live desktop UI) | `public/deck.html` lines 361-368 (`#view-doctrine`, panels `#doctrine-standing-orders`, `#doctrine-recent-activity`); `public/deck.js` `renderDoctrine()` line 2420, handlers lines 2498-2522, tab wiring line 178-185 and 229 | One flat list of ADOPTED clauses in catalog order: name, an on/off chip, a number input only when `r.max > 1`, a switch. Header "N / M applied". Right panel: top 6 rules by fire count. Edits go `POST /api/doctrine` then reload; errors are `alert()`. | No search, no group, no filter, no description, no default, no range shown, no changed marker. Clauses with `max <= 1` that are not switches (only `repairConditionFloor`, 0..1 step 0.05) show their value but cannot be edited. The 3 not-adopted clauses and the catalog are not shown at all (`doctrineCatalog` is not imported by `deck.js`). |
| **Tower** (`/m`, mobile) | `public/m.html` lines 260-263 (`#more-sec-doctrine`, `#more-doctrine`); `public/m.js` `renderMoreDoctrine()` line 2203, handlers 2570-2597, nav entry line 283 ("Doctrine", section "Rules"); `public/m.css` lines 505-514 | Same flat list of adopted clauses: name, an "applied / not wired" tag (always "applied"), value box when `max > 1`, switch. | Same gaps; on a phone a 113-row flat list with no search is the worst case. |
| **v6 / Book mode** (`public/v6.html`, `public/v6.js`; `/v5`, `/v6` are legacy, `/` serves `deck.html`; reachable as `/v6.html` by the generic `*.html` rule in `src/cli/index.ts`) | `renderBook()` line 664-770, `CLAUSE_TEXT` line ~866, mobile list `renderMobileDoctrine()` line 1971, `saveRule`/`saveAdopted` lines 1945-1966 | Standing orders as prose with an inline value chip; a collapsed "+ Add a policy" library of non-adopted clauses grouped by the four categories with full descriptions. | Only 16 clauses (3 retired) have hand-written prose in `CLAUSE_TEXT`; every other clause renders as "Name: chip". The library is the only place a description or a non-adopted clause is visible. |
| Shared state | `public/shared/store.js`: `doctrineRules`, `doctrineCatalog` (lines 56-59), `loadDoctrine()` 434, `setDoctrine()` 660 | Deck and Tower read `doctrineRules` only. | |
| Player guide | `public/guide.html` lines 425-440 (a hand-kept table of about 13 rules) | Defaults listed there differ from the code defaults (guide: Max lots per trip 6, Two-leg circuits on at 75%, Circuits across a gate on, Best ship for the best routes on; code: 3, off at 50%, off, off). They may be live values; I could not verify live state. | Stale or live-valued; either way it will drift again unless generated from the catalog. |

### 3.3 MCP (src/mcp/tools.ts)

- `stcommand_get_doctrine` (line 212): no input arguments; returns `{ rules, catalog }` via `textResult()`, which pretty-prints with `JSON.stringify(x, null, 2)` (line 49) and also attaches the same object as `structuredContent`. Reconstructed size with default values and 116 visible clauses: **152,124 bytes compact, 175,533 bytes pretty** (113 adopted + 116 catalog clause objects, each with its description), before any `shipCap:*` rules. The operator's "~160 KB" matches. The journal shows the practical consequence: sessions save the result to a file before reading it (journal 2026-11-08, 2026-11-10 13:15: "read from the saved get_doctrine file first"). Unverified: whether the client counts `content` and `structuredContent` both against its token limit.
- `stcommand_set_doctrine` (line 1472): `{key, value?, enabled?}`; returns the rule. It clamps silently (journal 2026-11-17: "clause max is 5, so 6 was not possible" was only noticed by reading the reply), cannot reset to the default, and sets one clause per call. Each call records an operator action.
- The player instructions (`src/mcp/server.ts` line 47) and several `ops` tool descriptions (`src/ops/catalog.ts` lines 562, 626, 636, 828) point to `get_doctrine` for keys.

### 3.4 Problems found, ranked

1. **No navigation at all.** 113 adopted clauses in one flat list on both live UIs, no search, no grouping; `category` has 4 values and two of them hold 74% of the clauses. The clause the operator wants cannot be found without knowing its key.
2. **The data a person needs to decide is hidden.** Descriptions (median 459 chars, with incident history and "Takes effect" boilerplate mixed in), defaults, ranges, dependencies and "changed from default" never reach Deck or Tower. The MCP tool sends 160 KB with each description twice, so an agent gets noise instead.
3. **Switch/value confusion and dependency traps.** 15 clauses have both an enabled flag and a 0..1 value; 3 have a fixed value of 1; `exploringEnabled` says "this value isn't used"; `repairConditionFloor` cannot be edited in either UI. About 18 clauses only act while another clause is on (section 6) and nothing in any UI says so.
4. Smaller: `category` misfiles (2.3); `enforced` is true for all 119; `DOCTRINE_TEMPLATES.hub` applies `warehouseTarget`, which is retired, and `Doctrine.setAdopted()` throws for a retired key with `adopted:true` (`doctrine.ts` line 1155), so `apply-template` for a `hub` system should fail with a 500 (read from code, not run); the guide's defaults disagree with the code.

## 4. Proposed taxonomy: 13 groups plus Retired

Grouping principle: what the operator is trying to do at the moment they open the screen, not which engine file reads the key. Group ids are short slugs (used in URLs, MCP `group` argument, tests).

| # | id | Group name | Sub-groups | Clauses |
|---|---|---|---|---|
| 1 | `cash` | Cash floors & ship buying | Floors; Ship buying; Trade spend; Hull caps (dynamic `shipCap:*`) | 5 (+ dynamic) |
| 2 | `routes` | Route choice & ship matching | Margins & lots; Intel & sanity; Circuits & follow-on; Hull matching | 17 |
| 3 | `reach` | Jumps & cross-system trading | Jumps; Cross-system; Slow hulls | 8 |
| 4 | `pacing` | Market impact & trip pacing | Buy guards; Trip limits; Recovery & impact model; Thin markets | 14 |
| 5 | `safety` | Loss limits & wind-down | Sale protection; Wind-down; Upkeep | 5 |
| 6 | `gate` | Gate & contracts | Gate; Contracts | 3 |
| 7 | `mining` | Mining & siphoning | Fleet size; Field assignment | 7 |
| 8 | `keeper-buy` | Keepers: buying & budget | Budget; Approval & auto-buy; Yard & delivery; Spend rate (new); Legacy target | 8 (+4 new) |
| 9 | `keeper-cover` | Keepers: coverage & triage | Intake; Top-up; Triage | 9 |
| 10 | `fresh` | Fresh systems: release & staging | Master; Release rule; Staging cost; Idle parking | 16 |
| 11 | `explore` | Exploring, tours & surveys | Exploring; Worth tests; Tours; Remote survey; Charting | 12 |
| 12 | `api` | API budget & rate limits | Second IP; Call savings; Keeper polling; Dispatcher cost | 9 |
| 13 | `auto` | Opening automation & advisory | Opening; Advisory | 3 |
| - | `retired` | Retired (hidden unless asked) | Warehouse | 3 |
| | | **Total** | | **119** (123 with the 4 new clauses in section 10) |

Notes on choices:
- "Opening and cash rules" from the brief collapses into `cash` plus `auto`: the opening is driven by saved templates (not clauses); only `openingAutomation` is a clause. The opening-time cash floors the operator raises (3M for keepers, 1M for releases) live in their features' groups (`keeper-buy`, `fresh`) and are pulled together in the "Common knobs" panel and a "Cash floors" cross-view (section 7.4), because the same idea (a wallet that must remain) appears in four places.
- Keepers are split in two because 17 clauses is too many for one screen and the questions differ ("why was this keeper bought / not bought" vs "how many markets get covered and polled").
- Group size ranges 3 to 17; the largest (`routes`, `fresh`) are split into sub-groups so no sub-group exceeds 8.
- Dynamic `shipCap:<TYPE>` rules go to `cash` / "Hull caps" (they are the auto-buyer's per-hull limits). The grouping module must have a prefix rule for them.

## 5. Every clause, one group (119 rows)

Columns: key | proposed group (id) | sub-group | one-line reason. The reason also says when a clause is a master switch or needs another clause. The old `category` is not repeated here (the cross-tab is in 2.3). Dynamic `shipCap:<TYPE>` rules (not in the 119): group `cash`, sub-group "Hull caps".

| key | group | sub-group | reason |
|---|---|---|---|
| `cashFloor` | cash | Floors | Catch-all wallet floor for every purchase; the root cash rule. |
| `shipBudget` | cash | Ship buying | Headroom above cashFloor before any hull is considered; sibling of autoBuyShips. |
| `autoBuyShips` | cash | Ship buying | Master switch for engine-proposed hulls (cards still apply); keeper probes are separate. |
| `tradeBuyCashShare` | cash | Trade spend | Caps one trip's purchases as a share of spendable cash. |
| `tradeBuyFreeBelow` | cash | Trade spend | Always-allowed amount under tradeBuyCashShare (early-game escape). |
| `marginFloor` | routes | Margins & lots | Minimum per-unit margin for a route to exist at all. |
| `maxLotsPerTrip` | routes | Margins & lots | Trip size in market lots; the main size knob (live value differs from the code default 3). |
| `snapshotMaxAgeMin` | routes | Intel & sanity | How old a price may be and still define a route. |
| `routePriceSanityPct` | routes | Intel & sanity | Rejects sell prices far above the market's own median bid. |
| `chainFollowOnWeight` | routes | Circuits & follow-on | Backhaul credit; independent switch, replaced by circuits where a circuit exists. |
| `chainCircuitWeight` | routes | Circuits & follow-on | Master switch for two-leg circuits; the five circuit knobs below only act while this is on. |
| `chainCircuitHorizonMin` | routes | Circuits & follow-on | Tuning of Two-leg circuits (reach in minutes). |
| `chainCircuitReturnPct` | routes | Circuits & follow-on | Tuning of Two-leg circuits (return-leg share). |
| `chainCircuitMinGain` | routes | Circuits & follow-on | Tuning of Two-leg circuits (minimum gain). |
| `chainCircuitMinRuns` | routes | Circuits & follow-on | Tuning of Two-leg circuits (second-leg staying power). |
| `chainCircuitCrossSystem` | routes | Circuits & follow-on | Sub-switch of Two-leg circuits; also needs autoCrossSystemRoutes for gate trips. |
| `routeMatchTopN` | routes | Hull matching | Master switch for giving top routes to the best-suited hull. |
| `routeHoldAware` | routes | Hull matching | Score a route by this ship's own hold; enable-only (value fixed at 1). |
| `routeSoonFreeMin` | routes | Hull matching | Counts ships about to finish as candidates for route matching. |
| `shipSpeedWeight` | routes | Hull matching | Values hull speed in route time. |
| `routeFitMinTrip` | routes | Hull matching | Keeps big hulls off small routes; works with routeFitBigHold. |
| `routeFitBigHold` | routes | Hull matching | Defines "big hull" for routeFitMinTrip; inert while that clause is off. |
| `positioningHops` | reach | Jumps | How far an empty ship may travel to reach a buy market. |
| `hauledHops` | reach | Jumps | How far a loaded ship may carry cargo across gates. |
| `redirectHops` | reach | Jumps | Where stranded cargo may be redirected; a safety-flavoured jump limit. |
| `autoCrossSystemRoutes` | reach | Cross-system | Master switch for routes that start in another system. |
| `crossSystemMaxAgeMin` | reach | Cross-system | Longer intel window for gate routes; belongs with the cross-system switch. |
| `slowHullSpeed` | reach | Slow hulls | Defines "slow hull" for the two slowHull limits below. |
| `slowHullHauledHops` | reach | Slow hulls | Loaded-jump limit for slow hulls. |
| `slowHullPositioningHops` | reach | Slow hulls | Positioning-jump limit for slow hulls. |
| `buyGuardImpactPct` | pacing | Buy guards | Pre-buy refusal when our own price impact kills the margin. |
| `routeCoolOffMin` | pacing | Buy guards | Cool-off after a route under-earned or lost money. |
| `deadRouteShareMin` | pacing | Buy guards | Shares a dead route between ships so each does not rediscover it. |
| `routeRoundsMax` | pacing | Trip limits | Max trips per route per 60 min. |
| `buyMarketRoundsMax` | pacing | Trip limits | Max trips per good at one buy market per 60 min. |
| `buyMarketSpacingMin` | pacing | Trip limits | Master switch and default gap for per-route spacing (also used by stcommand_set_route_spacing). |
| `buyMarketSpacingAutoPct` | pacing | Trip limits | Automatic trigger for spacing; needs buyMarketSpacingMin on. |
| `marketRecoveryMin` | pacing | Recovery & impact model | Recovery wait after our sales into a market. |
| `lotImpactMaxFactor` | pacing | Recovery & impact model | Learned per-market price impact (cap factor over the flat 4.5%). |
| `thinMarketSellImpactPct` | pacing | Thin markets | Base steep-fall plan for thin sell markets; master of the thin-market set. |
| `thinMarketMaxLots` | pacing | Thin markets | Lot cap at thin markets; inert while thinMarketSellImpactPct is off. |
| `thinMarketDearPrice` | pacing | Thin markets | Price at which a thin good counts as dear. |
| `thinMarketDearImpactPct` | pacing | Thin markets | Steeper impact for dear thin goods. |
| `thinMarketDearMaxLots` | pacing | Thin markets | Tighter lot cap for dear thin goods. |
| `maxLossPct` | safety | Sale protection | Refuses to sell below this loss against cost basis. |
| `autoApproveFloorSale` | safety | Sale protection | Sells below-floor lots without a card (share of cost); master of the pair. |
| `autoApproveFloorSaleMaxLoss` | safety | Sale protection | Loss cap for one auto-approved below-floor sale; needs autoApproveFloorSale. |
| `resetWindDown` | safety | Wind-down | Stops all new buying before the weekly reset (value = minutes before). |
| `repairConditionFloor` | safety | Upkeep | Opportunistic repair threshold (value is a 0-1 condition, not a switch). |
| `protectChainGoods` | gate | Gate | Keeps a gate mission's input goods out of ordinary trading while it is unfinished. |
| `contractBuyPriceGuard` | gate | Contracts | Price ceiling for goods bought for a contract. |
| `contractBuyCashShare` | gate | Contracts | Cash share one contract purchase may use. |
| `minerTarget` | mining | Fleet size | Drone count target (auto-buyer). |
| `promoteAtMiners` | mining | Fleet size | Promotes the biggest-hold miner to trader at this miner count. |
| `siphonTarget` | mining | Fleet size | Gas siphoner count target. |
| `fieldSpreadEnabled` | mining | Field assignment | Master switch for auto field assignment; the other three act only while it is on. |
| `maxCrewPerField` | mining | Field assignment | Crew cap per asteroid field. |
| `avoidStrippedFields` | mining | Field assignment | Deprioritizes stripped fields. |
| `avoidDriftFields` | mining | Field assignment | Deprioritizes fields needing a drift leg. |
| `keeperCount` | keeper-buy | Legacy target | Old fixed keeper target; superseded in practice by queue, top-up and keeperMaxTotal (consumer: fleet.ts ~11426). |
| `keeperMaxTotal` | keeper-buy | Budget | Fleet-wide keeper ceiling; bounds API polling load. |
| `autoKeeperProbes` | keeper-buy | Approval & auto-buy | Master switch for the engine proposing keeper probes. |
| `autoApproveKeeperProbes` | keeper-buy | Approval & auto-buy | Price cap for buying without a card; works with keeperAutoApproveMinCash. |
| `keeperAutoApproveMinCash` | keeper-buy | Approval & auto-buy | Wallet that must remain after an auto-buy; the operator's 3M rule lives here. Off in code, set by hand. |
| `keeperYardWaitMin` | keeper-buy | Yard & delivery | Releases a card waiting for a ship at its yard; wording is older than present-ship buying and remote delivery. |
| `keeperDeliveryHops` | keeper-buy | Yard & delivery | Cross-gate probe delivery reach. |
| `keeperYardGapRatio` | keeper-buy | Yard & delivery | Advisory note on a cheaper yard; no spending effect. |
| `autoKeeperGoodSystems` | keeper-cover | Intake | Adds every market of a good system to the keeper list; prerequisite of remoteSurveyIntake. |
| `keeperMinGoods` | keeper-cover | Intake | Distinct-goods minimum for a market to be worth a keeper. |
| `keeperMinGoodsRecommended` | keeper-cover | Intake | Same idea as keeperMinGoods for the card's recommendation text (two thresholds, 3 vs 5). |
| `keeperTopUpPerHour` | keeper-cover | Top-up | Master switch and rate of top-up for live systems. |
| `keeperTopUpMaxPending` | keeper-cover | Top-up | Top-up waits while this many listed markets lack a keeper; needs top-up on. |
| `keeperTopUpMaxUnpriced` | keeper-cover | Top-up | Skips systems with unpriced covered markets; needs top-up on. |
| `keeperTopUpMaxCalls` | keeper-cover | Top-up | Polling-load ceiling for top-up (also an API budget knob). |
| `keeperMaxRotationMin` | keeper-cover | Top-up | Stops top-up when a full keeper rotation is too slow. |
| `keeperTriage` | keeper-cover | Triage | Parks keepers on dead markets and re-checks later. |
| `freshGate` | fresh | Master | Master switch and mode (1 advisory, 2 auto) for the whole fresh-system queue. |
| `freshTarget` | fresh | Release rule | Number of live premium systems kept (auto mode). |
| `freshStagedAhead` | fresh | Release rule | Systems warmed up ahead of need; spends keepers. |
| `freshLeadMin` | fresh | Release rule | Open the next system this long before the fade. |
| `freshFadeHours` | fresh | Release rule | Premium fade age. |
| `freshMinGapMin` | fresh | Release rule | Minimum gap between releases. |
| `freshTradingSells` | fresh | Release rule | Counts only trading systems toward the live target. |
| `releaseMinPricedPct` | fresh | Release rule | Priced share needed before release. |
| `releaseOnTourPct` | fresh | Release rule | Earlier release when a tour ship has priced the system. |
| `systemReleaseMinCash` | fresh | Staging cost | Wallet that must remain after buying a system's keepers (cash floor for staging). |
| `freshKeepersPerSystem` | fresh | Staging cost | Keepers bought per fresh system. |
| `freshTours` | fresh | Staging cost | Tour ships that price staged systems (value = ships at once). |
| `freshIdleParkHours` | fresh | Idle parking | Parks keepers in a live system where nothing sells; master of the idle set. |
| `freshIdleRecheckMin` | fresh | Idle parking | Length of a re-check; needs idle parking on. |
| `freshIdleMinHourlyProfit` | fresh | Idle parking | Profit that counts a system as in use. |
| `freshIdleHoldBound` | fresh | Idle parking | Never park where a loaded ship is heading; enable-only. |
| `exploringEnabled` | explore | Exploring | Master switch for jump exploring (use the enabled flag; value unused). |
| `explorerCreditFloor` | explore | Exploring | Parks explorers under this wallet. |
| `scoutCreditFloor` | explore | Exploring | Parks chart scouts under this wallet. |
| `explorerTarget` | explore | Exploring | Dedicated explorer count (0 = none). |
| `exploreMinMarkets` | explore | Worth tests | Market minimum for a system to be toured. |
| `exploreMinShipyards` | explore | Worth tests | Shipyard minimum for a system to be toured. |
| `exploreMaxMarketStops` | explore | Worth tests | Markets read per explorer tour. |
| `warpTours` | explore | Tours | Lets tour ships warp instead of walking gates. |
| `tourHopPriority` | explore | Tours | Tour hops run at trade priority. |
| `remoteSurveyPerPass` | explore | Remote survey | Master and rate of remote surveying (no ship needed). |
| `remoteSurveyIntake` | explore | Remote survey | Queues systems found by remote survey; needs remoteSurveyPerPass and autoKeeperGoodSystems. |
| `sensorScanIntervalMin` | explore | Charting | Scout sensor-scan cadence. |
| `apiLaneProxy` | api | Second IP | Master switch for sending low-urgency reads through the proxy lane. |
| `apiLaneCount` | api | Second IP | Active proxies in the pool; needs apiLaneProxy. |
| `shipBook` | api | Call savings | Serves ship reads from a cache (shadow mode); biggest single call saving. |
| `marketSnapshotReuse` | api | Call savings | Reuses fresh snapshots instead of re-reading on dock. |
| `arrivalSurveyMaxAgeMin` | api | Call savings | Skips the arrival market survey when data is fresh. |
| `traderSkipKeeperMarkets` | api | Call savings | Traders skip re-recording keeper-covered markets. |
| `keeperPollMaxMin` | api | Keeper polling | Longest wait between keeper reads. |
| `keeperLaneWorkers` | api | Keeper polling | Concurrent keeper and survey tasks beside the trader loop. |
| `routeReuseMaxSec` | api | Dispatcher cost | Reuses the route list to free tick time for keepers. |
| `openingAutomation` | auto | Opening | Executes queued opening tasks and templates at reset; off by default. |
| `jevAttention` | auto | Advisory | Attention feed (advisory only, needs a decision-model key). |
| `jevRouter` | auto | Advisory | Co-pilot router (advisory only, needs a decision-model key). |
| `warehouseTarget` | retired | Warehouse | Retired 2026-10-05; hidden from list() and catalog(); still referenced by the hub starter template. |
| `warehouseMax` | retired | Warehouse | Retired with warehousing. |
| `warehouseMinMargin` | retired | Warehouse | Retired with warehousing. |

## 6. Dependencies, overlaps and clauses that look dead or superseded

All of this is read from the clause descriptions and the consumers in `src/engine/fleet.ts`; none of it was exercised live. The grouping module (section 9) should carry the `needs` relations as data so the UI can show them.

### 6.1 Master switches and the knobs they gate

| Master (acts alone) | Knobs that do nothing, or little, while the master is off |
|---|---|
| `chainCircuitWeight` (Two-leg circuits) | `chainCircuitHorizonMin`, `chainCircuitReturnPct`, `chainCircuitMinGain`, `chainCircuitMinRuns`, `chainCircuitCrossSystem` (this one also relies on `autoCrossSystemRoutes` for which gate trips exist). While on it replaces the `chainFollowOnWeight` credit for routes that have a circuit. |
| `routeFitMinTrip` | `routeFitBigHold` (defines "big hull"; inert while the master is off) |
| `thinMarketSellImpactPct` | `thinMarketMaxLots`, `thinMarketDearPrice`, `thinMarketDearImpactPct`, `thinMarketDearMaxLots` |
| `buyMarketSpacingMin` (master and default gap) | `buyMarketSpacingAutoPct`; also the per-route rules made with `stcommand_set_route_spacing` do nothing until it is on |
| `autoApproveFloorSale` | `autoApproveFloorSaleMaxLoss` |
| `fieldSpreadEnabled` | `maxCrewPerField`, `avoidStrippedFields`, `avoidDriftFields` |
| `exploringEnabled` (use the enabled flag; its value is unused) | `explorerCreditFloor`, `scoutCreditFloor` (park the same way as the switch) |
| `remoteSurveyPerPass` -> `remoteSurveyIntake` -> `autoKeeperGoodSystems` | a chain: intake needs the surveyor reading systems and the keeper-list intake switch on |
| `keeperTopUpPerHour` | `keeperTopUpMaxPending`, `keeperTopUpMaxUnpriced`, `keeperTopUpMaxCalls`, `keeperMaxRotationMin` |
| `freshGate` (off / 1 advisory / 2 auto) | every `fresh*` clause plus `releaseMinPricedPct`, `releaseOnTourPct`, `systemReleaseMinCash`; most release knobs need mode 2 (auto). `freshTours` needs auto. |
| `freshIdleParkHours` | `freshIdleRecheckMin`, `freshIdleMinHourlyProfit`, `freshIdleHoldBound` |
| `apiLaneProxy` | `apiLaneCount` |
| `autoBuyShips` | `shipBudget`, `shipCap:*`, `minerTarget`, `siphonTarget`, `explorerTarget` act through the auto-buyer |
| `autoApproveKeeperProbes` (price cap) | `keeperAutoApproveMinCash` (wallet that must remain), `keeperMaxTotal` (stops automatic buys) |
| `openingAutomation` | saved opening tasks, which themselves set other doctrine values by key |

### 6.2 Overlap (same decision, several clauses)

- **Four "wallet that must remain" floors:** `cashFloor` (everything), `keeperAutoApproveMinCash` (keeper auto-buy; off in code, the operator's 3M rule is a hand-set value), `systemReleaseMinCash` (staging a system), and `shipBudget` (headroom over the cash floor for a hull); plus `tradeBuyFreeBelow`. The new keeper spend cap reuses `keeperAutoApproveMinCash` rather than adding a fifth.
- **Three ways a keeper gets bought:** `autoKeeperProbes` (a ship visits a yard), the keeper market queue (cards), and `keeperTopUpPerHour`/`freshKeepersPerSystem`/`freshStagedAhead` (engine lists more markets). Limited by `keeperMaxTotal` (and the legacy `keeperCount`).
- **Two goods thresholds:** `keeperMinGoods` (3, which markets enter the list) and `keeperMinGoodsRecommended` (5, the "worth covering" text on a card). Same idea, two numbers.
- **Six trip-pacing guards:** `routeRoundsMax`, `buyMarketRoundsMax`, `buyMarketSpacingMin`/`AutoPct`, `routeCoolOffMin`, `marketRecoveryMin`, `buyGuardImpactPct`; plus the thin-market set and `lotImpactMaxFactor` / `maxLotsPerTrip` on the size side.
- **Jump limits:** `positioningHops`, `hauledHops`, `redirectHops`, `slowHull*`, `chainCircuitHorizonMin`.
- **Fifteen release knobs for one decision** (when to open the next fresh system): `freshTarget`, `freshMinGapMin`, `freshLeadMin`, `freshFadeHours`, `freshStagedAhead`, `freshTradingSells`, `releaseMinPricedPct`, `releaseOnTourPct`, `freshTours`, and the four idle-parking clauses. A "Release rule" sub-group with a one-paragraph explainer is the fix; the knobs stay.

### 6.3 Dead, retired, superseded or suspect

| Clause(s) | Finding | Action to propose |
|---|---|---|
| `warehouseTarget`, `warehouseMax`, `warehouseMinMargin` | Retired 2026-10-05; hidden from `list()`/`catalog()`; still read in `fleet.ts` (lines 1667, 1827-1875) but inert. | Keep in the `retired` group (hidden). |
| `DOCTRINE_TEMPLATES.hub` (`systemClassifier.ts` line 86) | Applies `warehouseTarget`, which `setAdopted()` refuses (line 1155), so the admin "apply starter template" call for a hub system should return 500. Read from code only. | Remove the entry (separate tiny fix, not part of this batch unless the operator wants it). |
| `keeperCount` | Legacy fixed keeper target (default 2). Read at `fleet.ts` line 11426 and `liveViews.ts` line 47. Superseded in practice by the queue, top-up and `keeperMaxTotal`; its description still says "probes at shipyards, miners at outer buy markets". | Ask operator; if still used keep in sub-group "Legacy target", else retire. |
| `keeperYardWaitMin` | Description says a keeper purchase can only run when one of our ships is docked at the yard. Since the present-ship buy (`buyKeeperThroughPresentShip`) and cross-gate delivery, and CLAUDE.md's 2026-11-17 correction, that is no longer the main case. Feeds the stall policy `graceMin` (`fleet.ts` line 8131). Also filed under `trading`. | Re-read the description against current behaviour; move to `keeper-buy` / "Yard & delivery". |
| `exploringEnabled` | Value is explicitly unused ("This value isn't used"); only the enabled flag matters. Defaults not adopted. | Mark `kind: switch`. |
| `enforced` (all 119 true) | Carries no information; Tower shows it as "applied". | Stop displaying it. |
| `keeperYardGapRatio` | Advisory note only; no spending effect. | Keep; label "advice only". |
| `minerTarget`, `promoteAtMiners`, `siphonTarget`, `crossSystemMaxAgeMin`, `keeperMinGoodsRecommended`, `openingAutomation`, `repairConditionFloor` | Never mentioned in the three journals or CHANGELOG by key (regex search). Not dead (all have readers); they simply are not touched during a live week. | Start collapsed ("rarely touched") in their group. |
| `explorerTarget` default 0, `exploringEnabled`, `explorerCreditFloor`, `scoutCreditFloor` | Explorers are parked (CLAUDE.md, 2026-10-29); three of these are `defaultAdopted:false` and invisible in Deck and Tower. | Keep, show under "Not adopted" filter. |
| `jevAttention`, `jevRouter` | Advisory only, ship off, need a decision-model key. | Keep in `auto`. |

## 7. Conventions

### 7.1 Keys

- **Do not rename existing keys.** They are persisted in `doctrine` rows, saved opening templates (`openingTasks.ts`), `run_results`, `action_events` and prose across docs and journals. If a rename is ever wanted, add an `aliases` field to the metadata and let `Doctrine` resolve old to new; not in this batch.
- **New keys** are camelCase, start with the group's prefix (the dominant existing prefixes already match: `keeper*` 16, `fresh*` 13, `route*` 9, `chain*` 7, `thin*` 5, `explore*` 3, `api*` 2) and end in a unit-ish suffix: `...Pct` (percent), `...Min` (minutes), `...Hours`, `...Hops`, `...Max` (ceiling), `...PerHour`, `...Cash` (credits that must remain). Known inconsistencies to leave alone: the release clauses (`releaseMinPricedPct`, `releaseOnTourPct`, `systemReleaseMinCash`) do not carry the `fresh` prefix; `exploringEnabled`/`fieldSpreadEnabled` use `...Enabled` while `autoKeeperProbes`/`warpTours` do not.
- A clause is exactly one of four **kinds**, recorded as metadata so the UI renders the right control: `switch` (enabled flag only; value fixed or unused), `number` (value with an enabled flag meaning "apply this limit"), `mode` (small integer states, e.g. `freshGate` 1/2, `apiLaneProxy` 3/4), `number+switch` (value and a separate on/off with different meanings; none today by design).

### 7.2 Names

Pattern `Subject: what it limits`, sentence case, 60 characters or fewer, no trailing period, no unit words (the unit is its own field). The text before the colon equals the sub-group name, so a grouped screen can drop it (the header already says "Release rule"). Today 55 of 119 names already follow `Prefix: ...`; the four over 60 characters shorten (e.g. `keeperYardGapRatio`: "Keepers delivered across gates: say when another yard is much cheaper" -> "Delivery: note a much cheaper yard").

### 7.3 Description template

Keep the existing `description` field untouched for compatibility and add an optional structured `doc` per clause, filled progressively (common knobs first):

| Field | Limit | Content |
|---|---|---|
| `summary` | 160 chars | What the engine does with it, in the operator's words. |
| `whenToChange` | 200 chars | The symptom that tells you to touch it ("traders idle while a system is staged and ready"). |
| `range` | generated | min / max / step / unit from the clause, plus a "safe range" sentence when known ("2-6 normal; above 8 starves the API budget"). |
| `offMeans` | 100 chars | What `enabled = false` does. Required, because today "Off" means "no limit" for some clauses and "old behaviour" for others. |
| `needs` | keys | Clauses that must be on for this to act (also machine-readable metadata). |
| `notes` | free | Incident dates, measurements, source docs. Collapsed in the UI. The 46 descriptions with dated evidence move their evidence here. |

Fallback while `doc` is absent: the view helper shows the first sentence of `description` (up to 200 chars) with a "More" expander for the rest.

Worked example (`keeperAutoApproveMinCash`): summary "Auto-buy a keeper probe only while the wallet would still hold this much after paying; below it the purchase becomes an approval card." whenToChange "Lower it to let keepers buy themselves during a cash-rich stretch; raise it to keep cash for hulls (operator rule 2026-11-11: 3,000,000 for keepers)." offMeans "No extra reserve beyond the cash floor." needs "autoApproveKeeperProbes on".

### 7.4 Common knobs (the pinned panel)

Evidence and its limits: a regex count of each key's mentions in the three journal files (`docs/journal/2026-11-01.md`, `2026-11-01-days-1-4.md`, `2026-11-08.md`, covering the weeks of 2026-11-01 and 2026-11-08) and `CHANGELOG.md`. This counts mentions, not changes; the authoritative record is `action_events` rows `config_change` / `doctrine:<key>` in the live database, which I could not read. Confirm the list with that query before building (open question 5).

| # | key | Group | Journal mentions / CHANGELOG mentions | Why it is touched |
|---|---|---|---|---|
| 1 | `keeperAutoApproveMinCash` | keeper-buy | 20 / 4 | The operator's keeper cash rule (300k -> 3M on 2026-11-10 13:15; 5M -> 3M on 2026-11-16 21:19). |
| 2 | `systemReleaseMinCash` | fresh | 14 / 2 | Staging cash rule (3M -> 1M on 2026-11-10). |
| 3 | `freshTours` | fresh | 24 / 4 | Tour ships pricing staged systems; the most-mentioned clause. |
| 4 | `freshGate` | fresh | 9 / 8 | Off / advisory / auto for the whole queue. |
| 5 | `freshTarget` | fresh | 7 / 2 | Live premium systems kept (5 -> 7 on 2026-11-01 20:30). |
| 6 | `freshStagedAhead` | fresh | 4 / 3 | Systems warmed up ahead of need (5 -> 3 on 2026-11-16 23:35). |
| 7 | `releaseOnTourPct` | fresh | 9 / 3 | Early release when a tour ship has priced the system. |
| 8 | `releaseMinPricedPct` | fresh | 5 / 7 | Priced share before release (80 -> 60). |
| 9 | `keeperMaxTotal` | keeper-buy | 10 / 7 | Keeper ceiling vs the API budget (820 -> 900 on 2026-11-01, 900 -> 1000 on 2026-11-08). |
| 10 | `autoApproveKeeperProbes` | keeper-buy | 9 / 3 | Price cap for buying without a card. |
| 11 | `keeperTopUpPerHour` | keeper-cover | 8 / 2 | Coverage top-up rate. |
| 12 | `keeperTopUpMaxCalls` | keeper-cover | 11 / 5 | Polling ceiling (135 -> 150 on 2026-11-08 02:35). |
| 13 | `apiLaneCount` | api | 9 / 2 | Active proxies (3 -> 6). |
| 14 | `cashFloor` | cash | 4 / 5 | Global floor. |
| 15 | `resetWindDown` | safety | 4 / 2 | Set 120 -> 30 min before the 2026-11-15 reset. |
| 16 | `keeperSpendPct` (new, section 10) | keeper-buy | n/a | The operator's wallet-scaled keeper cap. |

Also changed or mentioned: `autoApproveFloorSale` (5 / 1) and `autoApproveFloorSaleMaxLoss` (4 / 1), `thinMarketDearImpactPct` (6 / 3), `apiLaneProxy` (4 / 5), `maxLotsPerTrip` (TODO and the guide cite a live value of 6 against the code default 3). A "Watch list" row under the pinned panel can hold these.

Where the pin list lives: default list in the grouping metadata (`common: true`), per-browser reorder/extra pins in `localStorage` (a per-viewer convenience, with try/catch as the rest of the UI does). A shared, stored pin list is possible later via a fleet flag; not needed for the first batch.

## 8. UI redesign: the doctrine settings screen only

Scope: the clause list on the doctrine screen of Deck and of Tower, nothing else. Navigation, the other panels on those pages (Deck: "Recent activity" and "Blocked goods"; Tower: Blocked goods, Spaced routes, Alerts, MCP keys), colours, fonts and layout of the shells stay as they are. v6 Book mode is left as it is (it keeps working because `category` stays).

### 8.1 Deck (`public/deck.html` #view-doctrine, `public/deck.js`)

Replace the contents of the "Standing orders" panel (`#doctrine-standing-orders`) with:

1. **Toolbar:** one search box (focus with `/`), filter chips `All | On | Off | Changed from default | Changed this week | Not adopted`, a "Show descriptions" toggle, and a count ("23 of 116").
2. **Pinned "Common knobs" strip** (collapsible, 16 rows from 7.4) above everything else, same row component.
3. **Group sidebar** (14 entries, 13 plus a collapsed "Retired") listing group name, clause count, on-count and a dot when any clause in it differs from default. Counts follow the active search and filter, so a search shows at a glance which groups hold hits. Selecting a group scrolls/filters the list; "All groups" shows every group stacked with sticky headers and sub-group sub-headers.
4. **Clause row:** name with the key in small mono beneath; a switch; for `number` and `mode` kinds an inline numeric input with its unit and a muted range hint ("1-50, step 1"); a "default 15, now 20" marker with a reset-to-default link when changed; a dimmed "Needs Two-leg circuits (off)" line with a one-click "turn on" when a master is off; fire count / last fired where `doctrineFires` has it. Click the row (or "Show descriptions") to expand the summary, "when to change", "what off means" and the notes.
5. **Inline editing:** validate against min/max/step before sending; on reply compare the applied value with the requested one and, if the server clamped it, say so in a toast instead of `alert()`; a 10-second "Undo" in the same toast restores the previous value (the previous value is known client-side). Editing never blocks re-rendering of other rows (the current code rebuilds the whole list and loses focus).
6. **"Changed this week" view:** rows from `GET /api/doctrine/changes` (below), newest first: time, key/name, before -> after, actor. Includes changes made by opening tasks and the engine, not only the operator.
7. **State in the URL hash** (`#doctrine?g=fresh&q=release`) so a link or a reload keeps the view. Search is client-side over the catalog already in memory (about 116 rows): matches key (camelCase split, so "top up" finds `keeperTopUp...`), name, description, group and sub-group, all words must match, case-insensitive.

### 8.2 Tower (`public/m.html` #more-sec-doctrine, `public/m.js` `renderMoreDoctrine`)

Same data and helper module, phone layout: a sticky search field; a horizontal chip strip of groups (scrolls sideways inside the strip, not the page); the Common knobs block first; accordion rows (name, switch, value; tap to expand details); the filters in a single select. Touch targets and the existing `.doc-row` typography are kept (the new rows reuse `m.css` lines 505-514 and add a few classes).

### 8.3 Data contract (additive)

- `GET /api/doctrine` keeps `rules` and `catalog` exactly as today and adds, per catalog entry: `group`, `subGroup`, `kind`, `default: {value, enabled}`, `changed` (bool, derived from the stored row vs the catalog default), `updatedAt` (from `doctrine.updated_at`), `needs` (keys), `common` (bool), and optional `doc`; plus a top-level `groups: [{id, name, blurb, count, on, changed}]`. Old clients ignore the new fields. New client code must also work against an old server (no `groups` -> render one "All" group), which matters during the minutes between a deploy and the page cache refresh.
- New `GET /api/doctrine/changes?since=<ISO>|week`: `action_events` rows with kind `config_change` and subject `doctrine:*` for this tenant, mapped to `{at, key, before, after, actor}`. "week" uses the current universe key. Reuses `Store.actionEvents()` (`src/db/store.ts` line 849).
- `Store.getDoctrine()` (line 1627) additionally selects `updated_at`.

### 8.4 MCP (`src/mcp/tools.ts`)

`stcommand_get_doctrine` gets arguments (all optional): `group` (id or name prefix), `search` (same tokenised match as the UI), `keys` (explicit list), `enabled`, `adopted`, `changed` (`"default"` or `"week"`), `detail` (`"brief"` default, `"full"` adds `description`/`doc`, `"legacy"` returns today's `{rules, catalog}`), `limit` (default 40, max 200) and `offset`.

- No arguments: `{ total, groups: [{id, name, count, on, changedFromDefault}], common: [brief rows], hint }`, an estimated 4-6 KB (the 16 common rows at about 200 bytes each pretty-printed plus the group list). It tells the caller how to drill down.
- `group=<id>`: that group's brief rows (the keeper-buy group's 8 clauses measure about 1.8 KB brief, about 4.3 KB of descriptions alone).
- All 116 brief rows measure about 25 KB pretty-printed (18 KB compact), against about 176 KB today.
- A brief row: key, name, group, subGroup, kind, value, unit, min, max, step, enabled, adopted, needs, and `default` only when the clause differs from it.

`stcommand_set_doctrine` keeps `key`, `value`, `enabled` working unchanged and adds optional `reset: true` (restore the catalog default value and enabled flag), `changes: [{key, value?, enabled?}]` (up to 10; every key and value is validated first and nothing is applied if any fails; each applied change still records an operator action and a `config_change` event), and a richer reply: `before`, `requested`, `applied`, `clamped`, `default`. The operator's journals show the operator setting 3-4 clauses at once and finding out about clamping from a later read.

`src/mcp/server.ts` line 47 (player instructions) and the CLAUDE.md "Operating the fleet" bullet gain one line: "get_doctrine: start with no arguments, then `group=` or `search=`; use `detail=full` only for the few clauses you need".

### 8.5 Files that change (UI and MCP part only)

| File | Change |
|---|---|
| `public/shared/doctrineView.js` (new) | Pure helpers: tokenise and search, filter, group and count, diff against default, dependency lookup, hash state. No DOM. |
| `public/shared/store.js` | Keep `loadDoctrine`/`setDoctrine`; add `doctrineGroups` and `doctrineChanges` slices (lines 56-59, 434-444, 660). |
| `public/deck.html` | Only the `#doctrine-standing-orders` panel markup inside `#view-doctrine` (lines 361-368). |
| `public/deck.js` | `renderDoctrine()` (line 2420) standing-orders half and the two handlers (lines 2498-2522). The recent-activity half is untouched. |
| `public/deck.css` | New classes for the toolbar, sidebar and row. |
| `public/m.html` | Only `#more-sec-doctrine` (lines 260-263). |
| `public/m.js` | `renderMoreDoctrine()` (line 2203) and its handlers (lines 2570-2597). |
| `public/m.css` | The `.doc-row` block (lines 505-514) plus a few classes. |
| `src/http/dashboard.ts` | `GET /doctrine` additive fields; new `GET /doctrine/changes` (lines 908-930 region). |
| `src/mcp/tools.ts` | `stcommand_get_doctrine` (line 212) and `stcommand_set_doctrine` (line 1472). |
| `src/mcp/server.ts` | The one instruction line (line 47). |

Not changed: v5, v6 and the older versions, `public/guide.html` (a generated doctrine table is an option, section 11), any other screen.

## 9. Migration plan (low risk, reversible)

### 9.1 Design decisions that keep it safe

- **`group` is code metadata, not data.** A new pure module `src/engine/doctrineGroups.ts` (pattern of `src/engine/keeperTopUp.ts` and CLAUDE.md "Build new logic as self-contained modules") holds the group list (id, name, order, blurb), a per-key table (`group`, `subGroup`, `kind`, `needs`, `common`, optional `doc`) and a prefix rule for `shipCap:*`. It is NOT written into the 119 clause literals, so the catalog is untouched and the diff is reviewable. `Doctrine.catalog()` merges the metadata when it builds its result (an additive change of the returned object); `list()` stays as is.
- **`category` keeps working** (v6's library and any caller read it). It is not removed or redefined; it can be deprecated later once nothing reads it.
- **No database migration.** The `doctrine` table, its keys, `adopted` and `updated_at` are unchanged; doctrine rows survive resets exactly as today (the table is outside `TENANT_GAME_TABLES`). "Changed from default" is derived at read time from the stored row vs the catalog default; "changed this week" comes from `action_events`, which already records every change.
- **Existing keys are not renamed**, so stored rows, opening templates, `run_results` and old journals stay valid.
- **A drift guard:** a test fails if any catalog key has no group, if a group is empty, or if the metadata names an unknown key. A clause added later cannot ship ungrouped.
- **New clauses ship `defaultAdopted: true, enabled: false`** (116 of 119 existing clauses follow this pattern). `defaultAdopted: false` would hide them from Deck and Tower, which render adopted clauses only.

### 9.2 Order of steps (each its own local commit, one push, one deploy)

0. Read-only prep (today, optional): query `action_events` for `doctrine:*` changes to settle the common-knobs list.
1. `src/engine/doctrineGroups.ts` + `tests/doctrineGroups.test.ts` (pure; inert in production).
2. `Doctrine.catalog()` and `GET /api/doctrine` additive fields, `Store.getDoctrine` selecting `updated_at`, `GET /api/doctrine/changes`; tests.
3. MCP `get_doctrine` / `set_doctrine` arguments with `detail=legacy` preserved; tests; instruction line.
4. `public/shared/doctrineView.js` + tests (pure, runs under `node:test` like the other shared-module tests, e.g. `tests/chainNote.test.ts`).
5. Deck screen. Keep the old flat renderer reachable with `?flat=1` for one week as the escape hatch, then delete it.
6. Tower section.
7. Docs: CLAUDE.md (a short "doctrine groups" paragraph and the new MCP usage), `CHANGELOG.md`, the TODO item, the week journal, and a Cognee refresh (CLAUDE.md "Cognee memory").
8. Keeper spend cap (section 10) as its own commits (module + tests; then clauses + seam). It can ride in the same deploy because the clauses ship off, or be dropped from the batch without touching steps 1-7.

### 9.3 Tests

- `tests/doctrineGroups.test.ts` (pure): every `DOCTRINE_CATALOG` key has exactly one group and sub-group; group ids unique; no empty group; retired keys only in `retired`; `shipCap:*` falls to `cash`; every `needs` key exists; the 16 common knobs exist; counts per group match the table in this document (this document's counts become a regression check).
- `tests/doctrineView.test.ts` (pure, shared module): search ("top up" finds `keeperTopUpPerHour`), AND matching, filter chips, changed-from-default, counts per group under a query, fallback when `groups` is missing.
- HTTP/MCP tests: `get_doctrine` with no arguments is under 10 KB; `group=` returns only that group; `detail=legacy` equals the old shape; `set_doctrine reset`; `changes` is atomic (one bad key applies nothing); clamping reported.
- Existing `tests/doctrine.test.ts` and `tests/doctrineRetired.test.ts` pass unchanged.
- Running DB tests locally follows CLAUDE.md: `pg_ctlcluster 16 main start`, `npm run migrate:test`, then `node --env-file=.env.test --import tsx --test tests/<file>.test.ts`. About 65 suites fail on a clean checkout (known, 2026-10-31), so compare failing subtests before and after with a `git worktree`, not the count.
- UI: a DOM check of both screens at desktop and phone width (the repo has `scripts/dom-check.mjs`; I did not read it, so whether it fits is unverified).

### 9.4 Deploy and rollback

- A push to `main` restarts the production box and pauses traders (CLAUDE.md "Dual-push convention", the TODO and journal notes). Do it once, in the **2026-11-21 pre-freeze window** the TODO names (deploy before the 22:00 freeze), with the operator awake, after the hourly update, not during a stall. Push both `main` and `claude/stcommand-ui-parallel-versions-fd5p9q`.
- After the restart verify: `/version.json` shows the new build; `get_doctrine` with no arguments is small; Deck and Tower doctrine screens render; one harmless edit round-trips (set a value and restore it); `ops_trade_tempo` shows sales resuming.
- Rollback: every step is a local commit, so `git revert` of the batch (or of the one broken commit) and the same dual push. There is nothing to undo in the database. The additive API fields mean an old client keeps working against the new server and vice versa.
- Pre-deploy checklist item: the new clauses (section 10) are off, so a missed clause or a wrong default cannot change fleet behaviour.

## 10. New clause design: keeper spend per hour that scales with the wallet

Operator spec (2026-11-17, TODO item at `docs/TODO.md` line 43). Place: group `keeper-buy`, sub-group "Spend rate". Design only, no code.

### 10.1 Behaviour

- **Wallet limit.** In any rolling 60 minutes, keeper spend must stay at or under `keeperSpendPct` percent of the **trailing 2-hour minimum wallet**, clamped between `keeperSpendMinPerHour` and `keeperSpendMaxPerHour` (a minimum protects a small wallet from a pointless zero; the maximum stops a rich wallet from buying a flood). The minimum over two hours, not the instant balance, so a single big sale cannot open the tap.
- **Wallet floor.** A purchase also needs `wallet - price >= keeperAutoApproveMinCash` (the existing clause; if it is off the floor is 0 and the normal `cashFloor` check in `canAfford` still applies). The pure module re-checks it so a decision and its reason are testable in one place; it duplicates the check already inside `keeperAutoApprove()` (`src/engine/keeperBuy.ts`), which is harmless.
- **Optional profit limit** (second limit, off by default): hourly keeper spend also must stay at or under `keeperSpendProfitPct` percent of the last hour's matched profit. When both limits are active the lower wins. A non-positive profit hour means a zero allowance (reason says so).
- **Gate is active when either limit's clause is enabled.** With both off the module returns "allow: cap is off" and today's behaviour is reproduced exactly (this is the weight-0 / clause-off test CLAUDE.md requires).
- **Blocked means "ask", not "forbid":** like `keeperAutoApprove`, a purchase over the allowance is not bought automatically and falls back to an approval card, so the operator can still approve it. The reason is shown on the card ("this hour 142,000 of 225,000 spent; the next 45,000 fits at 14:20").

### 10.2 Clauses (all ship `enabled: false`, `defaultAdopted: true`)

| key | name | default | min..max | step | unit | notes |
|---|---|---|---|---|---|---|
| `keeperSpendPct` | Keeper spend: share of wallet per hour | 15 | 1..50 | 1 | % | Master of the wallet limit. Operator: start at 15, adjustable. |
| `keeperSpendMinPerHour` | Keeper spend: least allowed per hour | 50,000 | 0..1,000,000 | 5,000 | c | Floor under the wallet limit (about one probe at 41-57k). |
| `keeperSpendMaxPerHour` | Keeper spend: most allowed per hour | 600,000 | 50,000..5,000,000 | 25,000 | c | Ceiling on the wallet limit. If min > max the max wins. |
| `keeperSpendProfitPct` | Keeper spend: share of last hour's profit | 30 | 5..100 | 5 | % | The optional second limit, off by default. The default value is a placeholder to confirm with the operator (open question 7). |

The wallet floor reuses `keeperAutoApproveMinCash` rather than adding a fifth wallet floor.

Worked examples at 15% with a 45,000c probe, min 50k, max 600k, trailing-minimum wallet W: W 1.5M gives 225,000 an hour (5 probes); 3M gives 450,000 (10); 0.5M gives 75,000 (1); 0.2M gives 30,000 clamped up to 50,000 (1), though the floor (for example 3M) would still refuse the purchase; 10M gives 1.5M clamped down to 600,000 (13). The TODO's own examples (225k, 450k, 75k) agree.

### 10.3 Module and seam

- **New pure module `src/engine/keeperSpend.ts`** (named in the TODO), same shape as `src/engine/keeperTopUp.ts`: a policy object (`pct`, `minPerHour`, `maxPerHour`, `profitPct`, `floorCash`, each limit's on flag), a context (now, the price, the wallet now, the wallet samples of the last 2 hours, the keeper spend events of the last 60 minutes, the last hour's matched profit), and a decision (`allow`, `allowance`, `spent`, `headroom`, `retryAfterMs`, a one-line `reason`). No I/O, no clock, no globals. A second small pure helper builds the policy from the doctrine values (`policyFromDoctrine`), so the seam stays thin.
- **Inputs, and where they come from:**
  - Wallet samples: `ledger.wallet_after` (migration 045; null on rows before it existed), read by a new small `Store` method over the last 2 hours. The current wallet is always added as a sample. The ledger is universe-scoped by row-level security, so a new week starts clean. Fail closed: if the read fails, the decision is "ask".
  - Keeper spend: a new action-event kind `keeper_spend` (builder beside `configChangeEvent` in `src/engine/actionEvents.ts`) written by `recordAction()` at every successful keeper probe purchase, on all paths (auto-approved, card-approved, bought through a present ship). Read back with `Store.actionEvents(kinds: ["keeper_spend"], sinceIso)`. Survives a restart, which an in-memory counter would not. The ledger's SHIP rows cannot be used because they do not say the purchase was a keeper's.
  - Matched profit of the last hour: the existing matched-trading computation behind `/bridge` `matchedNet` (`src/http/dashboard.ts`) or `ops_pnl`. Whether a clean 60-minute window function exists is unverified (open question 8).
- **Seam:** `FleetManager.keeperAutoApproves()` (`src/engine/fleet.ts` line 7694), after `keeperAutoApprove()` says yes and before returning, ask `keeperSpend`; a deny becomes `{approve:false, reason}` and the card is raised as today. The card text and `ops keeper_review` add the "spent / allowance" line.
- **Do operator-approved cards count?** Yes, they are recorded as spend (so the rolling total is honest) but never blocked by this cap. Whether the cap should also hold back raising cards is an open question (9).
- **Retry hint:** `retryAfterMs` is the moment enough of the oldest spend events roll out of the window for the purchase to fit; the card and the log show it.
- **No history:** with no wallet sample older than the window the module uses the samples it has (at least the current wallet) and says so in the reason.

### 10.4 Tests (described)

Pure, in `tests/keeperSpend.test.ts`: both limits off equals "allow" with today's reasons; wallet limit math at 1.5M, 3M, 0.5M, 0.2M, 10M; clamp to min and to max, and min > max; minimum over a window where the wallet dipped and recovered; a spike in the last minute does not raise the allowance; spend events exactly on the 60-minute boundary; two events inside the window; a purchase that exactly fits; one unit over; the floor check with `keeperAutoApproveMinCash` on and off; profit limit lower than the wallet limit; zero and negative profit; both limits on (lower wins); `retryAfterMs` computed from the oldest events; no samples; pct at 1 and at 50; percent given as a non-integer. Policy builder: the clause values map to the policy, an off clause maps to "off".
Seam, in `tests/keeperSpendSeam.test.ts` in the style of `tests/keeperAutoApproveSeam.test.ts`: clauses off, `keeperAutoApproves` returns exactly what it returns today (the existing seam tests pass unchanged); clauses on, an over-allowance purchase returns `approve:false` with a reason that names the spend and the allowance, and an approval card is requested; a card-approved purchase writes a `keeper_spend` event that the next decision counts; a restart (a fresh `FleetManager` reading the events back) keeps the rolling total.
Catalog: the four clauses exist, are off, adopted, in range, and in `keeper-buy` / "Spend rate" (this is covered by the groups test). Store: the wallet-sample query returns the last 2 hours only (needs Postgres).

## 11. Open questions for the operator

1. **Groups:** is the 13-group split right? Specifically: keepers in two groups (`keeper-buy`, `keeper-cover`), `gate` kept as a small 3-clause group, and `auto` (opening automation and the two advisory clauses) as a catch-all of three.
2. **`get_doctrine` default:** make the no-argument call compact now (breaks any script that expects `rules` and `catalog`; `detail=legacy` restores it), or keep the old output as the default for one week and make the compact form opt-in?
3. **Legacy and dead clauses:** retire `keeperCount`? Re-word or retire `keeperYardWaitMin`? Remove the `hub` entry from `DOCTRINE_TEMPLATES` (it should currently fail)? Stop showing `enforced`?
4. **Renames:** confirm no key renames (recommended), accepting the existing prefix inconsistencies.
5. **Common knobs:** is the list in 7.4 right? I built it from journal mentions; should the real `config_change` history be queried first? Shared across operators (stored) or per browser?
6. **Three not-adopted clauses** (`exploringEnabled`, `explorerCreditFloor`, `scoutCreditFloor`): make them visible through an "Not adopted" filter with an Adopt button on Deck and Tower (today only v6's library can add them)?
7. **Keeper spend, defaults:** are 15% (given), min 50,000, max 600,000 and the profit share 30% acceptable placeholders? Should `keeperAutoApproveMinCash` stay the wallet floor at 3,000,000, or should the 1,000,000 floor from the TODO example be the starting value for this cap?
8. **Keeper spend, profit window:** matched profit over exactly the last 60 minutes (noisy; the 2026-11-17 hours ranged from -60k to +170k), or a 3-hour average divided to an hourly rate (the `/bridge` smoothing)?
9. **Keeper spend, scope:** should the cap hold back only auto-approval (as designed), or also stop new approval cards from being raised when the allowance is used up?
10. **v6/v5:** are they still used? If not, they are never touched; if yes, should the Book library at least show group names instead of the four categories (a small change in `public/v6.js`)?
11. **`public/guide.html`:** generate the doctrine table from the catalog (so its defaults cannot drift; it currently disagrees with the code) as a follow-up?
12. **Window:** is the 2026-11-21 pre-freeze deploy slot confirmed, and should the keeper spend clauses ride in the same deploy?

## 12. What I could not verify

- Live values, live adoption state and the live `shipCap:*` rules: the stcommand MCP server failed to connect (HTTP 401, revoked key) and I was told not to touch the fleet tools in any case. All counts are of the code's catalog defaults.
- The real doctrine change history (`action_events`, kind `config_change`): not queried. The common-knobs evidence is a text search of three journal files and the CHANGELOG, which counts mentions, not changes, and covers only the weeks of 2026-11-01 and 2026-11-08.
- The `get_doctrine` size is reconstructed offline (152,124 bytes compact, 175,533 bytes pretty with default values and no `shipCap:*` rules); the operator's "~160 KB" is consistent. Whether the MCP client counts `structuredContent` in addition to `content` is unknown.
- Whether `/v6` (no `.html`) is routed: `uiVersions.ts` serves only `/v5`; `/` serves `deck.html`; `/v6.html` is served by the generic `*.html` rule. I did not run the server.
- The `hub` template failure is read from code (`setAdopted()` throws for a retired key); I did not run it.
- That `keeperYardWaitMin` and `keeperCount` still matter in current behaviour: only their readers were found, not their live effect.
- Why the guide's defaults differ from the code (stale, or live values).
- No tests were run (the work was read-only); the test commands in 9.3 follow CLAUDE.md and were not exercised here.
- Whether a 60-minute matched-profit function exists for the optional keeper spend limit.
