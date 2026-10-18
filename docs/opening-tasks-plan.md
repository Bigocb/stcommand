# Opening tasks: implementation plan

Status: plan only, nothing built (2026-10-18). Raised by the operator in `docs/TODO.md` ("Opening automation: queued tasks and saved templates").
Written to be handed to a model that has not seen this repo. Do exactly what is written; where a rule is stated, do not choose another.

## 0. What is being built, in one paragraph

A tenant can keep a list of **tasks**. A task has a **trigger** (a condition on the fleet) and an ordered list of **steps** (actions). When the trigger is
first met the task starts and runs its steps one at a time, one step per engine tick at most. A step can use the ship an earlier step bought. Example task:
"when the command ship's hold is empty: buy a SHIP_LIGHT_SHUTTLE, set it to trader, put it on contract duty". A **template** is a saved, named list of tasks.
Applying a template adds its tasks, either now or for the **next universe** (the weekly reset), so the opening runs by itself after a reset. Operator, MCP
tools and the co-pilot can all add tasks. The whole feature is off until the doctrine clause `openingTasks` is switched on.

## 1. Rules for the implementing model (read before writing any code)

1. Work on the branch `claude/stcommand-ui-parallel-versions-fd5p9q`. Commit after each numbered work package (section 5) with the message given there. **Do not push**; the operator pushes (the box deploys from `main`).
2. **Never run the test suite against the production database.** `npm test` runs `scripts/assert-test-schema.mjs` first and refuses if `DB_SCHEMA` is `stcommand`. Use `.env.test` (copy `.env.test.example`). If `.env.test` does not exist, run only the pure tests (they need no database): `node --test --import tsx tests/openingTasks.test.ts tests/openingRunner.test.ts`.
3. Test and typecheck commands: single file `node --test --import tsx tests/<file>.test.ts`; all `npm test`; types `npm run typecheck`. **The full suite has about 187 failures that were there before you started** (they need a database). Before your first change run `npm run typecheck` and note the result; after each package it must be at least as clean. For a package, only its own test files must pass.
4. **Do not touch** these (they are live and unrelated): `src/engine/windDownScrap.ts`, `src/engine/lotGuard.ts`, `src/engine/trader.ts`, `src/engine/dispatcher.ts`, anything under `migrations/` that already exists. Do not add your tables to `Store.TENANT_GAME_TABLES` or `Store.SHARED_GALAXY_TABLES` in `src/db/store.ts`: those lists are wiped at a reset, and these tables must survive it.
5. Style: match the surrounding file (comment density, naming, 2-space indent, double quotes, `.js` suffix on relative imports). New logic goes in its own small module with a narrow interface (CLAUDE.md "Build new logic as self-contained modules"): pure, policy is data, explainable (every decision returns a one-line `reason`), tested in isolation, callers stay thin.
6. **Never call a spending or fleet-changing function from a test against the real game.** All tests use fakes.
7. After any call that errors, **do not retry it**. A buy that threw may still have happened (CLAUDE.md, 2026-10-08: a "rejected" `buy_ship` had executed). The runner in section 4.3 encodes this; do not "improve" it into a retry.
8. Do not add model names or session links anywhere except the commit trailers the operator's tooling adds.
9. If anything in this plan contradicts the code you find, stop and write the contradiction at the end of this file under "Discrepancies" instead of guessing.

## 2. Vocabulary (use these exact names)

| Name | Meaning |
| --- | --- |
| task spec | The stored recipe: `{ key, name, trigger, steps }`. Lives in a template or is copied into a task row. |
| task | A row in `opening_tasks`: a task spec plus run state. |
| template | A row in `opening_templates`: a name and a list of task specs. |
| step | One action in a task. |
| ship ref | How a step or trigger names a ship (section 3.1). |
| universe key | `<agent symbol>@<reset date>`, from `tenantUniverse(tenantId)` in `src/db/pool.ts`. |
| home system | `fleet.systemSymbol` (the tenant's headquarters system). v1 only buys in the home system. |

## 3. Data model

### 3.1 Types (file `src/engine/openingTasks.ts`, exported exactly as written)

```ts
export const OPENING_ROLES = ["miner", "trader", "surveyor", "tour", "explorer", "keeper", "scout", "siphoner"] as const;
export type OpeningRole = (typeof OPENING_ROLES)[number];

/** Copy of the ShipType union in src/core/schema.d.ts (line ~1825). */
export const OPENING_SHIP_TYPES = [
  "SHIP_PROBE", "SHIP_MINING_DRONE", "SHIP_SIPHON_DRONE", "SHIP_INTERCEPTOR", "SHIP_LIGHT_HAULER", "SHIP_COMMAND_FRIGATE", "SHIP_EXPLORER",
  "SHIP_HEAVY_FREIGHTER", "SHIP_LIGHT_SHUTTLE", "SHIP_ORE_HOUND", "SHIP_REFINING_FREIGHTER", "SHIP_SURVEYOR", "SHIP_BULK_FREIGHTER",
] as const;
export type OpeningShipType = (typeof OPENING_SHIP_TYPES)[number];

/** command = the one ship whose registration.role is "COMMAND"; step = the ship that step N (a buyShip step) bought; symbol = a literal ship symbol. */
export type ShipRef = { by: "command" } | { by: "step"; step: number } | { by: "symbol"; symbol: string };

export type Trigger =
  | { kind: "always" }
  | { kind: "cashAtLeast"; credits: number }                 // spendable credits (credits minus the cashFloor doctrine value) >= credits
  | { kind: "routeProfitAtLeast"; profitPerTrip: number }    // best route the dispatcher currently offers has profitPerTrip >= this
  | { kind: "shipHoldEmpty"; ship: ShipRef }                 // that ship's cargo.units === 0
  | { kind: "taskDone"; taskKey: string }                    // a task with this key is done in the current universe
  | { kind: "all"; of: Trigger[] };                          // every member is met; at most 6 members; members may not be "all"

export type Step =
  | { kind: "buyShip"; shipType: OpeningShipType; maxPrice: number; preApproved: boolean }
  | { kind: "setRole"; ship: ShipRef; role: OpeningRole }
  | { kind: "contractDuty"; ship: ShipRef; on: boolean }
  | { kind: "setDoctrine"; key: string; value?: number; enabled?: boolean };

export interface TaskSpec { key: string; name: string; trigger: Trigger; steps: Step[] }

export type TaskStatus = "queued" | "active" | "done" | "failed" | "needs_review" | "cancelled";

export interface TaskRun extends TaskSpec {
  id: number;
  status: TaskStatus;
  stepIndex: number;                    // index of the next step to run; === steps.length when finished
  stepPhase: "idle" | "started";        // "started" = a step was begun and its outcome was not recorded
  refs: Record<string, string>;         // step index (as a string) -> ship symbol that a buyShip step bought
  note: string | null;                  // last one-line reason, shown in the UI
}
```

Status meanings: `queued` waits for the next universe; `active` is being evaluated; `done` all steps finished; `failed` a step failed and nothing is
uncertain; `needs_review` a step that spends credits may or may not have happened, a person must look; `cancelled` dropped by a person or because its universe ended.

### 3.2 Limits enforced by `validateTaskSpec` (section 4.1)

- `key`: matches `/^[a-z0-9_-]{1,24}$/`. `name`: 1 to 80 characters after trim. `steps`: 1 to 8. A template holds 1 to 12 task specs with distinct keys.
- Numbers must be finite. `cashAtLeast.credits`: 0 to 1_000_000_000. `routeProfitAtLeast.profitPerTrip`: 1 to 100_000_000. `buyShip.maxPrice`: 1 to 5_000_000.
- `setDoctrine`: `key` 1 to 60 characters; at least one of `value` (finite) or `enabled` (boolean) present.
- A `{ by: "step", step: n }` ref is valid only if `n` is smaller than the index of the step using it and step `n` is a `buyShip`. In a trigger, `by: "step"` is **invalid** (no step has run yet).
- `{ by: "symbol" }`: `symbol` matches `/^[A-Z0-9-]{1,40}$/`.
- A template's `taskDone.taskKey` must be the key of another task in the same template. A task added on its own accepts any `taskKey`.

### 3.3 Migration `migrations/055_opening_tasks.sql`

Copy the style of `migrations/054_seasons.sql` (RLS block, `DO $$ ... CREATE POLICY tenant_isolation ...`). Two tables. The column is `trigger_spec`, not `trigger`.

```sql
CREATE TABLE IF NOT EXISTS opening_tasks (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_key         text NOT NULL,
  name             text NOT NULL,
  trigger_spec     jsonb NOT NULL,
  steps            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('queued','active','done','failed','needs_review','cancelled')),
  step_index       integer NOT NULL DEFAULT 0,
  step_phase       text NOT NULL DEFAULT 'idle' CHECK (step_phase IN ('idle','started')),
  refs             jsonb NOT NULL DEFAULT '{}'::jsonb,
  queued_under_key text,          -- the universe key when a 'queued' task was added; it activates in a different universe
  universe_key     text,          -- the universe the task runs in; set when it becomes active
  created_by       text NOT NULL, -- 'operator' | 'mcp' | 'copilot' | 'template'
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS opening_templates (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  tasks      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
```

For both tables: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy exactly as in 054, and an index
`idx_opening_tasks_tenant_status ON opening_tasks (tenant_id, status, created_at)`. Header comment: "Kept across the weekly reset on purpose: the point is to carry the opening into the next universe."

## 4. Behaviour, rule by rule

### 4.1 `src/engine/openingTasks.ts` (pure: no I/O, no clock, no globals)

Exports: the types above, `validateTaskSpec(x: unknown)`, `validateTemplateTasks(x: unknown)`, `triggerMet`, `decide`, `STANDARD_OPENING`.

```ts
export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };
export function validateTaskSpec(x: unknown): Validation<TaskSpec>;          // enforces 3.2 for one task; returns a cleaned copy (trimmed name, only known fields)
export function validateTemplateTasks(x: unknown): Validation<TaskSpec[]>;   // 1..12 specs, distinct keys, taskDone keys resolve inside the list

export interface OpeningFacts {
  spendable: number;                                  // credits minus the cashFloor doctrine value; may be negative
  bestRouteProfit: number | undefined;                // profitPerTrip of the best offered route; undefined when none
  ships: { symbol: string; isCommand: boolean; cargoUnits: number; waypoint: string; docked: boolean }[];
  yards: { waypoint: string; shipType: string; price: number }[];   // shipyard_inventory rows in the HOME system only
  doneKeys: ReadonlySet<string>;                      // task_key of tasks with status 'done' in the current universe
}

export function triggerMet(t: Trigger, f: OpeningFacts): { met: boolean; reason: string };

export type Decision =
  | { kind: "wait"; reason: string }
  | { kind: "run"; stepIndex: number; reason: string; buy?: { yard: string; price: number } }
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string };

export function decide(task: Pick<TaskRun, "trigger" | "steps" | "stepIndex" | "refs">, f: OpeningFacts): Decision;
```

`triggerMet` rules (each returns a reason string that names the numbers, for example `"spendable 41,200 < 110,000"`):

1. `always`: met.
2. `cashAtLeast`: met when `f.spendable >= credits`.
3. `routeProfitAtLeast`: met when `f.bestRouteProfit !== undefined && f.bestRouteProfit >= profitPerTrip`.
4. `shipHoldEmpty`: resolve the ref (rule 6 of `decide`, with no step refs allowed here); met when the ship exists and `cargoUnits === 0`. An unresolvable ref is **not met** (reason says why).
5. `taskDone`: met when `f.doneKeys.has(taskKey)`.
6. `all`: met when every member is met; the reason is the first unmet member's reason.

`decide` rules, in this order:

1. If `stepIndex >= steps.length`: return `done`.
2. If `stepIndex === 0` and `triggerMet(trigger)` is not met: return `wait` with that reason. Once `stepIndex > 0` the trigger is **never** re-checked.
3. Take `step = steps[stepIndex]`.
4. `setRole`, `contractDuty`: resolve `step.ship` (rule 6). If it cannot be resolved return `fail`. Otherwise `run`.
5. `setDoctrine`: `run`.
6. Resolving a ship ref: `command` -> the ship with `isCommand`; none -> `fail` `"no command ship in the fleet"`. `step` -> `refs[String(n)]`; missing -> `fail` `"step n has not bought a ship"`; the symbol must be in `f.ships`, otherwise `fail` `"<symbol> is not in the fleet"`. `symbol` -> must be in `f.ships`, otherwise `fail`.
7. `buyShip`, in this order:
   a. Candidates = `f.yards` rows with `shipType === step.shipType` and `price <= step.maxPrice`. None -> `wait` `"no yard in the home system stocks <type> at or under <maxPrice>"`.
   b. Keep candidates whose `waypoint` has at least one ship in `f.ships` with `docked === true` and `waypoint` equal. None -> `wait` `"no ship of ours is docked at a yard that stocks <type>"`. (v1 never moves a ship to a yard.)
   c. Choose the lowest `price`; ties by `waypoint` ascending (string compare).
   d. If `f.spendable < price` -> `wait` `"spendable <n> < price <price>"`.
   e. Otherwise `run` with `buy: { yard, price }`.

`STANDARD_OPENING: TaskSpec[]` is the operator's opening of 2026-10-18 as three tasks (the numbers are editable defaults, not decisions):

| key | name | trigger | steps |
| --- | --- | --- | --- |
| `cmd-trader` | Command ship trades | `routeProfitAtLeast 30000` | `setRole {by:"command"} trader` |
| `contract-ship` | Contract ship | `all[ taskDone "cmd-trader", shipHoldEmpty {by:"command"}, cashAtLeast 110000 ]` | `buyShip SHIP_LIGHT_SHUTTLE maxPrice 100000 preApproved false`; `setRole {by:"step",step:0} trader`; `contractDuty {by:"step",step:0} on` |
| `tour-ship` | Tour ship | `all[ taskDone "contract-ship", cashAtLeast 110000 ]` | `buyShip SHIP_LIGHT_SHUTTLE maxPrice 100000 preApproved false`; `setRole {by:"step",step:0} tour` |

(A SHIP_PROBE is not used for touring: a probe has 0 fuel capacity and cannot cross gates. The light shuttle at the home yard cost 84,521 on 2026-10-18.)

### 4.2 Persistence: `Store` methods in `src/db/store.ts`

Place them after the season methods (the block that starts with the comment `// ── Season plan`). Each method uses `withTenant(this.pool, tenantId, ...)` exactly like the season methods, with no manual `WHERE tenant_id`. Add row interfaces `OpeningTaskRow` (the `TaskRun` fields plus `tenantId`, `queuedUnderKey`, `universeKey`, `createdBy`, `createdAt`, `updatedAt`, all camelCase) and `OpeningTemplateRow` (`id`, `name`, `tasks: TaskSpec[]`, `createdAt`, `updatedAt`) next to the `SeasonRow` interface.

| Method | Behaviour |
| --- | --- |
| `listOpeningTasks(tenantId)` | All rows, newest first. |
| `addOpeningTask(tenantId, spec: TaskSpec, o: { startMode: "now" \| "next_universe"; universeKey: string \| null; createdBy: string })` | Inserts. `now` -> status `active`, `universe_key = o.universeKey`. `next_universe` -> status `queued`, `queued_under_key = o.universeKey`. Throws `Error("a task with key <key> is already active or queued")` if a row with the same `task_key` and status in (`queued`,`active`,`needs_review`) exists. |
| `cancelOpeningTask(tenantId, id)` | Sets status `cancelled`, note `"cancelled by a person"`, only when the status is `queued`, `active` or `needs_review`. Returns whether a row changed. |
| `updateOpeningTaskRun(tenantId, id, patch: { status?; stepIndex?; stepPhase?; refs?; note? })` | Updates those columns and `updated_at = now()`. |
| `activateQueuedOpeningTasks(tenantId, universeKey)` | `UPDATE ... SET status='active', universe_key=$1 WHERE status='queued' AND queued_under_key IS DISTINCT FROM $1`. Returns the count. |
| `expireOpeningTasks(tenantId, universeKey)` | `UPDATE ... SET status='cancelled', note='the universe ended before this finished' WHERE status IN ('active','needs_review') AND universe_key IS NOT NULL AND universe_key <> $1`. Returns the count. |
| `markStartedOpeningTasksForReview(tenantId, universeKey)` | `UPDATE ... SET status='needs_review', note='a step was started before a restart and its outcome was not recorded: check the fleet before doing anything' WHERE status='active' AND step_phase='started' AND universe_key = $1`. Called once per process start (section 4.4). |
| `listOpeningTemplates(tenantId)` | By name. |
| `saveOpeningTemplate(tenantId, name, tasks: TaskSpec[])` | Insert, or update `tasks` and `updated_at` when `(tenant_id, name)` exists. |
| `deleteOpeningTemplate(tenantId, id)` | Delete; returns whether a row went. |

### 4.3 `src/engine/openingRunner.ts` (async, talks to the world only through `OpeningPorts`)

```ts
export interface OpeningPorts {
  loadTasks(): Promise<OpeningTaskRow[]>;                       // status 'active' only, oldest first
  patchTask(id: number, patch: { status?: TaskStatus; stepIndex?: number; stepPhase?: "idle" | "started"; refs?: Record<string, string>; note?: string }): Promise<void>;
  facts(): Promise<OpeningFacts>;
  buyShip(shipType: OpeningShipType, yard: string): Promise<string>;      // returns the new ship's symbol
  setRole(symbol: string, role: OpeningRole): Promise<void>;
  setContractDuty(symbol: string, on: boolean): Promise<void>;
  setDoctrine(key: string, value: number | undefined, enabled: boolean | undefined): Promise<void>;
  requestApproval(kind: string, opts: { detail: string; cost: number; timeoutMs: number; onTimeout: "deny"; denyCooldownMs: number }): Promise<boolean | undefined>;
  note(kind: string, ship: string | undefined, detail: string, meta?: Record<string, unknown>): void;   // fleet_events line; never throws
}
export async function runOpeningTick(ports: OpeningPorts): Promise<{ ran: boolean }>;
```

`runOpeningTick` rules:

1. `tasks = await ports.loadTasks()`; `f = await ports.facts()`. Add to `f.doneKeys` nothing: the caller supplies it.
2. For each task in order, `d = decide(task, f)`.
   - `wait`: `patchTask(id, { note: d.reason })` only when the note differs from `task.note` (avoid a write per tick); continue to the next task.
   - `done`: `patchTask(id, { status: "done", note: "all steps finished" })`; `note("opening_task_done", ...)`; continue.
   - `fail`: `patchTask(id, { status: "failed", note: d.reason })`; `note("opening_task_failed", ...)`; continue.
   - `run`: execute the step as below, **then `return { ran: true }` immediately** (one step per call across all tasks). If `stepIndex === 0` first emit `note("opening_task_started", ...)`.
3. Executing a step:
   - `setRole`, `contractDuty`, `setDoctrine`: `patchTask(id, { stepPhase: "started" })`; call the port; on success `patchTask(id, { stepIndex: stepIndex + 1, stepPhase: "idle", note: "step <n> done" })` and `note("opening_step_done", ...)`; on a thrown error `patchTask(id, { status: "failed", stepPhase: "idle", note: <message> })` and `note("opening_task_failed", ...)`. (These do not spend credits, so a failure is certain.)
   - `buyShip`: if `!step.preApproved`: `ok = await ports.requestApproval("openingBuy:" + id + ":" + stepIndex, { detail: "<task name>: buy <type> at <yard> for <price>c", cost: price, timeoutMs: 30 * 60_000, onTimeout: "deny", denyCooldownMs: 60 * 60_000 })`. `undefined` -> `patchTask(note: "waiting for approval")` and return `{ ran: false }`. `false` -> `patchTask(status: "failed", note: "purchase denied")` and return `{ ran: false }`. Then: `patchTask(id, { stepPhase: "started" })` **before** the buy; `symbol = await ports.buyShip(...)`; on success `patchTask(id, { refs: { ...task.refs, [String(stepIndex)]: symbol }, stepIndex: stepIndex + 1, stepPhase: "idle", note })`. **On any thrown error: `patchTask(id, { status: "needs_review", note: "buy may have happened: " + message })` and `note("opening_task_failed", ...)`. Never retry, never loop.**
4. `ran: false` when nothing was executed.

### 4.4 Fleet wiring (thin) in `src/engine/fleet.ts`

1. **Doctrine clause.** In `src/engine/doctrine.ts`, add an entry next to `resetWindDown` (same object shape): `key: "openingTasks"`, `name: "Opening tasks"`, a description that says what section 0 says plus "Off by default: turn the clause on to use it. Takes effect on the next tick.", `value: 1, min: 1, max: 1, step: 1, unit: ""`, `enabled: false, enforced: true, category: "ops", defaultAdopted: true`. Run `node --test --import tsx tests/doctrine*.test.ts` (if a test counts clauses or lists keys, update it; if none exist, move on).
2. **New private method `runOpeningTasks()`** next to `retireNonTraders()`. Body, in this order:
   - Return at once unless `this.tenantId && this.store && this.doctrine.isEnabledOr("openingTasks", false)`.
   - Throttle: return unless `Date.now() - this.lastOpeningRunAt >= 10_000`; then set `this.lastOpeningRunAt = Date.now()`.
   - `const key = tenantUniverse(this.tenantId)` (import from `../db/pool.js`). If `key` is null/undefined return (the universe is not known yet).
   - Once per process (flag `openingBooted`): `await store.markStartedOpeningTasksForReview(tenantId, key)`.
   - Every run: `await store.expireOpeningTasks(tenantId, key)` then `await store.activateQueuedOpeningTasks(tenantId, key)`.
   - Build ports and call `runOpeningTick(ports)`. Port wiring: `loadTasks` = `store.listOpeningTasks` filtered to status `active` and `universeKey === key` (or null), oldest first; `facts` per 4.5; `buyShip` = `async (t, yard) => (await this.buyShip(t as ShipType, yard)).symbol`; `setRole` = `this.setShipRole(symbol, role)`; `setContractDuty` = `this.setContractDuty(symbol, on)`; `setDoctrine` = look at how the `stcommand_set_doctrine` tool in `src/mcp/tools.ts` (line ~1116) applies a change and call the same `Doctrine` method; `requestApproval` = `this.approvals.request(kind, opts)`; `note` = `void this.store.recordFleetNote(this.tenantId, kind, ship, detail, meta)`.
3. **Call site.** In `tickCore` directly after the line `await this.timed("retireNonTraders", () => this.retireNonTraders());` add `await this.timed("openingTasks", () => this.runOpeningTasks());`. Wrap the body of `runOpeningTasks` in try/catch that logs `this.log("opening tasks: " + message)` and never rethrows (a failure here must not stop the tick).
4. **`routeBuild.best`.** In the place where `this.routeBuild = { at: ..., offered: built.length, ... }` is assigned (search `this.routeBuild = {`), add a field `best: built.length ? Math.max(...built.map((r) => r.profitPerTrip)) : undefined` and add `best?: number` to the type on the `private routeBuild:` declaration. Nothing else about route building changes.

### 4.5 How `facts()` is built (inside `runOpeningTasks`)

- `spendable = this.credits - this.doctrine.value("cashFloor", 0)`. (`this.credits` is refreshed by `refreshCredits()`; do not call the API here.)
- `bestRouteProfit = this.routeBuildReport()?.best`.
- `ships`: from `this.fleetStatusSummary()` (fields `symbol`, `waypoint`, `nav`, `cargo`). `docked = nav === "DOCKED"`, `cargoUnits = cargo`, `isCommand = this.shipFor(symbol)?.registration?.role === "COMMAND"`.
- `yards`: `(await this.store.shipyardInventory())` rows (see the existing use in `storedShipyardForSale` in fleet.ts) filtered to `systemSymbol === this.systemSymbol`, mapped to `{ waypoint: waypointSymbol, shipType, price: purchasePrice }`.
- `doneKeys`: the `task_key` of every row from `listOpeningTasks` with status `done` and `universeKey === key`.

### 4.6 Templates and the reset

Applying a template (`applyTemplate(w, templateId, startMode)`, a function in `src/http/openingTasks.ts` used by HTTP and MCP) validates the stored specs again with `validateTemplateTasks`, then calls `addOpeningTask` for each spec with `createdBy: "template"`. If any insert throws (duplicate key), stop and return the error naming the key; tasks already inserted stay (the operator cancels them).

`next_universe` flow: before the reset the operator applies the template with `startMode: "next_universe"`; the rows are `queued` with `queued_under_key = THEOREM@<old reset date>`. After the reset the new universe key differs, so the first `runOpeningTasks` of the new week activates them. The week's ledger/RLS scoping is unaffected: these tables are not scoped by universe, the `universe_key` column is data.

## 5. Work packages (do in this order; commit after each)

Each package ends with "Done when". Do not start the next package until it holds.

### Package 1 — pure module and its tests

Files: `src/engine/openingTasks.ts`, `tests/openingTasks.test.ts`.
Do: implement section 3.1, 3.2, 4.1 exactly. Tests (node:test, `describe`/`it`, `assert/strict`) must include these cases, with exactly these expectations:
1. `validateTaskSpec` accepts each task in `STANDARD_OPENING`.
2. It rejects: key `"Bad Key"`; 0 steps; 9 steps; `buyShip` with `maxPrice: 0`; `setDoctrine` with neither `value` nor `enabled`; a step ref `{by:"step",step:1}` used by step 1; a step ref pointing at a `setRole` step; a trigger containing `{by:"step"}`; an `all` inside an `all`; `NaN` credits.
3. `validateTemplateTasks` rejects duplicate keys and a `taskDone` whose key is not in the list; accepts `STANDARD_OPENING`.
4. `triggerMet`: one case per trigger kind, met and not met, plus `all` returning the first unmet reason; `shipHoldEmpty` with an unknown command ship is not met.
5. `decide`: `stepIndex 0` with an unmet trigger -> `wait`; `stepIndex 1` with the same unmet trigger -> `run` (the trigger is not re-checked); `stepIndex === steps.length` -> `done`; `setRole` on `{by:"step",step:0}` with no ref -> `fail`; `setRole` on `{by:"step",step:0}` with `refs {"0":"X-9"}` while `X-9` is not in `ships` -> `fail`.
6. `decide` for `buyShip`: (a) no yard row for the type -> `wait`; (b) a yard row over `maxPrice` -> `wait`; (c) a yard with no docked ship of ours -> `wait`; (d) two yards, both with a docked ship, prices 90k and 80k -> `run` with the 80k yard; (e) equal prices -> the lexicographically smaller waypoint; (f) the cheapest yard has no docked ship but a dearer one does -> `run` with the dearer one; (g) `spendable` below the price -> `wait`.
Verify: `node --test --import tsx tests/openingTasks.test.ts` all pass; `npm run typecheck`.
Commit: `Opening tasks: pure trigger/step evaluator and validation`.

### Package 2 — migration and Store methods

Files: `migrations/055_opening_tasks.sql`, edits to `src/db/store.ts`, `tests/openingStore.test.ts`.
Do: section 3.3 and 4.2. The test follows `tests/seasonRoutes.test.ts` (the `appPool()` helper, a throwaway tenant row, `after` cleans up) and needs the test database. It must cover: add `now` -> `active`; add `next_universe` -> `queued`; duplicate active key throws; `activateQueuedOpeningTasks` with the same key as `queued_under_key` changes 0 rows and with a different key changes 1; `expireOpeningTasks` cancels an active task of another universe and leaves one of the current universe; `markStartedOpeningTasksForReview` moves a `step_phase='started'` task to `needs_review`; template save twice with the same name updates one row; delete returns true then false; **a second tenant cannot see the first tenant's tasks** (RLS).
Verify: `npm run migrate:test` then `node --test --import tsx --env-file-if-exists=.env.test tests/openingStore.test.ts`. Without a database, skip the test run but state that in the commit body.
Commit: `Opening tasks: tables and store methods`.

### Package 3 — runner and its tests

Files: `src/engine/openingRunner.ts`, `tests/openingRunner.test.ts`.
Do: section 4.3. Tests use an in-memory fake `OpeningPorts` that records every call. Cases:
1. A `setRole` task whose trigger is met: one tick patches `stepPhase started`, calls `setRole` once, then patches `stepIndex 1`; the next tick patches `done`.
2. Only one step is executed per call even with three runnable tasks (`ran: true`, exactly one port action).
3. `buyShip` not pre-approved: approval returns `undefined` -> no `buyShip` call, `ran: false`; returns `false` -> task `failed`, no buy; returns `true` -> `stepPhase started` is patched **before** `buyShip` is called (assert call order), then `refs["0"]` holds the returned symbol.
4. `buyShip` pre-approved: `requestApproval` is never called.
5. `buyShip` throws: task becomes `needs_review`, and a second tick calls `buyShip` **zero** more times.
6. `setRole` throws: task `failed`.
7. A multi-step "buy, setRole step 0, contractDuty step 0" task runs over three ticks and ends `done` on the fourth, using the symbol from the buy.
8. A waiting task does not call `patchTask` again when its reason is unchanged.
Verify: `node --test --import tsx tests/openingRunner.test.ts`; typecheck.
Commit: `Opening tasks: runner with approval, one step per tick, no retry after an uncertain buy`.

### Package 4 — fleet wiring and the doctrine clause

Files: `src/engine/doctrine.ts`, `src/engine/fleet.ts`, `tests/openingFleetWiring.test.ts`.
Do: section 4.4 and 4.5. The wiring test reads `src/engine/fleet.ts` as text (copy the style of the `fleet.ts wiring` describe block at the bottom of `tests/windDownScrap.test.ts`) and asserts with regular expressions: the call `this.timed("openingTasks", () => this.runOpeningTasks())` exists and comes after the `retireNonTraders` call; `runOpeningTasks` begins with the `isEnabledOr("openingTasks", false)` guard; the buy port calls `this.buyShip(`; `routeBuild = {` contains `best:`. Also add a test that the clause exists in `src/engine/doctrine.ts` with `enabled: false`.
Off-switch proof (required): a test in `tests/openingRunner.test.ts` is not enough; in the wiring test assert the guard text so that "clause off -> returns before touching the store" is checked by reading the source order (the guard is the first statement).
Verify: the wiring test, `npm run typecheck`, and `node --test --import tsx tests/doctrine*.test.ts` (if such files exist).
Commit: `Opening tasks: doctrine clause (off) and fleet wiring`.

### Package 5 — HTTP routes

Files: `src/http/openingTasks.ts`, one edit in `src/http/dashboard.ts`, `tests/openingRoutes.test.ts`.
Do: copy the shape of `src/http/season.ts` (`withWorker` helper, error mapping). Export `createOpeningRouter(worker)` and `applyTemplate(w, id, startMode, createdBy)`. Mount it in `src/http/dashboard.ts` on the line after `router.use("/season", createSeasonRouter(worker));` as `router.use("/opening", createOpeningRouter(worker));` and add the import next to the season import. Routes (JSON in and out; the body shapes are exact):

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/opening` | none | `{ enabled: boolean, universeKey: string\|null, tasks: OpeningTaskRow[], templates: OpeningTemplateRow[], standard: TaskSpec[] }` where `enabled` is `fleet.doctrine isEnabledOr("openingTasks", false)`; find the accessor the season router or dashboard uses to read doctrine (search `isEnabledOr(` in `src/http`) |
| `POST /api/opening/tasks` | `{ task: TaskSpec, startMode: "now"\|"next_universe" }` | the inserted row; 400 with `{error}` on validation failure |
| `DELETE /api/opening/tasks/:id` | none | `{ ok: true }` or 404 `{error:"no such task"}` |
| `POST /api/opening/templates` | `{ name: string, tasks: TaskSpec[] }` | the saved template; name 1 to 60 characters |
| `DELETE /api/opening/templates/:id` | none | `{ ok: true }` or 404 |
| `POST /api/opening/templates/:id/apply` | `{ startMode }` | `{ added: number }` |
| `POST /api/opening/templates/standard` | `{ startMode }` | applies `STANDARD_OPENING` without saving it as a template; `{ added }` |

Every mutating route also writes `w.store.recordOperatorAction(w.tenantId, "opening_task_add" | "opening_task_cancel" | "opening_template_save" | "opening_template_delete" | "opening_template_apply", undefined, <one line>, { via: "http" })`.
Tests follow `tests/seasonRoutes.test.ts` (needs the test database): add, list, cancel, validation error returns 400, apply the standard template with `next_universe` creates 3 `queued` rows, applying it twice returns an error naming the first duplicate key.
Commit: `Opening tasks: HTTP routes`.

### Package 6 — MCP tools and the co-pilot

Files: `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/engine/agentChat.ts`, `src/http/dashboard.ts`, `tests/openingMcp.test.ts`.

MCP (`src/mcp/tools.ts`, same pattern as `stcommand_set_contract_duty`; register after it; use `recordMcpAction(w, "<kind>", undefined, "<line>", {...})`). Tool names and inputs, exact:

| Tool | Input (zod) | Does |
| --- | --- | --- |
| `stcommand_list_opening_tasks` | none | tasks, templates, enabled flag. Read-only (`readOnlyHint: true`). |
| `stcommand_add_opening_task` | `task` (JSON object, validated with `validateTaskSpec`), `startMode` enum | adds one task, `createdBy: "mcp"` |
| `stcommand_cancel_opening_task` | `id: number` | cancels |
| `stcommand_save_opening_template` | `name: string`, `tasks: array` | validates with `validateTemplateTasks`, saves |
| `stcommand_apply_opening_template` | `templateId: number` or `standard: true`, `startMode` | applies via `applyTemplate` |

Add one bullet describing these five tools to the `instructions` text in `src/mcp/server.ts` (the same paragraph style as the others) saying: off until the doctrine clause `openingTasks` is on; a buy step asks for approval unless it is marked preApproved; steps run one per tick; a task in `needs_review` means a purchase may have happened, so read the fleet before doing anything.

Co-pilot (`src/engine/agentChat.ts`): extend `ProposedAction.kind` with `"add_opening_task"` and add optional `taskJson?: string` and `startMode?: "now" | "next_universe"` to `ProposedAction`. In `proposeTool()`: add `"add_opening_task"` to the `kind` enum, add parameters `taskJson` (string, "a task spec as JSON") and `startMode`; in `execute`, handle `add_opening_task` **before** the ship-symbol checks: parse `taskJson`, validate with `validateTaskSpec`, return `"Error: <message>"` on failure, otherwise queue a proposal with `summary = "add opening task <key>: <name> (<startMode>)"`. The `required` list of the tool's schema stays `["kind"]` for this kind (change `required` to `["kind"]`, and keep the existing `shipSymbol` check for the other kinds). In `executeCopilotAction` in `src/http/dashboard.ts` handle `add_opening_task`: validate again, call `w.store.addOpeningTask(..., { createdBy: "copilot", ... })`, then `recordOperatorAction(..., "opening_task_add", ..., { via: "copilot" })`, return `Done: <summary>.`. The captain still has to `/confirm` the proposal, which is the existing approval step for co-pilot changes.

Tests: `tests/openingMcp.test.ts` checks, by reading the source text like the wiring tests, that the five tool names are registered and that `agentChat.ts` contains `add_opening_task`; plus a unit test that `proposeTool().execute` with a valid `taskJson` returns text containing `Proposal id`, with invalid JSON returns text starting with `Error:`.
Commit: `Opening tasks: MCP tools and co-pilot proposal`.

### Package 7 — Deck screen

Files: `public/shared/opening.js` (new), `public/deck.html`, `public/deck.js`.
Model it on `public/shared/season.js` and how `deck.js` mounts it (`import { mountSeason }`, `seasonScreen ??= mountSeason($("season-root"), { api })`, `seasonScreen.show()`, `seasonScreen?.hide()` in the view switch at line ~92 and ~132).
Do:
1. In `public/deck.html` add, next to the `view-season` block, `<div class="content" id="view-opening" hidden><div id="opening-root" class="mx ss"></div></div>`.
2. In `public/deck.js` add the import, the `openingScreen` variable, the hide line and the show branch, exactly paralleling season. Add the tab `{ key: "opening", label: "Opening", view: "opening" }` to the `settings` group in `NAV_GROUPS`, directly after the `automation` entry.
3. `mountOpening(root, { api })` returns `{ show, hide }`. On `show` it calls `GET /api/opening` and renders: (a) a banner "Opening tasks are OFF (doctrine clause openingTasks)" when `enabled` is false; (b) the task table (name, status, `step n of m`, note, a Cancel button for `queued`/`active`/`needs_review`); (c) the template list with Apply now / Apply for next universe / Delete; (d) a button "Apply standard opening (next universe)" and one for "now"; (e) a plain JSON textarea plus Add now / Add for next universe to add a single task spec, and Save as template (name field); an invalid spec shows the server's `error` text under the textarea. Use `textContent`, never `innerHTML`, for any server-provided string (names and notes are user text).
4. A task with status `needs_review` renders in the warning colour class already used elsewhere in the Deck for warnings (search `public/deck.css` or the `<style>` block for `.warn`; if there is none, use an inline text prefix "CHECK THE FLEET:").
Verify: `node --input-type=module --check < public/shared/opening.js` and the same for `public/deck.js` (syntax only). `scripts/dom-check.mjs` is for the v2.html refactor and is not used here. If the dev server can be started (`npm run dev` needs the database), open `/deck`, click Settings then Opening, and confirm the screen renders; otherwise state plainly that the screen was not run.
Commit: `Opening tasks: Deck screen`.

### Package 8 — documents

Files: `CHANGELOG.md` (one entry at the top in the existing style), `docs/TODO.md` (move the "Opening automation" entry's built parts to the changelog; leave the open items), `docs/architecture-overview.md` only if a described layer changed (it did not: skip), `CLAUDE.md` (add one short paragraph under "Operating the fleet via the stcommand MCP server" saying the opening tasks exist, are off by default, and that `needs_review` means read the fleet first).
Commit: `Opening tasks: docs`.

## 6. Acceptance checks for the whole feature (all must be true before reporting done)

1. `npm run typecheck` reports no new errors compared with the start.
2. These test files pass: `openingTasks`, `openingRunner`, `openingFleetWiring`, `openingMcp` (and `openingStore`, `openingRoutes` when a test database is available; otherwise say they were not run).
3. With the clause off (default), no code path in section 4.4 reads or writes the opening tables during a tick (the guard is the first statement of `runOpeningTasks`).
4. `git status` shows no change to the files named in rule 4 of section 1.
5. No secret, token, key or model name appears in any added file (`git diff main -- . | grep -iE "token|secret|api[_-]?key"` shows only legitimate identifiers such as the existing word "token" in unrelated context; review each hit).

## 7. Out of scope for v1 (do not build)

Moving a ship to a yard before buying; buying outside the home system; triggers on prices of a named good; steps that start feeds, missions, dispatch tours or keeper placement; editing a task after it is added (cancel and re-add); a Tower (mobile) screen; any change to the autonomous buyers (`maybeBuyShip` and the keeper-probe proposals keep working as they do).

## Discrepancies

(Implementing model: write here anything in this plan that did not match the code. Leave empty if none.)
