# stcommand — agent notes

Durable, repo-level knowledge that should survive any one session. See
`docs/architecture-overview.md` for the system-by-system design breakdown
and `docs/TODO.md`/`CHANGELOG.md` for what's in flight or already shipped.

## Operating the fleet via the stcommand MCP server

The `stcommand` MCP server's own `initialize` response carries operating
instructions for its tools — re-read after any MCP reconnect/restart, since
they can be updated independently of this file. Key points worth keeping
here so they don't get lost between sessions:

- **This is a live, persistent fleet, not turn-based.** Ships keep flying
  in the background between tool calls. Re-checking state is cheap;
  re-issuing a command "to make sure it took" usually isn't useful and can
  interrupt a flight that was already progressing correctly (see the
  drift-vs-stuck section above — this is exactly the trap that led to
  misdiagnosing THEO-1C as stuck).
- **Every tool call acts immediately at operator trust level.** There's no
  confirm step except `stcommand_decide_approval`'s own gate.
- **Reassigning a ship's role interrupts whatever it was doing.** Don't
  call `stcommand_set_ship_role` on a ship mid-task without a reason — it
  won't finish its current job first.
- **Movement tools are scoped by distance, and using the wrong one for the
  range fails:**
  - `stcommand_dispatch_ship` — same-system only; sends to a waypoint and
    holds there once arrived.
  - `stcommand_jump_ship` — exactly one hop to an adjacent system through
    a gate.
  - `stcommand_dispatch_tour` — more than one jump away; takes a *system*
    symbol (not a waypoint) and walks the jump-gate graph automatically,
    then tours that system's markets indefinitely once it arrives.
  - Confirmed 2026-09-19: calling `dispatch_ship` with a same-system
    waypoint target failed with `"Failed to execute jump. Waypoint ... is
    not connected to the current location"` for a ship that had just been
    given a `dispatch_tour` system-level destination — same-system moves
    should never require jump-gate logic at all, so this points to a real
    bug in how the coordinator routes a `dispatch_ship` call issued right
    after a `dispatch_tour` call on the same ship, not a usage error.
    Worth a proper look if it recurs.

## SpaceTraders universe resets

SpaceTraders resets its entire game universe **weekly** (per the game's
own public status endpoint, `GET https://api.spacetraders.io/v2/` —
unauthenticated, no token needed — which returns `resetDate`,
`serverResets: { next, frequency }`, and an `announcements` array; resets
are typically Saturday mornings). A reset is a full regeneration: new
systems, new waypoints, new jump-gate layout, new markets — not just a
wipe of player progress. **Every existing agent token becomes invalid at
once.**

### What actually happens when a reset hits, live

Confirmed directly, 2026-09-13: every ship across every tenant started
failing on its very next live API call with
`agent token is from a previous server reset — re-register this agent to
resume`. This is already handled reactively per-tenant —
`src/core/client.ts`'s `request()` matches the API's `401` response text
(`/reset_date does not match/i`) and latches `fatalAuthError` on that
`Client` (exposed as `SpaceTradersAPI.deadTokenReason()`), which stops
that tenant from wasting further calls against a token that can never
work again. `src/http/admin.ts`'s `GET /tenants` now surfaces this per
tenant, and the admin page shows a banner when any tenant has a dead
token — see "Recovering from a reset" below.

**The recovery is NOT just "get a new token."** A reset also invalidates
a huge amount of *data this app has cached*, some of it shared across
every tenant:

- **Shared, galaxy-wide tables** (`Store.SHARED_GALAXY_TABLES` in
  `src/db/store.ts`): `galaxy_systems`, `galaxy_factions`,
  `galaxy_crawl_state`, `market_snapshots`, `market_latest`,
  `shipyard_inventory`, `module_catalog`, `galaxy_jump_costs`,
  `galaxy_gate_construction`. Every one of these is a plain fact about
  the galaxy itself (not any one tenant's observation of it) and every
  one's own migration comment already says so — e.g.
  `011_galaxy_topology.sql`: *"Static for the life of a server reset."*
  Left alone, these actively lie: an old jump-gate connection that no
  longer exists, a market price for a system that's now something else
  entirely. This is exactly why the public cartography page looked
  stale right after the reset — it was reading these tables.
- **Per-tenant tables that name something from the dead universe**
  (`Store.TENANT_GAME_TABLES`): ship-keyed state (`fleet_state`,
  `fleet_flags`, `ship_state`, `ship_claims`, `ship_log`,
  `ship_manifest`, `ship_persona`, `ship_position_history`,
  `held_route`), contracts/missions (`missions`, `pending_approvals`),
  warehouse (`warehouse`, `warehouse_ledger`, `warehouse_targets`), and
  financial/activity history (`ledger`, `bucket_ledger`, `buckets`,
  `activity`, `state_snapshot`). Deliberately **not** included:
  `doctrine`/`doctrine_fires`/`doctrine_fire_log` (operator-configured
  standing orders — a reset doesn't make a margin-floor setting wrong),
  `chat_messages` (co-pilot conversation log), `sessions` (login state),
  `operator_actions` and `tenants.play_profile` (play-style tracking —
  a role change or manual buy from a dead universe is still a real
  historical data point for comparing play styles across resets).

### Recovering from a reset — the admin-page tool

`GET /admin` (the operator-only admin page, `ADMIN_KEY`-gated) has an
"After a server reset" panel that does this cleanup on demand:

1. Re-register each affected tenant with a fresh SpaceTraders token
   first (the normal dashboard sign-in flow) — the admin panel doesn't
   do this part, it only clears stale data.
2. On the admin page, check the tenants whose data should be cleared
   (defaults to whichever tenants are currently showing a dead-token
   banner) and click "Clean up checked tenants + shared galaxy data."
3. This calls `POST /api/admin/reset-cleanup` (`src/http/admin.ts`),
   which wipes each checked tenant's `TENANT_GAME_TABLES`, truncates
   every `SHARED_GALAXY_TABLES` table unconditionally, and calls
   `GalaxyCrawler.resetCrawlState()` so the background galaxy-wide crawl
   (`src/engine/galaxyCrawler.ts`) restarts from page 1 immediately, in
   the current process — no redeploy/restart needed for that part.

A tenant that's already re-registered and flying in the new universe
should be **unchecked** before running this, so its brand-new data
doesn't get wiped right back out — that's what `keepTenantIds` is for.

### Open idea, not yet built: detect a reset proactively

Right now detection is reactive — the app only notices once some
tenant's own ticking happens to make a live call that fails. A cleaner
signal: poll `GET /` (unauthenticated, works even during the dead-token
window) on a slow interval, compare its `resetDate` against the last
one seen (stored somewhere durable, e.g. a new `galaxy_crawl_state` key),
and surface a banner the moment it changes — before any tenant's own
error wall of logs even starts. `serverResets.next` could also drive a
"reset expected soon" heads-up ahead of time, though resets are
scheduled, not guaranteed to fire exactly on time. Not scoped/built;
flagged here and in `docs/TODO.md` for whoever picks it up next.

## Diagnosing a ship that "looks stuck" mid-transit — check logs before concluding it's broken

Confirmed 2026-09-19: a ship correctly mid-flight on a long single-leg
**drift** transit can look, from `stcommand_get_fleet_status` /
`stcommand_get_activity` alone, exactly like a stuck/broken dispatch.
Don't conclude "stuck" from these symptoms without checking Render logs
for that ship's actual navigate/ETA line first:

- **Fuel pinned at a constant value for a long time is NOT a stuck
  symptom.** SpaceTraders deducts navigation fuel entirely **upfront**
  when a flight starts, not gradually over the transit. A ship that
  departed with fuel `X` and shows fuel `X-1` (or whatever the leg cost)
  for the *entire* transit is behaving exactly as expected — there is
  no further fuel draw to watch for until it arrives.
- **No activity-log entries for an hour+ is NOT a stuck symptom either**
  if the ship is on one continuous leg. There's nothing to log mid-flight
  — the ship agent just waits for arrival. Compare against other ships
  only if they're also on a single long leg; a busy multi-hop tour ship
  logging constantly is not a fair comparison.
- **An unchanged target waypoint with no intermediate hops is expected**
  for a direct in-system drift leg (as opposed to a multi-hop
  jump-gate tour like `dispatch_tour`, which does show intermediate
  waypoints).
- **DRIFT mode is slow — ETAs can run into hours.** A ship without
  enough fuel for cruise falls back to drift
  (`"needs X at cruise, have Y/Z"` in the logs), and drift ETAs of
  10,000+ seconds (3+ hours) for a single leg are normal, not a bug.

Before flagging a ship as stuck, check Render logs for that ship's own
`navigating to <waypoint>, ETA <seconds>s` line and do the arithmetic
against wall-clock time — that's the ground truth, not the polled
snapshot fields above.

## Dual-push convention

Render only auto-deploys from `main`, but this repo's actual working
branch is `claude/stcommand-ui-parallel-versions-fd5p9q`. **Every commit
this session makes must be pushed to both** — pushing only to the
feature branch strands the commit and nothing deploys.

## Reporting matched buy/sell P&L (operator ad-hoc requests)

When asked for a "P&L snapshot" or "how are we doing" on trading, **do not**
just diff `stcommand_get_state`'s lifetime `totals.buys`/`totals.sells`
and call the difference "trading net." That number is misleading: it
counts every open buy (cargo a trader is still holding, not yet sold) as
if it were a completed loss, so it reads as roughly break-even even in a
session where every closed trade was profitable.

The right method:

1. Pull `stcommand_get_activity` (limit up to 200) and pick out `kind:
   "buy"` and `kind: "sell"` entries.
2. Match a `sell` to an earlier `buy` on the **same ship + same good +
   same (or subset of) quantity** — that's one completed round trip.
   Sum the buy legs' `credits` (negative) and the sell legs' `credits`
   (positive) per round trip to get its profit.
3. Anything left over is an **open position**, not a loss:
   - A `buy` with no later matching `sell` — cargo still aboard a ship
     in transit or docked, cross-check with `stcommand_get_fleet_status`'s
     `cargo` field for that ship to confirm it's still holding.
   - A `sell` with no earlier `buy` in the fetched window — its cost
     basis happened before the window started; report the revenue as
     realized cash but don't score a margin on it.
4. Report two numbers, not one: **matched trading net** (sum of only the
   completed round trips' profit — the true trading performance) and
   **wallet delta** (the actual credits change, which also absorbs open
   positions, fuel, jump costs, and refuels). The gap between the two is
   explained by those non-trade costs plus whatever's still in cargo —
   call that out explicitly rather than folding it into "trading net."

This matters because fleet overhead (refuels, jump costs — jumps run
~5,000-5,700c each and this fleet's explorers/tour ships jump
frequently) and in-flight inventory can make the naive gross-totals diff
look flat or negative even during a genuinely profitable session.

## Player-facing guidance vs. engineering notes

This file (CLAUDE.md) is read by a Claude Code session working on the
repo — it has no reach into a separate agent that connects purely as a
player over the hosted MCP server (`/mcp`, `src/mcp/`), since that agent
never sees this repo at all. For *that* audience, `src/mcp/server.ts`
sets `PLAYER_INSTRUCTIONS`, the MCP `initialize` response's `instructions`
field — most MCP clients surface it to the connecting model as a hint, so
it's the one message that actually reaches a game-playing agent. It's kept
non-technical on purpose (a player's field guide, not a codebase tour) and
covers, top to bottom: the ship-role vocabulary (trader/miner/siphoner/
surveyor/explorer/scout/tour/keeper — what each one actually does),
moving ships around (dispatch_ship vs. jump_ship vs. dispatch_tour, and
why fuel not draining mid-flight isn't a stall), trading/pricing tools,
buying ships, the approvals gate, the read-state tools, and — the
original seed of this section — the handful of things a live operator
has had to correct a connected agent on more than once: dock/orbit log
lines near departure are often refueling rather than arrival, re-issuing
a command on an already-IN_TRANSIT ship doesn't do anything useful, and
so on. Add to it when a live-ops incident turns out to be a connected
agent misreading normal game behavior as a bug, or when a new tool/role
ships that a player would need to know about — that's the signal this
section exists to capture, the MCP-player equivalent of this file's own
"Reporting matched buy/sell P&L" entry below.

## Docs to keep current

- `docs/TODO.md` — open items; move a closed one to `CHANGELOG.md`
  rather than deleting it outright.
- `CHANGELOG.md` — one entry per shipped change, written for someone who
  wasn't in the room.
- `docs/architecture-overview.md` — the system-by-system design
  reference; update it when a described layer's shape actually changes,
  not for every feature.
- `docs/mobile-app-design.md` — Tower (the `/m` mobile app)'s IA and
  visual identity, and its shipped-vs-pending status per screen.
