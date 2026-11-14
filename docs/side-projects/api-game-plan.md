# Side project plan: a tick-based, adversarial, API-first trade game

Status: plan only (2026-11-14). Sources: SpaceTraders public docs/API as I know them (agents, ships, waypoints, markets with supply/activity, contracts, jump gates and the construction mission, shipyards, weekly reset, 2 req/s per-IP limit with burst 30), plus general knowledge of Screeps, Battlecode, Halite, CodinGame, Vindinium, EVE-style markets and SpaceMolt-type API MMOs. Nothing here was verified live; treat numbers as starting guesses to be tuned by self-play (section 6).

---

## 1. SpaceTraders: strengths, gaps, opportunities

### What it does well
- Excellent bot-author ergonomics: plain REST, one bearer token per agent, discoverable resources, real-time state with no client library needed.
- A coherent economy: supply levels (SCARCE..ABUNDANT) and activity (RESTRICTED..STRONG) give prices a readable cause; production chains exist and can be fed.
- Low barrier, long ceiling: a 20-line script makes money, an optimised fleet manager is weeks of work.
- Weekly resets give everyone a fresh start and keep the game small enough to run cheaply.
- Public leaderboards and an open community, which is most of why people write bots at all.

### Gaps (honest ranking of opportunity)
| # | Gap | Why it matters | Opportunity |
|---|-----|----------------|-------------|
| 1 | API budget is the dominant constraint (2 req/s per IP). The winning meta is request-efficiency and extra IPs. | Rewards infrastructure tricks, not strategy; punishes hand players and honest bots. | **High.** Replace wall-clock request limits with game-internal action budgets resolved per tick. |
| 2 | No real adversarial interaction. Agents share a galaxy but cannot hurt, block or outbid each other in any directed way. | Bots optimise a static puzzle; no opponent modelling, no arms races. | **High.** Piracy/blockade/price war with deterministic resolution. |
| 3 | Markets are NPC price-takers. Players trade against the server, never each other. | No order books, no market making, no arbitrage between players. | **High.** Player-run ports and an order book layered on an NPC floor/ceiling. |
| 4 | No player-to-player contracts. Contracts are server-issued only. | The most interesting bot problem (counterparty trust, pricing risk) is absent. | **High.** Escrowed, programmable contracts between agents. |
| 5 | Information is symmetric and mostly free except for API cost. | No scouting value, no intel market, no deception. | **Medium-high.** Stale, location-dependent information with an intel trade. |
| 6 | Weekly reset erases all progress, so long-term strategy is shallow; the same opening is replayed. | Optimal play converges to a scripted opening. | **Medium.** Seasons with a small persistent layer (knowledge, reputation), not wealth. |
| 7 | Production chains matter for the gate, not for agents: agents rarely own production. | Industry is flavour. | **Medium.** Agent-owned factories whose output is the tradeable good. |
| 8 | Fairness between hand players and bots: a bot with parallel calls beats a human trivially. | Humans quit. | **High if solved by ticks**: a human clicking once per tick is equal to a bot on time, unequal only in decisions. |
| 9 | Observability: no replay, no per-tick event log, no "why did my order fail" ledger, limited public stats. | Bot authors debug blind. | **High, cheap.** Event-sourced, replayable ticks and public replays. |
| 10 | Sybil/alt abuse and multi-account IP rotation to widen budget. | Distorts competition. | **High.** Per-agent budgets that don't scale by adding IPs; costly identities. |
| 11 | Little uncertainty: deterministic prices, no weather, no shocks. | Little room for risk management. | **Medium.** Seeded events (storms, droughts) as public forecasts plus private noise. |
| 12 | Few cooperative structures (no alliances with mechanical meaning). | Social layer is outside the game. | **Medium.** Guilds with shared warehouses and treasury API. |

Not worth chasing: another graphics layer, deep combat simulation (Screeps/Battlecode own that), a token/crypto economy.

---

## 2. Five concepts

### A. Saltmarch (archipelago logistics) 
Pitch: hundreds of islands joined by sea lanes. Ships take integer ticks to cross lanes; weather and currents change lane cost; pirates and rival blockades contest chokepoints. Players own ports and ships and trade through a shared order book.
- Core loop: buy raw goods, haul to a port with a processing slot, sell finished goods; contract and escort for others.
- Bot-author interest: routing under time-varying costs, convoy sizing vs raid risk, market making in a port you own.
- New vs SpaceTraders: ticks and action points, player ports, escrow contracts, raiding.

### B. Caravanserai (continental caravans)
Pitch: land trade with roads, tolls, bandits and seasons. Players build and maintain road segments and charge tolls.
- Loop: caravans along road graph; upkeep of roads; seasonal demand.
- Interesting: toll-setting game, infrastructure as a public good.
- New: player-owned infrastructure. Weaker: land maps are less novel and travel is very similar to space travel.

### C. Guildhall (ship-less factory-chain and contract city)
Pitch: no movement at all. Agents own workshops in one city-state, buy inputs on an order book, convert via recipes with real time/capacity, and sell outputs or fulfil each other's contracts. A pure market/production optimisation game.
- Loop: quote, produce, hedge, settle.
- Interesting: market making, derivatives-like contracts, cartel detection.
- New: all-economy, trivially cheap to simulate and balance. Weaker: no geography, little for scouting or raiding, can feel like a spreadsheet.

### D. Gridfall (grid tactics economy)
Pitch: a shared grid where units harvest tiles and fight over them each tick (Screeps-lite).
- Interesting: tactics. New: economy is secondary. Weaker: crowded by Screeps/Halite/Battlecode; high engineering cost for balance.

### E. Ledgerhouse (a meta-game layer on top of the real SpaceTraders API)
Pitch: we do not build a world. We build a service next to SpaceTraders that adds what it lacks: identity and careers that survive the weekly reset, guilds, player-to-player contracts with escrow, fair bot leagues, replays and analytics, shared intel, and play-money prediction markets. Players keep flying their SpaceTraders agents as usual; Ledgerhouse is the social, competitive and memory layer around them.

**What the layer adds (specifics)**
| Feature | How it works on top of SpaceTraders | Feasibility |
|---|---|---|
| Cross-reset persistence | A Ledgerhouse *career* (stable id) links one agent per weekly universe. We snapshot final credits, ships, charts and rank just before each reset and keep them forever. Season = N weeks; career stats, reputation, badges, "agent lineage" pages. | High: this is the layer's best idea. Risk: the snapshot must be taken in the minutes before the reset. |
| Bot leagues and tournaments | All agents play the same public universe at the same time, so a league is a scoring window: e.g. "credits gained between Monday 00:00 and Friday 00:00 UTC, normalised by start", or divisions by API-call efficiency (calls reported by the client SDK). Fair because the world is shared; unfair because early-week luck and system proximity differ (see below). | High, with caveats on verification. |
| Guilds and alliances | Purely off-game: shared treasury is *ours* (a play-credit ledger), guild score = sum of members, shared intel pool. Nothing in SpaceTraders can enforce in-game cooperation. | High, but it is bookkeeping, not mechanics. |
| P2P contracts and escrow | Escrow only works for things we can verify from public data (e.g. "agent X will have a ship of type Y at waypoint Z by time T" via public endpoints) and settles in Ledgerhouse play-credits, never real SpaceTraders credits (those cannot be transferred between agents through the API). Contracts are therefore *bets on observable state*, not real deliveries. | Medium: limited to the small set of publicly observable facts. |
| Analytics and replay | Poll public data into our own time series: agent list and public stats, market data we or volunteers observe, leaderboards from the status endpoint. Replays are *reconstructed* from sampled snapshots, not tick-exact. | Medium: great for dashboards, weak as replay. |
| Betting / reputation markets | Play-money prediction markets on public outcomes ("who tops the week's credits", "will the jump gate complete"); reputation = calibration score. No real money (gambling law, ToS). | High and cheap; fun but marginal. |
| Shared intel network | Members upload market, shipyard and chart observations (signed, timestamped) and get the pooled map back. This directly saves each member's request budget. | High value; trust problem (fake data) handled by reputation and cross-checking duplicates. |
| Human + bot co-op | Web console where a human sees the bot's state, sets goals and approves purchases while the user's own bot executes through the user's token on the user's machine. | Medium: needs a client SDK on the user side. |
| Unusual ideas | (1) "Handicap league": score = credits per API call, which rewards efficiency and makes the per-IP limit part of the game instead of a nuisance. (2) *Bot rental*: publish a strategy as a signed config others can run on their own agent, with royalties in play-credits. (3) "Ghost races": replay the leader's recorded decisions against your own results. (4) Cross-week "career mode" achievements ("completed a gate in week 3"). (5) A public *API-budget market*: players trade request-time slots on a shared-IP lane (only if the maintainers allow). | Mixed; (1) and (3) are the best. |

**Hard limits (verify with the maintainers before building; I could not confirm ToS wording in this session)**
- **Per-IP rate limit** (2 req/s, burst 30 as I know it): a central service that calls with users' tokens would serve everyone from one IP and collapse at about 50 active agents. Therefore **all token-authenticated calls must run on the user's own machine** (SDK/daemon), and the service consumes only *public* endpoints (agent lookup, status, leaderboards) plus signed reports. Poll budget for 1,000 agents once per hour: about 0.3 req/s, fine; per-minute polling is not.
- **ToS / maintainers.** Third-party tools and dashboards are common in the community, but a commercial or competition layer that induces many agents, rotates IPs, or touches tokens may conflict with their terms. Treat written permission as a gate: a short email asking "may we run a league and a read-only public-data poller?" is the first task of the whole project.
- **Weekly reset.** Everything in-universe disappears; our schema must be keyed by `(career, reset_date)` and the reset detector (`GET /` status endpoint, `resetDate`) must trigger a final snapshot. If we miss the window the week's final data is gone for good.
- **No webhooks.** We can only poll; there are no tick or event pushes, so near-real-time features (live battle, live auction) are impossible; plan around slow cadence.
- **Dependency risk.** Their API can change, rate-limit harder, ban our poller's IP, or go down mid-league. Everything we build on it is hostage; mitigation is to keep the layer's core (identity, ledger, guild, contract, league) *game-agnostic* and treat SpaceTraders as one adapter.
- **We cannot change the game.** None of gaps 1, 2, 3, 8 (budget, adversarial play, markets, hand-play parity) can be fixed from outside; the layer only addresses 4, 5 (partly), 6, 9, 12.

**How the layer reads state: tokens or public only?**
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Public endpoints only | No custody of secrets; no ToS worry about token handling; no shared-IP collapse | Sees only agent symbol, credits, ship count, headquarters, faction, leaderboard rows | **Default** for leagues and persistence |
| User-held tokens in our service | Rich data | Agent tokens are *full-control* (no read-only scope as I know it) so a leak lets an attacker fly or sell the fleet; also all calls come from our IP | **Reject** |
| Client SDK on the user's machine, which signs reports | Rich data, spreads load across users' own IPs | Reports are self-asserted and forgeable | Use for *optional* extras (intel, efficiency scores), never for ranking without cross-checks |

**Anti-cheat: verifying claims about agent state**
1. *Proof of control:* the user's client performs a challenge-derived action the public endpoints can see (for example, change credits by a nonce-defined amount through a trade or a ship purchase pattern within a window) and the server confirms via the public agent endpoint. The token never leaves their machine.
2. *Rank on publicly verifiable numbers only:* credits and ship count from the public agent record, sampled at fixed times by us. Anything else (profit per call, strategy label) is a self-reported tag with no prize attached.
3. *Cross-checks:* the client's claimed credits must match our public sample within tolerance; mismatch voids the entry.
4. *Sybil:* one owner, N agents per league, and the same-IP/same-start-time clustering test; since the real game accepts any number of agents, we cannot prevent alts, only exclude them from prizes.
5. *Gaming the window:* scores are deltas over a window with a fixed sampling schedule published in advance; snapshots at random times inside a published interval prevent last-second tricks.

**Scoring E in the matrix** reflects: low differentiation as a *game* (it is SpaceTraders plus a social layer), partial fill of gaps, cheap to build, but nearly zero balance control and a hard external dependency.

### Scoring matrix (1-5, weights reflect "one developer, bot authors, differentiation")
| Criterion (weight) | A Saltmarch | B Caravanserai | C Guildhall | D Gridfall | E Ledgerhouse (layer) |
|---|---|---|---|---|---|
| Differentiation from SpaceTraders (3) | 4 | 3 | 4 | 3 | 2 |
| Fills gaps 1-5 (adversarial, P2P, info) (3) | 5 | 4 | 3 | 3 | 2 |
| Cost/complexity for one dev (3) | 3 | 3 | 5 | 1 | 4 |
| Balance-testability via self-play (2) | 4 | 3 | 5 | 2 | 1 |
| Human playability by hand (2) | 4 | 4 | 4 | 2 | 3 |
| Replay/spectator appeal (1) | 4 | 3 | 2 | 5 | 3 |
| Independence from third parties (3) | 5 | 5 | 5 | 5 | 1 |
| **Weighted total (max 85)** | **76** | **65** | **71** | **49** | **46** |

(Independence was added as a criterion once concept E made dependency risk a real axis; without it the totals are A 56, B 47, C 56, D 34, E 43 out of 70 and the ranking is the same.)

Recommendation: **Saltmarch**, built as a **Guildhall core first** (the market/production engine is shared; geography is a layer added in phase 2). A and C are within a few points because they share the engine; the extra differentiation (piracy, scouting, blockade) breaks the tie for A. If the geography layer proves too costly, Guildhall ships as a game on its own.

**Does concept E change the recommendation? No, but it changes the plan in one way.** E cannot fix the problems that motivated the project (API budget as the dominant constraint, no adversaries, price-taker markets), because those live inside a game we do not control, and it carries an uncontrollable dependency. As a *route*, "layer first, then graduate" is therefore **not better** than building the world directly: the layer proves demand for leagues and careers, but it does not test the risky mechanics (tick/AP budgets, raiding, P2P order books), and half the audience's patience is spent on a product that is not the final one. What is worth taking from it:
- **Build the identity, ledger, guild, contract-escrow and league services game-agnostic** (adapter per game). Saltmarch is the first-party adapter; SpaceTraders could be a second, optional one. This costs little and is the real "graduation path".
- **Optional marketing funnel (about 2 weeks, in parallel with phase 0, only if the maintainers agree):** a public-endpoint-only weekly league and career page for SpaceTraders agents, to collect an audience of bot authors for the alpha (tests risk 6 below directly). Cut it if permission is not granted or it takes more than 2 weeks.

---


## 3. Saltmarch: full design

### 3.1 World model
- Archipelago of ~200 islands per shard, generated from a seed (Voronoi islands, lanes as a planar graph of ~600 edges). Each lane has a length in ticks (3-40), a **danger** (0-100) and a **weather** state that shifts lane time by up to +-30% on a public forecast (7 ticks ahead, noisy: accurate 80%).
- One **tick = 60 seconds** in beta (30 s later if load allows). All state changes happen at tick boundaries; between ticks the world is frozen and readable.
- Regions of ~25 islands form a **sea** (a shard region). Shards run 800-2000 agents; a season runs ~4 weeks.
- Islands have: 1-3 **resource nodes** (timber, iron ore, salt, grain, fish, clay, flax), 0-1 **harbour** (market + dock slots), 0-2 **build plots**, a population (NPC demand).

### 3.2 Entities and resources
| Entity | Key fields | Notes |
|---|---|---|
| Agent | id, name, treasury, AP, reputation, guild | Identity; AP is the rate limiter. |
| Vessel | id, class (skiff 20 / cutter 60 / brig 150 / galleon 400 cargo), hull, crew, location, route, cargo | Moves along lanes; upkeep per tick. |
| Port | island, owner (NPC or agent), dock slots, fee schedule, stock per good | Owned ports set fees and run an order book. |
| Workshop | port, recipe, capacity, queue, efficiency | Runs a recipe with batch time. |
| Order | side, good, qty, limit price, port, expires tick | Resting book at a port. |
| Contract | issuer, taker, terms (deliver X to port P by tick T for price), escrow, penalty | Peer-to-peer or NPC. |
| Guild | members, shared warehouse, treasury, roles | Mechanical alliances. |
| Intel | subject, payload, observed_tick, signature | Tradeable information item. |

Goods (24 total, 4 tiers): T0 raw (timber, iron ore, salt, grain, fish, clay, flax, coal), T1 (planks, iron bars, salted fish, flour, bricks, cloth, charcoal, glass), T2 (tools, sailcloth, bread, ship fittings, barrels, lamps), T3 (ship kits, charts, luxury goods, cannon). Each recipe is 2-3 inputs to 1 output with 3-8 tick batches. Ship kits are the sink that builds more ships.

### 3.3 Economy

**Price formula (NPC port AMM, per good g at port p).** Each port-good has stock `s`, target stock `T` (set by island type, e.g. a timber island has T high for timber, low for tools), and base price `b`.

```
mid(s)   = b * (T / max(s, 1)) ^ 0.5          clamped to [0.25 b, 4 b]
ask(q)   = (1 + f) * integral from s-q to s of mid(x) dx     (cost to take q units)
bid(q)   = (1 - f) * integral from s to s+q of mid(x) dx     (proceeds for giving q units)
         with f = 0.03 (port spread), integral = 2 b sqrt(T) (sqrt(hi) - sqrt(lo))
```
Closed form makes execution deterministic and integer-safe (use fixed-point with 1e-4 credit precision). Price is path-independent and reversible in stock, like SpaceTraders; impact per lot is visible in advance via `GET /ports/{id}/quote`, so there is no hidden slippage.

**NPC floor and ceiling.** The AMM is always available, so no good is ever untradeable; player order books at the same port sit inside the AMM band. Players beat the AMM by quoting tighter than `f`, which makes market making the intended mid-game.

**Stock dynamics per tick (NPC islands).**
```
s += production(node) - consumption(pop) + (T - s) * r      r = 0.002 mean reversion
```
Raw nodes produce `k_node` units/tick (e.g. 4-12) free of cost: this is the main **faucet of goods**. Population consumption is a **sink of goods**: pop * c_g per tick for food and consumer goods.

**Faucets (credits):** NPC AMM buys at `bid` (goods become credits only through the AMM or contracts); NPC contracts (a budget per island per day, capped by a global `contract_budget` scaled to active-player count); starting grant (new agents).
**Sinks (credits):** port fees (1-3% of trade), docking fees, crew upkeep per vessel per tick, hull repair, spoilage of perishables (grain/fish 0.5% of stock/tick), ship-kit purchase, building plots (one-off), insurance premiums to NPC underwriter, contract penalty burn (50% of penalty burns, 50% to counterparty), wealth-tax-like **harbour levy** on idle treasury above 2x median (0.05%/tick).
**Anti-inflation:** a controller tracks total credits and credits per active agent every 24 h. If money supply growth exceeds target (3%/day), it scales NPC contract budget and AMM bid base `b` for T3 goods down by up to 15%. The adjustment is published (`GET /economy/policy`), so bots can model it instead of being surprised. Aim: median agent net worth grows linearly, not exponentially, after day 3.

### 3.4 Player-to-player interaction
- **Order book + AMM** at every port (`POST /ports/{id}/orders`); owner port fees are set by the owner within 0-5%; owners compete for traffic.
- **Escrow contracts**: any agent can post, accept, or counter. Contract template: `{deliver|pay|stake}`, deadline tick, collateral. Settlement is automatic at the delivery port when the buyer's docked vessel holds the goods; disputes cannot happen because the server verifies delivery.
- **Piracy (adversarial layer).** A vessel with `stance=raider` may `intercept` a lane. Resolution at tick end, per lane and per vessel pair, deterministic from `H(seed, tick, lane, vessel_ids)`:
  ```
  p_catch = clamp(0.1 + 0.5*(raider_speed - target_speed)/target_speed + 0.01*lane.danger - 0.15*escorts, 0.02, 0.9)
  ```
  Loot is at most 40% of cargo (the rest is "scuttled": a sink). Raiders gain **infamy**; infamy raises NPC patrol response and harbour refusal. Escorts, insurance, and convoy mechanisms are all purchasable.
- **Blockade**: a guild may station vessels at a port; it raises dock waiting time for non-members, not an outright ban (avoids hard locks).
- **Alliances**: guilds share a warehouse and can post guild-wide contracts; guild treasury is multi-sig by role (API: `POST /guilds/{id}/proposals`).
- **Insurance** is a player-underwritten contract type; adverse selection, correlated risk and reinsurance are bot-author playgrounds.

### 3.5 Information model
- Prices and stock at a port are **only live if you have a vessel docked there or a standing agent (harbour factor) at that port**. Everything else is `observed_tick` stamped data (the response carries `age_ticks`).
- Public feed: weather forecast, lane danger (updated hourly), a delayed 60-tick public price **index** per good per sea (average, no stock).
- **Scouting** costs AP and a vessel's time; **factors** (paid agents at ports) cost credits per tick and give live data for one port.
- **Intel trade**: signed `Intel` objects can be sold; signature binds `observed_tick` so buyers can price staleness. Fake intel is possible (agents sign their own claims) and trust becomes a reputation game.
- **Fog**: other agents' vessels are visible only within 1 lane-hop of your own vessels/ports, with a position accuracy that degrades with distance. Treasury is private; net worth is public only to the nearest 10% bucket.

### 3.6 Progression and seasons
- **Season**: 28 days. Everything resets (treasury, vessels, ports) except the **persistent layer**:
  - **Reputation** (per agent): contract completion rate and volume, weighted with decay; gives small start perks like a slightly lower collateral requirement (max 10% effect).
  - **Charters** (unlocks): recipes or hull classes unlocked by achievement carry over *as access, not wealth*: they let you start with a T2 recipe known, but cost capital to use.
  - **Cosmetics, names, achievements, public replays and bot "career stats"**.
  - Carryover wealth is capped at 2% of the median season-end net worth so that new players are never locked out.
- **Mid-season "tides"**: week 2 and week 3 inject a shock (a new sea opens, a recipe tier unlocks, a storm season) so the optimal opening isn't a fixed script and late-joining agents have a seat at the table.
- **Late-join catch-up**: new agents get a start grant that scales with season day, up to 40% of the median wealth.

### 3.7 Fairness and anti-abuse
- **Action points, not request rates.** Each agent has `AP`, regenerating 1/tick to a cap of 60 (so a bot or a human can spend about 1 action per tick on average and burst up to 60). Each write costs AP (move 1, trade 1, build 5, post contract 2, scout 3). **Reads cost 0 AP but are state-cached per tick**: polling faster than a tick returns the same ETag'd body, so more IPs/more requests buy nothing. A generous per-agent HTTP ceiling (600 req/min per token) exists only to protect the server; the rate-limit key is the token, not the IP.
- **Sybil resistance:** account creation needs a GitHub/email-verified owner (max 3 agents per owner per shard), a proof-of-work puzzle (about 5 s CPU), and starting capital that is non-transferable for 48 h and then subject to a 10% transfer tax between agents with the same owner or tightly correlated trade graphs. Collusion detection (self-trading loops, wash trades) runs offline on the event log and voids score credit, not trades.
- **Determinism and no hidden randomness:** all RNG from `H(seed, tick, ...)`; no client-visible nondeterminism, so nothing to farm by retrying.
- **Idempotency** keys on all writes so network retries never double-spend AP.
- **Hand-play parity:** one action per minute is competitive; large-batch bot play is bounded by AP and by market depth. Bots are allowed and encouraged (first-class); there's a "hand" division on leaderboards for agents that never exceeded N actions/hour and sleep (self-declared, spot-checked via action timing entropy).

### 3.8 Leaderboards and scoring
| Board | Metric | Notes |
|---|---|---|
| Net worth | liquid + holdings at AMM bid | Primary; per season. |
| Trade efficiency | profit per AP spent | Rewards cleverness over spam. |
| Market maker | spread captured x uptime | Rewards liquidity provision. |
| Reliability | contract completion x value | Trust board. |
| Raider/defender | net loot vs losses; convoys delivered | Adversarial board. |
| Growth (rookie) | net worth gain, first 7 days | Newcomer board, and "hand" division. |
| Guild | pooled net worth and contracts | Social. |

No composite "overall" score; seasons award badges per board so that multiple strategies are viable.

### 3.9 Playing by hand
A small static web client (read-only map, order ticket, contract inbox) calls the same public API with a session token. Since only one action per tick is needed for competitiveness and prices only change at ticks, a human can play in short check-ins: queue a route of up to 8 legs and standing orders (`POST /vessels/{id}/plan`) that execute while away. Standing orders cost AP when executed, not when queued, so hand players aren't penalised for planning.

---

## 4. API design

### 4.1 Conventions
- Base: `https://api.saltmarch.example/v1`, JSON, `Authorization: Bearer <agent_token>`. Register: `POST /agents` (owner token + PoW) returns the agent token (shown once).
- **Tick model:** writes are *intents* queued for the next tick; response returns `202` with `{intent_id, resolves_at_tick}`. Results are read from `GET /intents/{id}` or the event stream. Immediate local validation (budget, ownership, schema) returns `4xx` right away so bots fail fast.
- **Idempotency:** `Idempotency-Key` header required on every POST/PUT; replays within 24 h return the original response.
- **Pagination:** cursor (`?cursor=&limit=`, max 200), responses `{data, next_cursor}`.
- **Errors:** RFC 9457 problem JSON: `{type, title, status, code, detail, tick, retryable, ap_cost, ap_balance}`. Stable machine `code` values (`INSUFFICIENT_AP`, `PORT_FULL`, `STALE_QUOTE`, `NOT_DOCKED`, `LANE_CLOSED`).
- **Budget headers on every response:** `X-AP: 42/60`, `X-AP-Regen: 1`, `X-Tick: 18231`, `X-Tick-Next-In: 37`.
- **Versioning:** URL major (`/v1`), additive minor changes announced in `GET /meta` (`schema_version`, `season`, deprecations with dates); old major supported through one full season.
- **Realtime:** `GET /stream` (SSE) with `tick`, `intent.resolved`, `contract.offer`, `vessel.attacked`, `market.trade` (own ports only). Webhooks optional: `POST /webhooks` with HMAC-signed `tick` and `intent.resolved` events, retried with backoff. SSE sends `Last-Event-ID` resume.

### 4.2 Endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /agents | Register (owner token, PoW) |
| GET | /agent | Own state: treasury, AP, reputation, guild |
| GET | /meta | Season, tick, schema version, rules constants, economy policy |
| GET | /map | Islands and lanes (static, ETag, cacheable all season) |
| GET | /islands/{id} | Island detail, nodes, plots |
| GET | /lanes/{id} | Lane length, danger, weather forecast |
| GET | /ports/{id} | Port info and fees (age-stamped if not docked) |
| GET | /ports/{id}/quote | `?good=&side=&qty=` exact AMM cost and book depth |
| GET | /ports/{id}/book | Order book (live only if present/factored) |
| POST | /ports/{id}/orders | Place limit/market order |
| DELETE | /orders/{id} | Cancel |
| GET | /vessels, /vessels/{id} | List, detail |
| POST | /vessels/{id}/move | Route to a port (server pathfinds, returns ETA) |
| POST | /vessels/{id}/plan | Queue up to 8 steps (move, trade, load, unload) |
| POST | /vessels/{id}/stance | `peaceful` / `escort` / `raider` |
| POST | /vessels/{id}/intercept | Raider on a lane |
| POST | /vessels/{id}/cargo | Load/unload between hold and port warehouse |
| POST | /ports/{id}/workshops | Build workshop (recipe) |
| POST | /workshops/{id}/queue | Queue batches |
| GET/POST | /shipyards/{port}/ships | Catalog and buy (ship kits as inputs) |
| GET/POST | /contracts | Browse, post |
| POST | /contracts/{id}/accept, /counter, /cancel | Lifecycle |
| GET/POST | /intel | Browse intel for sale, publish, buy |
| POST | /factors | Hire a harbour factor for live port data |
| GET/POST | /guilds, /guilds/{id}/proposals | Guild ops |
| GET | /events | Own event log (cursor, replayable by tick) |
| GET | /leaderboards/{board} | Season boards |
| GET | /replay/{season}/{tick} | Public state at a past tick (anonymised) |
| GET | /stream | SSE |
| POST | /webhooks | Register callback |

### 4.3 OpenAPI outline
```yaml
openapi: 3.1.0
info: {title: Saltmarch API, version: 1.0.0}
servers: [{url: https://api.saltmarch.example/v1}]
security: [{bearer: []}]
components:
  securitySchemes: {bearer: {type: http, scheme: bearer}}
  parameters: {IdempotencyKey: {in: header, name: Idempotency-Key, required: true, schema: {type: string, maxLength: 64}}}
  schemas: {Problem, Intent, Vessel, Port, Quote, Order, Contract, Intel, Tick, Page}
paths: {/agent: ..., /ports/{id}/quote: ..., /vessels/{id}/plan: ...}  # generate from code (zod/oapi-codegen), publish at /openapi.json
```
The spec is generated from the code's types (single source of truth) and a typed client is published for Python and TypeScript from CI.

### 4.4 Sample bot loop (pseudocode)
```
client = Saltmarch(token)
for event in client.stream():                      # one wake per tick
    if event.type != "tick": continue
    me      = client.agent()                       # cached per tick, free
    if me.ap < 6: continue                         # keep a reserve
    for v in client.vessels(idle=True):
        quotes = []
        for (src, dst, good) in candidate_routes(v):      # local cache of map + stale quotes
            buy  = client.quote(src, good, "buy",  v.free_hold)
            sell = estimate_sell(dst, good, v.free_hold)   # stale: discount by age
            eta  = path_ticks(src, dst, forecast) 
            risk = lane_danger(src, dst) * cargo_value(buy) * 0.01
            quotes.append((sell - buy.cost - fuelcrew(eta) - risk) / eta, src, dst, good)
        best = max(quotes)
        if best.value > MIN_PROFIT_PER_TICK:
            client.plan(v.id, steps=[move(best.src), buy(best.good), move(best.dst), sell(best.good)],
                        idempotency_key=f"{v.id}:{event.tick}")
    for c in client.contracts(open=True, near=me.ports):
        if worth_taking(c): client.accept(c.id)
```

### 4.5 First hour for a new player
1. `POST /agents` (2 min): get token, starting grant 5,000 c, one skiff in a safe home harbour, 60 AP.
2. `GET /meta`, `/map`, `/agent`: read the rules (the response includes a `tutorial` field with the next three suggested calls).
3. **Guided first contract** (NPC, no deadline pressure): "deliver 20 salt from the harbour to the next island": teaches `quote`, `plan`, `move`, settlement. Pays enough to cover a first cutter-up purchase.
4. Minute 15-30: first free-market loop (planks to the neighbouring island), the first order placed on the book.
5. Minute 30-60: unlock a workshop slot; first view of the leaderboard; invitation to a **practice sea** (sandbox, 10 s ticks, resets daily, no leaderboard) for experiments.
6. A rookie shield: no raiding of agents under 48 h old or below a cargo value cap.
A 40-line Python starter bot ships in the docs and in the repo, with a reference trader that earns about the median rookie wage.

---

## 5. Technical architecture (one developer)

### 5.1 Stack
- **Language: Go** (single static binary, fast, great concurrency, easy fixed-point math, oapi-codegen) for the API and sim. TypeScript is the alternate if the developer prefers; the sim is the performance-insensitive part, the correctness part is the determinism.
- **DB: Postgres** for accounts, intents, the event log, snapshots, leaderboards. Live world state lives **in memory** in the sim process, rebuilt from the latest snapshot plus the log on restart.
- **Queue:** none external initially: an in-process channel for intents with Postgres as the durable log (write intents to the log before ack). Add NATS or Redis streams only if the API tier is split from the sim.
- **Hosting:** one Hetzner/OVH VPS (4 vCPU, 8 GB, about 10-15 EUR/mo), Caddy for TLS, Cloudflare in front (free) for static map and docs, nightly pg_dump to object storage (Backblaze B2, about 1 EUR/mo).

### 5.2 Tick design (deterministic, replayable, testable)
```
loop each tick T:
  1. freeze: collect intents with arrival < T boundary into batch B (sorted by (tick, agent_id, seq))
  2. validate + charge AP (in stable order)
  3. apply phases in fixed order: movement -> interceptions/combat -> docking -> orders match (price-time) -> workshops -> contracts settle -> NPC economy update -> economy controller
  4. emit events (append-only), compute state hash
  5. publish snapshot for reads (copy-on-write per tick, ETag = tick), push SSE
```
- State is a pure function: `next(state, intents, seed) -> (state', events)`; **no wall clock, no map iteration order, no floats** (fixed-point int64). The same input log replays to the same hash (golden-file tests; the CI replays a recorded 10k-tick season and compares the final hash).
- Matching: price-time priority within a tick; ties resolved by `H(seed, tick, order_id)`; AMM executes last at the post-match stock.
- Snapshot every 100 ticks (gob/proto into Postgres/object storage); event log retained for replays and for the analysis site.

### 5.3 Data model sketch
```
agents(id, owner_id, name, token_hash, created_tick)
intents(id, agent_id, tick_received, kind, payload jsonb, idem_key unique(agent_id, idem_key), status, result jsonb)
events(tick, seq, agent_id?, kind, payload jsonb)            -- append-only, partitioned by day
snapshots(tick, blob)                                         -- binary world state
ports/vessels/workshops/orders/contracts/intel               -- materialised view tables refreshed each N ticks for SQL analysis, source of truth in memory
ledger(tick, agent_id, delta, reason, ref)                    -- double-entry, sums must reconcile with the in-memory treasuries every 100 ticks
leaderboard_snapshots(season, board, tick, rows)
```
A reconciliation job asserts conservation: sum of credit ledger deltas equals the economy controller's faucet minus sink totals. Any mismatch pages the developer.

### 5.4 Scale and thousands of bots
- Write path: 5,000 bots x about 5 intents/tick = 25k intents/min, roughly 400/s: trivial for one Go process; batch inserts of the intent log per tick (COPY).
- Read path: world snapshot built once per tick and served as pre-rendered, ETag'd JSON per resource; agent-specific views are small. With `Cache-Control: max-age` aligned to the next tick and a CDN for public data, 5,000 bots polling cost nearly nothing; SSE for the rest (5k open connections is fine in Go).
- Self-play load test: spawn 5k in-process bots calling the sim directly (no HTTP) for balance; separately run a 500-bot HTTP soak.

### 5.5 Cost estimate
| Item | Monthly |
|---|---|
| VPS (4 vCPU/8 GB) | 12 EUR |
| Backups/object storage | 2 EUR |
| Domain, email (Resend free tier) | 2 EUR |
| Cloudflare (free) | 0 |
| Monitoring (Grafana Cloud free) | 0 |
| **Total** | **about 16-20 EUR/mo** to 1-2k bots; a second VPS for a practice sea if popular. |

### 5.6 Observability
- Prometheus metrics: tick duration, intents/tick, AP spent, rejects by code, event-log lag, money supply, Gini, per-good price index.
- Structured logs with `tick`, `agent_id`, `intent_id`; a public **status page** with tick health.
- Developer dashboard per agent: AP use, rejected intents by code, per-route profit (reads `/events`), replay viewer at `/replay` which re-runs the tick function at any past tick (the same code as the sim, compiled to WASM later).
- Economy alarm rules: money supply growth > 5%/day, one agent > 20% of any good's volume for a day, tick duration > 50% of the interval.

---

## 6. Roadmap, risk, balance testing

### 6.1 Phases
| Phase | Duration | Deliverable | Exit test |
|---|---|---|---|
| 0 Prototype | 2 weeks | Pure-Go sim core: Guildhall slice (one sea of 10 islands, AMM prices, recipes, 3 goods tiers, order book), CLI, deterministic replay, 3 scripted bots | 100k-tick replay hash stable; money supply bounded; scripted trader beats random by 5x |
| 1 Geography + HTTP | 3 weeks | Lanes, vessels, plans, API with AP budgets, SSE, OpenAPI, starter bot | A new bot gets a first profit within 20 minutes of reading docs |
| 2 Private alpha | 4 weeks | 5 invited bot authors, one sea of 40 islands, contracts + intel, raiding (flagged off then on), 1-week mini-seasons | Retention: 4 of 5 still active in week 3; no economy exploit surviving a week |
| 3 Public beta | 6 weeks | Registration (PoW + GitHub), 3 seas, guilds, leaderboards, replays, rookie division, practice sea | 300+ agents, tick p99 < 5 s at 60-s ticks, one full 28-day season completed |

**Cut for v1:** weather forecast noise models, guild multi-sig, derivative contract types beyond deliver/pay, vessel crew skills, cannons/combat beyond the interception formula, WASM replay, mobile client. **Keep:** AP budgets, tick determinism, AMM+book, escrow contracts, interception, intel stamping.

### 6.2 Riskiest assumptions and cheap tests
| # | Assumption | Cheap test |
|---|---|---|
| 1 | Tick-and-AP budgets feel fair and fun, not sluggish, to bot authors who like fast feedback. | Phase 0 CLI with 10 s ticks; ask 3 bot authors to port a SpaceTraders bot in a weekend; measure time-to-first-profit and survey frustration. |
| 2 | Raiding adds depth rather than griefing that drives newcomers away. | Alpha with raiding on for half the seas only; compare 7-day retention of rookies; rookie shield tuned from data. |
| 3 | A player order book gets liquidity on top of the AMM. | Self-play market-maker bots with varying spreads; check if a smart maker earns more than the AMM-taker baseline and whether depth is nonzero at median hours. |
| 4 | Economy does not inflate or collapse (sinks balance faucets). | 1,000-agent, 28-day self-play sims in minutes (no HTTP); sweep faucet/sink constants; target Gini 0.35-0.55 and flat real prices. |
| 5 | Sybil/collusion cannot dominate boards. | Red-team: write a wash-trading and a multi-account bot and see whether the detector flags them; tune transfer tax. |
| 6 | Enough people will build bots for a new game with no community. | Pre-announce to the SpaceTraders Discord and Reddit with a 2-minute demo; count alpha signups before building phase 2 (need 15+). |
| 7 | One developer can run ticks, ops and community. | Time-box ops to 5 h/week in alpha; if over, cut shards. |
| 8 | The persistent layer (reputation/charters) gives continuity without runaway advantage. | Simulate carryover with cohorts in self-play; measure win-rate of veterans vs rookies (target below 55%). |

### 6.3 Balance testing with self-play bots
- **Bot zoo:** random walker; greedy single-hop trader; route optimiser with lookahead; market maker; contract broker; raider (parameter-swept aggression); escort; hoarder/speculator; copycat of the top agent.
- **Method:** fixed seeds x 30 sea layouts x 28-day seasons, run headless at roughly 10^5 ticks/second without HTTP. Track per-strategy net worth distribution, Gini, price volatility, time to first T3 good, raider ROI versus defender cost, and dominant-strategy detection (any strategy with win-rate above 40% across the zoo flags a rebalance).
- **Evolution:** a simple population search (CMA-ES over bot parameters) against the zoo to find exploits before players do; keep winning exploits as regression bots in CI.
- **Invariants in CI:** no negative stock, ledger conservation, no good price outside clamp, replay hash equality, AP never above cap.
- **Live tuning:** constants live in a versioned `rules.json`, announced in `/meta` with an effective tick, never changed mid-sea without a published notice (bots need stability).

### 6.4 Open questions for the human
1. Is the goal a community with many bot authors (favour open API, free, generous AP) or a small competitive scene (favour strong Sybil limits, ranked seasons)?
2. Seasons of 28 days or weekly like SpaceTraders? Longer favours strategy depth; weekly favours quick iteration and cheap resets.
3. Is raiding core (on by default) or an opt-in sea type? This decides the tone of the game.
4. Do you want a hand-play web client in the MVP, or API-only plus a read-only map?
5. Budget and licensing: open-source the sim (great for trust, replay and community balance work) or keep it closed?
6. Will you run your own bots in the same arena (and announce it), or keep a strict developer/player separation?
7. Name, domain and whether to avoid any resemblance to SpaceTraders branding (recommended: fully distinct world, shared only in API ergonomics).
8. Do you want to ask the SpaceTraders maintainers for permission to run a public-data league (concept E) as an audience funnel, and are you willing to hold off if they say no?
9. Is Go acceptable, or does the developer's existing stack (the SpaceTraders manager is Node/TypeScript) push toward TypeScript?
