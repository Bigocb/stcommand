# Standing Orders: Architecture Plan

The greenfield rewrite of straders, built multi-tenant from the start. This
supersedes `straders/docs/multi-tenant-plan.md`'s storage design in one
respect — Postgres instead of per-tenant SQLite files — for reasons below, and
carries forward the rest: SpaceTraders token as identity, bring-your-own-key,
no billing/OAuth in v1.

Companion documents this builds on directly:
- `straders/docs/greenfield-design.md` — the engine architecture (ShipRegistry,
  cargo manifest, scheduler, state machine, read model). Unchanged by anything
  here; this doc is about the tenancy and storage layer around that engine.
- `straders/docs/multi-tenant-plan.md` — the original multi-tenant design. Its
  finding that the engine core has zero global singletons still holds and is
  why this is tractable.

**Status: Phase 0 done, verified against a real Postgres instance, not just
written.** `migrations/001_init.sql` applies cleanly; `src/db/store.ts` ports
a representative slice of straders' `Store` (simple insert, upsert-on-conflict,
key/value flags, and the weighted-average-cost warehouse logic); and
`tests/store.test.ts` proves the actual safety property section 1 depends on —
a query with *zero* `WHERE tenant_id` clause still only ever sees one tenant's
rows, and a write for another tenant's id is rejected outright, both enforced
by Postgres itself. Also caught in testing, not by inspection: `sessions`
needs to be excluded from the automatic RLS policy, since a session has to be
looked up by its own id *before* `app.tenant_id` is known — that's how the
lookup learns which tenant it belongs to. Fixed in the migration below and
covered by a regression test. See `README.md` for exact status and how to
run it locally.

---

## 1. The one decision this doc locks in: Postgres, not per-tenant SQLite

The SQLite plan's per-tenant-file design was a workaround for two problems
Postgres already has real answers to:

**Isolation without auditing every query.** Adding a `tenant_id` column to
every table and hoping every query remembers `WHERE tenant_id = ?` is
correctly flagged in the old plan as a leak waiting to happen. Per-tenant
SQLite files sidestepped that by making isolation a filesystem property. But
Postgres has **Row-Level Security**: a policy attached to the table, enforced
by the database itself, that no query can bypass by forgetting a clause.
That's a stronger guarantee, not a weaker one.

**`better-sqlite3` blocks the event loop.** The old plan's own stated scaling
risk: one tenant's write stalls every other tenant's request, because
`better-sqlite3` is synchronous by design. An async, connection-pooled
Postgres driver doesn't have this problem at all.

Bonus, not the deciding factor: you already have a paid Postgres instance on
Render sitting idle from this app's perspective, and it centralizes backups
and monitoring instead of scattering per-tenant files across a persistent
disk volume you'd have to provision separately.

**Rejected alternative — schema-per-tenant.** Postgres's own native answer to
per-tenant-file isolation (`CREATE SCHEMA tenant_xyz`, swap `search_path` per
connection). Real isolation, but every future migration has to run once per
tenant schema. Doesn't scale operationally the way a single shared schema
with RLS does. Not used here.

### The real cost, stated plainly

`Store` in straders is ~974 lines written directly against `better-sqlite3`'s
**synchronous** API — every method is `this.db.prepare(...).run()/.get()/.all()`,
called without `await` from `fleet.ts`, `trader.ts`, `mission.ts`, the server
routes, and the test suite. Moving to Postgres makes every one of those calls
async. That's a real refactor of every call site, not a driver swap, plus
dialect auditing (`INTEGER PRIMARY KEY AUTOINCREMENT` → `GENERATED ALWAYS AS
IDENTITY`, 0/1 integer booleans → real `BOOLEAN`, `ROW_NUMBER() OVER
(PARTITION BY ...)` — this one already works identically in Postgres).

This is the right time to pay that cost: greenfield, no production data yet.
Paying it after the app has live tenants would be far more expensive.

---

## 2. Schema shape

One shared schema. Every tenant-scoped table gets a `tenant_id` column and an
RLS policy. Non-tenant-scoped tables (shared galaxy data — market snapshots,
shipyard inventory, module catalog, per the old plan's own observation that
these three tables hold public data with no per-agent scoping) don't need one
— they're the same rows for everyone on the same server reset, same as
before.

```sql
-- Set once per request by the tenant-resolving middleware, before any
-- tenant-scoped query runs on that connection.
-- SELECT set_config('app.tenant_id', $1, true);  -- true = transaction-local

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_symbol  text NOT NULL UNIQUE,
  token_enc     bytea NOT NULL,
  token_iv      bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  discord_webhook_enc bytea,
  discord_webhook_iv  bytea,
  -- LLM settings, section 3.
  llm_provider  text,
  llm_base_url  text,
  llm_model     text,
  llm_key_enc   bytea,
  llm_key_iv    bytea
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- Every existing straders table (ledger, activity, doctrine, warehouse,
-- warehouse_ledger, warehouse_targets, missions, fleet_state, fleet_flags,
-- ship_claims / ship_manifest / ship_state once the greenfield engine pillars
-- land, chat_messages) gets this treatment. One representative example:

CREATE TABLE doctrine (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      real NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE doctrine ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctrine FORCE ROW LEVEL SECURITY;  -- applies even to the table owner
CREATE POLICY tenant_isolation ON doctrine
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Shared, ungated (public galaxy data — same for every tenant):
--   market_snapshots, shipyard_inventory, module_catalog
-- get no tenant_id and no RLS policy.
```

`FORCE ROW LEVEL SECURITY` matters — without it, the table owner (the app's
own connection role, if misconfigured to superuser) bypasses RLS entirely.
The app's Postgres role must not be a superuser/table-owner-bypass role.

---

## 3. Settings: bring-your-own LLM key

Solves the abuse-vector problem the old plan flagged (co-pilot spends *your*
key if you host for others) by not having a shared key at all — each tenant
funds their own, same as they bring their own SpaceTraders token.

`ChatLLM` in straders already takes `{ apiKey, model, baseUrl }` as
constructor args, OpenAI-compatible chat-completions shape, defaulting to
Ollama Cloud. Carries over unchanged. A Settings page, reachable after login:

| Field | Notes |
| --- | --- |
| Provider | Dropdown: OpenAI, Groq, OpenRouter, Ollama Cloud, Custom. Each non-Custom choice fills in `llm_base_url`; Custom exposes the field. |
| API key | Encrypted at rest (AES-256-GCM, same mechanism as `token_enc` — one `SESSION_SECRET` env var as the master key). Never sent back to the client after save; show a masked placeholder. |
| Model | Free text — provider model names change too often to hardcode a list. |

Co-pilot is disabled until `llm_key_enc` is set for that tenant. No global
flag needed; absence of a key *is* "off."

Anthropic is out of v1 — it doesn't speak the OpenAI chat-completions shape
natively. Reachable via OpenRouter's compatibility layer if a tenant wants
Claude specifically; a native adapter is a later addition if it's asked for.

---

## 4. Auth & tenancy resolution

Unchanged from the old plan's design, restated for Postgres:

1. Visitor pastes their SpaceTraders agent token into the gate screen.
2. Server calls `GET /my/agent`. Success → the returned symbol is the tenant
   identity.
3. Look up or insert into `tenants`; encrypt the token before storing.
4. Create a `sessions` row; httpOnly, HMAC-signed cookie holding the session
   id (same pattern straders already uses for the dashboard-token gate — no
   JWT library).
5. A `resolveTenant` middleware reads the cookie, loads the session and
   tenant, runs `SET LOCAL app.tenant_id = ...` on the connection for that
   request's transaction, and attaches `req.tenant` before the route runs.

Registering a brand-new agent (no token yet) reuses the same flow with the
account-token + faction fields also on the gate screen, same as straders'
existing `registerAgent()` CLI logic.

---

## 5. Runtime: one process, N tenant workers, per the old plan's sequencing

`TenantRegistry` holds active `{ api, store, state, fleet, chat?, discord? }`
bundles per tenant, exactly as designed in the original plan. The only change
is what `store` is: an async Postgres-backed client scoped to that tenant's
`tenant_id`, instead of a `Store` pointed at a per-tenant file.

Lifecycle rule carries over unchanged and is worth restating because it's the
whole point of the product: **a tenant's engine keeps running whether or not
their dashboard tab is open.** Nothing here idles a tenant down for
inactivity. Capacity is managed as "how many tenants this host runs
concurrently" (a cap or waitlist), not by pausing active ones.

---

## 6. Hosting

Render, as already decided — a persistent Node service, not a serverless
platform. The engine is a long-running process (2s coordinator tick, one loop
per ship) with no natural fit to Vercel's stateless-function model; forcing
it there means rearchitecting things this plan doesn't need to touch.

With Postgres now the storage layer, the whole stack is: one Render web
service (the Node process) talking to the Postgres instance you already pay
for. No separate persistent-disk volume to provision — that was only needed
for per-tenant SQLite files.

Sizing is still bottlenecked by the SpaceTraders API's own 2 req/s rate limit
per tenant, not by CPU — the process spends most of its time waiting on
network I/O. Connection pool sizing on the Postgres side becomes the new
thing to watch as tenant count grows (each active `TenantWorker` needs at
least one pooled connection); worth checking the instance's max-connections
against planned tenant count once you know the tier.

---

## 7. Sequencing

| Phase | Scope |
| --- | --- |
| 0 | Repo scaffold: package.json, tsconfig, Postgres schema + migrations, async `Store` rewrite (port straders' `Store` method-by-method, same method names/shapes, async signatures) |
| A | Engine core ports over from straders largely unchanged (per the old plan's finding — no global singletons) once it's talking to the new async `Store` |
| B | Gate screen, tenant resolution middleware, `TenantRegistry`, RLS wiring |
| C | Settings page: LLM provider/key/model, Discord webhook (moves off the module-level singleton straders has today, into the `tenants` row per the old plan) |
| D | Deploy to Render against the existing Postgres instance |

Each phase is independently shippable, same principle as the greenfield
engine migration doc.

## Explicit non-goals (carried over from the old plan, unchanged)

- Billing/payments
- Horizontal scaling across multiple machines
- OAuth/social login — the SpaceTraders token is the credential
- Teams / shared fleet access — one login owns one fleet
