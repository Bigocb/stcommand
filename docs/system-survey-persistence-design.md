# Persisting explorer state: `surveyedSystems` and the tour queue — design

Status: implemented and verified in production (rev. 4: slice 5 executed 2026-10-20 — restart survival and the completion clear both observed live; see §10, "Slice 5 result". Shipped in PR #27) · branch `design/system-survey-persistence`

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

### 1a. The same restart also orphans a half-finished tour

`pendingTourStops` (`src/engine/fleet.ts:446`) is the second piece of
exploration state that lives only in memory: when a tour is interrupted by a
control-flow signal (cooldown/transit, PR #26), the stops not yet visited are
kept per ship so the retry finishes the job instead of re-touring or jumping to
a neighbour. A restart drops that remainder.

Confirmed live 2026-10-20, and it is the reason this design now covers both
sets. THEOREM-59 began touring X1-XM46 at 14:16, was on a 196s cooldown, and
logged three stops as failed before the container was recreated at 14:20:52.
After the restart `pendingTourStops` was empty, so:

- X1-XM46-C22C / Z23D / D25D were never read by the one hull that had flown
  there — and `surveySystem()` had already marked the system surveyed, so no
  later visit would finish the tour;
- `surveyedSystems` being empty at the same moment made every system look new,
  so the explorer's next trip toured **its own home system** (X1-QB34, 44
  waypoints, 23 marketplaces, 5 shipyards) for 15 stops.

The two sets fail together and must be fixed together: persisting the survey
mark without the queue makes an interrupted tour unrecoverable, and persisting
the queue without the mark makes the explorer re-tour everything it already
knows after each restart.

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
| **tour queue** | `pendingTourStops`, `fleet.ts:446`; written in `runTourStops()` `fleet.ts:4495`; read at `fleet.ts:4248` | in-memory `Map<ship, {system, stops[]}>` | **also persisted** — see §7.3; a restart orphans a half-finished tour |

Everything a *reader* does is already correct — six read sites, all testing
membership. For the survey ledger the change is confined to (a) where membership
is recorded and (b) where the set is seeded at boot. The tour queue is the same
shape: one write on the `Pending` branch, one clear on completion, one read at
boot. That is the whole reason this is a small change and not a refactor.

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

So the durable survey ledger is bounded by the systems a tenant can actually
reach and survey — today 10 rows, in the limit a few thousand. The tour queue is
bounded by the fleet itself (81 hulls at last count, of which the explorers are
a handful), so at most one row per touring ship. Both are trivially small;
rewriting a single jsonb blob per survey is not the right shape (see §4).

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
| D8 | **Does the tour queue get persisted, and in what shape?** | (a) same table, one row per ship — (b) re-derive the itinerary on resume — (c) jsonb in `fleet_flags` | **(a) a `tour_queue` table, one row per ship** | (b) is impossible: the itinerary is a pure function of the waypoint list, but *which* stops are already done is not — and it cannot be inferred from market snapshots either, because `maxAgeMs: 0` exists precisely because those snapshots are fresh *and empty* (`fleet.ts:4479`). (c) inherits the last-writer-wins race D2 rejects, and here a lost write means a lost itinerary, not a re-read. (a) is write-one-row, and the resume path already keys on `(ship, system)` (`fleet.ts:4248`), so the row's primary key is that key plus the tenant. **Deliberate simplification:** one row per ship, not per ship-and-system — a hull can only be touring one system at a time, and a queue for a system the ship has left is dead weight the in-memory version drops too. |

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

Same migration, second table — the tour queue (§7.3, D8):

```sql
  -- The rest of an explorer's interrupted tour: which ship, which system, and
  -- the stops it has not visited yet. Written when a Pending (cooldown/transit)
  -- stops the tour (runTourStops(), fleet.ts:4495), cleared when the last stop
  -- is done. Without it a restart orphans the remainder and the system — already
  -- marked surveyed — is never re-toured.
  --
  -- One row per ship, not per ship-and-system: a hull tours one system at a
  -- time, and the resume path already matches on (ship, system) (fleet.ts:4248).
  CREATE TABLE IF NOT EXISTS tour_queue (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ship_symbol   text NOT NULL,
    system_symbol text NOT NULL,
    stops         jsonb NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, ship_symbol)
  );

  ALTER TABLE tour_queue ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tour_queue FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation_tour_queue ON tour_queue;
  CREATE POLICY tenant_isolation_tour_queue ON tour_queue
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`stops` holds `[{ "symbol": "...", "market": true, "yard": false }, …]` — the
`TourStop` shape (`fleet.ts:332`). The flags are stored rather than re-derived
because they come from each waypoint's traits, and a resume must not depend on
the atlas still holding them.

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

Three more for the tour queue, same rules:

```ts
/** Save (overwrite) one ship's remaining tour stops. Idempotent per ship. */
async saveTourQueue(tenantId: string, row: {
  shipSymbol: string; systemSymbol: string; stops: TourStop[];
}): Promise<void>

/** Every queued tour for this tenant, oldest first — hydrated at boot. */
async listTourQueues(tenantId: string):
  Promise<{ shipSymbol: string; systemSymbol: string; stops: TourStop[]; updatedAt: number }[]>

/** Drop one ship's queue, called when its last stop is done. */
async clearTourQueue(tenantId: string, shipSymbol: string): Promise<void>
```

`tour_queue` joins `TENANT_GAME_TABLES` for the same reason: after a reset every
waypoint symbol in a queued itinerary is meaningless.

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
      `survey mark for ${systemSymbol} not persisted: ${describeError(err)}`));
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
    this.log(`surveyed-systems restore skipped: ${describeError(err)}`);
  }
  try {
    for (const q of await this.store.listTourQueues(this.tenantId)) {
      if (Date.now() - q.updatedAt > this.SURVEY_TTL_MS) continue; // older than the survey window: the system will be re-toured anyway
      this.pendingTourStops.set(q.shipSymbol, { system: q.systemSymbol, stops: q.stops });
    }
  } catch (err) {
    this.log(`tour-queue restore skipped: ${describeError(err)}`);
  }
}
```

`SURVEY_TTL_MS = 14 * 24 * 60 * 60 * 1000` (D4). Expired survey rows stay on
disk for audit; only the read filter changes, so a re-armed system keeps its
previous `surveyed_at` visible until the new survey overwrites it. The same
window bounds a restored tour queue: past it the survey mark has expired and the
system is due a fresh tour, so a resurrected itinerary would only duplicate work.

### 7.3 The tour queue is written, cleared and restored

`runTourStops()` (`fleet.ts:4463`) already keeps the unvisited stops in memory
when a `Pending` interrupts it. Two writes turn that into something a restart
survives:

```ts
// on Pending — best-effort, same rule as the survey mark: never throw into the
// tour, never delay the signal that nextExploreTask() needs.
if (err instanceof Pending) {
  this.pendingTourStops.set(shipSymbol, { system: systemSymbol, stops: stops.slice(i) });
  if (this.tenantId && this.store) {
    void this.store.saveTourQueue(this.tenantId, { shipSymbol, systemSymbol, stops: stops.slice(i) })
      .catch((e) => this.log(`tour queue for ${shipSymbol} not persisted: ${describeError(e)}`));
  }
  this.log(`${shipSymbol}: tour of ${systemSymbol} paused at ${stop.symbol} (${describeError(err)}) — ${stops.length - i} stop(s) left`);
  throw err;
}
```

and on the last stop:

```ts
this.pendingTourStops.delete(shipSymbol);
if (this.tenantId && this.store) {
  try { await this.store.clearTourQueue(this.tenantId, shipSymbol); }
  catch (e) { this.log(`tour queue for ${shipSymbol} not cleared: ${describeError(e)}`); }
}
```

**The clear is awaited and the write is not**, deliberately. The write sits in
front of a `Pending` that must yield the tick, so it cannot wait for a database
round-trip. The clear has no such signal behind it, and a row that outlived its
tour would make the next boot resume stops that are already done — so it is
finished before `explored …` is logged.

The resume path itself (`fleet.ts:4248`) does not change: it already matches
`interrupted.system === currentSystem` and replays the stored stops. What
changes is where `interrupted` came from at boot.

**Ordering note:** the queue write is fire-and-forget but the tour throws
immediately, so a crash in the microseconds between can still lose it. That is
acceptable — the fallback is today's behaviour (an unmarked system stays
unmarked and a later trip reads it), and `await`ing the write here would put a
database round-trip in the path of a cooldown signal that exists to yield the
tick.

### 7.4 Unchanged on purpose

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
| Restart mid-tour | queued stops restored, resumed on the ship's next explore tick | `tour_queue` row written at the pause (§7.3) |
| Tour queue write lost (crash in between) | the remainder is lost for that system only; the survey mark still stands | accepted, §7.3 ordering note |
| Ship left the queued system (operator move, scrape, sale) | the row is inert — the resume branch only fires when `system === currentSystem` — and is overwritten by the ship's next tour | one row per ship (D8) |

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

### Slice 1 — the tables exist and are tenant-safe
- `migrations/059_system_surveys.sql` (§5): **both** `system_surveys` and
  `tour_queue`, each with `ENABLE`+`FORCE` RLS and a `tenant_isolation` policy.
- `Store.recordSystemSurvey` / `listSystemSurveys` / `forgetSystemSurveys` /
  `saveTourQueue` / `listTourQueues` / `clearTourQueue` (§6); add both tables to
  `TENANT_GAME_TABLES`.
- Tests (`tests/systemSurveys.test.ts`, fresh file, `onMarket`-clean harness):
  - upsert twice → one row, `surveyed_at` advances;
  - `listSystemSurveys` returns rows newest-first and honours `sinceMs`;
  - `forgetSystemSurveys` with and without a symbol; count returned;
  - `saveTourQueue` twice for one ship → one row, `stops` replaced not appended;
  - `listTourQueues` round-trips the full `TourStop[]` shape, flags included;
  - `clearTourQueue` removes exactly one ship's queue;
  - **cross-tenant**: tenant B's `listSystemSurveys`/`listTourQueues` cannot see
    tenant A's rows even with no `WHERE` (mirror `tests/store.test.ts:52`);
  - `wipeTenantGameData()` empties both.

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

### Slice 3 — a restart loses nothing: neither the survey mark nor the tour in flight
Two sets, two write paths, one boot restore. They ship together because each is
worthless without the other (§1a): a persisted mark with a lost queue makes an
interrupted tour unrecoverable, a persisted queue with a lost mark re-tours the
whole galaxy after every restart.

- `init()` hydration for both, each soft-failed separately (§7.2);
  `SURVEY_TTL_MS` as the single window for both.
- `saveTourQueue` on the `Pending` branch of `runTourStops()`, `clearTourQueue`
  on its last stop (§7.3). Both best-effort, both logging through
  `describeError()`.
- Tests (`tests/fleet.test.ts`, plus the store suite from slice 1):
  - **survey mark, two boots:** boot `FleetManager` A against a real tenant,
    survey X1-XM46, then boot a **second** `FleetManager` on the same store and
    assert `surveyedSystems.has("X1-XM46")` after `init()` — two boots prove
    persistence, one proves only restore;
  - **tour queue, two boots — the live incident replayed:** boot A, run a tour
    of a 3-stop system with `dispatchShip` throwing `CooldownPending` on stop 2,
    assert the queue row holds `[stop2, stop3]`; boot a **second**
    `FleetManager`, `init()` it, call `exploreSystem(ship)` with no target, and
    assert it resumes stop 2 and 3 in the same system and never jumps — this is
    THEOREM-59's X1-XM46 case, which today is unrecoverable;
  - a resumed tour clears its row (assert the table is empty afterwards);
  - a row older than `SURVEY_TTL_MS` does not suppress a survey and does not
    resurrect a queue;
  - `listSystemSurveys` **or** `listTourQueues` throwing → `init()` still
    resolves (each in its own try/catch; §8, missing table);
  - a store throwing on `saveTourQueue` → the `Pending` still propagates and the
    in-memory remainder is still set (best-effort write, D5).

### Slice 4 — the operator can see and undo it
- `surveyedAt` in the galaxy payload; `POST /api/explorer/forget`
  (§9); optional MCP tool. `forget` on a system also drops any queued tour of it
  — otherwise the explorer would keep resuming an itinerary the operator just
  declared unread.
- Tests: forget clears both the row and the in-memory set (and the queue),
  scoped to the session tenant; a second tenant's marks are untouched.
- **Shipped:** both the payload field and the route; the fleet-side behaviour is
  tested directly (`forgetSurveys`, two tenants) because the route sits behind
  the session cookie. No Deck/Tower button yet and no MCP tool — the route is
  the surface for now, so a caller reaching it is doing so deliberately.

### Slice 5 — prove it in production
- Deploy, then:
  ```bash
  docker exec stcommand sh -lc 'node -e "…select count(*), max(surveyed_at) from system_surveys…"'
  ```
  before/after a `docker compose … up -d --force-recreate stcommand`;
  the `surveyed …` log line must be followed by a row, and the pre-restart
  rows must still be there;
- **the live test this design was rewritten for:** catch an explorer mid-tour
  (`tour of X paused at … (cooldown until …) — N stop(s) left`), restart the
  container while the queue row exists, and confirm the next explore tick logs
  `resuming the interrupted tour of X — N stop(s) left` and finishes it. The
  same restart must *not* send it touring its home system;
- the explorer's next genuinely new system must still tour fully (the
  PR #25 behaviour) — persistence must not make the tour unreachable again.

#### Slice 5 result — executed 2026-10-20, slice closed

Evidence, in order (all times UTC, tenant `252d8ba9`, schema `stcommand`):

```
PRE   tour_queue: THEOREM-6  sys=X1-QB34  stops=11  updated_at=15:39:58
      system_surveys: X1-QB34 15:19:48 · X1-CB23 15:20:36   (source=survey)
15:41:5x  docker compose up -d --force-recreate stcommand  → running/healthy
15:42:29  THEOREM-6: resuming the interrupted tour of X1-QB34 — 11 stop(s) left
15:42:30  THEOREM-6: dispatch → X1-QB34-Z11Z
15:42:35  THEOREM-6: dispatch → X1-QB34-EE1E
15:42:41  tour of X1-QB34 paused at X1-QB34-EE1E — 10 stop(s) left
```

The `11 stop(s) left` in the first line after boot is the load-bearing detail:
the process is new, so `pendingTourStops` was empty, and 11 is exactly the
persisted `jsonb_array_length(stops)`. The resume therefore came from
`listTourQueues`, not from surviving memory. The subsequent drop to 10 proves
the hydrated itinerary is a live control-flow object, not a log-only echo.
No `tour-queue restore skipped` line appeared, so the boot read did not throw.

`system_surveys` also carries live writes from the engine itself (`source=survey`,
two systems inside the same five minutes), which is the row-level half of slice 5.
No explorer resumed a tour of an already-surveyed system after the restart —
weaker evidence, since it is an absence of a log line rather than a positive
signal, but it is the specific regression the design exists to prevent.

**Clear path — verified at 16:08:42.** THEOREM-61 logged `explored X1-M36`
after a tour that had paused and resumed four times (so its row had been written
repeatedly). Immediately afterwards `tour_queue` holds **no** row for THEOREM-61
while `THEOREM-6/X1-QB34 stops=5` and `THEOREM-1B/X1-SU37 stops=13` are still
present. Those two surviving rows are what make the absence evidence: the probe
was demonstrably reading the right table, so one ship's row disappearing on
completion is a delete, not an empty result. `system_surveys` keeps the mark
(`X1-M36`, `surveyed_at=15:49:53`, 7 markets, 1 yard), which is the intended
split — finishing a tour retires the itinerary and keeps the survey.

That closes the last open item in this design: §7.3's awaited clear is now
observed in production, and the restart proof above shows the hydrated
itinerary actually drives the ship.

**How this slice was nearly lost to a measurement bug — do not repeat it.**
The first attempt reported `NO ROW APPEARED` and refused to restart, and an
earlier read claimed both tables held zero rows. Both were wrong: everything
lives in the `stcommand` **schema**, and a probe that does not qualify it
(`psql -U postgres -d stcommand`, or a `pg` client whose `search_path` option
never applied) resolves against `public`, where the tables do not exist. `psql`
says `Did not find any relation`; the `pg` client returned an empty result and
the watchdog interpreted that as "no rows". The writes had been working for
~20 minutes while the report said persistence was broken.

Rules that follow: fully qualify every relation in a verification script
(`stcommand.tour_queue`), never let an empty result stand in for a missing
relation, and treat "the write did not happen" as a claim requiring a probe
that would have *errored* if it were looking at the wrong place.


## 11. Out of scope

- `scoutExhaustedSystems` persistence (D7).
- Re-surveying on a schedule from the explorer itself — the tour role owns
  price refresh; this ledger only gates *exploration*.
- Any change to `galaxy_systems`, which stays shared and tenant-free
  (`migrations/011_galaxy_topology.sql`).
- Persisting the *itinerary plan itself* before the first stop is attempted —
  slice 3 writes only on a `Pending`, so a crash mid-tour before any pause (or a
  hard kill between stop N and N+1) still loses the remainder. Closing that
  needs a write per completed stop, which is 15 writes per tour for a recovery
  window of seconds; not worth it until something proves otherwise.
