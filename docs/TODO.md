# Open items

Master list of things in flight — live-ops issues, ideas raised but not
acted on, and decisions pending. Update this as things open and close;
don't let it go stale. When an item closes, move it to `CHANGELOG.md`
(if something shipped) rather than just deleting it.

## Live ops — needs a decision or action

- [ ] **Tour more systems to build cross-system pricing data.** Operator
  request 2026-09-12 — more tour coverage across more systems is needed
  before cross-system routes have enough data to evaluate. **In
  progress, 2026-09-13**: operator is manually converting traders to
  explorer for ~2 hours at a time when a system runs out of good routes,
  to force fresh tour coverage rather than waiting on the existing tour
  ships alone. Worth eventually automating (a doctrine rule that
  temporarily reassigns an idle trader to explore when a system's route
  list runs dry?) rather than a standing manual habit — not scoped.
- [ ] **Set up more approval gates.** Operator request 2026-09-13. Right
  now `ApprovalGate` (`src/engine/approvals.ts`) only gates two
  decisions: `buyShip` (`maybeBuyShip()`) and `buyKeeperProbe`
  (`maybeRequestKeeperProbe()`/`resolvePendingKeeperProbeApproval()`).
  Other consequential, engine-initiated spends run fully automatic today
  — e.g. `maybeBuyScout()`, `maybeBuySiphoner()`, `maybeInstallScanner()`,
  ship repairs (`maybeRepairFleet()`), and ship sales/scrapping. Not
  scoped: which of these actually warrant a human in the loop (repair is
  probably too frequent/low-stakes to gate; a scrap/sell is probably not)
  and whether they share `buyShip`'s two-hour auto-approve-on-timeout
  policy or something stricter.

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

- [ ] **Consider a separate, purpose-built mobile UI.** Raised 2026-09-13
  — operator uses the dashboard on iPhone via Safari's "Add to Home
  Screen" (a PWA shortcut, not a native/sideloaded app). v6's current
  mobile mode (`#mobile-view`'s own `.m-screen` tabs) is a condensed
  reflow of the desktop layout rather than a mobile-first design, and
  has already caused at least one real bug (the Ops tab's Approvals
  pane was simply missing from mobile markup — see `CHANGELOG.md`,
  "mobile Ops tab was missing Approvals entirely"). Not scoped: would
  need a decision on how much of the desktop's density (Fleet table,
  Markets panels, Doctrine sliders) actually belongs on a phone versus
  a narrower "what needs me right now" surface, and whether it's a
  redesign of the existing mobile mode or a genuinely separate build.
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
