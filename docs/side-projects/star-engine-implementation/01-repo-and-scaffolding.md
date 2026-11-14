# 01. Repository and scaffolding

Goal of this file: after following it literally, the implementer has an empty-but-green repository: `npm ci && npm run check`
passes, the purity lint is enforced, CI runs, and every directory in `02` exists with a README line.

---------------------------------------------------------------------------------------------------

## 1. Language and tooling choice

| Choice | Decision | Reasons | Rejected alternatives |
|---|---|---|---|
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` | The design plan says TypeScript unless otherwise stated (open question 5: "TypeScript for parity"). One language for engine, fake API server, simulator and tests; discriminated unions model `Decision`/`Event` precisely; JSON-native for an HTTP/JSON API. | Python (weaker static guarantees on money paths), Rust (slower to iterate; the bottleneck is the 2 req/s API limit, not CPU) |
| Runtime | Node.js 22 LTS (`"engines": {"node": ">=22"}`), ESM only (`"type": "module"`) | Built-in `fetch`, `node:test` available but we use vitest; stable LTS. | Bun/Deno (extra variance for little benefit) |
| Package manager | npm with committed `package-lock.json`; always `npm ci` | Fewest moving parts; no extra tool to install. | pnpm/yarn |
| Test runner | vitest + fast-check (property tests) | Fast, TS-native, snapshot support for golden decision logs. | jest |
| HTTP | `undici` (`request`/`fetch` + `ProxyAgent`) | The per-source-IP requirement needs a forward-proxy agent; `undici` provides `ProxyAgent` and exposes response headers (`x-ratelimit-*`, `retry-after`). Do not mix Node's global fetch with undici's ProxyAgent (their internal undici versions are incompatible; stcommand hit this). Use undici's own `fetch`/`request` everywhere. | axios, got |
| DB | `better-sqlite3` (synchronous, WAL mode) | Single writer; synchronous calls make the executor's "write intent, then call, then write result" ordering trivially correct and testable; one file per week. | Postgres (ops overhead for one process), LevelDB |
| Schema validation | `zod` for API payloads, config and policy | Every API payload is validated at the edge; anything that fails validation is logged and dropped (X-10 outlier path). | io-ts, ajv |
| Config files | YAML (`yaml` package) for `policy` and `runtime`; validated with zod; env vars only for secrets | Human-edited and diff-friendly; hot-reloadable policy (X-12). | JSON5, TOML |
| Logging | `pino` JSON lines to stdout and a rotating file; one event per line with `ruleId`, `reason` | Machine-greppable; the reason strings are the product. | winston |
| Lint/format | eslint (typescript-eslint, flat config) + prettier; `dependency-cruiser` to enforce layering | Purity of `src/core` is enforced mechanically, not by convention. | none |
| Build | `tsc` for type-check/emit to `dist/`; run in dev with `tsx` | No bundler needed. | esbuild bundling |
| Versions | At scaffold time install the latest stable of each package and let `package-lock.json` pin; record the resolved versions in `docs/adr/0001-stack.md`. Do not invent version numbers from memory. | The plan cannot verify registry state. | |

OPEN QUESTION Q-STACK: the operator may prefer Postgres for symmetry with stcommand (design plan open question 5). The
`Store` interface in `02` makes that a later swap; D2 stays unless the operator says otherwise.

---------------------------------------------------------------------------------------------------

## 2. Repository layout (exact)

```
star-engine/
  README.md                      (short: what it is, how to run shadow mode, link to docs/)
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  eslint.config.js
  .prettierrc
  .dependency-cruiser.cjs        (layering rules, section 5)
  .gitignore                     (data/, dist/, *.sqlite*, secrets/, .env*, recordings/*.ndjson)
  .env.example                   (variable NAMES only, empty values)
  config/
    runtime.example.yaml         (non-secret runtime config: mode, budget, paths)
    policy.default.yaml          (the policy; full contents in 04-decision-engine.md section 12)
    policy.schema.ts             (re-export of src/core/policy.ts zod schema, used by `npm run policy:check`)
  migrations/
    001_core.sql                 (events, api_calls, weeks, kv)
    002_projections.sql          (market_latest, market_history, shipyard_latest, ships, intents, lots, trips)
    003_analysis.sql             (rule_fires, skips, experiments, rule_stats, paper_trades)
  src/
    domain/                      PURE data types and tiny helpers, no logic of the game model
      ids.ts                     (branded string types: ShipSymbol, WaypointSymbol, SystemSymbol, GoodSymbol, WeekId, IntentId)
      money.ts                   (Credits = number integer helpers; roundCredits; safeAdd)
      types.ts                   (Observation, Snapshot, MarketView, Route, Decision, Intent... see 02)
      events.ts                  (Event discriminated union, see 02)
      reasons.ts                 (rule ids as a const enum-like object plus formatReason helpers)
    core/                        PURE decision logic. May import only src/domain and src/core. NO I/O, NO Date.now, NO Math.random
      policy.ts                  (zod schema and TS type for Policy; defaults; bounds)
      snapshot.ts                (fold events -> Snapshot)
      marketModel.ts             (price walk, depth, recovery, staleness confidence)
      travel.ts                  (distance, travel time and fuel models; fitted parameters passed in)
      opportunity.ts             (route generation and scoring, pace and reservations)
      allocator.ts               (ship-to-route assignment)
      purchase.ts                (PurchasePlanner)
      keeper.ts                  (KeeperPlanner, M3 slice)
      gate.ts                    (GatePlanner, M3 slice)
      contract.ts                (ContractPlanner, M3 slice)
      expansion.ts               (ExpansionPlanner, post-M4)
      winddown.ts                (WindDown phase flags)
      risk.ts                    (RiskGuard veto layer)
      decide.ts                  (the one entry point: decide(snapshot, policy, ctx) -> Decision[])
      telemetry/                 (pure reducers: metrics.ts, matchedProfit.ts, calibration.ts)
    api/                         I/O: the only code that knows URLs and JSON field names
      endpoints.ts               (typed wrappers, one function per endpoint, with (A) markers)
      schemas.ts                 (zod schemas for responses)
      client.ts                  (HTTP, auth header, proxy agent, error classification)
      limiter.ts                 (token bucket + hard per-minute and per-hour caps)
      budget.ts                  (priority queue, shedding, 429 back-off, accounting to api_calls)
      resetWatcher.ts            (poll GET /v2/ and 401 latch)
      readOnly.ts                (ReadOnlyClient wrapper used in shadow mode)
    store/
      db.ts                      (open, migrate, pragmas, advisory lock)
      store.ts                   (Store interface implementation: appendEvent, tx, queries)
      projections.ts             (rebuild/maintain derived tables from events)
      weekArchive.ts             (close a week, export summary, snapshot rule_stats)
    shell/
      clock.ts                   (Clock interface; SystemClock; FakeClock for tests)
      observer.ts                (API response -> Observation events)
      executor.ts                (Intent -> API calls; ShadowExecutor; LiveExecutor)
      shipWorker.ts              (per-ship async state machine)
      scheduler.ts               (the main loop: tick, run decide, dispatch)
      killswitch.ts              (file flag, signal, status endpoint control)
      lock.ts                    (single-writer lockfile)
      status.ts                  (read-only HTTP JSON status server, localhost only)
      bootstrap.ts               (week start: register, fetch agent/ships/home system)
    cli/
      main.ts                    (commander-free: `node dist/cli/main.js <command>`)
      commands/ run.ts shadow.ts record.ts replay.ts sim.ts compare.ts report.ts policyCheck.ts doctor.ts
  sim/
    fakeApi/                     (the fake SpaceTraders server, section in 06)
      server.ts handlers/ faults.ts world.ts
    marketSim.ts                 (market physics used by the fake server and by `sim` command)
    scenarios/                   (JSON scenario files: worlds + faults + expected invariants)
  recordings/                    (gitignored NDJSON from live; a tiny committed sample under recordings/sample/)
  tests/
    unit/ property/ replay/ integration/ chaos/ fixtures/
  docs/
    adr/0001-stack.md
    open-questions.md
    runbook.md                   (start, stop, kill switch, reset day)
    plan/                        (copy of this plan folder, read-only reference)
  .github/workflows/ci.yml
```

Rules for the layout:

1. `src/core` and `src/domain` import nothing outside themselves except `zod` (pure) in `core/policy.ts`. Enforced in section 5.
2. `src/api` may import `src/domain` only. It never imports `core`.
3. `src/shell` and `src/store` may import everything; they are the wiring.
4. `sim/` may import `src/domain` and `src/core` and implements the game's side. It must never be imported by `src/` (only by tests and `cli/commands/sim.ts`).
5. One module = one file with a narrow exported interface and a sibling `*.test.ts` under `tests/unit/` mirroring the path.

---------------------------------------------------------------------------------------------------

## 3. package.json (shape; fill dependency versions at install time)

```json
{
  "name": "star-engine",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . && depcruise src sim --config .dependency-cruiser.cjs",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:property": "vitest run tests/property",
    "test:replay": "vitest run tests/replay",
    "policy:check": "tsx src/cli/main.ts policy-check config/policy.default.yaml",
    "migrate": "tsx src/cli/main.ts migrate",
    "shadow": "tsx src/cli/main.ts shadow --config config/runtime.yaml",
    "record": "tsx src/cli/main.ts record --config config/runtime.yaml",
    "run:live": "tsx src/cli/main.ts run --config config/runtime.yaml",
    "sim": "tsx src/cli/main.ts sim",
    "doctor": "tsx src/cli/main.ts doctor --config config/runtime.yaml",
    "check": "npm run typecheck && npm run lint && npm run format:check && npm test && npm run policy:check"
  }
}
```

Dependencies (names only): runtime `undici`, `better-sqlite3`, `zod`, `yaml`, `pino`; dev `typescript`, `tsx`, `vitest`,
`fast-check`, `eslint`, `typescript-eslint`, `prettier`, `dependency-cruiser`, `@types/node`, `@types/better-sqlite3`.
Do not add anything with network side effects at install time. No LLM SDK may appear in `package.json` or the lockfile
(CI check in section 6 greps for `openai`, `anthropic`, `langchain`, `@google/generative-ai`, `ollama`).

tsconfig essentials: `"target": "ES2023"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`,
`"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`,
`"verbatimModuleSyntax": true`, `"outDir": "dist"`, `"rootDir": "."` with `include` of `src`, `sim`, `tests`.

---------------------------------------------------------------------------------------------------

## 4. Configuration

Two files, both validated by zod at start-up and on hot-reload. Secrets are NEVER in either.

### 4.1 `config/runtime.yaml` (non-secret, per-deployment; copy from `runtime.example.yaml`)

```yaml
# runtime.example.yaml
mode: shadow                 # shadow | live ; "live" additionally requires --i-understand-live on the command line
autonomyLevel: 0             # 0 observe, 1 safe trader, 2 growth, 3 expansion. shadow forces 0 for execution
agent:
  callsign: ""               # chosen at registration; the week id is callsign@resetDate
  faction: ""                # (A) faction symbol, operator choice (open question)
api:
  baseUrl: "https://api.spacetraders.io/v2"   # (A) the base URL; verified in M0. Keep configurable
  userAgent: "star-engine/0.x (research bot)" # generic name, no personal details
  timeoutMs: 15000
egress:
  proxyEnv: "STAR_PROXY_URL"          # NAME of the env var holding the proxy URL (never the URL itself)
  expectIpEnv: "STAR_EXPECT_EGRESS_IP" # NAME of the env var holding the IP the proxy should show (optional)
  requireSeparateIp: true             # start-up refuses to run if no proxy is configured (see 03 section 3)
budget:
  targetRps: 1.0                      # shadow default; live default 1.75
  burst: 10                           # below the game's 30
  maxCallsPerMinute: 60               # HARD cap, shadow default; live default 105
  maxCallsPerHour: 3300               # HARD cap
  maxCallsPerDay: 70000               # HARD cap (safety net; see 03)
  shedAbove: 0.92
  backoffFrac: 0.25
  backoffMin: 5
store:
  dir: "./data"                       # one sqlite file per week: data/<callsign>@<resetDate>.sqlite plus data/meta.sqlite
  recordingsDir: "./recordings"
status:
  host: "127.0.0.1"
  port: 8787                          # read-only JSON; never exposed publicly
killSwitch:
  filePath: "./data/KILL"             # existence of this file forces autonomy 0 within one tick
  maxDrawdownPct: 10                  # see 08
tick:
  coreMs: 1500
  maintenanceMs: 5000
alerts:
  fileLog: "./data/alerts.log"        # alerts are written here; webhooks are a later add-on (open question)
```

### 4.2 `config/policy.default.yaml`
The policy (every tunable number, rule on/off). Full content in `04-decision-engine.md` section 12. Hot-reload rules
(X-12): validate against the zod schema and bounds; on any error keep the old policy and emit an alert event; every
accepted change writes a `config_change` event with before and after and bumps `policyVersion` (monotonic integer).

### 4.3 Secrets: env var names only

| Env var | Meaning | Where read | Notes |
|---|---|---|---|
| `STAR_ACCOUNT_TOKEN` | Account-level token used ONLY to register a new agent each week (A) | `shell/bootstrap.ts` | Never logged. Must be a different variable name from anything stcommand uses (the live box uses `ST_ACCOUNT_TOKEN`); do not reuse its value. OPEN QUESTION whether a second agent may be registered on the same account (Q-ACCT) |
| `STAR_AGENT_TOKEN` | Agent bearer token for the current week | `api/client.ts` | Written by registration into `secrets/agent-token` (mode 0600) and loaded from there if the env var is empty; dies at reset |
| `STAR_PROXY_URL` | Forward proxy URL for the separate source IP (may embed credentials) | `api/client.ts` | MUST NOT be any of the live fleet's `PROXY_URL_*`, `API_LANE_PROXY_URL(S)` or `CRAWLER_PROXY_URL` values |
| `STAR_EXPECT_EGRESS_IP` | The IP the proxy is expected to egress from (optional sanity check) | `cli doctor` | |
| `STAR_CALLSIGN`, `STAR_FACTION` | Registration inputs (non-secret but per-deployment) | `bootstrap.ts` | |
| `STAR_STATUS_TOKEN` | Optional bearer for the local status endpoint | `shell/status.ts` | If unset, the endpoint binds to 127.0.0.1 only |
| `STAR_ALERT_WEBHOOK` | Optional webhook URL for alerts (later) | `shell/alerts.ts` | OPEN QUESTION Q-ALERT |

Secret handling rules (enforced by tests):
1. A `redactSecrets(string)` function replaces any substring equal to a loaded secret value with `[REDACTED]`; every log line and every event payload goes through it.
2. Tokens are never written into `events.payload`, `api_calls`, error messages or recordings. The recorder strips the `Authorization` header and any `token` field from `/register` responses before writing.
3. `.env*`, `secrets/`, `data/`, `recordings/*.ndjson` are gitignored; CI runs a secret scanner (gitleaks or the GitHub secret scan) on every push.
4. `config/*.yaml` committed to git contain only the example values; real runtime config goes in `config/runtime.yaml` (gitignored).

---------------------------------------------------------------------------------------------------

## 5. Layering enforcement (`.dependency-cruiser.cjs`)

Forbidden rules (each as a `forbidden` entry with `severity: "error"`):

| Name | From | To | Rule |
|---|---|---|---|
| core-is-pure | `^src/(core|domain)` | `node:` builtins (except `node:crypto` is NOT allowed either), `^src/(api|store|shell|cli)`, `undici`, `better-sqlite3`, `pino`, `yaml` | core/domain may only import core/domain and `zod` |
| api-leaf | `^src/api` | `^src/(core|store|shell|cli)` | api may import only domain |
| sim-isolated | `^src/` | `^sim/` | src never imports sim |
| no-cycles | any | any | circular dependencies are errors |

Additional ESLint rules for `src/core` and `src/domain` (via `no-restricted-globals` and `no-restricted-syntax`):
`Date`, `Math.random`, `performance`, `process`, `setTimeout`, `setInterval`, `fetch`, `console`, `require`, `crypto`,
dynamic `import()`. Hashing for intent ids is done in `shell` (the core returns the preimage string; shell hashes it).
A test (`tests/unit/purity.test.ts`) greps `src/core` and `src/domain` for these tokens as a second line of defence.

---------------------------------------------------------------------------------------------------

## 6. CI (`.github/workflows/ci.yml`)

Triggers: push and pull_request. Single job on `ubuntu-latest`, Node 22:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint` (eslint + depcruise)
4. `npm run format:check`
5. `npm run policy:check` (validates `config/policy.default.yaml` against the schema; every rule has `enabled` and bounds)
6. `npm test` (unit, property with a fixed seed from `FC_SEED` env plus 100 runs; the nightly job runs 10,000)
7. `npm run test:replay` against `recordings/sample/` (committed small fixture, under 2 MB)
8. `node scripts/no-llm.mjs` (fails if any dependency or source string matches the LLM list in section 3)
9. `node scripts/no-secrets.mjs` (fails if a file matches `ST_|STAR_.*=.+` outside `.env.example`, or a JWT-looking string)
10. Sim smoke: `npm run sim -- --scenario sim/scenarios/week-100x.json --speed 100` must finish in under 5 minutes (design M0 criterion) with all invariants green

Nightly (cron) job: property tests at 10,000 runs, the chaos suite (`tests/chaos`), and the full simulated week.
Required checks for merge: steps 1-9. No deploy step exists: STAR is run by hand on one machine.

---------------------------------------------------------------------------------------------------

## 7. Scaffolding task list (do these in order; each is a commit)

| # | Task | Done when |
|---|---|---|
| S1 | `git init`, license-free private repo, `.gitignore`, `.env.example`, empty folders with `.gitkeep` and one-line READMEs | tree matches section 2 |
| S2 | `package.json`, `tsconfig*.json`, eslint/prettier/vitest configs, install dev dependencies | `npm run typecheck` green on an empty `src/domain/ids.ts` |
| S3 | `.dependency-cruiser.cjs` and the purity ESLint rules, plus a deliberately failing fixture proving each rule fires (kept in `tests/fixtures/purity/`, excluded from the main lint, executed by `tests/unit/purity.test.ts`) | the test shows each violation is caught |
| S4 | `src/domain` types from `02` (types only, no behaviour) | typecheck green |
| S5 | `src/core/policy.ts` zod schema and `config/policy.default.yaml`; `policy:check` command | `npm run policy:check` green; a policy with an out-of-bounds value fails with a readable message |
| S6 | `src/store` migrations 001-003 and `store.ts` with `appendEvent`, `tx`, `openWeek(weekId)` and the single-writer lock | integration test: two processes cannot both open the same week for writing |
| S7 | CI workflow | first push is green |
| S8 | `docs/adr/0001-stack.md` (resolved versions, reasons from section 1), `docs/open-questions.md` seeded from `08` section 6, `docs/runbook.md` stub | files exist |

After S8 start M0 in `05`.

---------------------------------------------------------------------------------------------------

## 8. Conventions the implementer must follow

1. Money is an integer number of credits (`Credits = number`, always `Number.isSafeInteger`). Wallet peaks near 3e8, far below 2^53. No floats for money; rates and fractions are plain numbers and results are rounded with `roundCredits` (round half away from zero) at the boundary.
2. Time in the core is `EpochMs = number` supplied in the snapshot (`snapshot.nowMs`). Game timestamps (ISO strings from the API) are parsed in `api/schemas.ts` into `EpochMs`.
3. Every module function is `(input, policy, ctx) => output` with `ctx` carrying a seeded PRNG when randomness is unavoidable (A/B hashing uses a deterministic hash, no PRNG).
4. No module reads `policy` fields it does not own; each module exports `type XPolicy = Policy['x']`.
5. Every `Decision` has a non-empty `reason` string that embeds the key numbers; every skip returns `Decision{kind:'skip'}` with `ruleId` and `reason` (X-06 is enforced by a test that runs every module over fuzzed snapshots and asserts "no empty result without a skip explaining it").
6. Errors from the API are values (`Result<T, ApiError>`), not exceptions, anywhere in the shell except process-fatal ones.
7. Commits are small and each runs `npm run check`. Never commit recordings, databases or secrets.
