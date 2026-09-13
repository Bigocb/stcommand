# Open items

Master list of things in flight — live-ops issues, ideas raised but not
acted on, and decisions pending. Update this as things open and close;
don't let it go stale. When an item closes, move it to `CHANGELOG.md`
(if something shipped) rather than just deleting it.

## Live ops — needs a decision or action

- [ ] **Verify the new Yards & outfitting system filter live.** Shipped
  2026-09-13 — see `CHANGELOG.md`. Typechecked/syntax-checked only;
  `tests/dashboard.test.ts` couldn't run against the remote test Postgres
  (`ETIMEDOUT`, same sandbox flakiness as earlier this session). After
  next deploy: pick a system in the Yards & outfitting filter and confirm
  it actually narrows shipyards/modules to that system, and that a ship
  type or module scouted at two waypoints shows grouped under one entry
  with both prices.
- [ ] **Investigate: an approved auto-keeper-probe purchase request didn't
  actually buy the probe.** Operator report 2026-09-13 — approved the
  request via the approval gate, but the ship wasn't actually purchased.
  Not yet root-caused. Check `maybeRequestKeeperProbe()`'s post-approval
  path in `fleet.ts` (the `purchaseShip()` call and what happens if it
  throws/if the yard's stock changed between the request and the
  approval) and the `ApprovalGate` resolution flow itself for a case
  where an "approve" outcome doesn't actually trigger the buy.
- [ ] **Set `PROXY_URL_<AGENTSYMBOL>` for each tenant once dedicated
  proxies are provisioned.** Shipped 2026-09-13 — see `CHANGELOG.md` and
  `.env.example`. Operator is setting up Webshare (free tier, 10 dedicated
  datacenter proxies) as of this writing; once real proxy credentials
  exist, set one `PROXY_URL_*` env var per tenant on Render and confirm
  live that each tenant's traffic actually tunnels through its own IP
  (e.g. via Render logs — no more `rate limited, backing off` lines for a
  proxied tenant even while other tenants are busy).
- [ ] **Tour more systems to build cross-system pricing data.** Operator
  request 2026-09-12 — more tour coverage across more systems is needed
  before cross-system routes have enough data to evaluate. See
  `CHANGELOG.md` for what "tour more systems" actually takes today:
  either send an existing tour ship further out via the dashboard's Tour
  Dispatch panel, or promote/buy another Light Shuttle into the tour role
  first (a tenant can't send away its last home-system tour ship — that's
  hard-blocked).

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
- [ ] **Persist the system-by-system architecture breakdown.** Given
  conversationally on 2026-09-12; not saved anywhere. Worth turning into
  a `docs/architecture-overview.md` if it should survive past one
  session.
- [ ] **Keep one unit of a great-price good on hand as a souvenir/marker.**
  Random idea, 2026-09-12: if a tour ship, explorer, or trader anywhere
  stumbles on an exceptional price for something (antimatter was the
  example), hold back one unit in the cargo hold instead of selling the
  full stack. Not scoped at all yet — would need a definition of
  "exceptional," a decision on whether it's purely cosmetic/informational
  or feeds something else (a log entry, a per-tenant "best find" record),
  and whether it's worth the held cargo space on a ship that might need
  it.

## Closed / resolved (kept here briefly for context, then delete)

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
