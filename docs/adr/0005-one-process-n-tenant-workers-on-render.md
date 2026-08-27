# One long-running process, N tenant workers, hosted on Render

The engine is a persistent Node process (Express + a 2-second-cadence
coordinator loop per tenant fleet), not a collection of stateless
functions — there's no natural fit to a serverless/edge platform's
request-scoped execution model, and forcing one would mean rearchitecting
the fleet loop for no benefit this app needs. `TenantRegistry` boots a
`TenantWorker` bundle lazily on a tenant's first authenticated request and
keeps it running for the life of the process, deliberately independent of
whether that tenant's dashboard tab is open — "a tenant's engine keeps
running whether or not anyone is watching" is the product's core premise,
not an incidental property. Capacity is managed as "how many tenants this
host runs concurrently" (a cap or waitlist), never by idling an active
tenant down for inactivity. Hosting is Render against the Postgres instance
already paid for, in the `stcommand` schema of an instance (`promptoria-db`)
that also happens to run an unrelated production app in its `public`
schema — confirmed by querying it directly, not assumed, which is why every
RLS policy and the `apply_tenant_rls()` setup function are explicitly
schema-qualified and `search_path` is pinned once at the connection-pool
level (`src/db/pool.ts`) rather than trusted to every unqualified table
reference in `store.ts`. Sizing is bottlenecked by SpaceTraders' own 2 req/s
per-tenant rate limit, not CPU; Postgres connection-pool sizing is the
thing to watch as tenant count grows.
