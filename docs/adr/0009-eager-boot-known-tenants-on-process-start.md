# Eager-boot every known tenant on process start

`TenantRegistry.bootAll()` (called once from `src/cli/index.ts`'s `main()`,
fire-and-forget, immediately after the pool is created) boots every tenant
already in the `tenants` table as soon as the process starts, instead of
relying solely on `getOrCreate`'s existing lazy boot on a tenant's first
authenticated request.

Without this, "a tenant's engine keeps running whether or not their
dashboard tab is open" (docs/architecture-plan.md §5, ADR 0005) silently
stopped being true across a process restart: a Render redeploy, a crash, or
host maintenance left every tenant's fleet idle until someone happened to
hit an authenticated route for that tenant again — no bound on how long
that could take for a tenant who wasn't actively watching the dashboard,
which is precisely the operator this product's core promise is supposed to
cover. `getOrCreate`'s lazy path stays exactly as it was and is still what
boots a brand-new tenant the moment they register; `bootAll()` only covers
the already-known ones.

Boots concurrently (`Promise.allSettled` over every tenant), not one at a
time — the shared per-process `apiLimiter` `TenantRegistry` already holds
(see its own class comment on why multiple tenants share one rate-limit
bucket) serializes the real HTTP calls fleet-wide regardless, so a separate
throttling mechanism for the boot sweep itself would be redundant. Failures
are isolated per tenant on purpose: one tenant's boot failing (a revoked
token, a transient DB error) must never block any other tenant from
starting, and must never crash the server — `main()` logs and continues.

Not addressed by this change, and worth stating so it isn't assumed fixed:
this makes reboot recovery *closer* to bturney/spacetraders' per-ship
`ShipServerBoot` re-arm-from-persisted-events guarantee, not equivalent to
it. `bootAll()` still re-derives each tenant's live state from a real
`GET /my/agent` + fleet `init()` call rather than resuming from a persisted
timeline the way his `Process.send_after` timers do; see CONTEXT.md's
Cutover/Dual-write entries for the broader pattern this codebase uses
instead (persisted `ship_claims`/`ship_state`/`ship_manifest`, re-hydrated
on `init()`, not a per-entity timer resumed exactly where it left off).
