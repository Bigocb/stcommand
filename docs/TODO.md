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
- [ ] **Verify DRAGOM's margin-floor change.** Operator manually changed
  DRAGOM's `marginFloor` (was 20c, hardcoded floor was causing FUEL/
  JEWELRY routes to flap right at the threshold — see
  `docs/rate-limiter-saturation-plan.md`-adjacent investigation on
  2026-09-12). Check whether new routes are clearing now.
- [ ] **Check whether DRAGOM has ever flown a cross-system trade route.**
  Confirmed the pipeline is real (tour ship `DRAGOM-D` is actively
  charting/pricing markets in `X1-RN95`, `trader.ts`'s `viableRoute()`/
  `discoverPrices()` genuinely consider cross-system candidates via
  `GalaxyAtlas.canJump()`) — but every trade actually observed live
  stayed within the home system. Worth checking whether a cross-system
  route has ever been evaluated and rejected, or never even come up as
  a candidate.
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
  cargo-deployed probe changes that mechanic hasn't been investigated.
- [ ] **Persist the system-by-system architecture breakdown.** Given
  conversationally on 2026-09-12; not saved anywhere. Worth turning into
  a `docs/architecture-overview.md` if it should survive past one
  session.

## Closed / resolved (kept here briefly for context, then delete)

- [x] K8s pod-per-tenant and single-deployment exploration — both
  closed. See `docs/k8s-pod-per-tenant-exploration.md`. Conclusion:
  don't migrate; the shared-IP rate limit isn't solved by either shape,
  and the one real Render-restart benefit is achievable on Render itself
  via a health check (see the open item above).
