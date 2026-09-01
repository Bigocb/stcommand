# Postgres + Row-Level Security, not per-tenant SQLite files

One shared Postgres database with a `tenant_id` column and an RLS policy on
every tenant-scoped table, instead of straders' original per-tenant-file
plan. Per-tenant SQLite files made isolation a filesystem property to
sidestep two real problems; Postgres has stronger native answers to both:
Row-Level Security enforces isolation at the database layer even against a
query that forgets its own `WHERE tenant_id` clause, and an async,
connection-pooled driver doesn't share `better-sqlite3`'s synchronous,
event-loop-blocking design (where one tenant's write could stall every
other tenant's request). `FORCE ROW LEVEL SECURITY` is required so the
table owner can't bypass the policy if the app's Postgres role is ever
misconfigured toward superuser. The real cost — every one of `Store`'s ~974
lines moves from synchronous to async, at every call site across the
engine — is paid once, greenfield, rather than later against live tenant
data. See `docs/architecture-plan.md` §1 for the full accounting.

## Operational consequence: ad-hoc queries see nothing

`FORCE ROW LEVEL SECURITY` applies to the table owner too — that is the
point of it — which means **a psql session sees zero rows in every
tenant-scoped table** unless it sets the GUC the policy reads:

```sql
SET app.tenant_id = '<tenant uuid>';   -- then SELECT as normal
```

Without it, `current_setting('app.tenant_id', true)` is NULL, the policy
predicate is NULL rather than true, and every row is filtered out. No
error, no warning — just an empty result that looks exactly like missing
data.

This has now produced two wrong diagnoses against production, both of
which cost real time:

1. A standing "`withTenant()` silently persists zero rows" bug, chased at
   length and instrumented with counters, a watchdog and per-call timing
   logs in `pool.ts`. There was no write bug. The same tenant's tables
   held 20 doctrine rows, 2 fleet_flags and 4,062 ledger rows the whole
   time. Instrumentation removed; investigation closed.
2. A conclusion that the live tenant had no doctrine rows and was
   therefore being force-paused at boot, which motivated the
   `tenants.onboarding_pending` column in migration 010. The column is a
   better design than inferring "new tenant" from row absence and is
   worth keeping, but the regression it was said to fix did not exist.

The shared galaxy tables (`market_snapshots`, `market_latest`,
`shipyard_inventory`, `module_catalog`, `galaxy_systems`) carry no
`tenant_id` and no RLS, so they query normally — which is itself a trap,
because a session that reads those fine can look healthy while every
tenant-scoped table silently reads empty.
