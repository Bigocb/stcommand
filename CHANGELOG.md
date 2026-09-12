# Changelog

Every notable change, newest first. One entry per merged change, written
for someone who wasn't in the room — what changed and why, not just what
the commit touched. Decisions with lasting architectural weight get their
own ADR in `docs/adr/` (see `docs/adr/README.md`) instead of just a line
here; link it from the entry when that happens.

Backfilled from git history starting 2026-09-12 going back far enough to
be useful context; not a complete project history — see `git log` for that.

## Unreleased

- Nothing pending yet — add entries here as work lands, then move them
  under a dated heading below on the next meaningful checkpoint.

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
