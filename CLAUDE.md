# stcommand — agent notes

Durable, repo-level knowledge that should survive any one session. See
`docs/architecture-overview.md` for the system-by-system design breakdown
and `docs/TODO.md`/`CHANGELOG.md` for what's in flight or already shipped.

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

## Dual-push convention

Render only auto-deploys from `main`, but this repo's actual working
branch is `claude/stcommand-ui-parallel-versions-fd5p9q`. **Every commit
this session makes must be pushed to both** — pushing only to the
feature branch strands the commit and nothing deploys.

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
