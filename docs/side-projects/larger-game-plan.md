# Larger game plan: SpaceTraders as one organ of a bigger body

Status: design plan only, no code. Written 2026-11-14. Fact-checked against the live SpaceTraders docs, OpenAPI spec and unauthenticated API on 2026-11-14 (see "Verification" below). Text tagged **[corrected]** was wrong or unverified in the first draft and has been fixed; everything else is as first written. Working title: **Meridian Accord**.

---

## Verification (checked 2026-11-14)

Method: read docs.spacetraders.io (rate-limits, markets, agents, server-resets, changelog pages), the bundled OpenAPI spec (`https://api.spacetraders.io/v2/documentation/json`, v2.3.0, identical in size to the `reference/SpaceTraders.json` in the GitHub repo `SpaceTradersAPI/api-docs`), the repo README and community wiki, and made a handful of unauthenticated GETs (status, agents, systems, waypoints, construction, market, jump-gate). No agent was registered and no token was used. Anything that needs a token or a ship is marked UNVERIFIABLE and has an experiment in section D2-F.

Sources: `[S]` live status `https://api.spacetraders.io/v2/`; `[SPEC]` OpenAPI spec above; `[RL]` https://docs.spacetraders.io/api-guide/rate-limits; `[WIKI]` https://github.com/SpaceTradersAPI/api-docs/wiki/Ratelimit; `[MK]` https://docs.spacetraders.io/game-concepts/markets; `[AG]` https://docs.spacetraders.io/game-concepts/agents-and-factions; `[CL]` https://docs.spacetraders.io/resources/changelog; `[RM]` https://github.com/SpaceTradersAPI/api-docs (README / docs/overview.md); `[LIVE]` an unauthenticated call made today.

| # | Claim in the plan | Verdict | What is true / evidence |
|---|---|---|---|
| V1 | 2 requests/s sustained, burst 30 | CONFIRMED | `[RL]` table: 2 req/s, burst 30 requests, burst duration 60 s. `[LIVE]` headers: `x-ratelimit-limit-per-second: 2`, `x-ratelimit-limit-burst: 30`, `x-ratelimit-type: IP Address`, `retry-after: 1`. |
| V2 | The limit is per source IP only | CORRECTED | Two limiters: **IP Address** and **Account**, both 2/s, burst 30/60 s `[RL]`. `[WIKI]`: limit is per IP and per agent; one agent from many IPs does not raise throughput; several agents on one IP share that IP's limit. Unauthenticated reads only meet the IP limiter. Also: infra can return 429/502 without rate-limit headers; test `x-ratelimit-type` before treating a 429 as ours `[RL]`. |
| V3 | ~172,800 calls/day budget | CONFIRMED | 2 x 86,400. Burst does not add daily volume. |
| V4 | Public status endpoint with `resetDate`, leaderboards, announcements | CONFIRMED | `[S]` returns `resetDate`, `serverResets{next,frequency}`, `leaderboards`, `announcements`, `stats`, `health.lastMarketUpdate`, `version`. Works with no token. |
| V5 | Leaderboards can drive Reach events | CORRECTED | Only two boards: `mostCredits` (top 15 seen) and `mostSubmittedCharts` (top 5 seen). No history, no per-good or per-contract boards `[S]`. A free calendar/Oracle input, nothing richer. |
| V6 | Weekly reset cadence | CONFIRMED | `serverResets.frequency: "weekly"`; next `2026-11-15T13:00:00Z` `[S]`. The server notice says "typically Saturday mornings", but the live dates are Sundays (reset 2026-11-08, next 2026-11-15, 13:00 UTC). `frequency` is "how often we intend"; the cadence was fortnightly in 2023 `[CL]`. Treat as observed, never as calendar. |
| V7 | `resetDate` change = season boundary | CONFIRMED | `resetDate` = "date when the game server was last reset" (date only, no time) `[SPEC]`. Use it as the trigger, `serverResets.next` as the heads-up. Error list also has `3200 ResetError` and `3100 SystemStatusMaintenanceError` `[LIVE /error-codes]`. |
| V8 | Account token vs agent token | CONFIRMED | `[SPEC]` securitySchemes: AccountToken "grants authorization to create agents"; AgentToken "authorization to use the API during a specific reset". |
| V9 | A player/bot can (re-)register an agent | CORRECTED | Since 2025-01-25 `POST /register` needs an **account token** created in the email-login dashboard `https://my.spacetraders.io`; registering accounts through the API ended `[CL]`. We can never register for anyone. Every reset each player must re-register by hand or with their own account token. |
| V10 | Agent tokens die at reset | CONFIRMED | "grants authorization ... during a specific reset", "until the end of the reset" `[SPEC]`; announcement: "Previous access tokens will no longer be valid after the reset" `[S]`. The exact HTTP code a dead token gets: UNVERIFIABLE without a token. |
| V11 | Agent symbols are per reset | CONFIRMED (nuance) | Fresh registration each reset. Supporters "can reserve their agent call sign between resets" `[S]`: a symbol may repeat across weeks, so identity must key on `(symbol, resetDate)`, not symbol alone. Symbol is 3-14 chars `[SPEC]`. |
| V12 | Observer tier needs only an agent symbol | CONFIRMED | `GET /agents/{symbol}` and `GET /agents` need no token `[LIVE]`; return `symbol, headquarters, credits, startingFaction, shipCount`. `GET /my/agent` without a token returns 401 / code 4103 `[LIVE]`. |
| V13 | Tokens can be "scoped to read-only calls" | CORRECTED | There is one token type per agent with full control (buy ships, sell cargo, supply gates). No scopes exist `[SPEC]`. A stored token is a full-power credential, which strengthens "do not store tokens". |
| V14 | Which data are public | CONFIRMED | Spec `security: [{}, AgentToken]` (token optional) on status, agents, systems, waypoints, market, shipyard, jump-gate, construction `[SPEC]`; `[LIVE]` market, jump-gate, construction, waypoints all answered unauthenticated. Market unauthenticated = static lists only (imports/exports/exchange, no prices). |
| V15 | Market prices need a ship present | CONFIRMED | "Price data and transaction history are only available if you have a ship located at the waypoint" `[MK]`; `tradeGoods` and `transactions` "Visible only when a ship is present at the market" `[SPEC]`. Both need an authenticated agent with a ship there: **our keeper network is mandatory, not optional**. |
| V16 | A market-transactions endpoint exists | CORRECTED | No separate endpoint. `transactions[]` is a field of `GET .../market`. Each row: `waypointSymbol, shipSymbol, tradeSymbol, type(PURCHASE/SELL), units, pricePerUnit, totalPrice, timestamp` `[SPEC]`. |
| V17 | Transactions of other agents are visible, and how far back | UNVERIFIABLE | Spec says "recent transactions at this market"; length, retention window and whether rival agents' rows appear need a token. Design depends on it. Experiment E1. |
| V18 | Market tick is ~30 minutes | UNVERIFIABLE | No documented cadence. `[S]` exposes `health.lastMarketUpdate`; it read 16:16:14Z when queried at ~16:16:30Z, so updates may be far more frequent than 30 min. Experiment E3. |
| V19 | Ships at a waypoint are visible to anyone present (presence sampling, blockades) | CORRECTED | There is no public ship listing (no `GET /ships`). Only `POST /my/ships/{s}/scan/ships`, which needs a **Sensor Array** mount and puts the ship on a cooldown, returns nearby ships' symbol/registration/nav/mounts `[SPEC]`. Ship symbols are prefixed with the agent symbol `[SPEC register]`, so attribution works, but sampling is a ship-time and cooldown cost. |
| V20 | Contracts "we sponsor" | CORRECTED | Contracts are negotiated by an agent's own ship at a faction waypoint, **max 1 at a time**, faction-issued `[SPEC negotiate]`; types PROCUREMENT/TRANSPORT/SHUTTLE. A third party cannot create, price or see them. Progress is visible only with the agent's token. The "sponsored contract" half of Architecture A is not available. |
| V21 | `contract.terms.deliver[].unitsFulfilled` | CONFIRMED | `ContractDeliverGood{tradeSymbol,destinationSymbol,unitsRequired,unitsFulfilled}` `[SPEC]`. Authenticated, private. |
| V22 | Charts: `chart.submittedBy` public; charting gives credits | CONFIRMED (nuance) | Waypoint `chart{waypointSymbol,submittedBy,submittedOn}`; chart gives "one time reward of credits based on the rarity" `[SPEC]`. `[LIVE]`: home-system waypoints are pre-charted with `submittedBy` = a **faction** (e.g. AEGIS), not an agent. Only the first charter is recorded. |
| V23 | Jump gate needs FAB_MATS + ADVANCED_CIRCUITRY | CONFIRMED | `[LIVE]` `X1-RY70-I54/construction`: FAB_MATS 1600 required, ADVANCED_CIRCUITRY 400, QUANTUM_STABILIZERS 1 (already 1), all `fulfilled` 0 except the stabilizer. `GET construction` is public; `POST .../construction/supply` needs a token, a ship at the waypoint and the good in cargo `[SPEC]`. |
| V24 | Gate contribution per player is visible | CORRECTED | The public object has only `materials[{tradeSymbol,required,fulfilled}]` and `isComplete`. No contributor field `[SPEC][LIVE]`. Whether anything records the supplier (e.g. `/my/agent/events`, whose rows are `{id,type,message,data,createdAt}`) is UNVERIFIABLE. Contribution shares need our own attribution (section D2-B). |
| V25 | "The" gate is one shared Wonder everyone can feed | CORRECTED / UNVERIFIABLE | Each home system has its own gate under construction (`isUnderConstruction: true` `[LIVE]`). The spec has no owner check on supply, but a contributor's ship must physically reach that system, and jump gates exist only where built. Whether outsiders may supply another agent's gate: UNVERIFIABLE. Experiment E2. |
| V26 | Galaxy fetch is "several hundred to a couple thousand" calls | CORRECTED | `[S]` 7,033 systems, 206,416 waypoints; page limit is 20 `[SPEC]`. Systems alone: 352 calls. Every waypoint: 10,321 calls (~1.4 h of the whole IP budget). `GET /systems` already embeds each system's waypoint symbols/types/coordinates `[LIVE]`, so fetch traits lazily, only for depot systems. |
| V27 | Conditional requests (ETag / If-Modified) are available | CORRECTED | No `etag` or `last-modified` header on `/` or `/agents` responses `[LIVE]`. Dedupe by body hash, as the plan's fallback says. |
| V28 | 429 with `retry-after` is honoured | CONFIRMED | `retry-after: 1`, `x-ratelimit-reset` `[RL][LIVE]`. |
| V29 | Third-party services and bots are acceptable | CONFIRMED (spirit) | `[RM]` "write a script to automate your ships", "build a web or mobile app", "track and share market price data with other players", "create a Discord bot for other players"; docs list community leaderboards and UIs. Not a licence. |
| V30 | ToS rules on wrapping, redistribution, polling, proxies | UNVERIFIABLE | No terms-of-service text found: `spacetraders.io/terms`, `/tos`, `/privacy`, `my.spacetraders.io/terms` return 404; the dashboard shows only an email "Use Policy"; Discord rules are not public. API documentation is open (OpenAPI in a public repo) but no licence file found (`LICENSE` 404). Ask the maintainers (D2-E). |
| V31 | Webhooks / push events exist | CORRECTED | Roadmap lists webhooks as future `[RM]`. What exists: authenticated `GET /my/socket.io`, event `systems.{systemSymbol}.departure` per subscribed system `[SPEC]`. Contents of dashboard "webhooks" `[AG]` UNVERIFIABLE. |
| V32 | Enough players exist (implicit) | CORRECTED | `[S]` this week: 177 agents, 39,321 ships, 11,220 accounts ever. The Frontier audience is a few hundred, not thousands; scale tiers above ~200 must be Reach-only or observer players. |
| V33 | API is stable | CORRECTED | Game is "currently in alpha" `[RM]`, v2.3.0, resets "to deploy fixes, add new features, and balance" `[S]`; changelog has repeated breaking changes (2023-2025) `[CL]`. Plan for schema drift (already in 4.5). |

Tally: 33 rows. **CONFIRMED 16** (V1, V3, V4, V6, V7, V8, V10, V11, V12, V14, V15, V21, V22, V23, V28, V29; several with a nuance), **CORRECTED 14** (V2, V5, V9, V13, V16, V19, V20, V24, V25, V26, V27, V31, V32, V33), **UNVERIFIABLE 3** (V17, V18, V30; plus the dead-token HTTP code inside V10 and the contributor-event question inside V24/V25).

Claims whose falsity would have broken the design (all now handled in the deep dive):
1. **V15/V17 market transactions need a ship present and may be short-lived.** The "keeper reads the depot's transactions" verifier is the backbone. Needs our own ship at every depot and a retention window longer than the poll interval. Unproven until E1.
2. **V20 sponsored contracts do not exist.** Architecture A loses half its input channel; the depot (market sale) channel carries it.
3. **V19 no public ship listing.** The blockade/presence mechanic (worked example 2, espionage) cannot be built on public data.
4. **V24/V25 no contributor attribution on the gate and no single shared gate.** "Contribution share decides Portal ownership" needs our own conservation-checked attribution, and the Wonder gate must be a chosen system that guild ships can reach.
5. **V9 registration needs a human with an account token each week.** The weekly re-link is a manual step and a retention cliff (every reset).
6. **V30 ToS unknown.** Launch gate, not a build gate.
7. **V32 only ~177 agents.** Player counts of 500 or 5,000 can only be mostly Reach-side players.

---

## 1. Premise and pitch

### The fantasy
A fractured human diaspora, the **Accord**, survives on the rim. The war-and-politics layer ("the Reach") is played in our game. But every faction's fleet, fuel, alloys and credits come from **the Frontier**: a real, brutal, always-live commodity market that nobody controls, which is the SpaceTraders universe. You do not simulate the Frontier; you work it. Your logistics skill there is your faction's industrial base here.

Metaphor: the Reach is a board game of kingdoms; the Frontier is the live commodity exchange that feeds them. Real traders in the Frontier decide which kingdom can afford a war.

### Player roles
| Role | What they do | Where they play |
|---|---|---|
| **Strategist (human)** | Chooses doctrine, treaties, research, targets; plays 15-30 min/day | Reach UI; light Frontier play via our dashboard |
| **Bot author** | Writes the Frontier logistics engine (contracts, feeds, mining, trading); publishes it as a "Quartermaster" | SpaceTraders API; our API for orders/reports |
| **Guild leader** | Runs a faction of 5-30 members: allocates who supplies what, brokers treaties, pays out | Both, mostly Reach governance |
| **Spectator/analyst** | Reads the public Frontier ledger and Reach map | Read-only site |

### Why the bigger game gains
- A **real external economy** has what designers cannot fake cheaply: genuine scarcity, price noise, rival players, and a skill ceiling (our operator already runs 215-ship fleets).
- It supplies **meaningful, verifiable effort**. A resource in the Reach is backed by something that cost real logistics work.
- Weekly reset gives a **natural season clock** for free.
- Bot play is legitimate and central, not a cheat to ban: bots are the "industry", humans are the "government".

### Why SpaceTraders benefits
- New purpose for existing accounts: a reason to keep playing after the first week; a social layer (guilds, treaties) the base game lacks.
- Traffic is shaped politely (we read mostly public/aggregate data and cache; see section 4).
- Gives bot authors a scoreboard with stakes that is not just "most credits".

### The one-line pitch
"Your SpaceTraders fleet is your empire's economy. Win the market in the Frontier, spend it to win the war in the Reach."

---

## 2. Integration architectures

### A. Supply Chain ("the Foundry"): SpaceTraders as resource supply
Reach resources (Alloy, Fuel Cells, Circuitry, Rations...) are produced only by delivering mapped SpaceTraders goods (FAB_MATS, IRON, ADVANCED_CIRCUITRY, FUEL...) to a **depot** **[corrected]**: a depot must be a waypoint whose *market imports the good* (the delivery is a SELL, a row in that market's `transactions`) or a *construction site* (aggregate supply only). A bare waypoint has no inventory and cannot observe a delivery. The first draft's "or by completing **contracts we sponsor**" is **[corrected]**: removed, contracts are faction-issued to one agent, max 1 at a time, and invisible to us without that agent's token (V20). Delivery is verified from the depot market's transaction list read by our keeper ship plus the player's own report, not from the player's ledger (see Deep dive D2-A).
Pitch: simplest mental model, strongest meaning for logistics skill.

### B. Portal Sector: a literal gateway
One system in the Frontier is "the Breach". Ships parked at its jump gate, or a contract delivering goods to its waypoint, opens the "Portal" in the Reach map, letting that faction project force or trade at a chosen Reach location. SpaceTraders's own jump-gate construction mechanic (the gate needing FAB_MATS and ADVANCED_CIRCUITRY) becomes the story: building the real gate in the Frontier unlocks the Reach gate for the whole guild. **[corrected]** Every home system has its own gate under construction (1,600 FAB_MATS + 400 ADVANCED_CIRCUITRY + 1 QUANTUM_STABILIZERS seen live on 2026-11-14), the public construction object shows only totals (no contributors), and a contributing ship must physically reach the site. So "the" Breach is a *chosen* gate, ideally a guild's own home-system gate, and per-guild shares are our own bookkeeping (D2-B).
Pitch: spectacular, thematic, co-op; but weak as continuous economy.

### C. Oracle: SpaceTraders as event and price source
Reach events and prices derive from Frontier data: a price crash in a good triggers a Reach "famine"; a system's market going SCARCE triggers a blockade crisis; reset date and leaderboard drive calendar events. Nobody needs to deliver anything; the Frontier is weather.
Pitch: low integration cost, works with zero participation; but players' actions do not matter, so it is meaningless as a main loop.

### D. Mercenary/Contract Marketplace
Reach factions post **bounties** ("deliver 400 FAB_MATS to X1-AB12-C3 by Friday", "chart 10 waypoints", "hold market X for 6 hours"). Bot authors fulfill them in SpaceTraders and get paid in Reach currency/reputation. Our game becomes a meta-contract layer.
Pitch: bot authors are first-class mercenaries; clean verification story; this is the diplomacy/economy glue.

### E. Procedural universe seed
Hash the SpaceTraders system/waypoint layout of the week into the Reach map (planet types, anomalies, ruins).
Pitch: cheap, delightful, one-time; not a mechanic by itself.

### F. Training Academy
New players earn Reach "licenses" by achieving SpaceTraders milestones (first contract, 5 ships, a gate contribution). Pitch: onboarding funnel only.

### Scoring matrix (1-5, higher is better)
| Criterion (weight) | A Foundry | B Portal | C Oracle | D Mercenary | E Seed | F Academy |
|---|---|---|---|---|---|---|
| Meaningful to Reach (3) | 5 | 3 | 2 | 4 | 1 | 2 |
| Rewards skilled bots (3) | 5 | 2 | 1 | 5 | 1 | 2 |
| Works for low-effort humans (2) | 3 | 4 | 5 | 3 | 5 | 5 |
| Verifiability / anti-cheat (3) | 4 | 4 | 5 | 4 | 5 | 4 |
| API/rate-limit cost (2) | 3 | 4 | 5 | 3 | 5 | 4 |
| Resilient to API outage (2) | 3 | 3 | 4 | 3 | 5 | 4 |
| Reset fit (2) | 4 | 5 | 4 | 4 | 5 | 4 |
| Build cost for one dev (3) | 3 | 3 | 5 | 3 | 5 | 4 |
| **Weighted total (/100 max 100 -> raw)** | **88** | **77** | **82** | **90** | **70** | **74** |

Raw sums use the weights above (max 100). Note C scores well only because it is cheap; it fails the "meaning" test.

### Recommendation: D + A, with B as the season finale and C as ambient weather
- **A (Foundry)** provides the steady economy: standing conversion of delivered goods into Reach resources.
- **D (Mercenary board)** provides the strategic layer: factions post priced bounties, bots and humans pick them up; this is also how diplomacy and espionage tasks reach the Frontier.
- **B (Portal)** becomes the weekly climax: the real jump-gate construction is a shared objective.
- **C (Oracle)** is free atmosphere: leaderboard and reset date drive events; adds life even for idle players.
- E and F are cheap add-ons (map seeding; first-week quests).

---

## 3. The recommended design

### 3.1 Core loop
Frontier (SpaceTraders): operate fleet -> complete **verified acts** (deliveries, charts, holds, profit milestones).
Our server: verifies -> mints **Reach resources/influence** into the faction treasury (with sinks and caps).
Reach: spend on units, research, treaties, covert ops -> results produce **bounties and doctrine** that point back at the Frontier ("we need 800 FAB_MATS at the Breach by Saturday").

### 3.2 Reach systems and how SpaceTraders touches each

| Reach system | What it is | Frontier -> Reach (input) | Reach -> Frontier (output) |
|---|---|---|---|
| **Factions and conflict** | ~6-10 guilds (players) plus 4 NPC powers hold ~40 Reach sectors on a graph. Contested sectors resolve weekly by "supply war": each side's committed resource flow plus units. | Resource production (Foundry) fuels fleets; **blockade** acts: holding ships at a named waypoint for N hours raises a sector's "interdiction" value. | War objectives become bounties (supply the front, deny the enemy's depot market by out-buying a good there). |
| **Manufacturing and supply chains** | Reach tier-2/3 goods (Plating, Reactors, Drives) are crafted from tier-1 resources; recipes mirror SpaceTraders's real chains. | Tier-1 resources come from verified Frontier deliveries by good: IRON/ALUMINUM/COPPER, FAB_MATS, ELECTRONICS, FUEL. Goods with higher real difficulty (ADVANCED_CIRCUITRY) pay more. | Crafting queues create standing demand lists; the **demand board** pushes "needed goods this week" which bots read as a signal. |
| **Exploration and discovery** | Reach map fog of war; "Relics" and "Anomalies" are seeded from the week's SpaceTraders galaxy hash. | Charting waypoints, discovering a new shipyard/market, first-visit of systems (verified by reading the public waypoint `chart.submittedBy`), earn **Survey Points**. | Discoveries are published to a shared atlas that other bots use as reconnaissance (our atlas is a public, cached facsimile; it also reduces everyone's API load). |
| **Diplomacy and treaties** | Signed treaties: non-aggression, trade corridor, joint gate build, tribute. Treaties are machine-readable. | Treaty clauses can name Frontier conditions: "A delivers 300 FAB_MATS per day to B's depot" -> verified automatically; breach = reputation loss. | Violation evidence is an automatic report (no human adjudication needed). |
| **Research and tech** | Tech tree gated by Reach resources plus "Research Points" earned by *efficiency* in the Frontier. | RP from verified metrics: profit per API call, contract completion without pausing, price-impact-aware trading (lower market damage = more RP). Rewards good citizenship in the market. | Unlocks modify Reach (yield caps, units) and give Frontier **intel tools** (hosted dashboards, route suggestions: tools, not unfair advantages). |
| **Espionage and information** | Covert ops against rival guilds' Reach plans; the Reach has fog of war on rivals' treasuries and stockpiles. | Spies = ordinary Frontier ships doing "intel acts": loiter at a rival's declared depot waypoint, scan a market, chart. **[corrected]** There is no public list of ships at a waypoint (V19). A spy sees rivals only through (a) the depot market's `transactions` (rows carry `shipSymbol`, prefixed by agent symbol) and (b) `scan/ships`, which needs a Sensor Array mount and a cooldown. The intel act is therefore "read a rival's depot transaction list" and "scan", both token-holder actions; rivals can notice them only if we publish that a scan happened. | Counter-intel: decoy deliveries, falsified "manifest" declarations with a bounded lie budget. Information reports are delivered as text in Reach. |
| **Victory and scoring** | A season ends at the SpaceTraders reset. Score = sector control + wonders (the Breach gate) + treasury efficiency + legacy points. | Frontier performance is a **capped** component (<=40%) so Reach strategy matters. | Winner sets next season's "Edict" (a rule modifier). |

### 3.3 Worked examples
1. **Guild "Ashfall" needs Alloy for a Reach offensive.** Strategist posts bounty: 600 IRON_ORE-derived `ALUMINUM_ORE` units delivered to depot `X1-DF55-A1` in 48h, reward 6,000 Alloy + 40 influence. Bot author's Quartermaster sees the bounty via our API, runs it as a hauling feed, and our verifier credits Alloy when the depot market's `transactions` (read by our keeper) show a SELL of that good by a ship with the player's agent prefix. **[corrected]** `X1-DF55-A1` must be a market that imports the good; the player is paid the market price by the game *and* earns the Reach mint, so the bounty premium is on top of real profit, not instead of it.
2. **Blockade.** Guild "Verdigris" orders 3 ships to sit at the rival's depot waypoint for 12h. **[corrected]** There is no public ship list (V19). Presence is proven by the blockader's own signed reports cross-checked by our keeper's `scan/ships` (Sensor Array, cooldown) or, cheaper, by `GET /my/ships` read with the player's token on opt-in; the interdiction meter rises while verified presence holds. Treat this worked example as post-slice. The rival sees it and answers with a counter-bounty to buy out the blocker's escort, which is Frontier combat-free, so it is just fuel, patience and presence.
3. **Gate Week.** The season's Wonder is the real jump-gate construction in one Frontier system. All guilds are tempted to contribute (shared score), but contribution share decides who gets the Reach "Portal" ownership. **[corrected]** The public construction object has no contributor field (V24), so shares come from our own attribution: each contributor declares a supply, and we accept it only if the sum of declarations in a polling interval does not exceed the observed `fulfilled` delta (conservation check, D2-B). Betrayal at the last 10% is still observable as a stalled `fulfilled`. Cooperation and betrayal (withholding at the last 10%) emerge naturally.

### 3.4 Economy, sinks, balance
- **Mint rules (faucets):** each verified Frontier act mints at a fixed exchange rate keyed by good *tier* (not by the credits value, so inflation in SpaceTraders prices does not break us), then multiplied by a **diminishing return per good per guild per day** (soft cap curve `r = base * 1/(1 + n/k)`).
- **Sinks:** unit upkeep (every unit costs resources weekly), decay of stockpile (5%/day above storage cap), research costs, treaty tribute, fortification repair, covert-op costs, and the permanent sink of "wonder" contributions.
- **Anti-snowball:** top-3 guilds pay an "imperial overhead" (upkeep multiplier scaled by sector count); underdogs get a "frontier stipend" (extra mint from charting/exploration).
- **Bot vs human balance:** bots mint resources, but *spending decisions* (what to build, whom to attack, what treaties) are Reach actions with a daily action-point budget, so a bot cannot out-click a human in the Reach. Optional: bots can submit Reach orders but are rate-limited to "advisor" level (suggestions that a human must confirm) in ranked play; an unrestricted "Machine League" ladder exists.
- **Tuning knobs:** all rates are data (a `season_rules` table), changeable per season, and logged.

### 3.5 Weekly reset as a feature
- A **Season = one SpaceTraders week.** The reset date endpoint is our season clock; we also watch for "reset happened" (status `resetDate` change) and stop minting from old tokens.
- **Reach persists; the Frontier regenerates.** Treaties, reputation, tech, sector ownership carry across seasons as the **Legacy** state; resources and units mostly reset or decay at 80%.
- **Campaign = 4-season arc** with a season-edict that changes the story ("Season 3: the Embargo": a randomly chosen Frontier good is banned from minting).
- **Opening phase** (the first 24h after reset, the "Scramble"): all token holders re-register; bounties for early charting are rich; this matches the real opening where credits are scarce. **[corrected]** Re-registering is manual: `POST /register` needs the player's own account token from the dashboard (V9), reset time is observed as Sunday 13:00 UTC (V6), and each player must then re-link a new agent; budget a link flow that takes one minute and a reminder email/Discord ping at reset, because this step is the weekly churn cliff.
- **Frontier hash seeds Reach content:** relic placement, anomaly types and NPC faction homeworlds derive from the new system graph so each season looks different (architecture E, nearly free).
- **Legacy points** convert some Frontier excellence (e.g., final fleet size, total contract completions) into permanent cosmetic/rule perks (titles, a named sector).
- **Hall of Seasons:** archived final state, public.

---

## 4. Interfaces and data

### 4.1 Authentication and token handling
- SpaceTraders has an **account token** (created in the email dashboard, only used to register agents) and **agent tokens** (act as the agent, valid for one reset). We want the weakest thing that proves identity. **[corrected]** There is no read-only token: an agent token can buy ships and sell cargo (V13), so any stored token is a full-power credential.
- **Preferred proof of ownership without storing a token:** challenge-response via an agent-visible field. Our server issues a nonce; the player (or bot) performs an action only the agent holder can: e.g. **change the agent's headquarters ship role?** is not possible, so the realistic version is: *sell or buy 1 unit of a designated cheap good at a designated waypoint* or *name a chart*... The cleanest verified fingerprint is **a transaction in the depot market's `transactions` list** referencing the ship symbol and amount encoded by the nonce (for example buy exactly `N` units, where `N` derives from nonce). **[corrected]** The list is not public: it appears in `GET .../market` only for an agent with a ship at that market (V15/V16), so *our keeper ship* at the challenge market reads it, and the ship-symbol prefix gives the agent symbol. `N` must be within the good's `tradeVolume`. Cost: one tiny transaction plus one keeper read; whether the row survives long enough to read is E1 (V17). Fallback if rows are short-lived: the player does the transaction while a keeper-triggered poll window is open.
- **Fallback (simple, honest):** the player pastes an **agent token** once; we immediately call `/my/agent`, store `agentSymbol`, a hash, and (only if the player opts in to "Hosted Sync") the token encrypted with a server-side key (KMS/libsodium secretbox). Token handling rules: never log; **[corrected]** we cannot scope it to read-only (none exists), so *we promise to only call a fixed allow-list of GET endpoints* (enforced in the adapter, tested) except when the player enables "Quartermaster hosting"; one-click revoke (deleting the row); the token dies at the next reset anyway (V10), so there is nothing to keep across seasons and the retention window is at most one week. Dashboard-side rotation is the player's own action.
- **Third mode: no token at all (public reader).** Because ships/markets expose a lot publicly, the "Observer" tier needs only the agent symbol; it earns no mint but can see.
- We never ask for the **account token**.
- Session identity in our game uses our own login (email/OIDC), bound to one agent per season (agent symbols are per reset).

### 4.2 Reading state without breaking the rate limit
The budget: **2 req/s sustained, burst 30 per 60 s, per source IP** (plus an identical limiter per account/agent), shared by everyone behind our IP **[corrected: per IP *and* per account, V2]**. That is ~172,800 requests/day total, ~120/min; plan to use at most ~70% (~121k/day). Anything else running on the same IP (including any other fleet or crawler on the same box) draws from the same pool, so the service must run on its own IP. We must treat this as the central scarce resource. The full budget table for 50/500/5,000 players is in D2-A.
- **Rule 1: poll the least possible; prefer event-driven, caller-pushes.** Bots that already run a fleet *push* signed reports to us (see 4.5) from their own IP; we **verify spot-checks** rather than poll everything.
- **Rule 2: tiered polling by value.** Budget table:

| Tier | What | Frequency | Cost model |
|---|---|---|---|
| Season clock | `GET /v2/` status (unauth) | every 5 min | 288/day |
| Leaderboards | same status endpoint | free with above | 0 |
| Depot waypoints | market `GET .../market` for ~20 depot/wonder markets **[corrected]**: prices and `transactions` need *our own keeper ship parked at each depot* (V15); without it only the static import/export lists come back. Cadence 30 min is a guess until E3 (V18) | 30 min = 48/day per depot | ~1k/day for 20 depots |
| Gate construction | construction endpoint for Wonder system | 10 min | 144/day |
| Per-player verification | `/my/agent`, `/my/ships` (paged), contracts | on claim, throttled to 1 per player per 15 min | scales with claims |
| Spot audits | random 5% of reports | n/a | small |

- **Rule 3: a tenant-owned proxy pool.** Verifications use the *player's own token and our hosted worker per-player* only if the player opts in; heavy sync is better shifted to the player's side (their bot reports). **[corrected]** Do not plan on a proxy pool: the per-agent limiter does not move with IP and the community wiki says an agent on many IPs gains nothing (V2); ToS is unknown (V30). Hosted sync is capped at about 800 players at 3 calls per 30-min tick (D2-A), and the real lever is reporter mode, which costs us nothing per player.
- **Rule 4: global token bucket with priorities** (season-critical > claim verification > background atlas).
- **Rule 5: back-pressure is a game feature.** The Reach "Signal Delay": claims are batched into **Ticks** (every 30 min). Players see "verification pending", which also makes tick-based balance simpler.
- **Public data harvest:** system/waypoint graph is static for the week, fetched once per reset (paged with limit 20). **[corrected]** Full crawl is 352 requests for systems (each system row already embeds its waypoint symbols/types/coordinates) but **10,321** for every waypoint's traits (206,416 waypoints on 2026-11-14), about 1.4 h of the full IP budget. So: crawl systems (352), then fetch waypoint traits lazily for depot/gate systems only (~30 systems = ~60-100 calls), spread at low priority. Waypoint charts and `isUnderConstruction` come from the same calls.

### 4.3 Caching and snapshot design
- **Immutable-per-season atlas:** systems, waypoints, trait lists; keyed `season_id`. Never refetched.
- **Market snapshots:** append-only `frontier_market_obs(season, waypoint, good, supply, activity, buy, sell, trade_volume, observed_at, source)` where `source` is `ours`, `player_report`, or `public`. Keep latest + rolling 24 h in Postgres, older compressed.
- **Player snapshots:** `player_frontier_state(player_id, observed_at, credits, ship_count, contract_state, token_ok)` every claim; keep daily compaction.
- **ETag/If-Modified:** **[corrected]** not supported as far as observed (no `etag`/`last-modified` on `/` or `/agents`, V27); hash bodies to skip writes.
- **Reproducibility:** every mint stores the **evidence bundle** (raw JSON hash + endpoint + timestamp) so disputes are explainable.

### 4.4 Verifying a claimed trade or achievement
Verification classes, strongest first:
1. **Self-attested then confirmed from depot market data:** delivery to a depot market shows up as supply change and as a `SELL` row in `transactions[]`. **[corrected]** It is a field of `GET .../market` (not a separate endpoint) and only an agent with a ship at that waypoint sees it. Our keeper ship at the depot reads the list and matches (`shipSymbol` prefix = agent, `tradeSymbol`, `units`, `type=SELL`, `timestamp` inside the claim window). Whether other agents' rows are listed and for how long is unproven (V17, E1); if they are not, class 1 collapses to class 2 and trust drops one level for every claim.
2. **Authenticated read of the player's own state:** `/my/ships/{s}/cargo`, contracts `deliver` progress, `/my/agent` credits. Checks "contract fulfilled" with `contract.terms.deliver[].unitsFulfilled`.
3. **Challenge-response transaction** (section 4.1) for identity.
4. **Cross-evidence:** the same claim must be consistent between player report, our keeper observation and market deltas. Inconsistent claims go to a "disputed" state and mint at 0 until resolved.
5. **Anti-gaming:** self-trading between a player's own two agents is detected by the same ownership graph (same IP/proxy fingerprint, same token owner); cap mint from a pair of agents trading with each other; require goods to move *through a market* (price-forming) rather than ship-to-ship transfers.
- **Wash-trade guard:** mint depends on units delivered to **depot demand slots we publish**, not on arbitrary trades; so there is no way to fabricate value by trading in a loop.
- **Reset guard:** every call carries `season_id`; tokens from a previous reset stop working and are marked dead **[corrected]**: docs promise invalidation (V10) but the exact HTTP/body code is unverified without a token; detect via any 401/`ResetError` plus a `resetDate` change.

### 4.5 Failure handling
| Situation | Behaviour |
|---|---|
| SpaceTraders slow | Verification queue lengthens; UI shows "Frontier delay"; ticks continue; no minting for unverified claims; claims valid for 6 ticks. |
| SpaceTraders down | **Fog of Static** event: Reach continues on Reach-only actions; mint pauses; strategists get a free "recon" bonus; outage window recorded and **claims are retroactively accepted** if evidence appears later (idempotent by evidence id). |
| API changed (fields/semantics) | All parsing in one adapter package with versioned schemas (zod); contract tests against recorded fixtures; a canary job calls the real API hourly and flips a **feature flag** that degrades to C (oracle-only) mode if validation fails. |
| Reset earlier/later than scheduled | Season boundary is defined by observed `resetDate` change, not a calendar; a season-end grace window of 1 tick freezes minting. |
| Rate-limit exhaustion | Lower tiers starved first; 429 `retry-after` honoured; global breaker. |
| Token invalid | Mark player "Dormant"; keep Reach state; prompt to re-link. |

### 4.6 OUR game's API (sketch)
Base `https://api.meridian.example/v1`. Auth: bearer (our own key per player/bot). JSON. Idempotency-Key on writes.

| Resource | Endpoint | Purpose |
|---|---|---|
| Season | `GET /seasons/current` | clock, rules, edict, frontier reset date, status of link to ST |
| Link | `POST /links` / `GET /links/me` / `DELETE /links/me` | link an ST agent (challenge, token opt-in), see sync tier |
| Link challenge | `POST /links/challenge` | returns nonce + instructions + expiry |
| Reports | `POST /reports` | signed batch of Frontier acts from the player's bot (deliveries, charts, holds) |
| Claims | `GET /claims?status=` / `GET /claims/{id}` | verification state, evidence, mint result |
| Bounties | `GET /bounties`, `POST /bounties`, `POST /bounties/{id}/accept`, `POST /bounties/{id}/submit` | mercenary board |
| Demand board | `GET /demand` | weekly needed goods/waypoints for each depot, price multipliers |
| Atlas | `GET /atlas/systems/{id}`, `GET /atlas/markets?good=` | cached Frontier facsimile |
| Guild | `GET/POST /guilds`, `/guilds/{id}/treasury`, `/members` | membership, treasury |
| Treasury | `GET /guilds/{id}/ledger` | resource ledger (double entry) |
| Sectors | `GET /map`, `POST /sectors/{id}/orders` | Reach map, orders |
| Production | `GET /guilds/{id}/queues`, `POST /queues` | crafting |
| Research | `GET /tech`, `POST /guilds/{id}/research` | tech |
| Treaties | `GET/POST /treaties`, `POST /treaties/{id}/sign`, `GET /treaties/{id}/compliance` | machine-readable treaties |
| Intel | `GET /intel/reports`, `POST /ops/spy` | espionage |
| Events | `GET /events?since=` (SSE `/events/stream`), `POST /webhooks` | event feed |
| Leaderboard | `GET /scores` | per-guild, per-player |

### 4.7 Event model
Append-only, ordered by `(season_id, seq)`. Core event types:

```
frontier.market_observed      {waypoint, good, supply, activity, buy, sell, tv, source}
frontier.delivery_verified    {claim_id, player, good, units, depot, evidence_hash}
frontier.chart_verified       {claim_id, player, waypoint}
frontier.presence_sampled     {waypoint, agents[], sample_ts}
frontier.gate_progress        {system, material, fulfilled, required}
frontier.reset_detected       {old_reset, new_reset}
frontier.api_health           {state: ok|slow|down|schema_drift}
reach.minted                  {guild, resource, amount, cause_claim_id}
reach.order_submitted/resolved {...}
reach.bounty_posted/accepted/settled
reach.treaty_signed/breached
reach.sector_changed          {sector, from, to}
reach.research_done / spy_result / season_closed
```
Rules: every `reach.minted` references a `frontier.*_verified` event (provenance); a mint is a pure function of (evidence, season_rules), so re-running the log reproduces the state (event sourcing; makes outage backfill safe).

### 4.8 Pseudocode: a bot loop spanning both games
```python
# Quartermaster bot (runs on author's machine; talks to ST directly and to Meridian)
while True:
    season = meridian.get("/seasons/current")
    if season.frontier_reset_detected:           # SpaceTraders reset
        st.reregister()   # [corrected] POST /register needs the author's own ACCOUNT token (V9); never ours
        meridian.post("/links", challenge=meridian.challenge())
        continue

    demand = meridian.get("/demand")             # what the guild needs this week
    bounties = meridian.get("/bounties?status=open&guild=mine")
    plan = optimiser.plan(
        st_state = st.snapshot(),                # ships, markets from own cache
        weighted_goals = demand + bounties,      # reach value per unit
        market_impact_limits = season.rules.impact_cap,
    )

    for act in plan.next_actions():              # ordinary ST play
        result = st.execute(act)                 # buy, navigate, deliver, chart
        recorder.append(result)                  # ledger of own actions

    if recorder.has_new_verifiable_acts():
        meridian.post("/reports", batch=recorder.signed_batch(), idempotency_key=recorder.key)

    for claim in meridian.get("/claims?status=disputed"):
        recorder.attach_extra_evidence(claim)    # e.g. market transaction ids

    sleep(adaptive_delay(st.rate_budget_remaining()))
```
Human strategist counterpart: reads `/events`, picks bounties, sets guild `demand` priorities, signs treaties; no ST API required.

---

## 5. Technical architecture for one developer

### Stack
- **TypeScript monorepo** (Node 22): `apps/api` (Fastify), `apps/worker` (tick and verifier), `apps/web` (React + a simple SVG/canvas map), `packages/st-adapter` (typed SpaceTraders client with a shared limiter and recorded fixtures), `packages/rules` (pure game rules, season_rules driven; unit-testable with no I/O, in line with "pure module, policy as data").
- **Postgres** (one instance, row-level partition by season), **Redis or in-process queue** (pg-boss on Postgres to avoid another service), object storage for evidence archives.
- Auth: OIDC login; our API keys for bots.

### Data model sketch
```
player(id, email, created_at)
st_link(id, player_id, season_id, agent_symbol, mode{observer|reporter|hosted}, token_enc?, verified_at, status)
guild(id, name, season_id, ...)    guild_member(guild_id, player_id, role)
season(id, st_reset_date, rules_json, edict, status)
claim(id, season_id, player_id, kind, payload, evidence_hash, status, minted_event_id)
frontier_market_obs(...)   frontier_presence(...)   atlas_system / atlas_waypoint (season-keyed)
event(season_id, seq, type, payload, ts)           -- append-only
ledger_entry(guild_id, resource, delta, event_id)   -- double-entry
sector(id, season_id, owner_guild, interdiction, fortification)
unit, queue_item, treaty, treaty_clause, bounty, tech_state, intel_report
legacy(player_id|guild_id, perks_json)               -- survives resets
```

### Processing model
- **Tick** every 30 min (matches SpaceTraders's market cadence): (1) health check, (2) run verifier batch, (3) mint, (4) resolve Reach orders, (5) publish events. Resolution is deterministic from the event log.
- **Daily** jobs: decay, upkeep, treaty compliance, scoring snapshot.
- **Weekly**: reset watcher -> season close -> legacy conversion -> atlas rebuild -> new season rules.
- All game logic in `packages/rules` pure functions returning `(new_state, events, reasons)`; workers are thin.

### Cost (monthly, rough)
| Item | Estimate |
|---|---|
| VPS or small managed Postgres plus app (single box) | 15-40 USD |
| Proxy/second IP for verification (optional, only if hosted sync grows) | 5-20 USD |
| Domain, email, backups | 5-10 USD |
| **Total early** | **~25-70 USD** |
A second source IP is the main scaling lever, not CPU.

### Deployment
One Docker Compose stack on a Linux box (already the operator's pattern) behind Caddy; migrations via a plain SQL runner; feature flags per integration (`st_verify`, `st_poll`, `oracle_only`); canary and recorded-fixture contract tests in CI; nightly Postgres dump; season archive exported as static JSON.

---

## 6. Roadmap, risks, legal, open questions

### 6.1 Smallest playable slice (2-3 weeks): "Depot Run"
**[corrected]** The week-by-week text below is the first draft and is superseded by **Depot Run v2** in the Deep dive (D2-C), which fits the real API: no contracts, depots are importing markets, tokens optional. Kept for reference.
Goal: test whether *real delivery work turning into Reach consequences* is fun, with the least build.
- Week 1: adapter + atlas + season clock; link via pasted agent token (observer + reporter modes); 1 depot waypoint with a published demand list of 4 goods; verification by authenticated read of the player's contracts/market transactions **[corrected]** (contracts are private to the player and one at a time; use depot-market `transactions` read by our keeper instead); mint Alloy/Fuel into a guild ledger.
- Week 2: tiny Reach: 12-sector graph, 3 guilds (seeded with the operator's own agent plus 2 NPC-scripted guilds), one action type (commit resources to a sector for the weekly resolution), bounty board with 5 hand-made bounties; web page showing map and ledger.
- Week 3: one weekly resolution with 3-6 friendly testers (and one bot author); the reset becomes the season end; a retrospective with a fun/boredom survey.
Out of scope for the slice: espionage, research, treaty automation, hosted tokens, portals.
**Success criteria:** at least half of testers do an unprompted second delivery; at least one tester changes a Frontier behavior because of a Reach event; bot author reports the bounty loop is worth coding for.

### 6.2 Riskiest assumptions and cheap tests
| Assumption | Cheap test |
|---|---|
| Reach consequences make players care about Frontier deliveries | Paper prototype with a spreadsheet and a Discord for one week; hand-mint from screenshots |
| Deliveries can be verified reliably with few API calls | Spike: reconstruct 20 known deliveries from our own agent using only the endpoints in 4.4 |
| Rate limit is enough | Count calls in the slice; budget table in 4.2; load-test the limiter with the recorded fixtures |
| Challenge-response identity works without tokens | Try it with two own agents; measure friction |
| Enough players exist | Post the pitch to the SpaceTraders community Discord before building; count volunteers |
| Resets do not wreck pacing | Run one slice-season across a real reset and see if players return |
| Gaming/wash trading is bounded | Red-team: the operator's own fleet attempts to farm mint with self-trades |
| API stability | Subscribe to changelog; replay recorded fixtures weekly |

### 6.3 Legal, ToS and etiquette (verify before launch; this is not legal advice)
- **Read the SpaceTraders terms and the Discord rules** and ask the maintainer for explicit blessing; frame it as a community tool. Third-party games built on it are plausible but unconfirmed. **[corrected]** On 2026-11-14 no terms-of-service document was found on spacetraders.io or the dashboard (only an email "Use Policy" at login), and the Discord rules are not public (V30). The README does encourage "share market price data" and "create a Discord bot" (V29). Absence of a ToS is not permission; ask in the Discord and keep the reply.
- Do not **imitate** the SpaceTraders brand; use a distinct name and say "built on the SpaceTraders API".
- **Rate limit** is per IP **and** per account **[corrected, V2]**: do not circumvent by proxy-rotating in ways the terms forbid; a polite polling budget and a published reader policy matter more than extra IPs. Using a second IP for *our own* capacity should be disclosed and cleared.
- **Tokens are credentials:** minimise storage, encrypt, document, allow deletion; never store account tokens; privacy policy (GDPR basics for emails).
- **Data redistribution:** our public atlas republishes game data; confirm it is allowed, and that caching the galaxy is acceptable (the galaxy is public).
- **Play-fairness:** we should not give some players privileged API access; tools that give an unfair advantage over other SpaceTraders players (not just ours) may be unwelcome. Our demand board may move real market prices; be transparent and consider the "good citizenship" research bonus (impact-limited trading) as a way to avoid harming non-participants.
- **Dependency risk:** the game must degrade to oracle-only or Reach-only mode (4.5) if access is withdrawn.
- No real-money mechanics at first; avoid anything resembling gambling or paid advantage derived from a third party's economy.

### 6.4 Open questions for the human
1. Is the audience your own fleet plus friends, or the SpaceTraders public? (Changes trust, ToS, hosting.)
2. Should bots be allowed to give Reach orders in ranked play, or only mint?
3. Do we want a hosted "Quartermaster" that runs players' fleets (token custody, rate-limit and ToS exposure), or strictly bring-your-own bot?
4. Is it acceptable to exist in a world where our demand board moves real markets that other SpaceTraders players use?
5. Which Reach tone: serious grand strategy, light/comic, or minimal "score game"?
6. Willingness to contact the SpaceTraders maintainer first?
7. Can the existing stcommand fleet act as the **keeper network** (the "eyes" at depots), and is the operator comfortable with that dual role (player and referee)? Conflict-of-interest rule suggestion: a referee fleet never competes for mint.
8. Time budget: is weekly-season cadence acceptable for a one-developer live service?

---

## Deep dive: integration layer and Depot Run v2 (written 2026-11-14, from verified facts only)

Everything below uses only facts marked CONFIRMED or CORRECTED in "Verification". Where a design step depends on a V-row that is UNVERIFIABLE, it says so and names the experiment (E1-E3, D2-F).

### D2-A. The integration layer, redone

#### A1. What the Frontier gives us (the real menu)

| Need | Endpoint | Token? | Ship? | Returns that we can use | Rate cost |
|---|---|---|---|---|---|
| Season clock | `GET /v2/` | no | no | `resetDate`, `serverResets.next`, `health.lastMarketUpdate`, `stats`, leaderboards (credits top 15, charts top 5), announcements | 1 |
| Does the agent exist, wealth, fleet size | `GET /v2/agents/{symbol}` or paged `GET /v2/agents?limit=20` | no | no | `symbol, headquarters, credits, startingFaction, shipCount` | 1 / agent, or 1 / 20 agents |
| Atlas | `GET /v2/systems?limit=20&page=n`, `GET /v2/systems/{s}/waypoints?limit=20` | no | no | systems with embedded waypoint list; traits, `chart.submittedBy`, `isUnderConstruction` per waypoint | 352 / 10,321 for full galaxy |
| Gate topology | `GET .../jump-gate` | no | no | `connections[]` | 1 |
| Gate progress | `GET .../construction` | no | no | `materials[{tradeSymbol,required,fulfilled}]`, `isComplete` (aggregate, no contributors) | 1 |
| Depot market static | `GET .../market` | no | no | imports/exports/exchange lists only | 1 |
| Depot market live + transactions | `GET .../market` | **yes** | **ship at waypoint** | `tradeGoods[]` (price, supply, activity, tradeVolume) and `transactions[]` (`shipSymbol, tradeSymbol, type, units, pricePerUnit, totalPrice, timestamp`) | 1 |
| Player's cargo/contract/credits | `GET /my/agent`, `/my/contracts`, `/my/ships` (paged 20), `/my/ships/{s}/cargo` | player's token | n/a | exact state | 1-3 per player |
| Presence | `POST /my/ships/{s}/scan/ships` | our token | Sensor Array | nearby ships' symbols/nav | 1 + cooldown |
| Departures push | websocket `GET /my/socket.io` | our token | n/a | `systems.{s}.departure` | 0 per event (unverified limits) |

No public per-agent history, no public ship list, no public contract list, no event webhooks (V19, V20, V31).

#### A2. How a guild member's action is proven

Principle: **the proof is a row that the game itself wrote and that an independent reader (our keeper ship or a public endpoint) can see; a player's report only says where to look.** Ship symbols start with the agent symbol (V19/`register` text), so a row with `shipSymbol = THEOREM-7` belongs to agent THEOREM. Identity is `(agentSymbol, resetDate)` (V11).

| Claim | Player says | We look at | Match rule | Residual doubt |
|---|---|---|---|---|
| **Depot delivery** (a SELL to an importing market) | `{depot, good, units, shipSymbol, approxTime}` | depot market `transactions[]` via keeper (token + ship) | exists row: `type=SELL`, `shipSymbol` prefix = agent, `tradeSymbol`, `units` equal (or subset-sum of rows), `timestamp` in `[approxTime-1 tick, now]` | rows may roll off before we read (V17); a player could sell to a market they do not own, which is fine, that is the point |
| **Gate supply** | `{gate, good, units}` | public `construction.materials[good].fulfilled` before/after | **conservation:** sum of accepted declarations in a window <= observed delta; if declarations exceed delta, pro-rate and flag | no contributor in the object (V24): a rival could free-ride on a declaration; pro-rating limits damage |
| **Chart** | `{waypoint}` | public waypoint `chart.submittedBy`, `submittedOn` | `submittedBy == agentSymbol` and `submittedOn >= resetDate` | strongest evidence in the API: public, attributed, timestamped; one charter per waypoint |
| **Identity link (challenge)** | nonce `N` | depot market `transactions[]` via keeper | a PURCHASE (or SELL) of exactly `N` units of the named cheap good by a ship with the agent prefix within the challenge window | same as depot delivery; also needs `N <= tradeVolume` |
| **Wealth / fleet milestone** | credits, shipCount | public `GET /agents/{symbol}` | within +-X% of the claim | weak: credits move, fine for score bands not minting |
| **Contract completed** | contract id | token-only `/my/contracts/{id}` (player's own bot reports, or opt-in hosted) | `fulfilled=true` and `terms.deliver[].unitsFulfilled == unitsRequired` | private; max 1 contract at a time so volume is tiny; treat as a low-weight badge, not a mint |
| **Presence/hold** (post-slice) | `{waypoint, from, to}` | token `GET /my/ships` (opt-in) or keeper `scan/ships` | nav shows `waypointSymbol` and `status` over sample times | no public ship list (V19); cost is ship-time |

Evidence bundle stored with every mint (extends 4.3):
```
{ evidenceId, kind, season:{resetDate, universeKey:"<agent>@<resetDate>"},
  agent:"THEOREM", claimedBy:"reporter|hosted|observed",
  reads:[{ endpoint, params, fetchedAt, http, bodySha256, extracted:{...} }],
  rule:"depot_sell_v1", result:"verified|partial|disputed|rejected", reasonLine:"1-line why" }
```
Raw bodies are stored for 30 days, hashes forever; market `transactions[]` rows are the only game-authored proof so we archive each row that backs a mint.

Trust levels: **T1** public + attributed (chart). **T2** keeper-read game row, attributed by ship prefix (depot SELL, challenge). **T3** public aggregate with our own attribution (gate supply, conservation-checked). **T4** token read by us (contracts, ships). **T5** player report only. Minting weight: T1/T2 full, T3 full when the conservation check passes, T4 half, T5 zero (display only).

#### A3. The budget, for 50 / 500 / 5,000 players

Daily IP budget: 2 x 86,400 = **172,800**; planning ceiling 70% = **~121,000**. Assumptions: 30-min tick (48/day), 4 claims per ST-linked player per day, 5% audited (2 calls each), 3 gates watched, status every 5 min, roster by paged `/agents?limit=20` hourly (177 agents = 9 pages = 216/day), atlas = systems crawl 352/week amortised 50/day, depots D scale with players.

Fixed per day: status 288 + roster 216 + gates 3 x 144 = 432 + atlas 50 = **986**.

**Mode R, reporter (recommended): players' bots push signed reports; we read only depots, gates, public rosters; no player tokens.**

| Players | Depots D | Depot reads 48 x D | Audits 0.4 x N | Fixed | Total/day | % of 172.8k |
|---|---|---|---|---|---|---|
| 50 | 5 | 240 | 20 | 986 | **1,246** | 0.7% |
| 500 | 20 | 960 | 200 | 986 | **2,146** | 1.2% |
| 5,000 | 60 | 2,880 | 2,000 | 986 | **5,866** | 3.4% |

Cost is O(depots), not O(players). Burst: a tick's reads (D <= 60) fit inside one 30-call burst plus 30 s. But the real constraint is **keeper ships**: one per depot, bought and kept alive in the game, each needing fuel/ship upkeep; that is game credits and one fleet, not API calls.

**Mode H, hosted (we poll each player's token: `/my/agent` + `/my/contracts` + `/my/ships` p1 = 3 calls per tick = 144/day/player):**

| Players | Player polling | + Mode R base (depots, fixed) | Total/day | % of 172.8k |
|---|---|---|---|---|
| 50 | 7,200 | 1,226 (no audits) | **8,426** | 4.9% |
| 500 | 72,000 | 1,946 | **73,946** | 42.8% |
| 5,000 | 720,000 | 3,866 | **723,866** | **419% (impossible)** |

Hosted ceiling at 121k/day with 3 calls per 30 min: about 820 players; at 2 calls per hour (48/day): about 2,500. A tick for 500 hosted players is 1,500 calls = 12.5 min at 2/s, so ticks overlap if anything else queues. Hosted mode is an opt-in convenience for <= ~300 players, never the base.

**Reality check (V32):** only 177 agents exist on the server this week (11,220 accounts ever). The 500 and 5,000 rows are therefore ~300 and ~4,800 players who are Reach-only/observer, costing zero Frontier calls, or a world where SpaceTraders itself grew. Size the Frontier layer for 50-200 linked agents; the Reach layer is the one that scales.

Reset week spike: systems crawl 352 calls (~3 min of full budget) plus ~100 depot-system waypoint pages, run at background priority in the first hour after `resetDate` changes.

#### A4. What we may keep and display (until the maintainers say otherwise)

Keep and show, because it is the game's own public data and the README encourages sharing it (V12, V14, V29):
- agent symbol, HQ, starting faction, credits, shipCount (as returned by `/agents`), charts by `submittedBy`;
- atlas (systems, waypoints, traits, gate connections, construction totals), re-keyed by season;
- depot market snapshots and the `transactions[]` rows *our keeper saw* (these are observations by our own agent); show in aggregate and for guild members, hold individual rival rows for the Reach (espionage) layer.

Keep only with opt-in and a stated retention: player-reported manifests, tokens (Mode H, max one reset), email (our login, GDPR basics).

Do not keep or show: account tokens (never requested), any token in logs, other agents' private state (contracts, cargo) that we could only obtain via somebody's token, and a full mirror of the market for redistribution until V30 is answered. Always label our display "built on the SpaceTraders API, not affiliated".

### D2-B. Does the "depot waypoint" idea work?

Short answer: **not as written; it works if "depot" means "a market that imports the good", or "a construction site".**

What can be observed on the real API when goods go to a waypoint:

| Event | Observable? | By whom | Attributed? | Notes |
|---|---|---|---|---|
| Sell cargo to an importing market | Yes, `transactions[]` in `GET market` | any token + ship at that market | Yes (`shipSymbol` prefix) | Real credits paid to the player by the game. Retention window unknown (V17). Per-trade cap = `tradeVolume` |
| Supply a construction site | Aggregate yes (public `fulfilled`) | anyone, no token | **No** | `POST .../construction/supply` returns only `construction` + `cargo` to the supplier `[SPEC]` |
| Deliver to a contract | Only the agent | token | n/a | faction-issued, max 1 |
| Ship-to-ship transfer (`/transfer`) | Not by third parties | n/a | n/a | do not accept it as a delivery (wash-trade path) |
| Jettison | No | n/a | n/a | goods vanish |
| Park a ship at a waypoint | Not publicly | token owner; keeper `scan/ships` | partial | no public ship list (V19) |
| Chart a waypoint | Yes, public | anyone | Yes | one-time per waypoint |
| Buy a ship / scrap etc. | Only the agent | token | n/a | `shipCount` public (coarse) |

Ranked list of verifiable observable events (best first), by trust (T-level above) and cost:

| Rank | Event | Trust | Cost | Use in game |
|---|---|---|---|---|
| 1 | Chart (`chart.submittedBy`) | T1 | 1 call / 20 waypoints, no token, no ship | exploration/survey points, onboarding quest; only works while uncharted waypoints exist (home systems are pre-charted by a faction) |
| 2 | Depot SELL row | T2 | 48 reads/day/depot + one keeper ship per depot | the core "delivery" for Foundry and bounties |
| 3 | Identity challenge (PURCHASE of N units) | T2 | same read + one tiny trade | linking without storing a token |
| 4 | Gate `fulfilled` delta + declaration | T3 | 144/day/gate | season Wonder; conservation-checked |
| 5 | `/agents` credits/shipCount | T3 weak | 216/day for the whole roster | score bands, spectator ladders, not minting |
| 6 | Contract fulfilled | T4 | 1-2 per check, needs token | badge only |
| 7 | Presence (`scan/ships`, `/my/ships`) | T4 | ship-time + cooldown | post-slice (blockades) |

Design consequences: (1) publish **demand slots** only for markets that already *import* the good; compute them from the static, public import list (cheap, token-free) and from the keeper's live `supply` when available. (2) Mint on the SELL row, key by good tier, cap per tradeVolume window. (3) Wash-trade check: if the *buyer* side of the same good at the same market within the window is a ship from a linked agent that also sells to the same market, pair-cap it; both sides are in `transactions[]`. (4) Our referee keeper ships should never be paid out (conflict of interest, open question 7).

### D2-C. Depot Run v2 (replaces 6.1), 15 working days

**Hypothesis:** a player who sells goods at an importing market and sees a guild ledger/bounty change in a Reach page will do a second delivery they would not otherwise have made.

**Scope (what is real):** Frontier events: depot SELL (T2), chart (T1), optional gate supply (T3). Reach: one ledger, one weekly sector commit, 5 hand-made bounties, one web page. No tokens stored, no hosted sync, no contracts, no espionage, no blockades, no portals.

**Day-by-day** (Day 1 = Mon 2026-11-16, right after the 2026-11-15 13:00 UTC reset; resets are about each Sunday, so Day 6 straddles 11-22 and the test season starts at the 11-29 reset):

| Day | Work | Output / gate |
|---|---|---|
| 1 | Run E1-E3 results into notes; decide V17/V18 outcomes. Build typed `st-adapter` with the shared token-bucket (2/s, 30 burst, `x-ratelimit-type` check), zod schemas from the OpenAPI spec | Adapter + recorded fixtures from live public calls |
| 2 | Season clock watcher (poll `/` every 5 min, `resetDate` change = season rollover, `serverResets.next` heads-up); Postgres schema (season, player, st_link, claim, evidence, ledger_entry, event) | Reset replayed from fixtures |
| 3 | Atlas crawler: systems pages (352) then lazy waypoint pages for chosen depot systems; pick 5 depot markets (importing a good with healthy `tradeVolume`), 1 gate | Atlas JSON for 1 season; depot short-list |
| 4 | Keeper plan: 5 cheap ships parked at depot markets by the operator's own agent (or tester agent) and reader job (1 market read / depot / tick); store every `transactions[]` row with hash | First 24 h of rows captured |
| 5 | Verifier v1: `depot_sell_v1` (match report to row), `chart_v1`, `link_challenge_v1`; evidence bundle writer; unit tests on rules in `packages/rules` | Re-verify 20 known own sells from stored rows (gate for week 2) |
| 6 | Reporter API: `POST /reports`, `GET /claims`, idempotency keys; link flow with nonce purchase and pasted-token fallback (token discarded after `/my/agent`) | A tester can link an agent in under 2 min |
| 7 | Mint rules from data (`season_rules`): tier table, diminishing return `1/(1+n/k)`, per-depot slot caps | Ledger entries reproducible from event log |
| 8 | Guild + ledger + bounty board (5 hand-made bounties, reward in Alloy/Fuel Cells, deadline in ticks); 2 NPC-scripted guilds | Seed data; bounty accept/submit |
| 9 | Reach mini: 12-sector graph, one action "commit N resource to sector", weekly resolution function (pure) | Resolution replayed in tests |
| 10 | Web: map, guild ledger, claims page with evidence links, season clock; "verification pending" tick UX | Public read-only page |
| 11 | Dry run on live depots with operator's own agents only (2 agents as 2 guilds + red-team: self-trade, transfer, replay, wrong-prefix claims) | Red-team report; fix list |
| 12 | Fixes + tester onboarding doc; Discord post asking the SpaceTraders community for volunteers and the maintainer for blessing (V30) | 3-6 testers + 1 bot author confirmed |
| 13 | Rehearse the reset: simulate `resetDate` change with fixtures, dead links, re-link flow | Reset runbook |
| 14 | Season starts at the 2026-11-29 reset: onboard testers in the first hour; bounties live; Scramble chart quest | Live season |
| 15 | Watch, nudge, do not fix features; log every claim; at the next reset (about 2026-12-06) run the retro | Fun score + metrics |

(If testers are late, the test season slips one week; nothing else changes.)

**Definition of fun to test (all measured, decided before launch):**
1. At least half of testers make an unprompted second depot delivery within 48 h of their first mint. (Behavioural, from claims.)
2. At least one tester changes a Frontier action because of a Reach event (a bounty, a ledger change, a rival's sector commit). Evidence: claim timestamps after the event and a one-line why in the survey.
3. At least 60% of testers re-link after a reset without being pushed twice. (Retention across the weekly cliff.)
4. Median time from link to first verified mint is under 24 h and 90% of valid claims are verified within 2 ticks. (Verification feels fair.)
5. Survey, 1-5 after day 3 and at the retro: "I understood what my delivery did" >= 3.5 average; "I would play next week" >= 3.5.
6. The bot author writes a Quartermaster loop against `/bounties` and reports it was worth the effort (a yes/no with a reason).
Fail fast: if after 5 days fewer than 3 testers have a verified mint, the verification path is the problem, not the fun.

### D2-D. Every place the plan must change (checklist, applied above where marked [corrected])

1. Header/status: add verification pointer; plan was unchecked (done).
2. Section 2A Foundry: depots are importing markets; remove sponsored contracts (done). Scoring matrix: Foundry "verifiability" 4 stays only if E1 passes; rate-limit cost 3 -> 4 in reporter mode; resilience stays 3. Mercenary board is unaffected and becomes the safer anchor.
3. Section 2B Portal: gate is per-system; attribution is ours (done).
4. 3.2 Espionage row and worked example 2 (blockade): no public ship list (done); mark post-slice.
5. 3.2 Exploration row: charts are first-charter-only and home systems are pre-charted by factions; a Scramble quest works only in systems nobody charted.
6. 3.2 Victory row and worked example 3: conservation-checked gate shares (done).
7. 3.5 reset: Sunday 13:00 UTC observed, manual re-registration, `(agent, resetDate)` identity, `serverResets.frequency` is intent (V6, V9, V11).
8. 4.1: no read-only tokens; token retention max one reset; keeper-read challenge (done).
9. 4.2: per-IP and per-account limits, budget by mode, 352/10,321 crawl numbers, no ETag, no proxy pool (done).
10. 4.3: `frontier_market_obs.source` gains `keeper`; archive `transactions[]` rows; `player_frontier_state` only in Mode H.
11. 4.4: transactions are a field not an endpoint; retention unknown (done); add trust levels T1-T5.
12. 4.5 failure table: add "keeper lost/ship destroyed or out of fuel" and "transaction window shorter than poll" rows; add `maintenance` (error 3100) as a down case.
13. 4.6 API: add `GET /evidence/{id}`, `GET /depots` (importing markets + slots), `POST /links/challenge` returns a good, units `N`, depot, expiry.
14. 4.7 events: add `frontier.keeper_health`, `frontier.tx_row_archived`; `frontier.presence_sampled` moves to post-slice.
15. 4.8 pseudocode: `st.reregister()` uses the author's account token (done).
16. 5 cost: a second IP is mandatory (own service must not share an IP with any live fleet), keeper ships cost game credits; add them to the cost model.
17. 6.1 slice replaced by v2 (done); 6.2 add rows below; 6.3 ToS wording (done); 6.4 add question 9.

New rows for 6.2:
| Assumption | Cheap test |
|---|---|
| Depot `transactions[]` includes other agents' rows and lives longer than a tick | E1 |
| Gate `fulfilled` moves visibly and nothing attributes the supplier | E2 |
| Market refresh cadence and reset-boundary behaviour are as assumed | E3 |
| A maintainer answers on ToS within a week | Post in the Discord; no answer = launch gate stays closed |

New open question 9: **Which agent plays keeper?** Keepers must be agents we own; they are real accounts in a game of ~177 agents, and they hold markets' `transactions` visibility, so decide whether the operator's own agent doubles as referee (conflict, question 7) or a dedicated "referee" agent is registered each week by the operator with their own account token.

### D2-E. Risk register: the third-party dependency

| Risk | Likelihood | Impact | Concrete mitigation |
|---|---|---|---|
| **ToS unknown or restrictive** (V30): no terms found; Discord rules private | Medium | Launch blocker (legal/relationship) | Ask the maintainer in the official Discord before inviting anyone; keep their reply; ship under a distinct name with "built on the SpaceTraders API" disclaimer; publish a reader policy (rates, contact) and honour any change; keep Reach-only fallback so withdrawal is survivable; no money mechanics |
| **Redistribution/wrapping** of market data | Medium | Takedown request | Display aggregates and own-keeper observations; do not offer a bulk mirror endpoint; make the public atlas lazy and rate-limited; honour removal |
| **Rate-limit shared with other clients** (per IP and per account) | High if on a shared host | Starved verification | Separate IP for the service; token bucket with priorities (clock > claims > atlas); 70% ceiling; honour `retry-after`; check `x-ratelimit-type` to separate game 429 from infra 429/502; no proxy rotation |
| **API drift / alpha instability** (V33) | High | Parsing failure, wrong mints | One adapter, zod schemas from the OpenAPI spec, recorded fixtures, hourly canary, auto-fallback to Oracle mode (feature flag) when validation fails; subscribe to the changelog and Discord announcements; pin `version` in logs |
| **Downtime / maintenance** (`SystemStatusMaintenanceError` 3100) | Medium | Delayed verification | Queue claims for 6 ticks (existing rule), idempotent evidence ids, "Fog of Static" state, backfill after recovery from archived rows; the keeper reads are the single point, so archive rows as they arrive |
| **Transaction retention shorter than poll** (V17) | Unknown | Verification gaps | E1 measures window; poll at window/2; fall back to challenge windows and T3/T1 events only; if retention is under 5 min, class T2 is dropped and the slice pivots to charts + gate + contracts-by-report |
| **Reset timing moves** (V6) | Medium | Season mismatch | Boundary = observed `resetDate` change; 1-tick grace; never a calendar |
| **Token leak** | Low if we avoid storage | Full-power credential exposure (V13) | Default reporter mode; if stored: encrypt, GET-only allow-list, delete at reset, never log, tell the user how to rotate in the dashboard |
| **Tiny player base** (V32) | High | No guild dynamics | Make Reach playable without Frontier (observer tier), recruit in the Discord, bots as NPC guilds, keep slice to 3-6 testers |
| **Maintainer shuts or changes the game** | Low-Med | Product ends | Reach has its own value without minting; seasons archive; Oracle fallback; do not build irreplaceable content on the Frontier |

### D2-F. Three experiments for this week (exact calls)

Rules: do not create new agents with a token from us; E1 and E2 use an agent the operator already owns, from the operator's own machine. E3 is unauthenticated and can run from anywhere. The reset is at 2026-11-15T13:00Z (verified in the status), so E3 runs tomorrow and E1/E2 are best run on the new universe after it, from Sunday afternoon.

**E1. Market transactions: who is visible, for how long, and does a challenge purchase show up**
Needs: one owned agent with a ship at an exchange/export market (a probe is enough), about 1 unit of a cheap good.
Calls (all authenticated with the operator's own token):
1. `GET /v2/systems/{S}/waypoints/{W}/market` every 5 min for 4 h (48 calls). Save every response.
2. At minute 30: `POST /v2/my/ships/{ship}/dock`, then `POST /v2/my/ships/{ship}/purchase` with `{"symbol":"<cheap good>","units":7}` and note the clock; repeat once at minute 90 with `units: 11`.
3. After each, `GET .../market` at +1, +5, +15, +30 min.
Look for: (a) `transactions[]` length and oldest/newest `timestamp` (the retention window and cap); (b) distinct `shipSymbol` prefixes (other agents' rows visible?) and how many rows per hour; (c) does the 7-unit row appear after 1 min or only on the next market refresh (compare with `health.lastMarketUpdate`); (d) is `units` > `tradeVolume` rejected; (e) does a SELL by another agent appear. Decision: if (a) window >= 30 min and (b) others visible -> T2 class works; if only own rows -> T2 collapses to "challenge only", downgrade depot mints to T4 (player report + audit with their token).

**E2. Construction: what does a supply change, and who can supply**
Needs: an owned agent with a ship at (or able to reach) a gate site, and a few units of FAB_MATS or ADVANCED_CIRCUITRY (or the cheapest required good).
Calls:
1. Unauthenticated, every 30 s for 15 min: `GET /v2/systems/{S}/waypoints/{G}/construction` (30 calls). Record `fulfilled` per good.
2. Authenticated: `GET /v2/my/agent/events` before and after.
3. Authenticated: `POST /v2/systems/{S}/waypoints/{G}/construction/supply` with `{"shipSymbol":"...","tradeSymbol":"FAB_MATS","units":1}`.
4. If the operator has a second owned agent: try the supply with a ship whose agent did not start in that system (HQ elsewhere), to test V25.
Look for: (a) does the public `fulfilled` change by exactly 1 within one poll; (b) the supply response body (only `construction` and `cargo`?); (c) any new row in `/my/agent/events` mentioning the supply; (d) any error that says gates are owner-only or system-restricted; (e) whether the public object ever shows the supplier. Decision: no supplier visible and cross-system supply allowed -> conservation-checked Wonder (D2-B rank 4); supply denied cross-system -> the Wonder becomes per-guild home-gate races, scored by completion time.

**E3. Reset boundary and market cadence (unauthenticated, tomorrow)**
Calls: `GET /v2/` every 60 s from now until 2026-11-15T14:00Z (about 1,300 calls over 22 h, 0.8% of one day). From 12:55Z to 13:30Z tighten to every 10 s (about 210 calls). Also `GET /v2/agents?limit=20&page=1` at 12:55, 13:05, 13:15, 13:30 and `GET /v2/agents/WHATER` (a leaderboard agent) at the same times, and `GET /v2/systems?limit=1` once per minute in that window.
Look for: (a) the exact UTC when `resetDate` changes and when `serverResets.next` moves one week on; (b) status text/`status` field and any 3100 maintenance outage and its length; (c) `stats.agents` falling to ~0 and when it climbs; whether old agent symbols 404 and `/systems` content changes; (d) the series of `health.lastMarketUpdate` values: is it every 1, 5, 15 or 30 min (V18); (e) whether `announcements` change. Decision: sets the season-boundary grace window and the market polling interval; also the length of the downtime the Fog of Static must cover.

Optional free sweep today (unauthenticated, about 25 calls): read `chart.submittedBy` for the first 20 waypoints of 5 non-home systems to see how many are pre-charted by factions versus agents; this sizes the chart-quest idea.

### D2-G. Does the core idea survive?

Yes, but narrower. What survives: the premise (verified Frontier work mints Reach resources), the season clock (weekly reset, observable from a public endpoint), the bounty board, and the gate as a shared objective as an aggregate-only, conservation-checked counter. What dies or moves: sponsored contracts, public presence sampling and blockades, per-contributor gate attribution from the game, a single shared gate for everyone, and the idea that the Frontier audience can scale to thousands (about 177 agents this week). One unproven hinge decides how strong the proof is: whether depot `transactions[]` show other agents' rows long enough to read (E1). If it fails, the design falls back to charts (public, attributed), gate counters (public aggregate) and player-token audits, which is weaker but still buildable.
