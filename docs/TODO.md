# Open items

Master list of things in flight — live-ops issues, ideas raised but not
acted on, and decisions pending. Update this as things open and close;
don't let it go stale. When an item closes, move it to `CHANGELOG.md`
(if something shipped) rather than just deleting it.

## Live ops — needs a decision or action

- [ ] **CARO stuck in a purchase-failure loop.** CARO-1/3/4/5/6 have been
  repeatedly failing "insufficient credits" (FUEL x3, MEDICINE x15) on a
  ~10-20 min cycle for over an hour as of 2026-09-12. Not yet
  investigated — need to check CARO's actual live credit balance and
  why the trader/agent keeps re-attempting purchases it can't afford.
- [ ] **Fix the cross-system jump-cost bootstrap gap.** Root-caused
  2026-09-12: `GalaxyAtlas.recordJumpCost()` is only called from
  `fleet.ts`'s and `trader.ts`'s own jump paths, never from the shared
  explore/tour jump path in `shipProxy.ts:711`. So a real jump a tour
  ship or explorer makes (DRAGOM-D's jump to X1-RN95, confirmed live)
  never lowers `crossSystemLegCost()`'s learned estimate — every
  cross-system leg gets priced against the flat, deliberately
  conservative `CROSS_SYSTEM_JUMP_COST_ESTIMATE = 5,000` placeholder
  (`dispatcher.ts:39`) forever, which is high enough that nothing has
  cleared it yet. Closed loop: no cross-system trade route can ever
  become profitable enough to fly, so no real trade jump cost is ever
  recorded to correct the estimate. Fix: wire `recordJumpCost()` into
  `shipProxy.ts`'s explore-jump path too, so every real jump (not just
  trader/fleet-manager ones) feeds the learned-cost cache.
- [ ] **Tour more systems to build cross-system pricing data.** Operator
  request 2026-09-12 — more tour coverage across more systems is needed
  before cross-system routes have enough data to evaluate at all, on top
  of the jump-cost bootstrap fix above.
- [ ] **Render zero-downtime deploys.** `healthCheckPath` is unset on the
  `stcommand` service and there's no health endpoint in the app at all.
  Add a trivial `GET /healthz` route + configure the Render health check
  to get zero-downtime rolling restarts on the existing Starter plan —
  no infra migration needed for this.

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

- [ ] **Probes deployed from cargo on heavy haulers.** Floated as an
  exploratory idea; probes have effectively zero fuel and can't
  self-navigate, so "camping" a market with a probe today means buying
  one directly at a shipyard on that exact waypoint. Whether a
  cargo-deployed probe changes that mechanic hasn't been investigated —
  re-raised 2026-09-12 as an alternative to buying a probe at every
  shipyard for wider market coverage; still not investigated.
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

- [x] K8s pod-per-tenant and single-deployment exploration — both
  closed. See `docs/k8s-pod-per-tenant-exploration.md`. Conclusion:
  don't migrate; the shared-IP rate limit isn't solved by either shape,
  and the one real Render-restart benefit is achievable on Render itself
  via a health check (see the open item above).
- [x] DRAGOM's margin-floor change — confirmed working. Lowered from
  20c to 10c on 2026-09-12; verified via live logs that DRAGOM-1 went
  from flapping/stuck on one route (repeated `margin 19-20c <= floor 20c`
  rejections) to 11 successful route pickups across FUEL/FOOD/MEDICINE
  in the 51 minutes after the change, with zero margin-floor rejections.
  No new failure mode introduced by the looser floor. See `CHANGELOG.md`.
