# Persisting `surveyedSystems` — design

Status: proposed · 2026-10-20 · branch `design/system-survey-persistence`

## 1. What is wrong today

`FleetManager.surveyedSystems` is a plain in-memory `Set<string>`
(`src/engine/fleet.ts:513`). It is the **only** record of "an explorer has
already swept this system's markets", and it dies with the process.

Four consequences, in order of how often they bite:

1. **Every restart re-tours.** `surveyedSystems` is empty after `init()`, so
   the first system any explorer reaches is "new" and gets the full
   ten-market-plus-every-shipyard tour — regardless of how many times we have
   traded there. That is one wasted tour per restart, and restarts are not
   rare (deploy, Render recycle, crash).
2. **Two overlapping processes disagree.** `process A` surveys X1-TX45 and
   marks it; `process B` (booted from an older snapshot) never learns it and
   re-tours the same system. This is precisely the failure that forced
   `markSystemCharted()` into a read-union-write merge
   (`src/engine/fleet.ts:2187–2223`, and the incident recorded in its comment:
   X1-TX45 "successfully surveyed three separate times across three different
   process instances within about two hours").
3. **No operator visibility and no recovery.** There is no way to ask "which
   systems has the explorer covered", and no way to un-mark a bad survey — the
   only lever is a restart, which clears *everything*.
4. **A wrong mark is permanent for the process.** The X1-XM46 class of bug
   (an empty sweep recorded as a completed survey) is now guarded at write
   time (`src/engine/fleet.ts:2121–2124`), but if any other path marks a system
   that was never actually read, the explorer skips it until the next restart.
   Persisting makes that state durable — so persistence must ship with a TTL
   and a forget control, not alone (§5, §7).

## 2. What the set means, and every seam that touches it

Definition, from the field's own comment (`src/engine/fleet.ts:516–518`):
**"an explorer snapshotted this system's markets"** — explicitly *not* "every
waypoint in this system is charted". That second question belongs to
`scoutExhaustedSystems` (`src/engine/fleet.ts:519`).

| Seam | Location | Current code | Changes |
|---|---|---|---|
| declaration | `fleet.ts:513` | in-memory `Set<string>` | stays; becomes a hydrate-from-DB mirror |
| write — survey | `fleet.ts:2155` | `surveyedSystems.add()` last act of `surveySystem()` | routed through new funnel |
| write — tour proxy | `fleet.ts:2666` | `onSystemSurveyed: (sys) => this.surveyedSystems.add(sys)` | routed through funnel |
| write — explore proxy | `fleet.ts:2998` | same | routed through funnel |
| write — scout proxy | `fleet.ts:3070` | same | routed through funnel |
| proxy callback type | `shipProxy.ts:110`, fired at `shipProxy.ts:903` | `(systemSymbol: string) => void` (sync) | **unchanged** — the funnel adds synchronously, persists best-effort |
| read — BFS advance | `fleet.ts:3830` | `nextHopToUnsurveyed()` skip filter | unchanged |
| read — jump target | `fleet.ts:4258` | `candidates.find(c => !has(c))` | unchanged |
| read — pre-jump gate | `fleet.ts:4271` | `targetWasSurveyed` (PR #25) | unchanged |
| read — tour gate | `fleet.ts:4351` | `if (!has(target)) await surveySystem(target)` | unchanged |
| read — opportunistic explore | `fleet.ts:9529` | `reachable.filter(c => !has(c))` | unchanged |
| read — scout hop | `fleet.ts:9609` | filter | unchanged |
| persistence precedent | `markSystemCharted()`, `fleet.ts:2213`; hydrate at `fleet.ts:719–723` | jsonb array in `fleet_flags` | **not** copied — see §4 |
| store surface | `src/db/store.ts:1684–1702` (`getFleetFlag`/`setFleetFlag`/`removeFleetFlag`), table at `migrations/001_init.sql:178` | tenant-scoped key/value | new row-per-system methods instead |
| reset hygiene | `Store.TENANT_GAME_TABLES`, `src/db/store.ts:3826`, wiped by `wipeTenantGameData()` `store.ts:3844` | list of per-tenant game tables | new table added to the list |

Everything a *reader* does is already correct — six read sites, all testing
membership. The change is confined to (a) where membership is recorded and
(b) where the set is seeded at boot. That is the whole reason this is a small
change and not a refactor.

## 3. Facts from the live database (sizing, not guesses)

Measured against the running container's own `DATABASE_URL`, schema
`stcommand`:

```
galaxy_systems rows                7,027
  of which waypoints scanned         240
tenants                                1
distinct systems in market_snapshots  10
fleet_flags rows                       0
```

So the durable set is bounded by the systems a tenant can actually reach and
survey — today 10 rows, in the limit a few thousand. A row-per-system table is
trivially small; rewriting a single jsonb blob per survey is not the right
shape (see §4).

## 4. Decisions

| # | Decision | Options | Recommendation | Why |
|---|---|---|---|---|
| D1 | **Per-tenant or global?** | (a) `(tenant_id, system_symbol)` with RLS — (b) global `system_symbol` PK | **(a) per-tenant** | Market *data* is genuinely shared (`market_snapshots` has no `tenant_id`, `migrations/001_init.sql:246`; boot reads it via `freshMarketSnapshots()` filtered per system, `tenantRegistry.ts:822–843`). But if the *explore plan* were global, a second tenant would boot with `unsurveyed.length === 0` at `fleet.ts:9529` and its explorer would idle forever — a regression of exactly the feature PR #25 fixed. Keep the shared data shared; keep the ledger of "what **this** tenant has read" per tenant. This also matches `chartedSystems`, `gateConstructionSkips` and every other per-tenant set. |
| D2 | **New table or a `fleet_flags` blob?** | (a) `system_surveys` table — (b) jsonb array under `fleet_flags` key `surveyedSystems` | **(a) table** | Three reasons. (i) A blob is last-writer-wins: the exact race `markSystemCharted()` had to work around with a read-union-write (`fleet.ts:2192–2212`) — a row per system has no such race. (ii) A blob has no timestamp, so no TTL and no visibility. (iii) Rewriting a 7k-element array on each survey is wasteful when the write is one row. |
| D3 | **Can "surveyed" be derived** from `market_snapshots`/`market_latest` instead of stored? | derive vs persist | **persist** | Rejected option, worth recording. (i) Systems with no `MARKETPLACE` waypoint at all would never be marked → the explorer re-tours them forever, the ping-pong bug class again. (ii) Snapshot rows age out / are pruned by freshness windows (`freshMarketSnapshots(BOOT_MAX_AGE_MIN)`), so the derived answer flips over time. (iii) No record of which trip did it, or of what it found. |
| D4 | **Does a survey ever expire?** | (a) forever — (b) TTL | **(b) 14-day TTL** | Persisting forever means a single wrong mark hides a system for the life of the universe with no recovery. The tour role already refreshes stale *prices* (`staleMarketTargets`), so a TTL is not about price freshness — it is a bounded self-heal for a bad row, and it caps the damage of any future mislabelled mark. 14 days keeps re-arm load trivial (a two-system graph re-tours twice a fortnight, not every 12 seconds). Constant in code (no new doctrine clause, no `tests/doctrine.test.ts` churn) with the forget control as the operator override. |
| D5 | **Blocking or best-effort write?** | (a) `await` in the callback path — (b) add to memory synchronously, persist best-effort | **(b) best-effort** | The four write paths include two synchronous proxy callbacks (`shipProxy.ts:110`, `:903`) whose signature is `=> void`. Widening them to `Promise<void>` ripples through `agent.ts:177`/`scout.ts:87,190` for no benefit. Rule: **memory first, always** (so the running tick behaves identically to today), then a fire-and-forget upsert that logs on failure. A store outage must never stop a survey or throw into `tick()`. |
| D6 | **What happens if the table is missing?** | throw vs soft-fail | **soft-fail** | `init()` sits inside `tenantRegistry.boot()`'s retry loop, which retries forever on a throw (`fleet.ts:788–793` documents this hazard for `held_route`). A deploy that lands before `npm run migrate` must boot without the set, log once, and carry on — same degradation as today. |
| D7 | **Do we persist `scoutExhaustedSystems` too?** | yes / no | **no — out of scope** | It is re-derivable from waypoint chart flags (`fleet.ts:4184`, `some(w => !w.chart)`) and self-heals on the next refresh; the cost of an empty set at boot is one scout hop per system, not a repeated tour. Noted as follow-up, not bundled. |

## 5. Schema

`migrations/059_system_surveys.sql` — next free number confirmed against
`origin/main` (`058_opening_tasks_reconcile.sql` is the highest on the remote;
`057` was never used).

```sql
-- Per-tenant ledger of systems whose markets an explorer has actually swept.
-- NOT a claim about waypoints being charted — that is scoutExhaustedSystems'
-- job (fleet.ts:519). See docs/system-survey-persistence-design.md.
--
-- A row per system rather than the fleet_flags jsonb blob chartedSystems
-- uses: the blob is last-writer-wins across overlapping processes, which
-- markSystemCharted() has to work around with a read-union-write
-- (fleet.ts:2192). Rows cannot lose each other.
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS system_surveys (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    system_symbol   text NOT NULL,
    surveyed_at     timestamptz NOT NULL DEFAULT now(),
    markets_found   integer NOT NULL DEFAULT 0,
    shipyards_found integer NOT NULL DEFAULT 0,
    source          text NOT NULL DEFAULT 'survey',
    PRIMARY KEY (tenant_id, system_symbol)
  );

  ALTER TABLE system_surveys ENABLE ROW LEVEL SECURITY;
  ALTER TABLE system_surveys FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation_system_surveys ON system_surveys;
  CREATE POLICY tenant_isolation_system_surveys ON system_surveys
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

  CREATE INDEX IF NOT EXISTS idx_system_surveys_tenant_ts
    ON system_surveys (tenant_id, surveyed_at DESC);
END $$;
```

`source` exists so an operator can audit *why* a system was marked
(`survey` | `tour` | `explore` | `scout`) — relevant because persisting makes
a mislabelled mark durable.

## 6. Store API (`src/db/store.ts`)

Three methods, all `withTenant()` — never a raw pool query, so RLS applies:

```ts
/** Record (or refresh) this tenant's survey of one system. Idempotent. */
async recordSystemSurvey(tenantId: string, row: {
  systemSymbol: string; markets: number; shipyards: number; source: string;
}): Promise<void>

/** system_symbol -> surveyed_at (epoch ms), newest first, optionally only
 *  rows newer than `sinceMs`. One query; hydrated into the in-memory set. */
async listSystemSurveys(tenantId: string, sinceMs?: number):
  Promise<{ systemSymbol: string; surveyedAt: number }[]>

/** Drop one system's mark, or every mark when `systemSymbol` is omitted.
 *  Returns the number of rows removed, for the caller's log line. */
async forgetSystemSurveys(tenantId: string, systemSymbol?: string): Promise<number>
```

Upsert body:

```sql
INSERT INTO system_surveys
  (tenant_id, system_symbol, surveyed_at, markets_found, shipyards_found, source)
VALUES ($1, $2, now(), $3, $4, $5)
ON CONFLICT (tenant_id, system_symbol) DO UPDATE
  SET surveyed_at = now(), markets_found = excluded.markets_found,
      shipyards_found = excluded.shipyards_found, source = excluded.source
```

Plus `"system_surveys"` added to `Store.TENANT_GAME_TABLES`
(`src/db/store.ts:3826`) — a universe reset gives every tenant new symbols and
stale marks are meaningless (`wipeTenantGameData()`, `store.ts:3844`).

## 7. Engine changes (`src/engine/fleet.ts`)

### 7.1 One funnel for all four write sites

Replace the four `this.surveyedSystems.add(x)` calls with one method:

```ts
/** The only place a system is marked surveyed. Memory first — the current
 *  tick must behave exactly as before — then a best-effort durable row. */
private markSystemSurveyed(
  systemSymbol: string,
  source: "survey" | "tour" | "explore" | "scout",
  counts?: { markets: number; shipyards: number },
): Promise<void> {
  this.surveyedSystems.add(systemSymbol);
  this.surveyedAt.set(systemSymbol, Date.now());
  if (!this.tenantId || !this.store) return Promise.resolve();
  return this.store
    .recordSystemSurvey(this.tenantId, {
      systemSymbol, markets: counts?.markets ?? 0,
      shipyards: counts?.shipyards ?? 0, source,
    })
    .catch((err) => this.log(
      `survey mark for ${systemSymbol} not persisted: ${err instanceof Error ? err.message : String(err)}`));
}
```

Call sites: `fleet.ts:2155` (survey — `await`ed, it is already async and has
the real counts), and the three proxy callbacks at `fleet.ts:2666`, `:2998`,
`:3070` become `onSystemSurveyed: (sys) => { void this.markSystemSurveyed(sys, "tour"); }`
(the scout one passes `"scout"`, the explore one `"explore"`). The `.catch` is
inside the method, so `void` cannot produce an unhandled rejection.

### 7.2 Boot hydration

In `init()`, immediately after the existing flag restores
(`fleet.ts:717–733`), soft-failed like them:

```ts
if (this.tenantId && this.store) {
  try {
    const rows = await this.store.listSystemSurveys(this.tenantId, Date.now() - this.SURVEY_TTL_MS);
    for (const r of rows) { this.surveyedSystems.add(r.systemSymbol); this.surveyedAt.set(r.systemSymbol, r.surveyedAt); }
  } catch (err) {
    this.log(`surveyed-systems restore skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

`SURVEY_TTL_MS = 14 * 24 * 60 * 60 * 1000` (D4). Expired rows stay on disk for
audit; only the read filter changes, so a re-armed system keeps its previous
`surveyed_at` visible until the new survey overwrites it.

### 7.3 Unchanged on purpose

`exploreSystem()`'s pre-jump gate (`fleet.ts:4271`, PR #25) needs no change: it
asks "did I know this before this trip", and hydration makes "knew it" survive
restarts — which is the point of this change.

## 8. Failure modes

| Mode | Behaviour | Guard |
|---|---|---|
| Store throws on write | survey completes, log line, memory still marked | best-effort write + internal `.catch` (D5) |
| Table missing (deploy before migrate) | boot proceeds with an empty set, one log line | soft-fail try/catch in `init()` (D6) |
| Two processes survey the same system | two upserts, one row, newest `surveyed_at` wins | `ON CONFLICT … DO UPDATE`, row granularity (D2) |
| Process A survives a restart of B | B re-reads A's rows at boot | hydration (§7.2) |
| Bad mark (wrong system, empty sweep) | suppressed for ≤14 days, then re-armed; or cleared immediately by the operator | TTL (D4) + forget control (§9) |
| Universe reset | old rows wiped with the tenant's game data | `TENANT_GAME_TABLES` (D2, §6) |
| RLS GUC unset | zero rows, no error | `current_setting('app.tenant_id', true)` |
| 7k-row hydrate | ~one indexed read at boot, once per tenant | PK `(tenant_id, system_symbol)`, TTL filter |

## 9. Operator surface

- **`GET /api/galaxy`** (or the existing galaxy payload) gains
  `surveyedAt: <epoch ms> | null` per system — the map can grey out covered
  systems and the panel can show "surveyed 3h ago, 6 markets / 1 shipyard".
  Additive; no client change required for this to be safe.
- **`POST /api/explorer/forget`**, body `{ systemSymbol?: string }` — omit to
  clear all. Tenant from `req.tenantId` (session middleware,
  `src/http/resolveTenant.ts`), **never** from the path; a `:tenantId` segment
  compared against the session, 403 on mismatch, if the UI wants one. Clears
  the DB rows and the in-memory set, logs
  `forgot N survey marks (tenant …, system …)`.
- **MCP**: `stcommand_explorer_surveys` (list, and `forget` with the same
  semantics) — optional, slice 4b.

## 10. Tracer-bullet slices

Each slice is vertical (schema → engine → surface → verification) and
independently shippable. Migration gets its own slice, per house rules.

### Slice 1 — the table exists and is tenant-safe
- `migrations/059_system_surveys.sql` (§5).
- `Store.recordSystemSurvey` / `listSystemSurveys` / `forgetSystemSurveys` (§6);
  add `system_surveys` to `TENANT_GAME_TABLES`.
- Tests (`tests/systemSurveys.test.ts`, fresh file, `onMarket`-clean harness):
  - upsert twice → one row, `surveyed_at` advances;
  - `listSystemSurveys` returns rows newest-first and honours `sinceMs`;
  - `forgetSystemSurveys` with and without a symbol; count returned;
  - **cross-tenant**: tenant B's `listSystemSurveys` cannot see tenant A's rows
    even with no `WHERE` (mirror `tests/store.test.ts:52`);
  - `wipeTenantGameData()` removes them.

### Slice 2 — every mark is written, and nothing else changes
- `markSystemSurveyed()` funnel (§7.1); four call sites converted.
- Tests (`tests/fleet.test.ts`, alongside the existing survey block at
  `:347`):
  - `surveySystem()` persists one row with the real market/shipyard counts;
  - an empty sweep persists **nothing** (composes with the existing guard at
    `:369`);
  - the `onSystemSurveyed` callback path persists (call through a fake proxy);
  - a store whose `recordSystemSurvey` rejects → `surveySystem()` still
    resolves, the set is still marked, and no rejection escapes.

### Slice 3 — it survives a restart
- `init()` hydration + TTL (§7.2); `SURVEY_TTL_MS`.
- Tests:
  - boot `FleetManager` A against a real tenant, survey X1-XM46, then boot a
    **second** `FleetManager` on the same store and assert
    `surveyedSystems.has("X1-XM46")` after `init()` — two boots prove
    persistence, one proves only restore;
  - a row older than `SURVEY_TTL_MS` does not suppress (assert via
    `exploreSystem()` re-touring);
  - `listSystemSurveys` throwing → `init()` still resolves (§8, missing table).

### Slice 4 — the operator can see and undo it
- `surveyedAt` in the galaxy payload; `POST /api/explorer/forget`
  (§9); optional MCP tool.
- Tests: forget clears both the row and the in-memory set, scoped to the
  session tenant; a second tenant's marks are untouched.

### Slice 5 — prove it in production
- Deploy, then:
  ```bash
  docker exec stcommand sh -lc 'node -e "…select count(*), max(surveyed_at) from system_surveys…"'
  ```
  before/after a `docker compose … up -d --force-recreate stcommand`;
  the `surveyed …` log line must be followed by a row, and the pre-restart
  rows must still be there;
- the explorer's next genuinely new system must still tour fully (the
  PR #25 behaviour) — persistence must not make the tour unreachable again.

## 11. Out of scope

- `scoutExhaustedSystems` persistence (D7).
- Re-surveying on a schedule from the explorer itself — the tour role owns
  price refresh; this ledger only gates *exploration*.
- Any change to `galaxy_systems`, which stays shared and tenant-free
  (`migrations/011_galaxy_topology.sql`).
