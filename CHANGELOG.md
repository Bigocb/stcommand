# Changelog

Every notable change, newest first. One entry per merged change, written
for someone who wasn't in the room — what changed and why, not just what
the commit touched. Decisions with lasting architectural weight get their
own ADR in `docs/adr/` (see `docs/adr/README.md`) instead of just a line
here; link it from the entry when that happens.

Backfilled from git history starting 2026-09-12 going back far enough to
be useful context; not a complete project history — see `git log` for that.

## Unreleased

- **Fix: galaxy crawl's agent-directory pass hammered SpaceTraders' real
  rate limit on every single attempt, continuously, for at least two
  days.** Found chasing an unrelated mystery — the new per-feed
  heartbeat (previous entries) itself went silent for 5-10 minutes at a
  time, and `FleetManager.tick()`'s new per-step timing instrumentation
  pinned it to `feeds.tick()` taking 400s+ in one pass. Neither was the
  real cause: `GalaxyCrawler.crawlAgents()` fetched every page of the
  galaxy-wide agent directory in a single unthrottled `for(;;)` loop,
  zero delay between requests — fine "on a fresh reset" when the
  directory was a page or two, but once it grows past a couple of pages
  (organic growth over the days since the last reset, no code involved)
  that burst alone blows straight through SpaceTraders' real per-IP
  ceiling (2 req/s) within its own loop. Worse: since a failed pass never
  set `agentsCrawlDone`, the hourly re-run gate never applied — it retried
  the *entire* unthrottled burst again on literally the next 5s tick,
  forever, with zero backoff and no way to recover on its own. Checked
  Render logs back to 2026-09-24: this had been failing continuously for
  at least two days, single-instance, unrelated to any redeploy or code
  change — just the agent count crossing whatever page count first
  exceeded the burst tolerance.
  Fix: `crawlAgentsPage()` replaces the loop with the same one-page-per-
  tick, resumable pattern `crawlSystemsPage()` already used safely at
  full galaxy scale (this crawler ticks every 5s — see `cli/index.ts` —
  so one page per tick is ~0.2 req/s regardless of how large the
  directory grows). A failed page just retries the same page next tick;
  already-accumulated pages aren't discarded.
- **Tower: set a feed's sell-gap ("spread") from the mobile UI, not just
  desktop.** Tower's feed panel (`more-feeds`) already had start/pause/
  resume/remove/crew-size, unlike `force` which stayed desktop-only —
  extended the same pattern to `sellGapMs`: a `gap Xm`/`gap default` tag
  on each feed card, a minutes input + "Set spread" button per card
  (`POST /api/feeds/sell-gap`, same endpoint desktop uses), and an
  optional gap field on the start-feed form so a fresh feed can set its
  spread at creation instead of reverting to the 5-minute default and
  needing a second call to fix it — exactly the gap in the workflow that
  came up live recreating the H56 feed earlier this session.
- **Full per-step timing instrumentation for the coordinator's tick() pass,
  after the feed heartbeat itself proved the stall wasn't feed-side.**
  The previous entry's heartbeat (logs at most once a minute,
  unconditionally, at the top of `FeedManager.step()`) went quiet for
  5-10 minutes at a time on its own — proving the problem isn't inside
  `feed.ts` at all, since that log sits upstream of every feed-specific
  code path. `feeds.tick()` is one call in a long serial chain inside
  `FleetManager.tick()` (`refreshCredits → ... → missions.tick() →
  feeds.tick() → ...`), so something *earlier* in that same chain
  occasionally blocking for minutes would stall everything after it in
  that pass — invisible everywhere else, since the ship-level Scheduler
  that drives mining/trading/etc. is a separate loop and stayed healthy
  throughout.
  Every step of `tick()` (both the paused/halted early-return and the
  full pass — every `await`, plus the synchronous calls like
  `dispatcher.recompute()`/`proposeOperatorHolds()`) is now wrapped in a
  new `timed()`/`timedSync()` helper that measures its own duration: any
  single step ≥1s (`STEP_WARN_MS`) logs immediately by name; if the whole
  pass totals ≥3s (`TICK_WARN_MS`), the full per-step breakdown — every
  step's name and ms, not just the slow one — is persisted to a new
  `tick_step_timings` table (migration 031) via `Store.recordSlowTick()`.
  Only slow passes are recorded (a tick fires every ~2s; logging all of
  them would be ~30 rows/minute/tenant of noise while healthy) — read
  back via `Store.recentSlowTicks()` or the new diagnostic
  `GET /api/tick-timings`. Root cause of the original stall still
  unconfirmed — this is what makes the next occurrence provable instead
  of inferred.
- **Feeder tiers: heartbeat + arrival logging, after an unexplained silent
  gap.** Live incident: a freshly-recreated H56 IRON_ORE feed sat at 0/3
  crew for ~9 minutes with zero log output — not even
  `pickFeedCarrier()`'s own throttled "no carrier" diagnostic, which
  should fire at least every 15s on a genuine failed pick. `feeds.tick()`
  runs every 2s from the coordinator loop, so a real failure-to-pick
  should have logged dozens of times; it logged none, and the scheduler's
  own heartbeat showed the fleet healthy (not starved) throughout, ruling
  out that as the cause. Root cause not yet identified — this ships two
  new log lines so it's provable next time instead of inferred from
  absence: a once-a-minute unconditional heartbeat at the top of
  `step()` (crew count, mine/force/gap settings) proving whether a feed
  is even being reached, and a `"... arrived with Nu, gap clear — selling
  now"` line symmetric with the existing `"... holding ... waiting"` log,
  so every arrival is visible whether the sell-gap held it or not — two
  ships arriving and each immediately selling within seconds of each
  other now shows up directly instead of only being inferable from
  suspiciously-close sell timestamps.
- **Feeder tiers: per-feed sell-pacing (spread sells out, not just cap
  volume) plus a one-time crew-join stagger.** Built from a live
  operator observation: H56's IRON_ORE price held up better across a
  quiet multi-hour gap in the ledger than the raw sold-volume for that
  window would predict, suggesting SpaceTraders' market price may
  recover between sells, not just react to cumulative recent volume
  regardless of timing (unverified against SpaceTraders' own docs — that
  text isn't published — so this ships as a testable bet, not an assumed
  fact). Two mechanisms, both in `FeedManager`:
  - **Sell-pacing gate** (the main mechanism): a feed now tracks the
    last successful sell into its `targetWaypoint`, shared across its
    whole crew. A carrier arriving with cargo, inside the gap since that
    last sell, just waits in place (already docked, cargo intact)
    instead of selling immediately — `DEFAULT_SELL_GAP_MS` (5 min)
    unless the feed sets its own `sellGapMs` (new, persisted, migration
    030). Per-feed rather than a global constant since the right gap is
    a live A/B question per route, same as `force`/`mine` already are.
    Skipped entirely when `feed.force` is set.
  - **Crew-join stagger**: a ship joining a feed's crew (auto-picked or
    operator-assigned) gets its first cycle offset by its join order
    (`STAGGER_STEP_MS` × slot, capped at `STAGGER_MAX_SLOTS`) instead of
    starting immediately — a one-time phase nudge so a batch of ships
    added together don't start their mine/buy→sell cycle in lockstep.
  UI: a `gap` tag on each feed row (desktop Ops → Feeder tiers), a
  minutes input + "Set sell gap" button per row, and an optional gap
  field on the start-feed form; `POST /api/feeds/sell-gap` under the
  hood. Tower's feed panel stays read-only, same as `force` before it.
- **Feeder tiers: margin-gated buying, replacing the drift check that
  never actually worked.** The old guard (`MAX_FEED_BUY_INFLATION`)
  compared each cycle's buy price against a "base price" that got reset
  to the current price every single cycle — it could never see
  cumulative drift, which is exactly how THEO-6's H56→F50 IRON feed
  climbed 90c→240c+ over nine buys without ever tripping it (see the
  two urgent fixes below, found investigating the same incident). Every
  buy now checks live profitability instead: the source price against
  the destination's current sell price (`FleetManager.sellPriceAt()`,
  new), gated by `MIN_FEED_MARGIN_PCT` (10%). No margin → the feed waits
  and rechecks every 15s rather than buying regardless, and — since it
  doesn't reset `t.market` the way the old guard did — it keeps
  watching the *same* market for recovery instead of pointlessly
  re-shopping to one that's already known to be worse.
  New per-feed `force` flag (persisted, migration 029) skips the gate
  entirely for an operator who wants a route run through regardless —
  a contract deadline, or just wanting the good moving now. Toggle from
  the Ops Feeder-tiers panel (`Force`/`Unforce` button on each feed
  row) or at creation (`force (ignore margin)` checkbox); `POST
  /api/feeds/force` under the hood. Tower's feed panel stays read-only
  for now — deliberately out of scope this pass, desktop covers it.
- **Fix (live incident): a mine-feed's hold could clog with the
  asteroid's other deposits and never clear.** `held` (stepCarrier()'s
  "am I already carrying the target good" check) only counts units of
  `feed.good` — a hold that's completely full of the asteroid's *other*
  ore types reads as "empty-handed" and falls into the mine branch, but
  `mineOnce()` has no free cargo slots to extract into and silently
  no-ops every call while still reporting success. Confirmed live:
  THEO-27/THEO-29/THEO-2C (the H56 IRON_ORE feed's crew) sat full of
  COPPER_ORE/ALUMINUM_ORE/SILICON_CRYSTALS — zero IRON_ORE — for 48+
  minutes, re-logging "mining at .../using survey at ..." every cycle
  with nothing ever extracted or delivered. This is *why* H56's price
  never moved during the whole earlier "do we need more miners or a
  refinery" discussion — not a market-mechanics answer, a feed that had
  silently stopped delivering entirely. The mine branch now clears a
  full-but-wrong-good hold before mining, same as the buy branch already
  does before buying.
- **Fix (urgent, live incident): a feed could buy from its own sell
  target, looping in place and burning cash every cycle.** THEO-6's IRON
  feed (H56 → F50, no `buyAt` pin) drove F50's own buy price down through
  its own selling until F50 became the system's cheapest known IRON
  market — at which point the next cycle's "buy cheapest known market"
  auto-pick selected F50 itself. The ship never traveled: buy 60u at F50
  for 13,560c, immediately sell the same 60u back into F50 for 6,780c,
  repeat — a straight -6,780c every ~90 seconds, dozens of consecutive
  cycles, confirmed live in the ledger. The cheapest-known-market pick
  now excludes the feed's own `targetWaypoint`. This doesn't fix the
  separate, already-known issue of H56 itself inflating from repeated
  buying (still being designed — see the operator/engineering
  conversation this session) but it stops the much faster in-place loop.
- **Tower: moved the Activity feed from the bottom of the More tab to
  Home.** Operator report: "the other UIs have an activity feed where I
  can see buys and sells as they go by" — Tower already had one, but it
  was the last of ten sections on a long More-tab scroll, easy to miss
  entirely, and the operator explicitly didn't want it added back there
  ("there's too much stuff already"). Home already polls continuously (the
  one screen that's always live), so Activity now lives there instead,
  right under the triage list — `loadActivity()` moved off the
  More-tab-only loaders to fire on every boot/poll tick, same as bridge/
  approvals/dispatch.
- **Fix: Tower's Fleet screen never actually loaded the data its own new
  feed/mission/contract claim display needs.** `claimFor()`/`fleetRows()`
  (added same day, see the entry below) read `feeds`/`missions`/`contracts`
  from the shared store, but `loadProgramme()` — the only thing that
  populates them — was wired to fire on the More tab only, never on Fleet
  and never at boot. Confirmed live: THEO-6's card showed no feed claim at
  all on a fresh Fleet-tab visit, because the arrays were still empty.
  `setTab("fleet")` and the 15s poll now both call `loadProgramme()` too.
- **Fleet tab/Tower now show a feed/chain, mission, or contract claim for
  any ship, not just traders.** `jobFor()` (v6.js) and `claimFor()`/
  `jobLabel()` (m.js) previously only ever computed a "signed to" label
  for `role === "trader"` — every other role's Job column read "—" even
  when a mission or feed had actually claimed it, which was exactly the
  live confusion behind today's stuck-miners investigation (a miner
  holding contract-protected IRON_ORE with nothing on screen explaining
  why). Now checks, in order: a feed/chain claim (`feeds`'s own
  `assignedShips`, showing the chain name when one applies), a mission
  claim (`missions`'s `assignedShips`, naming the outstanding material),
  the existing trader-only dispatch assignment, and — lowest priority,
  informational — cargo the ship happens to be holding that an active,
  non-abandoned contract still wants. The Automation feed's
  `describeAutomation()` picks up the same claim ahead of its old
  role-specific fallback text ("autonomous — picks its own field each
  cycle" no longer says that about a ship a feed has actually pinned).
- **Add: `POST /api/miner-preference` now logs to `operator_actions`** (kind
  `miner_preference`), same as `/fleet/role` already does for role changes.
  Found as a dead end while investigating the IRON_ORE-stuck-miners
  incident below: the operator's account of having set a mining preference
  on specific ships days earlier had nothing to check it against —
  `setMinerPreference()` persists to a single `fleet_flags` JSON blob that
  gets deleted outright once the last preference is cleared, and neither
  it nor its HTTP route ever wrote an audit row. Now every set/clear is a
  permanent, queryable row, regardless of what the current live state is.
- **Fix: an operator-abandoned contract's goods stayed protected forever,
  with no way to ever clear a hold that picked them up.** THEO-27/THEO-29
  (plain auto-miners, no custom route or mission involved) sat with full
  holds of IRON_ORE indefinitely, silently re-picking a survey and doing
  nothing every tick. Root cause, confirmed via a persisted
  `contractOperatorState` fleet flag: an IRON_ORE procurement contract had
  been abandoned by the operator on 2026-09-20 ("stop sourcing this," per
  `ContractManager.abandon()`'s own doc comment), but
  `ContractManager.protectedGoods()` never checked the `abandoned` set the
  way `outstandingDeliveries()`/`deliverVia()` already did — so IRON_ORE
  stayed in `allProtectedGoods()` forever (no sell, no jettison) while
  `deliverVia()` correctly refused to route it anywhere (no active
  delivery to route to). Two checks that individually made sense
  disagreed about one contract, and any ship that incidentally mined the
  now-undeliverable-but-still-protected good got stuck with no exit.
  `protectedGoods()` now skips abandoned contracts too, same as
  `outstandingDeliveries()` — the stuck miners' next sell-cargo step
  should reclaim the ore automatically, no manual jettison needed.
- **Fix: `MissionManager`/`FeedManager` buy and sell never reached the
  ledger.** Both called `this.api.purchaseCargo()`/`sellCargo()` directly on
  the raw SpaceTraders client, bypassing `recordLedger` (and, for buys, the
  activity feed) entirely — a whole category of real spend was invisible to
  ledger-based reconciliation, discoverable only via ephemeral Render logs.
  Found while tracing a ~330,000c balance drop for the operator: a mission's
  material purchases and a feed's buy/sell legs left no ledger trail at all.
  Both managers now take a `recordLedger` option (same shape as
  trader.ts/siphoner.ts/scout.ts/agent.ts already use), wired from
  `FleetManager`'s own `this.recordLedger`; feed/mission buys also now fire
  `onActivity("buy", ...)` for parity with every other buy path in the fleet.
- **Confirmed, separately: a feed reassignment jettisoning a ship's existing
  cargo is a real, verified loss, not a bug in the reassignment logic
  itself.** THEO-6 bought 60u EQUIPMENT (192,140c) at 01:51, was reassigned
  to a feed at 01:55, and `clearUnrelatedCargo()` tried to sell the
  EQUIPMENT at the feed's location before jettisoning it — the sell failed
  (no market there buys EQUIPMENT) and it fell back to jettison at 02:07,
  logged (`THEO-6 jettisoned 60u EQUIPMENT`) but with zero credits
  recovered. `clearUnrelatedCargo()`'s sell-then-jettison fallback (already
  fixed for both managers back on 2026-09-10, commit b064034) is working as
  designed; the loss here is the ordinary risk of reassigning a ship whose
  hold isn't sellable at its current location, not a new defect.
- **Fix: `FleetManager.sellCargo()` recorded a real sale to the ledger and
  activity feed but never printed a log line — the only sell path in the
  codebase with that gap.** Confirmed live 2026-09-25 answering an
  operator's "where did my money go": THEO-6 bought 60u EQUIPMENT
  (~192,140c) on a normal trade route, then got commandeered as a feeder
  carrier before selling it — `clearUnrelatedCargo()` (shared by
  FeedManager/MissionManager, used to free a newly-commandeered ship's
  hold) called this method to sell the EQUIPMENT off, which genuinely
  worked and genuinely recovered credits, but produced zero trace in the
  Render log stream. Every other sell path (trader.ts's own sells,
  feed.ts/mission.ts's direct `api.sellCargo()` calls) already logs
  itself; an operator grepping logs for "sold" to reconcile a large
  balance drop found every sale except this one. Added the missing log
  line, same format as the others.

- **Fix: starting a feeder chain from tiers that were already running as
  standalone feeds silently did nothing to those tiers, while still
  reporting success.** Confirmed live 2026-09-25: operator started three
  standalone feeds (IRON_ORE→H56, IRON→F50, ELECTRONICS→D40), then built a
  chain from those same three tiers — `startChain()`'s own "chain started"
  log fired, but `FeedManager.start()` had an unconditional
  `if (this.active.has(key)) return;` for a feed already running under that
  (market, good) key, so none of the three tiers actually received the new
  `chainId`/`buyAt`. The chain didn't show up in the UI because, in the
  data, it didn't actually exist — no tier carried its id. Fixed by having
  `start()` **adopt** an already-running feed into the chain (apply the new
  `chainId`/`chainName`/`chainOrder`/`buyAt`/`mine` and force its carrier(s)
  to re-pick their source next tick) instead of no-op'ing, whenever the
  call is specifically a chain start (`opts.chainId` set); an ordinary
  repeated `startFeed()` call on an already-running feed is still the
  harmless no-op it always was.

- **Add: feeder chains — connected feeder tiers where each one buys where
  the previous one sold, instead of each independently re-deriving
  "cheapest known market" and possibly drifting to an unconnected one.**
  Operator feedback on the standalone feeder-tier feature: "when we make a
  chain like this, they shouldn't be separate, I want the next step to buy
  where the previous step sold." A chain (e.g. ore→H56→F50→D40) is several
  `Feed`s sharing a `chainId` (`FeedManager.startChain()`), with every tier
  after the first getting its new `buyAt` pin (see below) set automatically
  to the previous tier's own `targetWaypoint` — no separate persisted
  entity, just grouping metadata (`chain_id`/`chain_name`/`chain_order`,
  migration `028`) on the same `feed_missions` rows. Several chains can run
  at once, each toggled independently (`pauseChain`/`resumeChain` pause/
  resume every member tier as one unit; `removeChain` stops and forgets the
  whole thing). New routes: `GET /api/feed-chains`, `POST /api/feed-chains/
  {start,pause,resume,remove}`. New "Feeder chains" panel in desktop
  (`v6.js`/`v6.html`, Ops tab) with a dynamic tier-row builder (add/remove
  tiers, each with its own good/market/mine); Tower (`m.js`/`m.html`) gets
  a read-only view + on/off toggle for now — building a new chain stays a
  desktop action, noted on the Tower panel itself. A chain's tiers are
  still plain `Feed`s underneath, so they also show up in the existing
  "Feeder tiers" panel (now showing a "chain: `<name>`" badge) with full
  per-tier crew controls — the chain panel is only for building/toggling
  the chain as a whole.
  Also added the underlying **`Feed.buyAt` pin**: a feed's source market
  can now be fixed explicitly instead of always auto-picking the system's
  cheapest known seller — the piece a chain tier actually relies on, also
  usable standalone via `startFeed`'s new `buyAt` param.

- **Fix: feeder tiers could only ever source by buying at a market — a
  feed for a mined good (raw ore, the actual bottom tier of the
  ore→refinery chain the feature was built for) would sit stuck logging
  "no source found" forever, since nothing sells raw ore.** Added an
  explicit "mine instead of buy" checkbox per feed (`Feed.mine`, new
  `feed_missions.mine` column, migration `027`) — deliberately a manual
  operator choice, not auto-detected from "has no market seller", since
  that heuristic is unreliable and the operator already knows which is
  which. When set, sourcing skips the market lookup entirely and calls a
  new `ShipAgent.mineOnce()` (`src/engine/agent.ts`, factored out of
  `tick()`'s own step-4 mining logic so it's reusable outside the normal
  survival loop) — the crew must be drawn from the miners pool specifically
  (`pickCarrier`'s new `requireMiner` flag), since a trader has no mining
  mount and would just spin. Also fixed the auto-crew gate, which checked
  for a known market buyer before ever assigning a carrier — always false
  for a mine feed, so it would never staff up at all without this.

- **Add: feeder tiers — a dedicated crew that continuously buys a good
  cheap and sells it into one specific upstream market, to keep that
  market's price from spiking under a buyer's own repeated purchasing
  pressure.** New, deliberately separate `FeedManager`
  (`src/engine/feed.ts`) and `feed_missions` table (migration `026`) — not
  a `Mission` kind, kept apart per operator request: a feed has no
  construction site or required/fulfilled materials to track and never
  "completes" the way a mission does, it just runs until the operator
  turns it off. Same crew shape as the multi-carrier mission work below
  (`assignedShips`/`carrierTarget`, one independent buy→sell `TaskState`
  per crew ship, throttled auto-ramp toward the crew target) and its own
  `ship_claims` owner (`"feed"`, ranked with `mission`/`rescue`/`repair` —
  see `shipRegistry.ts`'s own comment on why it isn't just reused
  `"mission"`). New routes: `GET /api/feeds`, `POST /api/feeds/start`,
  `/pause`, `/resume` (the ON/OFF toggle), `/remove` (stop and forget, vs.
  pause's "keep to resume later"), `/assign`, `/remove-carrier`,
  `/carrier-target`. New "Feeder tiers" panel in desktop (`v6.js`/
  `v6.html`, in Ops next to Construction missions) and Tower (`m.js`/
  `m.html`, in More) — start form, crew list with per-ship remove, crew-
  size input, and the on/off toggle. This is the first concrete piece of
  the operator's "protocol" ask (see `docs/TODO.md`): manually starting a
  feed for each tier of a chain (e.g. X1-SN30's H56→F50→D40 ahead of the
  ADVANCED_CIRCUITRY bottleneck at I60) is possible today; auto-deriving
  the whole chain from one construction site is the remaining piece,
  tracked in `docs/TODO.md`.

- **Add: multi-carrier construction missions — a site can now be staffed by
  more than one ship at once.** `Mission.assignedShip` (a single string)
  was the hard architectural limit blocking parallel buyers on a
  bottleneck material (e.g. ADVANCED_CIRCUITRY at a jump gate, where one
  carrier alone can't hit a same-day build). Replaced with
  `assignedShips: string[]` + `carrierTarget: number`; `MissionManager`
  now runs each crew member's own independent source→buy→supply
  `TaskState` per tick, auto-ramps the crew toward `carrierTarget` one
  ship per tick (same throttled pattern the old single-carrier auto-pick
  used), and exposes `removeCarrier()`/`setCarrierTarget()` alongside the
  existing `assignCarrier()` (which now *adds* to the crew instead of
  replacing it). `store.ts`/migration `025_mission_multi_carrier.sql`
  persists the new `assigned_ships`/`carrier_target` columns (dropped the
  old singular `assigned_ship` column). New routes
  `POST /api/missions/remove-carrier` and `POST /api/missions/carrier-target`.
  Desktop (`v6.js`) and Tower (`m.js`)'s Construction missions panels
  updated to show the crew and a crew-size control.
  **Known gap**: `v2.js`–`v5.js` and `deck.js` still read the old
  `m.assignedShip` field in their own mission panels, which is now always
  `undefined` — those panels will show "no carrier yet" even when a crew
  is assigned, until they're ported to `assignedShips` too (see
  `docs/TODO.md`). Assigning still works from any of them (the API
  route is unchanged), only the carrier display regresses.
  This is groundwork for the "protocol" work described in
  `CLAUDE.md`/`docs/TODO.md` — an auto-derived, toggleable feeder chain
  (ore → refinery → intermediate → construction site) for speed-running a
  future gate build; the chain-proposer and the ON/OFF UI are not built
  yet, this lands the engine layer they depend on.

- **Fix: Deck (`/deck`) Overview's "Home system" mini-map rendered every
  marker at zero size, so the panel looked blank.** `renderMinimap()`
  emitted a nested `<span class="mk planet">` marker inside each `.blip`,
  but `deck.css` (copied verbatim from the design spec's own stylesheet)
  only defines `.blip.planet`/`.blip.market`/`.blip.gate`/`.blip.ship…` —
  there is no `.mk` rule anywhere in Deck's CSS. Every waypoint and ship
  therefore drew a 0×0 element and the chart appeared empty even though
  `state.systems` was populated and the "N waypoints" count was correct.
  A pre-existing bug from the original Overview pass, not from the Pass
  A–D work. Fixed by putting the marker classes directly on the `.blip`
  div — the same shape `renderMap()` already uses and the same rules
  `deck.css` already has. Live verification pending.

- **Add: Deck (`/deck`) Doctrine enable/disable toggles — Pass D of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Doctrine
  screen rendered Standing Orders read-only, so an operator could see which
  rules were on but couldn't flip one without leaving Deck. Ported Tower's
  toggle control and handler (`m.js`'s `renderMoreDoctrine()` + its click
  listener): each rule row gets a `.sw` switch whose `aria-pressed`
  reflects `rule.enabled`, and clicking it calls
  `POST /api/doctrine { key, enabled: !currentlyEnabled }` then re-fetches
  via `loadDoctrine()`. Deck's existing list rendering is kept — only the
  toggle was added, per the plan. Also added a `"doctrine"` subscription
  (there was none) so the store's own `notify("doctrine")` re-renders the
  screen, matching how every other slice is wired. No backend change.
  Live verification pending (no DB/token in the build environment).

- **Add: Deck (`/deck`) Map galaxy data — Pass C of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Map
  screen had only a top-3 leaderboard snippet; this adds the two panels
  the plan called for, without adding a seventh rail item (the design call
  already made for this repo is to extend Map's right-hand panel rather
  than add a Galaxy tab). Ported `v6.js`'s `renderFactions()` and
  `renderSystemAgents()` directly. The System Agents panel preserves the
  running-tally logic exactly: history is grouped by `agentSymbol`, and a
  signed delta is shown only when there are **2+** points (a single point
  is not a trend), colored green/red/dim, with the tenant's own agent
  marked `· you`. **No backend work** — `GET /api/agents-in-system/history`
  and the durable `agent_credit_snapshots` series were already built this
  session; `loadGalaxy()` already fetched all four endpoints in one call,
  so Deck just had to import `factions`/`systemAgents`/`systemAgentsHistory`
  from the existing store import and render them. Live verification
  pending (no DB/token in the build environment).

- **Add: Deck (`/deck`) Markets write toolbars — Pass B of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** Deck's Markets
  screen already *showed* warehouse and dispatch data read-only; this makes
  those panels write. Ported the exact working implementation from
  `public/v6.js` (`dispatchAssign`/`dispatchClear`/`warehouseDesignate`/
  `warehouseRelease`) — same endpoints, same body shapes. Dispatch toolbar:
  a trader ship picker, a good picker (distinct `dispatchRoutes[].good`),
  an **Assign** button (`POST /api/dispatch` with the route's buy/sell
  fields) and an **Auto** button (`{ shipSymbol, clear: true }`). Warehouse
  toolbar: a ship picker (holds ≥20), a waypoint input, **Designate**
  (`POST /api/warehouse/designate`) and **Release**
  (`POST /api/warehouse/release`). Reused the `.field-select`/`.field-input`
  classes Pass A added. The selects repopulate on every poll but preserve
  the operator's current choice, the same discipline `v6.js`'s
  `renderDispatch()`/`renderWarehouse()` already follow — a 15s refresh
  must not yank a selection back to the first option mid-interaction.
  No backend change. The plan's lower-priority items within this pass were
  also built in the same commit: warehouse manual **Adjust**
  (`POST /api/warehouse/adjust`), curated **sell-targets** add/remove
  (`POST /api/warehouse/targets` + `/targets/remove`, each removable
  inline from the warehouse panel), and a **Keeper stations** panel
  (`POST /api/keeper/markets` — save the line list, the cover-full-list
  toggle, and reset-to-defaults). The keeper textarea is only re-seeded
  from the store when it isn't focused, so a 15s poll can't wipe a
  half-typed list. Live verification pending (no DB/token in the build
  environment).

- **Add: Deck (`/deck`) Fleet ship-action sheet — Pass A of
  `docs/deck-remaining-build-plan.md`, built 2026-09-20.** The single
  largest functional gap in Deck was that an operator could *see* every
  ship on the Fleet screen but not act on one. Ported the shape of Tower's
  already-working action sheet (`public/m.js`'s `renderSheet()` and its
  `#sheet-actions` handler) rather than redesigning it: send-to-waypoint,
  Hold/Release, Dock/Undock (disabled mid-transit, matching the route's own
  guard), Assign route (top-4 by `profitPerTrip`), Repair, Sell/Scrap
  (confirm-gated), Change role (with the `roleMismatchReason()` mismatch
  warning and the keeper-market input shown only for `keeper`), and Full
  details (per-item Jettison, module/mount Remove, install-from-cargo).
  **No new backend route and no new `Store`/`FleetManager` method** — every
  action already had a working endpoint in `src/http/dashboard.ts`; that
  file was not touched. Added two reusable form classes (`.field-select`,
  `.field-input`) to `deck.css` so later passes don't re-invent the same
  inline style a third time. One deliberate deviation from the plan's §1c
  ("wire a listener on `#fleet-detail-actions`"): the buttons are created
  inside `renderFleet()`'s `innerHTML` assignment, so a statically-declared
  container in `deck.html` would be wiped on every render; the two
  delegated listeners instead bind to the stable `#fleet-detail-body`
  parent, which is the same one-handler-keyed-off-`data-act` pattern.
  Live verification pending (no DB/token in the build environment) — the
  operator will confirm the buttons work end-to-end after deploy.

- **Add: Deck (`/deck`), the desktop redesign — Overview pass built
  2026-09-19.** `docs/deck-desktop-design.md` was written as a mechanical,
  step-by-step build spec (full CSS and HTML copied verbatim, exact data
  bindings checked against real code) specifically to be built without
  needing design judgment calls. First pass: `/deck` route + shell + Overview
  screen only (KPI row, Wants-vs-Doing triage table, live Approvals/Activity
  signal rail), reusing `public/shared/*.js` patterns verbatim — no new
  backend routes, no new `Store`/`FleetManager` methods, same
  `loadState`/`loadBridge`/`loadApprovals`/`loadDispatch`/`loadActivity`
  polling as Tower. Fleet/Markets/Map/Ops/Doctrine and the ⌘K command
  palette are later passes, not this one. The ⌘K hint renders inert. Shell
  nav items for future screens show "coming soon" placeholders. Live
  verification pending — the operator will confirm Overview works end-to-end
  after deployment, same pattern Tower's own first pass followed.

- **Fix: a hold targeting a waypoint 2+ hops away retried an impossible
  direct jump forever.** `ShipProxy.runHoldGoal()`'s cross-system branch
  (`jumpTo`, wired to `FleetManager.jumpShip()`) passed the hold's *final*
  target waypoint straight to a single-direct-gate-only jump primitive —
  correct for an adjacent system, permanently broken for anything farther,
  since `jumpShip()` throws "not connected" and there was no multi-hop
  fallback. Confirmed live via the new MCP tools: an agent held THEO-13 at
  a waypoint 2 hops away and it retried the identical doomed jump every
  tick forever ("Failed to execute jump ... is not connected to the
  current location") — the exact failure class `advanceTourDispatch()`
  (a tour ship's own multi-hop dispatch) already existed to prevent, for
  a caller that never got the fix. Factored `advanceTourDispatch()`'s
  hop-by-hop walk into a shared `hopToward()`, and added `jumpToward()` —
  now every `jumpTo` wiring (13 sites, every scheduler-driven role) takes
  one hop at a time toward the target and lets the next tick take the
  next, instead of one all-or-nothing direct jump. This bug predates the
  MCP server (`sendShipTo()`'s own cross-system dispatch had the same
  gap) — the MCP tools just made it easy to hit by dispatching a ship
  somewhere a human operator would normally reach via tour-dispatch
  instead.

- **Add: trading/pricing intel tools to `/mcp`** — `stcommand_get_goods`
  (every observed TradeSymbol, for resolving a plain-language good name),
  `stcommand_get_best_price` (cheapest-to-buy and best-to-sell locations
  for a good, scoped to this tenant's own charted systems and the same
  freshness window the dashboard's Markets tab uses — never another
  tenant's unexplored markets, even though `market_latest` is shared
  server-wide), `stcommand_get_price_trend` (per-minute avg/min/max sell
  price over a time window, via the existing `goodPriceHistory()`), and
  `stcommand_get_shipyard_inventory` (every observed ship type/price per
  shipyard, filterable by system or ship type). All four reuse the exact
  Store/FleetManager methods `dashboard.ts`'s own `/markets`/`/prices`/
  `/goods` routes already call — no separate query logic. 20 tools total
  now (10 read-only, 10 write).

- **Fix: `/mcp` rejected a bare API key, requiring the literal `Bearer `
  prefix — confirmed live, broke a real setup.** A `.mcp.json` committed
  to the repo by another session interpolates
  `Authorization:${STCOMMAND_MCP_TOKEN}` from an env var holding just the
  raw `sctk_...` key, no `"Bearer "` anywhere — a natural, easy-to-hit
  config shape, not a malformed request. `createMcpAuth` now accepts
  either `Bearer <key>` or the bare key directly; `sctk_`-prefixed keys
  are never ambiguous with another auth scheme, so nothing is lost by
  also accepting them unprefixed.

- **Add: a hosted MCP server (`/mcp`), first pass — an agent can now take
  real fleet actions instead of an operator relaying them by hand.**
  Per `docs/mcp-server-plan.md`: per-tenant Bearer-key auth (new
  `tenant_mcp_keys` table + `hashApiKey()` in `src/auth/crypto.ts`,
  minted/revoked from the dashboard's Book-mode settings panel via
  `GET/POST /api/mcp-keys`, `POST /api/mcp-keys/:id/revoke` — the raw key
  is shown exactly once, at mint time, same as a GitHub PAT), mounted at
  `/mcp` ahead of the cookie-based `resolveTenant` (same position
  `/api/admin` occupies). Stateless Streamable HTTP
  (`@modelcontextprotocol/sdk`) — a fresh `McpServer` per request, nothing
  held across restarts.
  16 tools: 6 read-only (`stcommand_get_state`, `_fleet_status`,
  `_approvals`, `_doctrine`, `_activity`, `_ship_state`) and 10 write
  (`stcommand_dispatch_ship`, `_hold_ship`, `_release_ship`, `_jump_ship`,
  `_dispatch_tour`, `_set_ship_role`, `_dock_toggle`, `_refuel_ship`,
  `_buy_ship`, `_decide_approval`) — covering everything this session's
  own live-ops work on THEO-1C actually needed. Every write tool calls
  the *exact* `FleetManager` method the matching dashboard route already
  calls (`sendShipTo`/`manualJumpShip`/`dispatchTourShip`/etc.) — the
  design doc's own load-bearing constraint, given today's earlier fixes
  were all bugs from exactly that kind of divergence between manual-
  action paths. Every write tool call is also logged to the existing
  `operator_actions` table with a `mcp_`-prefixed kind and
  `meta.source: "mcp"`, so a later investigation can tell an agent's
  action from a dashboard click.
  Not yet built (tracked in `src/mcp/tools.ts`'s own trailing comment and
  `docs/TODO.md`): `stcommand_get_bridge`/`_markets`/`_galaxy_overview`
  (each composes several store calls the way their dashboard handlers do
  — worth factoring that composition out of `dashboard.ts` first), the
  missions/contracts/warehouse/doctrine write tools, and the
  confirm-flag requirement on destructive actions
  (scrap/sell-ship/abandon-contract/pause-fleet) once those are added.

- **Fix: `autoExplore()`'s idle check didn't know about a `dispatchTourShip()`
  destination, so a ship on a real, operator-directed multi-system tour
  trip kept getting offered up for the `autoExploreBorrow` approval gate
  (see below) at every docked stop along the way.** `dispatchTourShip()` —
  the Fleet tab's "send this tour ship to system X" control — only ever
  sets `tourDestination`; unlike `sendShipTo()`/`manualJumpShip()` it never
  calls into `isHeld()`/`operatorHolds`, so a ship mid-dispatch read as
  "idle" (not held, cargo empty, not mid-transit) every time it paused
  between hops. Confirmed live: an operator dispatched THEO-1C on a real
  7-hop trip toward X1-TX45 and had to deny an `autoExploreBorrow` request
  roughly once per stop, ~every 15-25 minutes, for a ship that was
  actively mid-mission the whole time. `autoExplore()`'s eligibility
  filter now also excludes any ship with a live `tourDestination`.

- **Fix: the Navigate tab's manual "jump" control never registered as an
  operator action at all.** Turned out to be the real culprit behind the
  `tourDestination` bug below, not the plain dispatch control: `/fleet/jump`
  called `FleetManager.jumpShip()` — a bare navigation primitive — directly.
  Confirmed live: an operator jumped THEO-1C to X1-TX45 from its Navigate
  tab; the jump itself succeeded, but nothing claimed ownership, set a
  hold, or cleared its stale `tourDestination`, so the very next
  `tourScout()` tick picked the old automatic destination back up as if
  the manual action had never happened — the ship landed in the operator's
  chosen system for one tick, then kept walking on its own schedule.
  `jumpShip()` itself has to stay a bare primitive (it's also how
  `advanceTourDestination()` performs each hop of an automatic multi-hop
  tour trip — giving it hold/ownership side effects would make that walk
  self-cancel after one hop). Added `manualJumpShip()`, a thin wrapper used
  only by the dashboard's `/fleet/jump` route, that claims operator
  ownership and clears `tourDestination` after the jump — same pattern
  `sendShipTo()` already uses for the plain dispatch control.

- **Fix: `sendShipTo()`/`holdShip()` (the manual dispatch/hold controls)
  never cleared a leftover `dispatchTourShip()` destination.** Confirmed
  live, same THEO-1C: a deploy restart restored a stale `tourDestination`
  (X1-YG81) from an unrelated earlier trip; the operator then dispatched
  THEO-1C to X1-TX45 via the dashboard's plain dispatch control, which
  correctly held it at the target waypoint — but `tourDestination` was a
  separate persisted field the hold never touched, so `tourScout()`'s
  `advanceTourDestination()` picked the stale goal back up on its very
  next tick and walked the ship straight through the operator's hold
  toward X1-YG81. `sendShipTo()`/`holdShip()` now clear `tourDestination`
  in the same `updateShipManualState()` call that sets the hold, so a
  manual dispatch always wins over a standing automatic tour plan instead
  of just outrunning it for one tick.

- **`autoExplore()`'s opportunistic borrow of an idle tour/scout ship now
  requires operator approval, same gate as a ship purchase.** This path
  (`FleetManager.autoExplore()`) pulls any idle tour or chart-scout ship —
  cargo empty, not held, not mid-transit — onto a multi-minute jump trip to
  an unsurveyed connected system, entirely separately from the dedicated
  `explorer` role. Confirmed live: an operator-dispatched tour ship
  (THEO-1C, sent to look around COSMIC's home system, X1-TX45) got
  borrowed into an explore trip to X1-QB86 within a minute of finishing
  its survey pass and going idle — invisible from outside since the
  ship's role never changed from `tour`, so there was no way to tell it
  was about to leave. Now gated behind `ApprovalGate.request("autoExploreBorrow", ...)`,
  same one-request-at-a-time-fleet-wide pattern as `buyScout`/
  `buyKeeperProbe` (2h timeout, auto-approves if nobody's watching —
  preserves today's fully-automatic behavior for an unattended fleet,
  while giving an operator who's actually looking a chance to say no).

- **Galaxy map: hover tooltip for system glyphs, and a declutter pass for
  crowded local clusters.** The galaxy-mode overview (`renderGalaxy3D()`,
  `v6.js`) previously gave a system glyph no feedback at all until you
  clicked it (which immediately drops you into that system) — there was
  no way to check a system's stats without navigating away first. Hovering
  a glyph now shows the same `#map-tip` panel the per-system waypoint view
  already uses, with type, home/marketplace/shipyard/jump-gate tags, and
  ship count. Separately, real galaxy coordinates cluster tightly in
  places (confirmed live — dense charted neighborhoods drew as an
  unreadable knot of overlapping rings); added `declutterGlyphPositions()`,
  a light pairwise-repulsion pass that nudges only still-overlapping glyph
  pairs apart after scaling, leaving isolated systems untouched.

- **Fix: the role-change warning claimed a non-probe keeper "won't be able
  to do this role's job" — it will, just less efficiently than a probe.**
  `roleMismatchReason()`'s keeper case only flags a hull mismatch because
  `FleetManager.setShipRole()` places no actual restriction on it — any
  ship reassigned to keeper flies itself to its assigned market and docks
  there via the same `navigateTo()` every other role uses
  (`keeperPoll()`, `agent.ts`). Only a probe/satellite is special-cased
  elsewhere (bought directly at the target waypoint, since it has no fuel
  and can never move itself there) — a mobile hull works fine as a
  keeper, it just spends fuel a probe wouldn't. The warning now says so
  instead of implying the assignment won't work: rewrote it as a
  self-contained per-role message (desktop and Tower both stop appending
  a generic "won't be able to do this role's job" suffix that was simply
  wrong for this one case).

- **Fix (best-diagnosis, unconfirmed on-device): Tower's per-location
  shipyard/route picker rows didn't respond to a tap at all on iPhone,
  even after the poll-rebuild fix above.** Live report: the picker opens
  fine (its toggle button works reliably) but tapping a row inside it did
  nothing — confirmed working from a desktop browser via the equivalent
  `.buy-ship-alt` buttons, so this is mobile-Safari-specific, not a
  server or logic bug. The one concrete difference found between the
  toggle button (works) and the picker's row buttons (don't) in the same
  delegated-click container: the toggle has `cursor: pointer` set inline,
  the row buttons had no `cursor` at all — a known class of iOS Safari
  issue where a delegated `click` (handled by an ancestor's listener
  rather than the element's own) doesn't fire reliably on an element with
  no `cursor: pointer`/interactive CSS signal. `.ship-pick button` now
  sets `cursor: pointer`, `touch-action: manipulation`, and an explicit
  tap-highlight color. This is a plausible fix based on the available
  evidence, not one confirmed against a real device in this sandbox —
  flagged honestly, needs the operator to confirm it actually resolves
  the tap.

- **Fix: Tower's new per-location shipyard/route pickers could buy at (or
  assign) the wrong location — tapping a specific "also" shipyard bought
  at the cheapest one instead.** Same root cause as the ship-detail-panel
  fix earlier this session, one tab over: Tower's Markets tab polls every
  15s (`loadMarkets()` → the `subscribe("markets", ...)` path), and
  `renderMarkets()` unconditionally rebuilds both the routes list and the
  yards list on every poll — including whichever picker the operator just
  opened. A tap that straddles that rebuild can land on whatever element
  ends up at the same screen position afterward, not the one that was
  there when the tap started; live report matched exactly ("clicked the
  row I wanted, but nothing happened" / bought at the home system
  instead). `renderMarkets()` now skips rebuilding a list while its
  picker is open (`openRouteGood`/`openYardGroup`); each toggle handler
  still calls its own render function directly, so opening/closing a
  picker is unaffected — only the periodic path is guarded.

- **Add: a tour ship that finds an uncovered shipyard now holds there,
  docked, until its own keeper-probe approval is decided.** Operator
  requirement, prompted directly by the two live keeper-probe-approval
  races fixed earlier this session: touring on before the operator (or
  the timeout policy) decides just reopens the same "is a ship really
  still there" gap those fixes closed reactively. `tourScout()` now
  checks a new `hasPendingKeeperApproval` callback right after recording
  a shipyard's stock — if a `buyKeeperProbe` request for exactly this
  waypoint is still open (raised just now, or found already open on a
  revisit), it holds instead of picking its next stop. Closes on its
  own once the request is decided (approved, denied, or auto-decided by
  the timeout) — never an indefinite hold. Two new tests in
  `tests/tourScout.test.ts`.

- **Add: manual Dock/Undock to Tower's ship-action sheet.** Desktop has
  had this for a while (`.dock-toggle`, hitting the existing
  `/api/fleet/dock` toggle endpoint), but Tower's sheet never got a
  button wired to it. Same endpoint, same label logic (reads current
  `nav.status`, disabled with an explanatory title while in transit
  rather than hidden).

- **Fix: approving a "buy keeper probe" request could still fail even
  when the confirming ship was genuinely, currently at the yard — just
  in orbit rather than docked.** Follow-up to this session's earlier
  keeper-probe-approval fix (which closed the *stale-cache* version of
  this failure) — a second, separate live report showed the same
  underlying requirement biting a different way: `purchaseShip()` only
  grants access to a docked ship (orbit is navigate/extract only), and
  `resolvePendingKeeperProbeApproval()`'s live presence check confirmed
  the ship was at the right waypoint but never checked docked status.
  It now docks the candidate itself when it's in orbit there, the same
  idempotent dock-if-orbiting step every other purchase call site in
  this file already takes — rather than consuming the approval and
  gambling on catching the ship already docked. `purchaseKeeperProbe()`
  also gets the same clearer "orbiting isn't enough" error wording
  `buyShip()` got, since it calls `purchaseShip()` directly and doesn't
  inherit that translation.

- **Fix: shipyard/module intel listings (desktop and Tower) only let you
  buy at the cheapest location for a ship type or component — every other
  location the "also: X, Y" line named was inert text, with no way to buy
  there instead.** Live report: an operator with a ship already at one of
  the "also" waypoints had no way to buy there at all, only at the
  (possibly distant) cheapest listing. Each "also" location is now its
  own real, clickable buy target — small inline buttons on desktop
  (`.buy-ship-alt`/`.buy-mod` in `renderShipyardIntel()`), an expandable
  per-location picker on Tower (`renderMarketYards()`, same toggle pattern
  the route-assignment picker already used).

- **Fix/clarify: buying a ship failed with a raw "must have at least one
  ship available at the purchase location" even when a ship was right
  there — in orbit.** That's the live API's actual requirement, not a
  bug: per SpaceTraders' own docs, only a *docked* ship can access a
  shipyard — orbit only grants navigate/extract. `FleetManager.buyShip()`
  now catches that specific failure and rethrows with the real
  requirement spelled out ("no ship of yours is docked at ... orbiting
  isn't enough") instead of the generic API wording, on both the desktop
  and Tower buy flows (they share this one code path).

- **Fix: dispatching a tour ship to a system (or any `<select>`-driven
  action in a ship's detail panel) was unusable — the panel reset out from
  under the operator on every attempt, before a choice could be made.**
  Live report: "EVERY time I try and use this so send a tour somewhere it
  refreshes before I can choose." Both places a ship's detail panel
  renders (`openShipDetails()`, shared by the Bridge triage rail's
  `#manifest` and the Fleet tab's own tabbed `#fleet-detail` pane) rebuild
  from scratch on every 5-second fleet-data poll while open — a fix
  earlier in this file's history ("typing resets after a few seconds")
  already preserves a plain text input's value/caret across that rebuild,
  but a `<select>` has no equivalent: choosing an option opens the
  browser's own native picker UI entirely outside the page's DOM, and the
  element stays focused with its value unchanged for however long that
  picker is open — long enough, routinely, to lose the race against a 5s
  poll. The rebuild then replaces the `<select>` out from under the still-
  open picker, so no selection was ever possible to begin with; the
  Fleet-page pane didn't even have the text-input fix. Both refresh
  functions (`refreshOpenShipDetails()`, `refreshFleetShipDetail()`) now
  skip the rebuild entirely for a poll cycle whenever focus is already
  inside the panel, rather than trying to preserve a picker they can't see
  into — the next quiet poll (once the operator is done) picks up
  whatever changed instead.

- **Fix: approving a "buy keeper probe" request on the dashboard could
  silently fail and quietly re-ask later, with no visible error.** Live
  incident: X1-MV41-XZ3Z asked for approval twice, both approved, both
  purchases failed with "must have at least one ship available at the
  purchase location" — each failure burned the approval, so the next time
  any ship happened to redock at that shipyard, `maybeRequestKeeperProbe()`
  asked fresh, with no memory of the earlier approve. Root cause:
  `resolvePendingKeeperProbeApproval()` (`src/engine/fleet.ts`) already
  guarded against firing the purchase with nothing there, but the guard
  trusted `fleetStatusSummary()`'s cached ship positions — each ship's own
  agent's last-known nav, current only as of that ship's own last tick.
  This method runs every fleet tick regardless of whether the candidate
  ship's own tick has run recently, so a tour ship that had already moved
  on since its last tick still read as "at" the yard, passed the guard,
  and the real purchase then failed against SpaceTraders' live state. Now
  confirms the candidate is genuinely still there with one live
  `getShip()` call before ever consuming the approval — the same
  live-over-cached pattern already used everywhere else in this file.

- **Fix: a stalled HTTP call could silently kill a ship's scheduler task
  forever, with no error and no reschedule.** Live incident: two different
  traders (THEO-1, THEO-11) each went dark for 30-50+ minutes, both
  immediately after logging the DRIFT-leg fuel diagnostic (`DRIFT leg to
  X: needs N at cruise, have M/C`) and just before the actual navigate
  call — no error logged, no further scheduler activity for either ship at
  all, until the whole process restarted. `Client.request()`
  (`src/core/client.ts`) called `fetch()`/`undiciFetch()` with no timeout
  or `AbortController` at all; if that one call stalls (dropped
  connection, server accepts but never replies), the promise never
  settles, and since `trader.ts`'s scheduler wrapper only reschedules from
  a call that actually resolves or rejects, the ship's whole task chain
  hangs permanently and invisibly. Two independent ships hitting the exact
  same hang point is what made this a systemic gap rather than a fluke.
  Every request now races a 20s `AbortController` timeout; a stalled call
  retries like a 5xx (bounded by the existing `maxRetries`) and then
  throws a real, catchable `APIError` instead of hanging, so the ship's
  usual error-backoff-and-retry path takes over.

- **Fix: a surveyor parked in its own asteroid field logged a false
  "cannot refuel and no reachable market" warning on every single tick,
  indefinitely, despite surveying successfully every time.**
  `pickSurveyTarget()` (`src/engine/agent.ts`) deliberately prefers
  staying put once a surveyor is already sitting in an asteroid field —
  re-surveying the same field keeps the pool fresh without burning fuel.
  But `surveyScout()` still called `refuelIfNeeded(5, target.symbol)`
  unconditionally, even when `target` was exactly where the ship already
  stood. `refuelIfNeeded()`'s round-trip budget prices a full "get there,
  then get back out to the nearest market" trip regardless of distance —
  for a 0-distance target that's still whatever it costs to reach the
  nearest real market from an asteroid field that isn't one itself, which
  can be large or entirely unreachable. Same root cause `scout.ts`'s
  `pickChartTarget()` call site hit earlier this session (the THEO-A
  6-hour-hold incident) — now fixed the same way there: the refuel gate is
  skipped entirely when the ship is already standing on its own target,
  since no travel is about to happen and there's nothing to budget fuel
  for.

- **Fix: a trader restarting mid-haul could lose track of cargo it had
  already bought, get reassigned an unexecutable good, and sit stuck full
  forever.** Live incident: THEO-1 bought 40u MEDICINE in two 20u lots five
  seconds apart; a Render restart (triggered by an unrelated deploy) landed
  right after the second lot but before `persistHeldRoute()` ran — that
  write only happened once, after the *entire* multi-lot buy loop
  completed, not after each lot. On reboot the app had no durable memory of
  the trip, so `deliverHeldCargo()` had nothing to resume, and
  `RouteDispatcher.recompute()`'s busy-carry-forward logic (which only
  protects a trader when its own in-memory `this.assignments` map — wiped
  on every restart — already has a record for it) handed the now-full,
  cargo-stuck ship a fresh, unexecutable good on every recompute since.
  Two independent fixes: `trader.ts` now sets `heldRoute`/`heldCost` and
  calls `persistHeldRoute()` after *every* lot of a multi-lot buy, not once
  at the end, so even a restart between the first lot and the second finds
  a durable pin for what's already in the hold; `dispatcher.ts`'s
  `recompute()` now also skips any trader reporting `busy: true` (real
  cargo in the hold, per `dispatcherTraders()`) even when it has no
  carried-forward assignment record, leaving genuinely busy ships alone
  rather than assigning them fresh work — `TraderAgent`'s own held-route
  recovery is the one place with enough detail to resume correctly.

- **Fix: the dedicated explorer role re-toured a system's markets on every
  single revisit, forever, instead of just the first.** Live incident:
  THEO-C (role `explorer`) ping-ponged between X1-FF6 and X1-NR97 — the
  only two systems its home gate connects to, both fully surveyed within
  the first couple of trips — for over a day straight, re-running the exact
  same multi-stop market tour (including a 574-fuel DRIFT leg to
  X1-FF6-F25B) on every visit for zero new data.
  `FleetManager.exploreSystem()`'s candidate selection already tries to
  prefer an unsurveyed system (`candidates.find(c =>
  !surveyedSystems.has(c))`), but once every reachable system is surveyed
  it has nothing left to return and falls back to `candidates[0]` — the
  system it just came from — and the function then unconditionally re-ran
  the whole market survey regardless of whether `target` was already
  marked surveyed. It now skips straight to the jump-through once a target
  is already in `surveyedSystems`. Separately: `ShipProxy.runExploreGoal()`
  (the path `autoExplore()`'s occasional repurposing of an idle tour/scout
  ship uses) never marked a system surveyed at all — a real, independent
  gap from the same root cause, now fixed with a new `onSystemSurveyed`
  callback wired from `FleetManager` into every tour/scout/explorer
  `ShipAgent`/`ScoutAgent` construction site. Two new tests in
  `tests/fleet.test.ts` covering `exploreSystem()`'s skip; the existing
  `tests/shipProxy.test.ts` suite (unchanged) confirms `runExploreGoal()`
  itself still behaves correctly with the new callback wired in.

- **The dedicated explorer now backtracks through known space once its
  immediate neighbors are exhausted, instead of just bouncing between
  them.** Follow-up to the fix above: skipping the re-tour stopped the
  wasted fuel, but THEO-C still had no way to reach anything past X1-FF6
  or X1-NR97 — `exploreSystem()`'s candidate selection only ever looked at
  systems *directly* connected to wherever the ship currently stood, so
  with both immediate neighbors surveyed it was permanently capped at
  those two, forever. New `FleetManager.nextHopToUnsurveyed()` runs the
  same multi-hop BFS `advanceTourDispatch()` already uses for a tour
  ship's cross-system trip, but across *every* system this tenant knows
  of, and returns just the next hop toward the nearest one still
  unsurveyed — so the explorer now hops back through an already-known
  system when that's genuinely the only way onward, rather than treating
  "nothing new next door" as "nothing new anywhere." Two new tests in
  `tests/fleet.test.ts`.

- **Fix: a scout refusing to even attempt a leg it couldn't afford at
  CRUISE, when DRIFT could likely have covered it.** Live incident,
  immediately downstream of the fix below: once THEO-A got past
  X1-MV41-B11A, its next target sat far enough away that a full CRUISE
  round trip to the system's only known market (~104 fuel) exceeded its
  92/300 tank — and it held indefinitely, `not enough fuel for
  X1-MV41-EX9X and no reachable market`, the same as before. But
  `navigateTo()` already has an automatic DRIFT fallback for exactly this
  case (`chooseFlightMode()` in `flightMode.ts`, whose own design note
  says "any successful navigation beats none" — DRIFT costs meaningfully
  less fuel than CRUISE for the same distance, in exchange for a much
  slower transit), and the real navigate API is the final authority
  either way. The scout's pre-flight `refuelIfNeeded()` gate never gave it
  the chance: a refusal was treated as "cannot proceed at all" and held
  before `navigateTo()` ever ran. It now only holds when genuinely out of
  fuel (0, matching `navigateTo()`'s own `StrandedError` threshold) —
  otherwise it hands off to `navigateTo()` and lets DRIFT (or the live
  API's own rejection, worst case) decide. Tests updated/added in
  `tests/cooldownPending.test.ts` and `tests/scoutSelfTarget.test.ts`.

- **Fix: a scout standing exactly on its own next chart target held for
  fuel it didn't need, for over 6 hours straight.** Live incident: THEO-A
  jumped into X1-MV41 (the earlier fix below working as intended), toured a
  few waypoints, then arrived at X1-MV41-B11A — an uncharted asteroid with
  no market of its own — with 92/300 fuel, and got stuck holding there
  forever: `holding at X1-MV41-B11A: not enough fuel for X1-MV41-B11A and
  no reachable market`. `pickChartTarget()` correctly picks the nearest
  uncharted waypoint, which can be the ship's own current position (distance
  0) once everything else nearby is charted — but `tick()` still ran the
  full `refuelIfNeeded()` round-trip budget before attempting to chart it,
  which prices in a return trip to the *nearest market*, regardless of
  whether the ship is actually about to travel anywhere. From B11A that
  return trip was 100+ fuel to the system's one distant fuel station — a
  cost with nothing to do with charting a waypoint already underneath the
  ship. `tick()` now skips the refuel gate entirely when the ship is already
  standing on `target`, since `navigateTo()` no-ops in that case anyway and
  no fuel is at risk. Two new tests in `tests/scoutSelfTarget.test.ts`; also
  fixed a latent gap in an existing `cooldownPending.test.ts` fixture that
  had the same self-target ambiguity (its "must not fly with no fuel" test
  happened to still pass before only because the refuel gate never checked
  which target it was for).

- **Fix: a tour ship dispatched across multiple jump-gate hops got stuck
  mid-route, mis-reading its own in-flight transit as a failed jump.** Live
  incident: THEO-14 was bought and dispatched to tour X1-B48 (2 known hops
  away), but sat touring X1-XB94 indefinitely, logging `tour dispatch hop
  to X1-B48 failed, touring X1-XB94 while waiting: [object Object]` on
  every retry. `advanceTourDispatch()`'s `jumpShip()` call reaches the gate
  via `dispatchShip()`/`agent.dispatchTo()`, which for a tour ship
  (`ShipAgent`) really flies there and throws `NavigationPending` as real
  control flow while `schedulerDriven` is true — not a failure. The old
  catch treated any thrown value as a genuine jump failure, permanently
  (mis-)recording a perfectly good gate as under construction via
  `recordGateNotComplete()` and falling back to local touring — the exact
  same misdiagnosis on every subsequent retry, since a multi-hop dispatch
  always needs at least one real transit. (The `[object Object]` was
  `String()`-ing a `Pending`, which isn't an `Error`.) `advanceTourDispatch()`
  now re-throws `Pending` so it propagates to `nextTourTask()`'s own catch,
  which already reschedules correctly at `err.resumeAt` — a genuine jump
  rejection still records the gate as blocked, unchanged. Two new tests in
  `tests/fleet.test.ts`.

- **Fix: `ScoutAgent.dispatchTo()` never actually flew the ship, breaking
  every jump through it.** Live incident, caught within an hour of shipping
  the scout-jump feature below: THEO-A sat at X1-B48-F25A while the fleet
  logged `THEO-A jumping X1-B48-B13A -> X1-VJ42-X19E` followed immediately
  by `Failed to execute jump. Waypoint X1-B48-F25A is not a jump gate.` on
  a ~90s retry loop for 15+ minutes straight. Root cause: unlike every other
  role's `dispatchTo()` (`ShipAgent`, `TraderAgent`, `SiphonerAgent` all
  actually fly there and block until arrival, propagating `Pending`
  correctly inside a scheduled tick), `ScoutAgent.dispatchTo()` just set a
  `manualGoal` flag and returned immediately, leaving the actual flight for
  some future tick to notice. `jumpShip()`/`dispatchShip()` assume the
  standard contract — they call `dispatchTo()` to reach the gate, then
  immediately attempt the live jump expecting the ship to already be there
  — so for a scout the ship never moved and every jump attempt failed
  against wherever it actually was standing. `ScoutAgent.dispatchTo()` now
  matches the other roles: navigates and orbits for real (still recording
  `manualGoal` so a later tick charts the destination), letting
  `schedulerDriven` propagate `Pending` exactly like `ShipAgent.dispatchTo()`
  already does. Three new tests in `tests/scoutDispatchTo.test.ts`.

- **Chart scouts jump to a new system once their current one is fully
  charted, instead of idling forever.** Live incident: THEO-A was
  converted to `scout` and assigned X1-B48, but a live public-API check
  confirmed all 30 of B48's waypoints already had a `chart` (almost
  certainly charted first by the 32-ship rival fleet HYDRA) — it kept
  cycling every waypoint logging `already charted, skipping`, burning fuel
  for zero value with no way out. `ScoutAgent` gained a
  `jumpToUnchartedSystem` hook, called when `pickChartTarget()` comes up
  empty and there's nothing left to sensor-scan either; `FleetManager`'s
  new `scoutJumpToUnchartedSystem()` picks a connected system (preferring
  one already known to have an uncharted waypoint, then an unchecked one,
  before retrying anything already confirmed empty — tracked in a new
  `scoutExhaustedSystems` set so it can't ping-pong between two exhausted
  neighbors), jumps via the existing `jumpShip()`, and force-refreshes the
  destination's waypoint traits (`refreshWaypointTraits()`, same fix as the
  B48 stale-cache bug below) so the very next tick sees accurate chart
  status. Gated by a new `scoutCreditFloor` doctrine value plus the shared
  `exploringEnabled` switch — same budget-limit shape as explorers'
  `explorerCreditFloor`, sized separately since a scout's jump is a much
  cheaper, single-hop spend. Four new tests in `tests/scoutJump.test.ts`.

- **Traders top off at a fuel market before departing, not just when low.**
  Live incident: THEO-B (600-unit tank) departed a fuel-selling market at
  392/600 (65%) — above the old `<50%` refuel trigger, so `navigateTo()`
  skipped it entirely — then needed 453 fuel for the very next leg at
  CRUISE and had to fall back to DRIFT, several times slower, for a trip a
  topped-off tank would have flown normally. Tour ships already got this
  exact fix (`ShipAgent.tourScout()`'s "top off at every market, not just
  when running low"); traders never did. `TraderAgent.navigateTo()` now
  tops off whenever docked at a real FUEL-selling market and not already
  ~95% full — a same-system round trip's fuel math doesn't know what leg
  comes next, and checking a market that already sells fuel costs nothing
  extra. The other refuel path — burning FUEL out of the cargo hold when
  there's no market here — is a real tradeoff (hold space, not a free
  top-off) and stays gated to genuinely low, unchanged. Four new tests in
  `tests/trader.test.ts`.

- **RouteDispatcher: check the sell leg's fuel distance too, not just the
  buy leg.** Live incident: THEO-11 (80-unit tank) was assigned
  `ADVANCED_CIRCUITRY X1-XB94-D43 -> X1-XB94-A4`, rejected a cycle later
  inside `TraderAgent.findRoute()` (`buyAt->sellAt distance 91 exceeds fuel
  capacity 80`), then handed a different unreachable/unprofitable route
  twice more over the next 15 minutes — never completing a trip — while 14
  other same-system routes it could actually fly sat unused in the same
  ranked work list. `RouteDispatcher.recompute()`'s `reachable()` check
  (added for a prior DRAGOM-3 fuel-distance case) already verified the ship
  could reach *buyAt* from its current position, but never checked that the
  *whole round trip* (buyAt→sellAt) fit the tank —
  a same-system route could pass the first check and still be physically
  unreachable for a small hull. It now also checks `distance(buyAt,
  sellAt) <= fuelCapacity` for a same-system `direct` item (the one role
  that needs the full round trip, unlike buy/sell/haul); a cross-system
  sell leg is untouched, since that's a jump, not a fuel-distance flight,
  and `canJump()` already covers whether it's possible at all. Three new
  tests in `tests/dispatcher.test.ts`.

- **Fix a tour ship never seeing a system's own markets when it was cached
  before they were charted.** Live incident: THEO-A, dispatched to X1-B48,
  arrived and sat reporting `no reachable target` forever instead of
  touring, even though the diagnostic breakdown added earlier the same day
  confirmed the ship genuinely had zero in-system targets (`0 in X1-B48,
  atMarketHere=false`) — not a fuel-range problem. Root cause: SpaceTraders
  only reveals a waypoint's `traits` once *someone* (any agent, not
  necessarily this tenant) has actually charted it. X1-B48 was scanned and
  cached weeks before this session's tour-dispatch feature existed; at that
  moment its two FUEL_STATIONs and two PLANETs apparently hadn't been
  charted yet, so they cached with empty trait arrays — no MARKETPLACE,
  permanently, since `GalaxyAtlas.loadSystem()` trusts any non-empty cached
  waypoint list forever and never re-fetches it. The live API shows all
  four carrying MARKETPLACE today (confirmed by hand against the public
  endpoint), but this tenant's cache never learned that.
  `GalaxyAtlas.refreshWaypointTraits()` is the one deliberate exception to
  that trust rule — a live re-fetch that overwrites the cached waypoint
  list while preserving already-resolved jump gates. `tourScout()` now
  calls it (via a new `refreshSystemMarkets` agent option, wired for tour
  agents only) exactly once per system when it finds zero in-system targets
  despite knowing the system exists, so a genuinely marketless system still
  only pays for one live call rather than one every tick forever. Five new
  tests across `tests/galaxy.test.ts` and `tests/tourScout.test.ts`.

- **Tour dispatch now routes around a specific gate under construction,
  instead of only ever considering the shortest hop count.** Follow-up to
  the fix below: `findSystemPath()`'s BFS picked the fewest-systems route
  regardless of whether any gate along it was known to be blocked — for
  THEO-10's case, X1-XB94's genuine direct gate to X1-MJ67, which returned
  that path forever even once `advanceTourDispatch()` had recorded
  X1-MJ67-I55 as incomplete, since nothing about the pathfinding itself
  cared. It now excludes any connection through a gate the construction
  cache already knows is incomplete before running BFS, so a longer but
  actually-jumpable route (through a different gate into the same
  destination system, where one exists) wins instead. A gate with unknown
  status is still included — this doesn't require every gate on a route to
  already be verified before a first attempt. When a destination's only
  known gate is the blocked one, this correctly falls back to "no known
  path yet" rather than fabricating a route that can't exist — reaching
  X1-MJ67 specifically still has to wait on that gate's own construction,
  same as before, since it has only the one gate. Three new tests in
  `tests/fleet.test.ts`.

- **Fix a tour ship retrying a doomed jump forever instead of touring while it
  waits.** Confirmed live: THEO-10, dispatched to tour a remote system,
  spent over an hour "sitting at the gate" — every tick it tried to jump to
  X1-MJ67-I55, got rejected ("Destination jump gate ... is under
  construction"), logged "will retry next tick", and unconditionally
  reported back to `tourScout()` that it had done work, which skipped the
  ship's normal same-system touring target selection every single time. The
  explore path already has the right pattern for this
  (`ShipProxy`'s JUMP phase calls `GalaxyAtlas.recordGateNotComplete()` on a
  live rejection so `canJump()`/`gateComplete()` stop lying), but
  `advanceTourDispatch()` never used it — it just retried the identical
  jump blind, every tick, forever. It now checks `gateComplete()` before
  attempting (skipping the attempt once the cache already knows the gate is
  incomplete) and calls `recordGateNotComplete()` on a live rejection,
  falling through to normal touring of the ship's current system in both
  cases instead of reporting "did work". `FleetManager.tick()`'s existing
  periodic `refreshGateConstruction()` sweep is what notices the gate
  actually finishing and lets the tour resume on its own.

- **Fix a released ship standing down forever against its own stale hold.**
  Confirmed live: THEO-10 (a tour ship) was released from the dashboard —
  the "Hold" button correctly reappeared, `operatorHolds` and the persisted
  `shipManualState` were both correctly cleared — but the fleet-status log
  kept reporting `want:hold <waypoint>` for it indefinitely, and the ship
  just sat at the gate instead of touring. `IntentBoard.commit()` only ever
  resolves *this tick's* proposals (confirmed intentional — see
  `intent.test.ts`'s "leaves the standing intent in place"); a ship nothing
  proposes anything for keeps whatever was last committed forever, it's
  never implicitly retracted. Every other fleet-driven goal (repair, tender,
  explore, scrap) already calls `forgetIntent()` itself when it finishes;
  `hold` has no natural finish, so `releaseTo()` — the one path every
  release goes through — had to do it instead, and didn't. A tour ship is
  the case that surfaced this: nothing else ever proposes anything for it,
  so once its one active proposal (the operator hold) stopped, the stale
  committed intent from before the release just sat there, and `tourScout()`
  kept standing down against it via `standDownReason()`. `releaseTo()` now
  calls `forgetIntent()` too. Also gives `releaseTo()` a log line
  (`<ship>: released to <owner>`) — it never had one, unlike `holdShip()`/
  `sendShipTo()`, which made this harder to confirm from the logs alone.
  New regression test in `tests/fleet.test.ts`.

- **Show other agents sharing a system, both on the public map and in the
  game UI.** Prompted by a live incident: a competing fleet (HYDRA, 32
  ships) sharing THEO's home system turned out to explain both a mystery
  gate contributor and a market staying crushed longer than THEO's own
  volume alone would predict — the operator asked for this to be visible
  going forward instead of hand-checked. `GalaxyCrawler` gains a periodic
  (hourly) pass over the public `GET /agents` directory, grouped by
  headquarters system and kept in memory alongside its existing
  factions/systems crawl — same "no tenant client, no rate-limit cost"
  design as those two, since credits/ship counts genuinely change over
  time unlike static faction/system data. `/cartography`'s click-a-system
  panel now lists agents headquartered there (symbol, ship count,
  credits), sorted by fleet size. The v6 dashboard's Galaxy tab gains a
  matching "Agents in system" pane, scoped to the signed-in tenant's own
  home system (`GET /api/agents-in-system`), next to the existing
  Leaderboard/Factions panes. Verified end-to-end with real data through
  both surfaces (mock server + Playwright): correct sort order, "· you"
  marking on the v6 pane, counts and credits formatted correctly.
- **Fix `/cartography`'s click-a-system panel never opening.** Confirmed
  live: clicking a dot did nothing, no matter which one. Root cause was
  in the drag-to-pan handler added alongside the panel itself
  (`setupMapControls()`'s `pointerdown` listener): it called
  `svg.setPointerCapture()` unconditionally, even when the press landed
  on a dot. Once the SVG has pointer capture, the browser routes the
  resulting synthetic `click` event to the capturing element instead of
  the dot underneath the pointer, so the dot's own click listener
  (`openSystemPanel`) never ran — reproduced with a real simulated
  click (fails) versus a directly-dispatched click event on the same
  node (works, since it bypasses native pointer-capture routing).
  Fixed by skipping the drag-start (and the capture) when the press
  target is a `circle.dot` — a press starting on a dot is a click, not
  a pan. Drag-to-pan on empty map background still works, verified.
- Replace the flat 10-minute sale cooldown with graduated, volume-based
  route scoring. Confirmed live: THEO's fleet ran up 3.6M credits in
  ~30 minutes system-wide, then every route in the system went to zero
  profit at once — a per-route cooldown only reacts *after* a specific
  route is sold into, so a burst spread thin across many routes never
  individually triggers it, even though the fleet's own volume is what
  crashed the whole market. `RouteDispatcher.recordSale(good, sellAt,
  units)` now tracks recent sold volume per market (30-minute rolling
  window) and `scoreRoute()` discounts a route's ranking — not its real,
  displayed profitPerTrip — proportionally to how much of a full trip's
  worth of volume the fleet has already dumped there recently. Selling
  roughly one trip's worth halves a route's score, two trips' worth
  thirds it, and so on, so the dispatcher naturally spreads trades
  across markets *before* a price actually collapses, and a market's
  fatigue fades smoothly as the window ages sales out rather than
  snapping back all at once at a fixed cooldown expiry. A heavily-sold
  route still wins if it's the only one for its good. Also closes a gap
  the first pass of this change introduced: the existing "second
  trader, different market" fallback pushed its own work item at the
  route's raw, undiscounted profit, which could out-rank the
  now-deprioritized primary pick in the final cross-good sort and
  silently undo the whole adjustment for a single-trader case — both
  direct-route ranking figures are now decayed consistently. Four new
  tests in `tests/dispatcher.test.ts` cover the decay, its recovery
  over time, and the single-route-survives-fatigue case.
- Fix two idle traders getting assigned the identical route while one was
  already flying it. Confirmed live: THEO-B was mid-haul on CLOTHING
  X1-XB94-K87 -> X1-XB94-A1 (bought, in flight, not yet sold) when the very
  next `dispatch recompute` handed THEO-A the identical CLOTHING/A1 leg
  fresh — the same-route collision the 10-minute sale cooldown (below,
  2026-09-14 earlier) does not cover, since no sale had happened yet to
  start that cooldown. Root cause: `RouteDispatcher`'s busy-carry-forward
  reserves a busy direct trader's leg under the qualified `good@sellAt`
  key, but the new "best route for this good" work item generated each
  cycle was keyed on the bare good with no market qualifier — the two keys
  never collided, so nothing stopped a second, idle trader from being
  freshly assigned the exact leg the first was already flying. Fixed by
  tracking busy direct traders' claimed (good, sellAt) pairs and checking
  them at both places new route work gets generated; a second trader can
  still take the same good into a genuinely different market, which is
  the feature this collision was hiding inside of. Two new regression
  tests in `tests/dispatcher.test.ts` (verified to fail without the fix).
- **Cartography: click-a-system side panel.** Clicking a dot on the
  public `/cartography` galaxy map now opens a slide-in panel with that
  system's sector/type, waypoint count and type breakdown, and any known
  jump-gate connections (each clickable to re-center the map on the
  destination system). New `GET /api/cartography/systems/:symbol`
  (`Store.getGalaxySystemDetail()`) reads tenant-scanned `waypoints` when
  available, falling back to the background crawler's `crawledWaypoints`
  only when a system hasn't been visited by any tenant yet — the two are
  never merged. This was scoped in `docs/TODO.md` on 2026-09-14 and
  shipped the same day (`b72fec4`); logging it here since it went
  straight into a commit without a changelog entry at the time. Map dots
  themselves stay system-granularity — no per-waypoint markers yet.
- Fix a paused construction mission silently un-pausing itself across a
  restart. `MissionManager.persist()` wrote the DB row's `paused` column
  from a flag passed in at each call site, defaulting to `false` when
  omitted — but `tick()`'s periodic `reconcile()` (which keeps a paused
  mission's material counts fresh even while paused, on its own slow
  cadence) called `persist(mission)` without ever passing that flag, so
  every reconcile of a paused mission quietly wrote the DB row back to
  unpaused while it stayed correctly paused in memory. The next restart
  read that stale row and resumed the mission on its own — no operator
  action, no log line admitting it. Confirmed live: tenant `bfc926dc`'s
  `X1-XB94-I55` mission (paused 2026-09-14 03:32, released THEO-B) came
  back resumed and buying FAB_MATS again at 11:49, the first restart
  whose only intervening `persist()` call was `reconcile()`'s. Fixed by
  having `persist()` always derive `paused` from the live `this.paused`
  Set instead of trusting a per-call flag, so every persist reflects
  the true in-memory state.
- Tower's More tab gains an Activity section — sells, buys, repairs,
  scraps, jumps, mission/contract events, warehouse moves, and the
  like, reusing the same `activity` store slice and `/api/activity`
  endpoint desktop's own activity feed already reads (no new backend).
  Mining extraction, surveying, siphoning, and market/shipyard scan
  snapshots are filtered out client-side (`ACTIVITY_HIDDEN_KINDS` in
  m.js) — those fire on essentially every tick and would drown out
  everything else in a feed meant to answer "what's going on," not
  replay the tick log. Desktop's own activity feed is untouched.
- Fix (correction to the same-day StrandedError fix below): watched
  THEO-9 live after deploying StrandedError and it kept looping anyway
  — turned out it was sitting at 0 fuel *right on top of* a market that
  sells fuel (X1-XB94-E44), so `navigateTo()`'s "not at a market" check
  correctly did not treat it as stranded, but `runRepairGoal()`/
  `runScrapGoal()` never called `refuelIfNeeded()` before navigating in
  the first place — unlike `runHoldGoal()`, which already did. The ship
  just kept computing a route through a *different*, equally-unreachable
  fuel stop instead of buying fuel where it already stood. Both now call
  `refuelIfNeeded({ reserve, target })` before `navigateTo()`, same as
  `runHoldGoal()` already does.
- `RouteDispatcher` now deprioritizes a `(good, sellAt)` leg for
  `SALE_COOLDOWN_MS` (10 min) right after a trader actually sells there —
  new `recordSale()`, called from both of `TraderAgent`'s sell sites
  (the direct-route leg and the warehouse `sell` role). Confirmed live:
  the existing "two traders may share a good only when selling into
  different markets" protection only reserves a leg while the ship
  flying it is *busy* — the moment it finishes and goes idle, the
  reservation releases, and since ranking is pure last-known profit, the
  very next idle trader was handed the identical "best" route before the
  price its predecessor's own sale had just crashed got any chance to
  recover: THEO-1 sold 40u ELECTRONICS at X1-XB94-D43 for 35,900c;
  THEO-A sold the same 40u at the same waypoint 8 minutes later for
  20,800c. The cooldown is a deprioritization, not a hard block — a
  cooling leg still gets picked if it's the only route for its good, so
  a trader is never left idle over it, but loses to any real alternative
  first.
- Fix: a fleet-driven goal (repair/scrap/hold/explore/tender) whose ship
  ran out of fuel mid-route retried the identical doomed navigate call
  forever — every ~13s, no back-off, no recovery. Reported live: THEO-4
  and THEO-9 (mid-scrap) retried "requires 1 more fuel for navigation"
  for hours, contributing to multi-hour stretches overnight where the
  earnings tracker showed zero sales fleet-wide. Root cause:
  `navigateTo()`'s "route via a fuel stop" logic could pick a stop
  computed from the ship's own 0 current fuel — which is, by definition,
  exactly as unreachable as the original destination — and just let the
  live API call fail every time. `navigateTo()` now throws a new
  `StrandedError` immediately when the ship has 0 fuel and isn't at a
  market, before ever attempting that doomed call;
  `ShipProxy.runFleetDrivenGoal()` catches it centrally (covering all
  five fleet-driven goals in one place) and backs off cleanly instead of
  logging a fresh "agent error" every cycle. `getStrandedShips()` still
  derives stranded status independently from live ship state, so this
  doesn't change whether a fuel-tender rescue gets attempted — only stops
  wasting API calls and log volume on a call already known to fail. *Why
  no rescue tender ever reached these two ships in the first place is a
  separate, still-open question — not fixed here.*
- Fix: a scout/tour ship's opportunistic jump (`autoExplore()`) could
  retry an identical doomed jump forever once committed — confirmed
  live, THEO-C retried a jump through X1-XB94-I55 every ~11s for hours,
  always failing "Jump gate X1-XB94-I55 is under construction" even
  though `canJump()`'s own pre-check is supposed to filter out exactly
  this. Root cause, two parts: (1) `GalaxyAtlas.refreshGateConstruction()`
  treated *any* error from the construction-status check — not just a
  404 (genuinely no construction record, i.e. pre-built) — as "gate is
  complete," permanently poisoning the one-way cache on what could've
  been a transient failure; now only a real 404 is treated that way, any
  other error leaves the gate unresolved for the next sweep to retry.
  (2) Once a ship's committed intent already had a bad gate baked in
  (from before the cache was poisoned), nothing ever re-validated it —
  `runExploreGoal()`'s JUMP phase just retried the same `jumpShip()` call
  forever. It now catches a jump rejection, calls the new
  `GalaxyAtlas.recordGateNotComplete()` (the one deliberate exception to
  the cache's one-way design — a live rejection is stronger evidence
  than any cached guess) to correct the cache immediately, and abandons
  the goal so the fleet re-decides next pass. Also fixed a related bug
  found while tracing this: `exploringShips` only ever gained entries —
  nothing removed a ship from it once its trip ended (success *or*
  failure), so any ship that had ever auto-explored once was
  permanently benched from being picked again for the rest of the
  process's life. `autoExplore()` now reconciles it against each ship's
  actual current intent on every pass.
- `sellShip()` now re-fetches the ship live instead of trusting its agent's
  cached snapshot before picking a scrap yard — that cache only refreshes
  on the agent's own tick cadence, so a ship whose agent hadn't ticked
  recently could have its *previous* system searched for a yard instead
  of its real current one, reporting "no known shipyard" even when the
  true current system has one. The error message on a genuine miss is
  also far more specific now (distinguishes "this system was never
  scanned" from "it was scanned, but nothing there has a SHIPYARD trait")
  — reported live: an operator scrapping a miner from Tower saw it fail
  even in a system they could confirm had shipyards, and the prior plain
  "no known shipyard in <system>" message gave no way to tell which of
  these it actually was.
- Fix: selling/scrapping a ship stationed in a system with no shipyard of
  its own (the common case for a miner parked in an asteroid field) threw
  "no known shipyard in &lt;system&gt;" and did nothing. `sellShip()` now
  calls a new `nearestShipyardForSale()`, which looks one gate-hop past
  the ship's own system when nothing scrappable is known locally, and
  `runScrapGoal()` (`src/engine/shipProxy.ts`) jumps there first via the
  same `jumpTo` primitive `runHoldGoal()` already uses for a cross-system
  target. Deliberately not shared with repair's own yard lookup — a
  critically damaged ship should not be routed further afield on top of
  its existing damage, and `runRepairGoal()` has no jump handling of its
  own — so repair stays same-system-only. Reported live: scrapping a
  miner did nothing, even after the keeper fix below.
- Fix: `FleetManager.controlledAgent()` was missing `keepers` from the role
  maps it checks, so Hold, Sell/Scrap, Send-to-waypoint, role-change, and
  designate-warehouse-ship all threw "not under fleet control" for any
  ship currently in the keeper role — on both the desktop dashboard and
  Tower — even though `shipFor()`/`stepFor()`/`noteShipState()` already
  worked around the same gap for reads. `keepers` is the same `ShipAgent`
  class as every other role map, so it now belongs in `controlledAgent()`
  directly; the three read-path fallbacks that special-cased it are
  simplified now that they're redundant. Reported live: scrapping THEO-3
  from Tower did nothing.
- Fix: holding or releasing a ship (Fleet tab, either the triage-row
  buttons or the ship-detail modal) now also refreshes the Dispatch/Trade
  Ops assignment list, not just Bridge. `holdShip()`/`releaseShip()`
  free or reclaim that ship's dispatcher assignment immediately
  server-side, but the Dispatch list only re-polls every 20s — in that
  window a just-held ship's stale pre-hold route stayed on screen
  alongside whichever other trader the dispatcher handed the now-freed
  route to, looking like two ships sharing one route. They were never
  both actually running it; it was a display lag, not a duplicate
  assignment.
- Galaxy crawler Phase B + C: `GalaxyCrawler` no longer needs any tenant's
  authenticated `SpaceTraders` client to make progress — every endpoint it
  calls (`/systems`, `/factions`, `.../jump-gate`) is public, so it now
  runs on plain tokenless `fetch()` and no longer competes with any
  tenant's rate limiter (`TenantRegistry.anyBootedApi()`, which existed
  only for this, was removed). Once the systems/factions crawl finishes,
  it now also runs an ongoing opportunistic sweep of every known-but-
  unresolved jump gate, checking the public (no-token, chart-gated)
  `.../jump-gate` endpoint on the chance some other player has charted it
  since — most checks still fail (still uncharted by anyone), but hits are
  free connection data merged into `galaxy_systems.jump_gates` via a new
  `Store.mergeGateConnections()` (read-modify-write scoped to just that
  column, leaving `waypoints`/`crawled_waypoints` untouched). A drained
  queue rebuilds and re-sweeps every 24h. New `Store.listSystemsForGateCrawl()`
  feeds the queue build. See `docs/TODO.md`'s cartography items for what's
  still not wired up on the rendering side, including a spec'd (not yet
  built) click-a-system side panel for the public cartography page.

## 2026-09-13 (Galaxy crawler: stop discarding free per-system waypoint data)

Verified live against the real SpaceTraders API (no token): `GET
/systems` — which `GalaxyCrawler` already calls once per page for
system-level metadata — embeds every system's full waypoint list
(symbol/type/x/y/orbitals) in the same response. The crawler was
discarding that array entirely and only persisting sector/type/x/y.

- `migrations/020_galaxy_crawled_waypoints.sql` — new `crawled_waypoints`
  column on `galaxy_systems`, deliberately **separate** from the existing
  `waypoints` column. `GalaxyAtlas.loadSystem()` (the per-tenant boot
  path) treats any non-empty `waypoints` row as a fully-scanned system
  and casts it straight to the live API's `Waypoint` type (`.traits`
  included) with zero live fetch — writing this public, trait-less data
  there would have handed a tenant's very first visit to that system
  waypoints missing `.traits` entirely, and every trait check downstream
  (shipyard/marketplace detection, mount checks) would throw. Caught
  before shipping, not after.
- `src/db/store.ts` — `mergeSystemWaypoints()` (writes only
  `crawled_waypoints`, leaves `waypoints`/`jump_gates` untouched);
  `listGalaxySystems()` now also returns `crawledWaypoints`.
- `src/engine/galaxyCrawler.ts` — `crawlSystemsPage()` now persists
  `sys.waypoints` via the new method alongside the existing meta write.

**Honest scope note**: this only captures the data — nothing renders it
yet. The public cartography page draws one dot per *system*, never
per-waypoint; Tower/desktop's galaxy views read a tenant's own in-memory
`GalaxyAtlas`, not this shared column. Wiring an actual view is a
separate follow-up (`docs/TODO.md`). The larger design (decoupling the
crawler from any tenant's authenticated client, and opportunistic
jump-gate connection discovery via the same public, chart-gated
`.../jump-gate` endpoint) is also not built yet — this is Phase A of
three only.

Typechecked clean. Full test suite couldn't run against the remote test
Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier this session,
retried twice).

## 2026-09-13 (System classifier + starter doctrine templates)

Operator idea, following straight from the checkpoint's new system-
attribute capture: classify a system by those attributes and suggest the
right doctrine template for that type, rather than every tenant running
identical settings regardless of what its home system actually looks
like.

- `src/engine/systemClassifier.ts` (new) — `classifySystem()`, a plain
  rule-based classifier (deliberately not learned — this matches the
  doctrine system's own explicit-rules philosophy) over market/shipyard/
  jump-gate/connectivity counts, sorting a system into `isolated`,
  `market_desert`, `shipyard_poor`, `hub`, or `standard`. `DOCTRINE_TEMPLATES`
  pairs each archetype with a small set of starter doctrine deltas (e.g.
  `isolated` zeroes `explorerTarget` — there's no gate to jump through;
  `hub` turns on `warehouseTarget` and raises `keeperCount` — enough
  markets and liquidity to be worth it). Explicitly a first-pass
  starting point, not a tuned result — every value is normal editable
  doctrine afterward.
- `src/http/admin.ts` — the checkpoint's captured system snapshot now
  includes its `archetype`. Two new endpoints: `GET
  /tenants/:id/system-template` (read-only preview: classify the
  tenant's *current* home system, return the matching template) and
  `POST /tenants/:id/apply-template` (re-classifies fresh server-side
  rather than trusting a client-sent archetype, then applies each
  delta via `Doctrine.setAdopted()` + `.set()` — the same public API
  the dashboard's own Doctrine tab uses). Nothing runs on its own; this
  only ever executes on an explicit operator click.
- `public/admin.html`/`admin.js` — the Play style panel now shows the
  detected archetype and template preview (when the tenant is booted in
  this process) with an "Apply template" button, confirmed before it
  fires since it changes live doctrine settings.

Typechecked clean. `tests/admin.test.ts` couldn't run against the
remote test Postgres (`ETIMEDOUT`, same sandbox flakiness as earlier
this session, retried twice).

## 2026-09-13 (Checkpoints now capture home-system attributes too)

Operator observation: the same manual strategy that's working great on
THEO doesn't transfer to THEO-2 at all — the systems aren't comparable,
so a fair play-style comparison needs to control for the system's own
attributes (market count, etc.), not just tenant performance.

- `src/http/admin.ts` — `POST /tenants/:id/checkpoint`'s auto-captured
  `meta` now also includes the tenant's home system: waypoint count,
  market count, shipyard count, jump-gate count, and connected systems
  (all read from `GalaxyAtlas`, the same source the cartography page and
  desktop galaxy overview already use — free for the operator, no need
  to type any of it by hand). Sits alongside the existing credits/role-
  count capture on every checkpoint note.

Typechecked clean.

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
