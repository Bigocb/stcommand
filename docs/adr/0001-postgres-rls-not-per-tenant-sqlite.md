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
