# Open items

Master list of things in flight — live-ops issues, ideas raised but not
acted on, and decisions pending. Update this as things open and close;
don't let it go stale. When an item closes, move it to `CHANGELOG.md`
(if something shipped) rather than just deleting it.

## Live ops — needs a decision or action

- [ ] **Mission price target as the control, not a guard (raised 2026-10-07, operator).** With `recoverPct` on, the
  ceiling sets the price the market is held at and the producer's refill sets the buying rate (see
  `docs/reset-opening-playbook.md`, "The ceiling is a target price"). Today the ceiling is `maxInflationPct` over a
  baseline seeded once (THEO F53: 1,051). Make it explicit: (1) a target price set relative to the opening price when
  the mission starts, shown as a price, not a percent; (2) adaptive: tighten the target when every input of the
  producer is at HIGH (production can sustain a lower price) and relax it, within a bound, while inputs are SCARCE;
  (3) show the resulting expected rate (units/hour at the target) on the chain panel so a too-low target that would
  stall the gate before the reset is visible. Also: never swap a mission carrier that still holds mission cargo
  (2026-10-07, THEO-2B sold 20 FAB_MATS bought at 1,464 back for 706 after being moved to a feed).

- [ ] **Trader starvation follow-ups (raised 2026-10-07, THEO-C/THEO-30 check).** Shipped: the scheduler pass cap,
  the boot gate, and one-call junk dumps for mining drones (CHANGELOG 2026-10-07). Measure the drones' call share after
  the deploy (`stcommand_ops_instances` byCaller). Still open: (2) Route churn: three times in 90 minutes the dispatcher reassigned
  THEO-C/THEO-30 while they were flying empty to the previous route's buy market; keep the current route unless the new
  one beats it clearly. (3) A server restart reshuffles assignments (THEO-C lost a 16.9k/trip EQUIPMENT leg one stop
  from its buy market for a 4.2k JEWELRY one); restore the last assignment of a ship already en route. (4) A restored
  operator hold loses a race with the trader's first tick: THEOREM_DEV_2-1, held at F52, logged "operator hold at F52"
  at 04:10:22 after a restart, then "no claimable route viable / discovering prices" at 04:10:26 and flew to H55 anyway.
  Every restart moved it (03:44, 04:10). The trader should not tick before the restore loop's holds are in place.
  (5) The dispatcher assigns legs below the trader's own `marginFloor`: 07:25, THEOREM_DEV_2-1 got FERTILIZERS G54 ->
  E49 (+96/unit) and 2-3 COPPER H55 -> A3 (+60) with the floor at 300; both traders rejected them and went "discovering
  prices", while FIREARMS E48 -> J62 sat at +1,141 and ASSAULT_RIFLES at +844 (fresh at both ends) unassigned.
  Fixed 2026-10-07: the dispatcher drops direct legs at or under `effectiveMarginFloor` before assigning, and a trader
  that refuses an auto leg hands it back (`RouteDispatcher.decline()`). Still open: check why its FIREARMS value
  (8,592) was a third of margin x tradeVolume (22,820). (6) The dashboard shows a mission/feed carrier's stale cached snapshot: 12:31 THEO-1
  read "in orbit at I59, fuel 180" (from 12:15) while it was docked empty at F53; a suspended agent's cache is never
  refreshed while the mission flies the ship. Refresh it from the mission's own reads, or show the live ship.

- [ ] **Engine flaws found starting THEOREM_DEV_2 fresh (raised 2026-10-06).** (1) A tour ship holds in place while
  a keeper-probe approval is pending (`tour scout: holding at ... — keeper probe approval pending`), so a new tenant's
  first tour never starts until someone decides. (2) `maybeBuyShip`'s "best-scored" fallback proposes drones even with
  `minerTarget`/`siphonTarget` 0; only `shipCap:FRAME_DRONE` 0 stops it. (3) An idle trader with no viable route
  ("discovering prices...") flies back and forth between the only two known markets, refuelling each time, instead of
  heading for an unpriced one. (4) A new tenant's command frigate is hull-classified as a miner at boot regardless of
  `minerTarget`. (5) An MCP tool error can surface as the literal text `[object Object]` (seen on
  `stcommand_dispatch_ship` for a ship mid-tour). (6) A tour shuttle can get stuck bouncing between two far markets
  (J61 <-> J62), refuelling every 4 minutes. [Likely fixed 2026-10-07: tour stepping stone, see CHANGELOG.]

- [~] **Batch ship reads: serve agents from a periodic `GET /my/ships` sweep (raised 2026-10-06, operator;
  Phase 1 SHIPPED 2026-10-06).** Every agent step starts with `GET /my/ships/:id` (`ShipAgent.refresh` /
  `TraderAgent.refresh`, ~85-90 per five minutes at 40 ships, the largest single use of the 90-a-minute budget),
  and it grows with every ship — at 100 ships it would be ~45 a minute on its own. `GET /my/ships` returns complete
  ships twenty per call, so a sweep is 2 calls at 40 ships and 5 at 100.
  - **Phase 1 (shipped): measure only.** `ShipSnapshotBoard` (`src/engine/shipSnapshots.ts`) takes a sweep every 30s
    (`FleetManager.sweepShips`, routine priority, ~4 calls a minute) and compares every single-ship read the fleet
    makes anyway with the latest sweep copy, counting only reads Phase 2 would really have served (copy under 30s
    old, ship hasn't acted since) and advancing the copy as Phase 2 would (finished transit = arrived, expired
    cooldown = clear). Logs `ship sweep: N single reads · E could have used the sweep, M matched (x%) · mismatches:
    <field counts> (status: <top transitions>) …` every five minutes. The copy is dated by when the sweep request
    was sent, so an action during the in-flight sweep counts as "acted since" (the first summary, 80% matched, was
    biased by dating it on response). **Next:** read a day of these lines. Phase 2 is worth it only if the
    match rate is very high and the mismatches are explainable.
  - **Phase 2: let `ShipProxy.refresh()` use the copy** when it is newer than the ship's last local update and under
    ~20s old; otherwise read as today. Every action that fails because the state was wrong (not docked, in transit,
    cargo mismatch) forces a fresh single read and one retry. Shorten the sweep to ~15s at that point. Cooldowns by
    their absolute `expiration`, never `remainingSeconds`.
  - **Phase 3:** route `FeedManager.getShip` / `MissionManager.getShip` (another ~25 per five minutes) and the
    dashboard snapshot's two-minute full list through the same copies; drop the separate list.
  - Watch: the per-ship "last updated" ordering (an action response must always beat an older sweep), and that the
    sweep itself never queues behind deferrable work (routine tier, one in flight at a time).

- [~] **Rebuild the admin area from scratch (raised 2026-10-04, operator;
  first pass SHIPPED 2026-10-04 as Deck's Admin tabs — see CHANGELOG; remaining:
  confirm in use with `OPERATOR_AGENTS` set, then retire `public/admin.html`, the
  `/admin` route and `ADMIN_KEY`; a watcher pause/run-now switch; per-agent
  Health for non-operator tenants).** `public/admin.html` + `src/http/admin.ts` predate
  most of what now exists. A rebuild should surface, at minimum: the reset
  watcher (`reset_watch` status, next reset countdown, `ST_ACCOUNT_TOKEN`
  configured?, manual "run recovery now" / pause switch); the weekly
  scoreboard (`run_results` — a table and week-over-week comparison, play
  profile per week); the fleet timeline and cash curve (`fleet_events`,
  `run_timeline`, the ops `timeline` tool); the ops tools as pages (stuck,
  instances/rate limit, keepers, pnl, logs); tenant list/cleanup/impersonate
  as today. **Decided 2026-10-04:** auth moves to the normal tenant session
  plus an operator flag (retiring the shared `x-admin-key`), and Deck absorbs
  the admin pages (it is the desktop home; `public/admin.html` goes away).
  Also decided: the operator flag is an env list of agent symbols (e.g.
  `OPERATOR_AGENTS=THEO`; can't lock the operator out), and the Deck layout is
  tabs on one page or separate pages — NOT stacked sections.

- [ ] **Discuss: should a tender wait out a jump cooldown before flying
  to its fuel market? (raised 2026-10-03, operator wants to talk it
  through before anything changes — do NOT change it unprompted.)**
  `ShipProxy.runTenderGoalStep()` now calls `refresh()` + `waitCooldown()`
  at the top of every step (added with the stale-position fix, f4f92cb;
  same pattern repair/scrap/hold use). After a gate jump the ship carries
  a ~10 min cooldown, so THEO-6B sat in X1-Y84 for ~4–5 min before
  heading to the fuel market. Unverified belief: SpaceTraders only blocks
  jump/scan/survey/extract during a cooldown, not plain navigation, so the
  wait may be unnecessary for the non-jump steps (fly to market, buy,
  fly to the stranded ship) and could be limited to the jump hop. Trade-off:
  saves minutes per cross-system rescue vs. changing behaviour that works.
  Open questions: confirm navigation really isn't cooldown-gated (a
  one-off live test), and whether repair/scrap/hold would want the same
  relaxation or only tenders. Current decision: leave as is.

- [ ] **H56 IRON_ORE feed vs. trader buying pressure — live crew-size test,
  in progress 2026-09-26.** Context: H56 is a refinery market — it
  *imports* IRON_ORE (buys from the mine feed's miners) and *exports*
  IRON (sells to arbitrage traders like THEO-6/THEO-8, who resell it
  elsewhere, e.g. THEO-8 bought 80u IRON @ 83-86c and sold it at F52 for
  171c). When a trader buys IRON out faster than miners feed IRON_ORE in,
  H56's IRON price spikes and its supply rating degrades (SCARCE/LIMITED)
  — confirmed 9/25: IRON purchase price ran 90c→317c over ~4h under a
  thin, unbiased 3-ship crew. Two related fixes landed the same day:
  auto-wiring miner preference (`setMinerPreference`) so `mine` feeds bias
  survey/extraction toward the feed's own good, and changing `mine` feeds
  to top off the hold before selling (`stepCarrier()`'s `holdFreeSpace`
  check) instead of delivering on every small extraction batch. Since
  then IRON's price has fallen every hour, back down to 87c/ABUNDANT by
  9/26 20:00 as crew size grew 3→6→8. Operator is now running 10 miners +
  6 dedicated surveyors feeding H56, against one trader currently buying
  IRON there, and reports the price looks "balanced" — i.e. holding in
  the MODERATE-or-better supply band (operator's stated target) rather
  than sliding back to LIMITED/SCARCE. Update 2026-09-26 ~22:00-23:00:
  operator identified the two buyers as THEO-1 (steady, tagged `(feed)` —
  40u IRON every ~11min, a real chain buyer per `feed IRON →
  X1-SN30-F50`) and THEO-6 (also just assigned to that same chain at
  22:16, plus occasional opportunistic buys from THEO-8, untagged, not
  part of any feed). With both THEO-1 and THEO-6 buying against the
  10-miner/6-surveyor crew, IRON slipped from 89c/ABUNDANT (22:17) to
  106c/MODERATE (22:53) — still in the green zone but trending the wrong
  way. Operator's read: "10 miners isn't enough for that" (2 buyers) —
  reduced back to 1 buyer at ~22:55 to see if the price stabilizes/
  recovers. **Open**: no read yet on where it settles with 1 buyer, or
  what buyer:miner ratio is the actual breaking point. **Follow-up idea
  raised by operator**: once real price/supply bands are established for
  a route under buying pressure, feed the observed thresholds into the
  margin-gate/`force` logic so a feed could auto-react (e.g. bias crew
  size or throttle a chain's buy leg) instead of needing a human watching
  the dashboard.
- [ ] **Port `v2.js`–`v5.js`/`deck.js`'s Construction missions panels to
  `assignedShips`/multi-carrier.** `Mission.assignedShip` (singular) was
  replaced by `assignedShips`/`carrierTarget` (see CHANGELOG's
  multi-carrier entry) so a bottleneck material can run more than one
  ship. `v6.js`/`m.js` (Tower) were updated to match; the older desktop
  versions and Deck still read the now-gone `m.assignedShip` field in
  their own mission cards, so they'll show "no carrier yet" even when a
  crew is assigned. Assigning still works everywhere (the API is
  unchanged) — only the display regresses on those surfaces.
- [ ] **Protocol: auto-derived chain proposer for feeder tiers.** The
  engine and manual UI for a feeder tier now exist (`FeedManager`,
  `src/engine/feed.ts` — see CHANGELOG's feeder-tier entry): an operator
  can start/stop/toggle/crew-size a "buy `good` cheap, sell it into market
  X" tier by hand, one tier at a time. What's still not built is the
  *auto-derive* half of the original ask — walking backward from a
  construction site's outstanding material through export→import market
  matches to propose the whole tier chain at once (ore→refinery→
  intermediate→site), shown as an editable list the operator confirms
  before it starts, with one master toggle for the whole chain rather than
  per-tier toggles. First live test case: X1-SN30's ADVANCED_CIRCUITRY
  bottleneck at I60, chain ore→H56→F50→D40 (H56 imports IRON_ORE/
  ALUMINUM_ORE/COPPER_ORE and exports the refined IRON/ALUMINUM/COPPER
  that F50 imports; F50 exports ELECTRONICS, which D40 imports on the way
  to its own ADVANCED_CIRCUITRY export) — can be set up manually with
  three `/api/feeds/start` calls today; the proposer would do that in one
  step for any future system.
- [ ] **Verify Deck (`/deck`) live — feature-parity pass, 2026-09-27, not
  yet manually verified in a browser.** Overview/Fleet/Markets/Map/Ops/
  Doctrine all have real content now (passes A-D of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20), plus a new
  **Feeds** screen and this pass's additions (see CHANGELOG's "Deck
  feature-parity pass" entry): Feeder tiers/chains, Ops' Automation +
  Notes panels, Markets' segmented Routes/Yards/Prices control + the
  miner-preference mini-form, Fleet's ETA column, and Overview's
  "Matched" P&L tile. `npx tsc --noEmit` and `node --check public/deck.js`
  are clean and the HTML's div/id balance was checked mechanically, but
  none of it has actually been clicked through live — verify each new
  panel renders against real fleet data (a running feed, a ship
  IN_TRANSIT for the ETA column, at least one closed trade for Matched to
  show a number instead of "—") before calling this pass done. The ⌘K
  hint still renders but does nothing. Once live verification is
  complete: Fleet pass follows the same spec-then-build pattern, once
  Overview's approach is proven and its live-ops needs are understood.
- [ ] **Hosted MCP server (`docs/mcp-server-plan.md`) — first pass shipped
  2026-09-19, connection confirmed working live the same day.** Auth
  (`tenant_mcp_keys` + `POST/GET /api/mcp-keys`, minted from the
  dashboard's Book-mode settings panel), mounted at `/mcp`, 20 tools (10
  read-only, 10 write) covering dispatch/hold/release/jump/tour-dispatch/
  role/dock/refuel/buy/approvals plus a trading/pricing intel group
  (best price, price trend, shipyard inventory, known goods) — every
  write tool routes through the exact same `FleetManager` method the
  matching dashboard route calls (the doc's §3 constraint). Along the
  way: fixed `createMcpAuth` to accept a bare key (not just literal
  `Bearer <key>` — a real `.mcp.json` config committed by another session
  hit this), and added request-level logging to `/mcp` since Render
  doesn't capture request-type logs for this service at all (confirmed
  absent even for ordinary dashboard POSTs). Still to build (tracked in
  `src/mcp/tools.ts`'s own trailing comment): bridge, markets' routes
  view, galaxy overview, missions/contracts/warehouse/doctrine writes,
  the confirm-flag requirement on destructive actions.
  **Follow-up idea, not started**: the co-pilot (`agentChat.ts`'s
  `ChatAgent`) should never grow its own separate execution tools —
  its own header comment ("adding an execution tool later is one object
  in `tools`") invites exactly the divergent-path mistake this session's
  earlier fixes were about. When it needs to act, it should call the
  same handler logic `src/mcp/tools.ts` registers, not reimplement
  dispatch/hold/jump/etc. a second time. Written up in
  `docs/mcp-server-plan.md` §9 and `docs/engine-redesign.md` §9 (the
  latter generalizing this past ship ownership specifically — "any
  shared action surface needs one gate, not several").

- [ ] **Why doesn't the fuel-tender rescue ever reach a ship stranded
  mid-fleet-driven-goal?** Found 2026-09-14 investigating why THEO's
  overnight credit balance was flat: THEO-4 and THEO-9 (both mid-scrap,
  0 fuel, not at a market) sat stranded for hours. `getStrandedShips()`
  derives stranded status independently from live ship state (not
  intent-gated), so it should have flagged both — the `fleet-rescue`
  scheduler task ran every cycle the whole time — but no "ferrying Nu
  FUEL..." log line ever appeared for either ship. `StrandedError`
  (shipped same day, see CHANGELOG) stops the wasted retry loop these
  two ships were stuck in, but doesn't explain why `makeRescuePlan()`
  never produced a plan for them in the first place — that needs tracing
  into `rescueFailures`/`makeRescuePlan()` directly, ideally with live
  DB/dashboard access rather than log archaeology alone.

- [ ] **Wire crawled_waypoints into an actual map view.** Shipped
  2026-09-13: `GalaxyCrawler.crawlSystemsPage()` persists each system's
  public waypoint layout (`Store.mergeSystemWaypoints()`, migrations/020)
  into its own `crawled_waypoints` column — free data from a `GET
  /systems` call the crawler already makes, previously discarded. Shipped
  2026-09-14: Phase B (the crawler now runs on plain tokenless `fetch()`
  against the public API, no longer routed through any tenant's
  `SpaceTraders` client or sharing its rate limiter — `TenantRegistry
  .anyBootedApi()`, which existed solely for this, was removed) and Phase
  C (an ongoing opportunistic jump-gate sweep — once the systems crawl is
  done, `GalaxyCrawler` cycles through every known-but-unresolved gate
  from `crawled_waypoints`, calling the public, chart-gated `.../jump-gate`
  endpoint on the chance someone else has charted it since; hits are
  merged into `jump_gates` via the new `Store.mergeGateConnections()`,
  read-modify-write on just that column so it never touches
  `waypoints`/`crawled_waypoints`; a drained queue rebuilds and re-sweeps
  every 24h since "still uncharted" is a matter of *when*, not *if*, for
  a gate someone eventually visits). `GalaxyCrawler`'s constructor is now
  `(store, log)` — no longer takes a tenant-API getter.
  **Still not done**: nothing renders any of this yet. The public
  cartography page (`GET /api/cartography/systems`) only ever draws one
  dot per *system* (`listGalaxySystemPositions()`), never per-waypoint
  detail directly on the map itself — clicking a dot now opens a side
  panel with per-system waypoint/gate detail (shipped 2026-09-14, see
  CHANGELOG), but the map's dots themselves stay system-granularity.
  Jump-gate connections learned by the Phase C sweep specifically (as
  opposed to scanned tenant gates, which already show as connection
  lines) still aren't drawn. Tower's Map and desktop's galaxy view both
  read a tenant's own `GalaxyAtlas.listSystems()` (in-memory,
  tenant-scan-only), not this shared DB column at all.

- [ ] **Set up the A/B tenants once play-style tracking ships.** Operator
  plan 2026-09-13: THEO-2 as the "manual intervention" arm, compared
  against an unmodified-automation baseline tenant. **Profile labels
  done, same day** — operator has labeled the tenants via the admin
  page's Profile column. Still open: log a checkpoint on each labeled
  tenant (via the "Play style" panel) to get the system-attribute
  snapshot on record — the same manual strategy that works on THEO
  doesn't transfer to THEO-2 at all, because the two home systems aren't
  comparable (market/shipyard/gate counts differ), so this is worth
  doing specifically for that data point, not just the label. THEO's
  *own* early manual overrides (command ship → tour, approved two
  miners, bought and converted a third to trader) happened before this
  feature existed and can't be reconstructed automatically — log it as
  a checkpoint note too if still wanted on the record.
- [ ] **Tune the starter doctrine templates once real data exists.**
  Shipped 2026-09-13: `src/engine/systemClassifier.ts` classifies a
  tenant's home system (isolated / market_desert / shipyard_poor / hub /
  standard) from the same attributes the checkpoint captures, and the
  admin page's Play style panel shows the matching starter doctrine
  template with an "Apply template" button. The archetypes and every
  template value are a first-pass guess, not a tuned result — genuinely
  worth revisiting once THEO-2 (or any classified system) has enough
  runtime to show whether the suggested deltas actually help. Nothing
  applies itself; it's a suggestion the operator clicks to apply, same
  weight as any other doctrine edit.
- [ ] **Verify the reset-cleanup admin tool actually ran clean.**
  Shipped 2026-09-13 in response to a live SpaceTraders universe reset
  — see `CLAUDE.md`'s "SpaceTraders universe resets" section for the
  full story and `CHANGELOG.md` for the shipped entry. Typechecked;
  `tests/admin.test.ts` couldn't run against the remote test Postgres
  (`ETIMEDOUT`, same sandbox flakiness, retried once). After using the
  admin page's "After a server reset" button: confirm the cartography
  page starts showing fresh (empty, then slowly repopulating) data
  instead of the old universe's systems; confirm the cleared tenants'
  dashboards come up empty/fresh rather than showing ghosted
  old-universe ships or routes; confirm `docs/TODO.md`'s next galaxy-
  crawl-progress check (`GET /api/admin/galaxy/status`) shows the count
  climbing from 0 again.
- [ ] **Proactive reset detection.** Idea from the same incident, not
  built — see `CLAUDE.md`'s "Open idea, not yet built" section. Right
  now a reset is only noticed reactively (a tenant's own live call
  fails with the dead-token message). Poll the public, unauthenticated
  `GET https://api.spacetraders.io/v2/` on a slow interval, compare its
  `resetDate` against the last one seen, and surface a banner the
  moment it changes — catches it before any tenant's own error wall
  starts, and works even with zero tenants currently booted.
- [ ] **Verify Tower (`/m`) live — all 5 tabs.** Home and Fleet confirmed
  working by the operator 2026-09-13 (the one blank-deck report traced to
  an expected cache-skew window right after a deploy, not a code bug —
  see `CHANGELOG.md`'s Fleet entry). Map, Markets, and More shipped same
  day, not yet seen live. Still worth a pass on: Fleet's individual
  actions (Hold/Release, Repair, Send to waypoint, Assign route,
  Sell/Scrap) actually reflecting on desktop too (same `/api/fleet/*`/
  `/api/dispatch` endpoints — should just work); Map's blips positioned
  sensibly for a real system, tapping one opens the sheet, and Buy from
  the sheet actually purchases; Markets' route-assign picker and Yards Buy
  button; More's contract accept/decline and doctrine toggles actually
  landing (same endpoints desktop already uses). All 5 tabs (Home, Fleet,
  Map, Markets, More) are now built — this is purely a live-verification
  pass, no more screens pending.
- [ ] **Tour more systems to build cross-system pricing data.** Operator
  request 2026-09-12 — more tour coverage across more systems is needed
  before cross-system routes have enough data to evaluate. **In
  progress, 2026-09-13**: operator is manually converting traders to
  explorer for ~2 hours at a time when a system runs out of good routes,
  to force fresh tour coverage rather than waiting on the existing tour
  ships alone. Worth eventually automating (a doctrine rule that
  temporarily reassigns an idle trader to explore when a system's route
  list runs dry?) rather than a standing manual habit — not scoped.
- [ ] **Verify the three new approval gates fire live.** Shipped
  2026-09-13: `buyScout` (`maybeBuyScout()`), `buySiphoner`
  (`maybeBuySiphoner()`), and `installScanner` (`maybeInstallScanner()`)
  now go through `ApprovalGate` the same way `buyShip` already did —
  same 2h auto-approve-on-timeout policy, same "pending request is a
  guard clause, not a new suspension mechanism" shape. Typechecked
  clean; `tests/fleet.test.ts` couldn't run against the remote test
  Postgres (`ETIMEDOUT`, same sandbox flakiness, retried once). Worth
  watching the admin/dashboard approvals list for the first live
  `buyScout`/`buySiphoner`/`installScanner` request to confirm it
  actually shows up and decides correctly, same as the reset-cleanup
  tool's own "shipped, not yet seen fire live" pattern.
  **Investigated and deliberately NOT gated**: ship repairs
  (`maybeRepairFleet()`) — cheap, frequent, and delaying one risks
  losing the ship to a critical failure, the opposite of what a gate is
  for. Ship sell/scrap turned out to already be fully operator-gated —
  `sellShip()` only ever runs from an explicit dashboard/Tower "Sell"
  click (`POST /api/fleet/sell-ship`); the `scrapHere` callback wired
  into every `ShipAgent` role is plumbed but never actually invoked
  autonomously anywhere in the engine today (confirmed by search) — so
  there was no automatic scrap decision to gate.

- [ ] **Supply-chain-aware buy-side price manipulation.** Raised
  2026-09-19, day before a scheduled reset: `GET /market/supply-chain`
  (public, unauthenticated — confirmed live against the real API) returns
  `exportToImportMap`, the game's production graph — e.g. `FAB_MATS`
  needs `IRON`+`QUARTZ_SAND`; `ADVANCED_CIRCUITRY` needs
  `ELECTRONICS`+`MICROPROCESSORS`, which themselves need
  `SILICON_CRYSTALS`+`COPPER`. Selling a good's upstream inputs into a
  market that exports it raises that market's local supply/activity,
  which drives its sell price down over successive trades — not
  instantly, real trade volume over time. This generalizes past gate
  materials to any produced good a trader wants to buy cheap, and is
  strongest at *low*-`tradeVolume` markets (the API's own trade-volume
  field is explicitly "how much a market's price swings per trade" — the
  opposite of where you'd naively look for a big, liquid market to
  manipulate).
  **Explicitly NOT building into the fleet automation before tomorrow's
  reset** — this galaxy's specific markets are about to be wiped, so
  there's no runway for anything built against them tonight to pay off,
  and this is a real new pricing strategy (ties directly into the
  trade-routing/pricing design in `docs/engine-redesign.md` §4.1,
  `RouteCandidate.score`) that deserves a proper design pass once there's
  a fresh galaxy to design against, not a rushed hack under deadline
  pressure.
  **Operator wants to try it manually first, tomorrow, before any of it
  gets built** — pick a market in the new galaxy that exports something
  worth buying in bulk (a gate material or otherwise), identify its
  upstream inputs from the supply-chain graph, sell those inputs into it
  by hand via the dashboard, and see whether the price actually moves the
  way the theory predicts before spending effort automating it.

## Design docs written, no implementation decision made

- [ ] `docs/api-request-priority-plan.md` — thread Scheduler Task
  priority into `RateLimiter.acquire()`. Not urgent; latent until the
  shared limiter is actually contended.
- [ ] `docs/rate-limiter-saturation-plan.md` — queue cap + shedding for
  the shared `RateLimiter`. Same — latent at current tenant count.
- [ ] `docs/ambiguous-mutation-safety-plan.md` — catch the uncaught
  `fetch()` throw in `Client.request()` and add live-state
  reconciliation before retrying a mutation. **Worth doing regardless of
  scale** (real money-loss shape, not a performance/fairness concern) —
  higher priority than the other three in this section.
- [ ] `docs/api-capacity-doctrine-plan.md` — generalize the
  `explorerCreditFloor` pattern to API capacity. Explicitly recommended
  **not** to build yet — revisit only after the saturation plan lands or
  tenant count grows enough to matter.

## Parked ideas — raised, not acted on
- [ ] **One tenant session per browser, not per tab.** Surfaced
  2026-09-13 while building "View as" and "+ New agent" on the admin
  page: session auth is a single cookie for the whole browser, so
  switching tenants in one tab (via either of those, or a normal
  re-login) silently flips every other open tab to the new tenant on its
  next request — there's no real per-tab isolation today. Fine for a
  single operator using one tenant at a time, increasingly awkward now
  that flipping between THEO/THEO-1/THEO-2 is an expected workflow (see
  the play-style A/B tracking work). A real fix would need per-tab
  credentials (e.g. the session id carried in the URL/localStorage and
  sent as a header instead of an httpOnly cookie) rather than the
  current cookie-only model — a real architecture change, not scoped.

- [ ] **Push notifications for Tower (`/m`).** Operator request 2026-09-13,
  explicitly future work, not now. Would need: a service worker
  (Tower currently has none — `manifest-tower.webmanifest` alone doesn't
  register one) to receive `push` events and show a notification even
  when the PWA isn't open; a Web Push subscription per installed device,
  stored per-tenant (a device can re-install/re-subscribe, so this is a
  new table, not a single column); VAPID keys generated and held as env
  vars; and a server-side sender triggered off the same conditions that
  already populate Home's triage feed (a new approval, a ship going
  stranded) rather than a new notification concept. Not scoped further.
- [ ] **A log explorer on the admin screen.** Floated 2026-09-12 while
  debugging DRAGOM-C's stuck retry loop — being able to search/filter
  live app logs from inside the admin UI instead of going through
  Render's own log tools would make this kind of live-ops debugging
  faster. Not scoped: would need to decide on retention/volume handling
  and whether it reads from Render's API or the app's own log stream.
- [ ] **Probes deployed from cargo on heavy haulers.** Floated as an
  exploratory idea; probes have effectively zero fuel and can't
  self-navigate, so "camping" a market with a probe today means buying
  one directly at a shipyard on that exact waypoint. Narrower now than
  when raised: 2026-09-12 shipped auto-buying a probe at any shipyard a
  ship visits, which covers every *shipyard* market automatically — this
  idea would only still matter for a market that has a marketplace but
  no shipyard, which a bought-at-a-shipyard probe can never reach either
  way. Still not investigated.
- [ ] **Keep one unit of a great-price good on hand as a souvenir/marker.**
  Random idea, 2026-09-12: if a tour ship, explorer, or trader anywhere
  stumbles on an exceptional price for something (antimatter was the
  example), hold back one unit in the cargo hold instead of selling the
  full stack. Not scoped at all yet — would need a definition of
  "exceptional," a decision on whether it's purely cosmetic/informational
  or feeds something else (a log entry, a per-tenant "best find" record),
  and whether it's worth the held cargo space on a ship that might need
  it.

- **Steady, spread-out input delivery with a large miner pool (operator idea, 2026-10-05).** Last week the fleet ran
  ~30 miners on the iron source. Hypothesis: with a big pool split across a recipe's inputs and their deliveries
  staggered, so inputs arrive at a constant rate instead of in bursts, a producer like F53 might stay out of
  RESTRICTED/WEAK and its export price might actually fall. Context from 2026-10-05 tests: flooding sand took F53
  sand SCARCE -> ABUNDANT in ~1h (needed ~400-500 units; the first 120 did nothing) and moved FAB_MATS from
  RESTRICTED to WEAK, but iron push drained H55's source and lost money per trip. Do not test until the current
  copper/silicon/FAB_MATS tests finish.

- **Backhaul: a loaded return leg (operator idea, 2026-10-05).** Route economics now charge the empty flight back to
  the buy market as a real cost of every repeat (fuel + time), which is correct for today's A->B->A shuttle. Rough
  concept to investigate later: look for "two-way" lanes, where the ship sells good X at B, buys a second good Y there,
  and carries it back to A (or to wherever it wants to buy X's next round), so the return leg earns instead of being
  sunk fuel. Needs a pair-of-legs search over the same price data (X: A->B, Y: B->A, or a triangle A->B->C->A) scored
  on combined net per hour, plus holding the hold-size / cash constraints across both purchases. Not scoped.

- **Gate-chain follow-ups (2026-10-05).** (a) done in Deck 2026-10-05 (Tower shows tags only; v6 none). (b) done 2026-10-05 as the Ops "Gate supply chain" panel.
  (b-old) A "chain health" Deck panel like the community
  supply-chain graph: each input's supply + import activity at the producer, the producer's export activity, supply and
  trade volume, weakest link coloured. (c) Durable per-market activity/trade-volume history that can be queried without a
  tenant session (the ledger/activity tables are row-locked per tenant, so the read-only SQL login sees none of it).
  (d) Test hypotheses: export activity above WEAK needs ALL inputs' import activity STRONG (the community graph shows
  FAB_MATS STRONG with iron and sand both STRONG); trade volume grows with sustained heavy trading of a good (ELECTRONICS
  at F53 went 20 -> 43 over ~3h of heavy buying) and an import grows when over-delivered.

## Closed / resolved (kept here briefly for context, then delete)

- [x] Yards & outfitting system filter + per-item pricing — confirmed
  working live by the operator, 2026-09-13. See `CHANGELOG.md`.
- [x] Keeper-probe approval fix (both rounds) — operator confirms it
  looks fixed, 2026-09-13. See `CHANGELOG.md`'s two entries.
- [x] `PROXY_URL_<AGENTSYMBOL>` set for each tenant — done, 2026-09-13.
- [x] Persist the system-by-system architecture breakdown — done,
  2026-09-13. See `docs/architecture-overview.md`.
- [x] Public galaxy cartography page — shipped 2026-09-12. See
  `CHANGELOG.md`. `getSystems()` on the SpaceTraders client was removed as
  dead code once `getSystemsPage()` (which also returns the pagination
  total) fully replaced its one caller.

- [x] K8s pod-per-tenant and single-deployment exploration — both
  closed. See `docs/k8s-pod-per-tenant-exploration.md`. Conclusion:
  don't migrate; the shared-IP rate limit isn't solved by either shape,
  and the one real Render-restart benefit is achievable on Render itself
  via the health check shipped below.
- [x] DRAGOM's margin-floor change — confirmed working. Lowered from
  20c to 10c on 2026-09-12; verified via live logs that DRAGOM-1 went
  from flapping/stuck on one route (repeated `margin 19-20c <= floor 20c`
  rejections) to 11 successful route pickups across FUEL/FOOD/MEDICINE
  in the 51 minutes after the change, with zero margin-floor rejections.
  No new failure mode introduced by the looser floor. See `CHANGELOG.md`.
- [x] CARO's insufficient-credits purchase-failure loop — operator is
  deleting the CARO tenant outright (2026-09-12), so no further
  investigation needed.
- [x] Cross-system jump-cost bootstrap gap — fixed 2026-09-12.
  `recordJumpCost()` now also fires from `shipProxy.ts`'s shared
  explore-jump path, so every real jump a tour ship or explorer makes
  feeds `crossSystemLegCost()`'s learned average, not just trader/fleet-
  manager jumps. See `CHANGELOG.md`.
- [x] Render zero-downtime deploys — `GET /healthz` added, mounted
  ahead of every other route in `src/cli/index.ts`. **One manual step
  still needed**: no Render API/MCP tool exposes updating an existing
  service's health-check path, so set it by hand — Render dashboard →
  stcommand → Settings → Health Check Path → `/healthz`. Without that
  one field set, the route exists but Render never calls it.
- [x] Auto-buy a keeper probe at any uncovered shipyard — shipped
  2026-09-12. See `CHANGELOG.md`. **Test-infra note**: 3 of 4 new
  `tests/fleet.test.ts` cases verified passing directly; the 4th
  (`"buys a probe and stations it as keeper..."`) needs a live
  `makeTenant()` round-trip against the remote test Postgres, which hit
  a connection timeout (`ETIMEDOUT`) both times it was attempted in this
  session — a sandbox network-connectivity issue, not a code failure.
  Worth re-running that one case directly next time the test DB is
  reachable, just to see it pass rather than infer it from the guard
  logic and `setShipRole()`'s own separate coverage.
