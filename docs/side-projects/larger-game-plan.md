# Larger game plan: SpaceTraders as one organ of a bigger body

Status: design plan only, no code. Written 2026-11-14. Sources: public SpaceTraders docs/API knowledge and reasoning; not checked against this repo.
Facts about SpaceTraders below (weekly resets, account vs agent tokens, 2 req/s per IP with burst 30, public status endpoint with leaderboards and `resetDate`) should be re-verified against docs.spacetraders.io before building. Working title: **Meridian Accord**.

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
Reach resources (Alloy, Fuel Cells, Circuitry, Rations...) are produced only by delivering mapped SpaceTraders goods (FAB_MATS, IRON, ADVANCED_CIRCUITRY, FUEL...) to a **depot waypoint** or by completing **contracts we sponsor**. Delivery verified from the ledger of the player's own agent.
Pitch: simplest mental model, strongest meaning for logistics skill.

### B. Portal Sector: a literal gateway
One system in the Frontier is "the Breach". Ships parked at its jump gate, or a contract delivering goods to its waypoint, opens the "Portal" in the Reach map, letting that faction project force or trade at a chosen Reach location. SpaceTraders's own jump-gate construction mechanic (the gate needing FAB_MATS and ADVANCED_CIRCUITRY) becomes the story: building the real gate in the Frontier unlocks the Reach gate for the whole guild.
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
| **Espionage and information** | Covert ops against rival guilds' Reach plans; the Reach has fog of war on rivals' treasuries and stockpiles. | Spies = ordinary Frontier ships doing "intel acts": loiter at a rival's declared depot waypoint, scan a market, chart. Public SpaceTraders data (ships at a waypoint are visible to anyone present) gives true observations of rivals, and our game gives rivals the ability to notice. | Counter-intel: decoy deliveries, falsified "manifest" declarations with a bounded lie budget. Information reports are delivered as text in Reach. |
| **Victory and scoring** | A season ends at the SpaceTraders reset. Score = sector control + wonders (the Breach gate) + treasury efficiency + legacy points. | Frontier performance is a **capped** component (<=40%) so Reach strategy matters. | Winner sets next season's "Edict" (a rule modifier). |

### 3.3 Worked examples
1. **Guild "Ashfall" needs Alloy for a Reach offensive.** Strategist posts bounty: 600 IRON_ORE-derived `ALUMINUM_ORE` units delivered to depot `X1-DF55-A1` in 48h, reward 6,000 Alloy + 40 influence. Bot author's Quartermaster sees the bounty via our API, runs it as a contract-style hauling feed, and our verifier credits Alloy when the market ledger shows the delivery.
2. **Blockade.** Guild "Verdigris" orders 3 ships to sit at the rival's depot waypoint for 12h. We sample the waypoint's ship list (public) every 15 min; the interdiction meter rises while hull signatures are present. The rival sees it and answers with a counter-bounty to buy out the blocker's escort, which is Frontier combat-free, so it is just fuel, patience and presence.
3. **Gate Week.** The season's Wonder is the real jump-gate construction in one Frontier system. All guilds are tempted to contribute (shared score), but contribution share decides who gets the Reach "Portal" ownership. Cooperation and betrayal (withholding at the last 10%) emerge naturally.

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
- **Opening phase** (the first 24h after reset, the "Scramble"): all token holders re-register; bounties for early charting are rich; this matches the real opening where credits are scarce.
- **Frontier hash seeds Reach content:** relic placement, anomaly types and NPC faction homeworlds derive from the new system graph so each season looks different (architecture E, nearly free).
- **Legacy points** convert some Frontier excellence (e.g., final fleet size, total contract completions) into permanent cosmetic/rule perks (titles, a named sector).
- **Hall of Seasons:** archived final state, public.

---

## 4. Interfaces and data

### 4.1 Authentication and token handling
- SpaceTraders has an **account token** (registration, may register agents) and **agent tokens** (act as the agent). We want the weakest thing that proves identity.
- **Preferred proof of ownership without storing a token:** challenge-response via an agent-visible field. Our server issues a nonce; the player (or bot) performs an action only the agent holder can: e.g. **change the agent's headquarters ship role?** is not possible, so the realistic version is: *sell or buy 1 unit of a designated cheap good at a designated waypoint* or *name a chart*... The cleanest verified fingerprint is **a transaction in the public market ledger** referencing the ship symbol and amount encoded by the nonce (for example buy exactly `N` units, where `N` derives from nonce). The verifier checks it through market-transaction history visible to the agent. Cost: one tiny transaction.
- **Fallback (simple, honest):** the player pastes an **agent token** once; we immediately call `/my/agent`, store `agentSymbol`, a hash, and (only if the player opts in to "Hosted Sync") the token encrypted with a server-side key (KMS/libsodium secretbox). Token handling rules: never log; scope to read-only calls except when the player enables "Quartermaster hosting"; one-click revoke (deleting the row) and instruct players to re-register when they want rotation.
- **Third mode: no token at all (public reader).** Because ships/markets expose a lot publicly, the "Observer" tier needs only the agent symbol; it earns no mint but can see.
- We never ask for the **account token**.
- Session identity in our game uses our own login (email/OIDC), bound to one agent per season (agent symbols are per reset).

### 4.2 Reading state without breaking the rate limit
The budget: **2 req/s sustained, burst 30, per source IP**, shared by everyone behind our IP. That is ~172,800 requests/day total, ~120/min. We must treat this as the central scarce resource.
- **Rule 1: poll the least possible; prefer event-driven, caller-pushes.** Bots that already run a fleet *push* signed reports to us (see 4.5) from their own IP; we **verify spot-checks** rather than poll everything.
- **Rule 2: tiered polling by value.** Budget table:

| Tier | What | Frequency | Cost model |
|---|---|---|---|
| Season clock | `GET /v2/` status (unauth) | every 5 min | 288/day |
| Leaderboards | same status endpoint | free with above | 0 |
| Depot waypoints | market `GET .../market` for ~20 depot/wonder markets (needs a ship present or at least it needs one of our "keeper" ships; public parts only otherwise) | 30-60 min, matches game's ~30-min market tick | ~1-2k/day |
| Gate construction | construction endpoint for Wonder system | 10 min | 144/day |
| Per-player verification | `/my/agent`, `/my/ships` (paged), contracts | on claim, throttled to 1 per player per 15 min | scales with claims |
| Spot audits | random 5% of reports | n/a | small |

- **Rule 3: a tenant-owned proxy pool.** Verifications use the *player's own token and our hosted worker per-player* only if the player opts in; heavy sync is better shifted to the player's side (their bot reports). If hosted sync is used, spread by **source IP** (per-region workers or a small proxy pool), documented as the limit is per IP and the ToS question in section 6 applies.
- **Rule 4: global token bucket with priorities** (season-critical > claim verification > background atlas).
- **Rule 5: back-pressure is a game feature.** The Reach "Signal Delay": claims are batched into **Ticks** (every 30 min). Players see "verification pending", which also makes tick-based balance simpler.
- **Public data harvest:** system/waypoint graph is static for the week, fetched once per reset (paged with limit 20: roughly several hundred to a couple thousand requests, spread across a couple of hours at low priority), then served from our atlas.

### 4.3 Caching and snapshot design
- **Immutable-per-season atlas:** systems, waypoints, trait lists; keyed `season_id`. Never refetched.
- **Market snapshots:** append-only `frontier_market_obs(season, waypoint, good, supply, activity, buy, sell, trade_volume, observed_at, source)` where `source` is `ours`, `player_report`, or `public`. Keep latest + rolling 24 h in Postgres, older compressed.
- **Player snapshots:** `player_frontier_state(player_id, observed_at, credits, ship_count, contract_state, token_ok)` every claim; keep daily compaction.
- **ETag/If-Modified:** use conditional headers where supported; otherwise hash bodies to skip writes.
- **Reproducibility:** every mint stores the **evidence bundle** (raw JSON hash + endpoint + timestamp) so disputes are explainable.

### 4.4 Verifying a claimed trade or achievement
Verification classes, strongest first:
1. **Self-attested then confirmed from public data:** delivery to a depot market shows up as supply/trade-volume change; with per-delivery `ship symbol` available in the market's transactions endpoint to someone with a ship there. Our keeper ship at the depot reads the transaction list (the endpoint is visible to agents with a ship present) and matches (`shipSymbol`, `tradeSymbol`, `units`, `timestamp`).
2. **Authenticated read of the player's own state:** `/my/ships/{s}/cargo`, contracts `deliver` progress, `/my/agent` credits. Checks "contract fulfilled" with `contract.terms.deliver[].unitsFulfilled`.
3. **Challenge-response transaction** (section 4.1) for identity.
4. **Cross-evidence:** the same claim must be consistent between player report, our keeper observation and market deltas. Inconsistent claims go to a "disputed" state and mint at 0 until resolved.
5. **Anti-gaming:** self-trading between a player's own two agents is detected by the same ownership graph (same IP/proxy fingerprint, same token owner); cap mint from a pair of agents trading with each other; require goods to move *through a market* (price-forming) rather than ship-to-ship transfers.
- **Wash-trade guard:** mint depends on units delivered to **depot demand slots we publish**, not on arbitrary trades; so there is no way to fabricate value by trading in a loop.
- **Reset guard:** every call carries `season_id`; tokens from a previous reset return 401 and are marked dead.

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
        st.reregister(); meridian.post("/links", challenge=meridian.challenge())
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
Goal: test whether *real delivery work turning into Reach consequences* is fun, with the least build.
- Week 1: adapter + atlas + season clock; link via pasted agent token (observer + reporter modes); 1 depot waypoint with a published demand list of 4 goods; verification by authenticated read of the player's contracts/market transactions; mint Alloy/Fuel into a guild ledger.
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
- **Read the SpaceTraders terms and the Discord rules** and ask the maintainer for explicit blessing; frame it as a community tool. Third-party games built on it are plausible but unconfirmed.
- Do not **imitate** the SpaceTraders brand; use a distinct name and say "built on the SpaceTraders API".
- **Rate limit** is per IP: do not circumvent by proxy-rotating in ways the terms forbid; a polite polling budget and a published reader policy matter more than extra IPs. Using a second IP for *our own* capacity should be disclosed and cleared.
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
