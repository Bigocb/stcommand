# 02. Architecture, interfaces, data model, event log

Everything the implementer needs to write `src/domain`, `src/core` interfaces, `src/store` and the executor contract.
Game-specific JSON field names are NOT defined here (they are `(A)` and live in `src/api/schemas.ts`, `03`). Here, the
domain types are STAR's own normalised model; the Observer maps API payloads into them.

---------------------------------------------------------------------------------------------------

## 1. Process model

One Node process, one writer (D8). Concurrency is cooperative on the event loop (all store calls are synchronous).

```
                    +----------------------- shell (I/O) -----------------------+
  game API  <--->   | api/client -> api/limiter -> api/budget (priority queue)  |
                    |        ^ responses                      | granted calls    |
                    |   shell/observer  ---Observation--->  store.appendEvent   |
                    |                                         |                  |
                    |   shell/scheduler (tick):               v                  |
                    |     snapshot = buildSnapshot(store)   Snapshot             |
                    |     decisions = core.decide(snapshot, policy, ctx)  (PURE) |
                    |     intents   = risk-filtered decisions -> store (PLANNED) |
                    |     executor.run(intents)  (Live | Shadow)                 |
                    |   shell/shipWorker: one async state machine per ship       |
                    +-----------------------------------------------------------+
```

Tick order (each `tick`, default every 1.5 s for the core loop; maintenance every 5 s):
1. `observer` ingests whatever responses arrived since the last tick (they were already appended as events when they arrived).
2. `buildSnapshot` folds events into an immutable `Snapshot` (derived tables are the fast path; events are the truth).
3. `decide()` runs the pure modules in the fixed order of section 4 and returns `Decision[]`.
4. `risk.review()` filters each decision (allow / modify / veto with reason). Vetoed decisions are logged as `skip` events.
5. Survivors become `Intent`s: written with state `PLANNED` and an idempotency key, then handed to the budget scheduler.
6. The executor performs calls in grant order. Each call result is an event. Ship workers advance their state machines.

---------------------------------------------------------------------------------------------------

## 2. Domain types (`src/domain/types.ts`): copy these exactly

Names are branded strings at the type level (see `ids.ts`); at runtime they are plain strings.

```ts
// ids.ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ShipSymbol = Brand<string, 'ShipSymbol'>;
export type WaypointSymbol = Brand<string, 'WaypointSymbol'>;
export type SystemSymbol = Brand<string, 'SystemSymbol'>;
export type GoodSymbol = Brand<string, 'GoodSymbol'>;
export type WeekId = Brand<string, 'WeekId'>;         // "<callsign>@<YYYY-MM-DD reset date>"
export type IntentId = Brand<string, 'IntentId'>;     // sha256 hex of preimage, first 32 chars
export type Credits = number;                         // integer
export type EpochMs = number;
export type RuleId = string;                          // e.g. "T-01", "G-02", "X-03"

// types.ts
export type Supply = 'SCARCE' | 'LIMITED' | 'MODERATE' | 'HIGH' | 'ABUNDANT';       // (A) verify enum in M0
export type Activity = 'RESTRICTED' | 'WEAK' | 'GROWING' | 'STRONG';                // (A) may be absent on some goods
export type MarketKind = 'EXPORT' | 'IMPORT' | 'EXCHANGE';                          // (A) which list the good appears in

export interface GoodQuote {
  good: GoodSymbol;
  kind: MarketKind;
  buyPrice: Credits;      // what WE pay per unit to buy from this market (the market's sell/ask price). (A) field naming differs per API: normalise here
  sellPrice: Credits;     // what WE receive per unit when selling to this market (the market's bid)
  supply: Supply;
  activity: Activity | null;
  tradeVolume: number;    // units per lot
}

export interface MarketObservation {
  waypoint: WaypointSymbol;
  system: SystemSymbol;
  observedAtMs: EpochMs;
  source: 'ship' | 'keeper' | 'tour' | 'trade-response' | 'import-file';
  goods: GoodQuote[];     // empty if the market only lists goods without prices (public listing, no ship present)
  hasPrices: boolean;
  hasShipyard: boolean;
}

export interface ShipFrame {
  symbol: ShipSymbol;
  type: string;           // hull type symbol (A), e.g. SHIP_LIGHT_HAULER; the policy maps type -> class
  hullClass: 'PROBE' | 'SHUTTLE' | 'HAULER' | 'HEAVY' | 'BULK' | 'EXPLORER' | 'COMMAND' | 'OTHER';
  cargoCapacity: number;
  fuelCapacity: number;
  speed: number;          // engine speed (A)
}

export type NavStatus = 'DOCKED' | 'IN_ORBIT' | 'IN_TRANSIT';

export interface ShipState {
  frame: ShipFrame;
  waypoint: WaypointSymbol;               // current or destination if in transit
  system: SystemSymbol;
  nav: NavStatus;
  arrivalMs: EpochMs | null;              // from the API route.arrival; never from cached polling
  fuel: number;
  cargo: Record<GoodSymbol, number>;      // units aboard
  cargoUsed: number;
  readAtMs: EpochMs;
}

export interface YardListing { hullType: string; price: Credits; readAtMs: EpochMs }
export interface YardObservation { waypoint: WaypointSymbol; system: SystemSymbol; observedAtMs: EpochMs; listings: YardListing[] }

export interface WaypointFact {
  symbol: WaypointSymbol; system: SystemSymbol; x: number; y: number;
  traits: string[];                       // e.g. MARKETPLACE, SHIPYARD (A: trait names)
  type: string;                           // PLANET, GAS_GIANT, JUMP_GATE ... (A)
  isMarket: boolean; isYard: boolean; isGate: boolean;
}

export interface Route {
  id: string;                             // deterministic: `${buy}|${sell}|${good}`
  good: GoodSymbol;
  buyAt: WaypointSymbol;
  sellAt: WaypointSymbol;
  hops: number;                           // jump-gate hops between the two systems (0 = same system)
}

export interface RoutePlan {              // output of opportunity scoring
  route: Route;
  units: number;                          // planned units for ONE trip
  lotsBuy: number; lotsSell: number;
  plannedBuyAvg: Credits; plannedSellAvg: Credits;   // per unit
  expectedProfitPerTrip: Credits;
  tripHours: number;
  expectedProfitPerHour: Credits;
  expectedCalls: number;                  // API calls this trip will cost
  profitPerCall: number;
  confidence: number;                     // 0..1 from price age
  state: 'OK' | 'COOLING' | 'PACED' | 'UNKNOWN';
  reason: string;                         // one line
}

export type JobKind = 'TRADE_ROUTE' | 'CONTRACT' | 'GATE_FEED' | 'KEEP' | 'TOUR' | 'POSITION' | 'HOLD';

export interface Assignment {
  ship: ShipSymbol;
  job: JobKind;
  routeId: string | null;
  plan: RoutePlan | null;
  ruleId: RuleId;
  reason: string;
}
```

### 2.1 Decisions and intents

```ts
export type DecisionKind =
  | 'assign'           // ship -> job (route, tour, hold)
  | 'trade_lot'        // buy or sell one lot (produced by ship worker step policy, validated by risk)
  | 'buy_ship'         // purchase a hull
  | 'buy_keeper'
  | 'accept_contract' | 'fulfil_contract'
  | 'gate_feed' | 'gate_buy'
  | 'refuel'
  | 'navigate'
  | 'set_phase'        // wind-down flags etc.
  | 'wait'             // an explicit, logged "do nothing because ..."
  | 'skip'             // a rule considered an action and declined
  | 'veto';            // RiskGuard result for another decision

export interface Decision {
  id: string;                    // deterministic within a tick: `${ruleId}:${subject}:${nowMs}`
  kind: DecisionKind;
  ruleId: RuleId;
  paramsVersion: number;         // policy version used
  subject: string;               // ship symbol / waypoint / route id the decision is about
  action: Record<string, unknown>; // kind-specific, typed per kind via DecisionAction union below
  reason: string;                // one line with the key numbers (X-06)
  estProfit?: Credits;           // for ranking and for the paper ledger
  overriddenBy?: RuleId;         // set by the conflict resolver (README 3.2 of the design plan)
}

export type IntentState = 'PLANNED' | 'SENT' | 'CONFIRMED' | 'FAILED' | 'ABORTED' | 'SHADOWED';

export interface Intent {
  id: IntentId;                  // hash of preimage = `${kind}|${subject}|${targetKey}|${epochBucket}`
  kind: DecisionKind;
  subject: string;
  targetKey: string;             // e.g. hull type + yard, or route id + lot index
  epochBucket: number;           // floor(nowMs / dedupeWindowMs); with dedupeMin=30 identical intents collide
  decisionId: string;
  ruleId: RuleId;
  state: IntentState;
  createdMs: EpochMs; updatedMs: EpochMs;
  payload: Record<string, unknown>;
  error?: string;
}
```

### 2.2 The Snapshot (single input to every module)

```ts
export interface MarketView {            // MarketModel output for one (waypoint, good)
  waypoint: WaypointSymbol; good: GoodSymbol;
  lastQuote: GoodQuote; observedAtMs: EpochMs; ageMin: number;
  confidence: number;                    // 0..1, decays with age (04 section 2)
  impactPerLot: number;                  // fitted, default policy.market.impactPerLotDefault
  recoveryPerHour: number;               // fraction of displaced price recovered per hour (fitted)
  depthSellUnits: number;                // units sellable before price falls below the floor
  depthBuyUnits: number;                 // units buyable before price rises above the ceiling
  cooling: boolean; coolingUntilMs: EpochMs | null;
  unknown: boolean;                      // age > hardStaleMin => excluded from routes (K-04)
}

export interface Reservation { ship: ShipSymbol; waypoint: WaypointSymbol; good: GoodSymbol; side: 'BUY' | 'SELL'; units: number; untilMs: EpochMs }

export interface WalletState { credits: Credits; holdsValueEstimate: Credits; floor: Credits; lastChangeMs: EpochMs }

export interface BudgetState {
  usedLastMinute: number; capPerMinute: number;
  utilisation: number;                   // 0..1
  backoffUntilMs: EpochMs | null; hits429Last10Min: number;
  perPriorityQueueDepth: [number, number, number, number, number];
}

export interface Snapshot {
  nowMs: EpochMs;
  weekId: WeekId;
  weekStartMs: EpochMs; resetAtMs: EpochMs | null;  // from the status poll; null if unknown
  hoursSinceStart: number; hoursToReset: number | null;
  wallet: WalletState;
  ships: Record<ShipSymbol, ShipState>;
  shipIntent: Record<ShipSymbol, Assignment | null>;
  waypoints: Record<WaypointSymbol, WaypointFact>;
  systemsKnown: SystemSymbol[];
  gateEdges: Array<[SystemSymbol, SystemSymbol]>;   // (A) from jump-gate connections; may be empty before discovery
  markets: Record<WaypointSymbol, MarketObservation>;   // latest per waypoint
  marketHistory: (wp: WaypointSymbol, good: GoodSymbol) => Array<{ tMs: EpochMs; buy: Credits; sell: Credits; supply: Supply; tv: number }>; // bounded window
  yards: Record<WaypointSymbol, YardObservation>;
  reservations: Reservation[];
  budget: BudgetState;
  openContracts: ContractFact[]; activeContract: ContractFact | null;
  gate: GateFact | null;
  realised: RealisedStats;                         // rolling realised results for RiskGuard and escape clause
  autonomy: 0 | 1 | 2 | 3;
  killSwitch: boolean;
  phase: Phase;
  fitted: FittedParams;                            // travel/fuel/impact fits, see 04
}

export type Phase = 'OPENING' | 'GROWTH' | 'EXPANSION' | 'STEADY' | 'WINDDOWN';

export interface RealisedStats {
  matchedProfitLast1h: Credits; matchedProfitLast2h: Credits;
  profitPerHourLast2h: Credits;
  walletFlat2h: boolean;                           // cash flat or falling for stallHours
  idleTraderFrac: number;
  worstTradeLoss24h: Credits;                      // most negative single trade
  perRoute: Record<string, { trips: number; lastSpreadFrac: number; medianSpread24h: Credits; plannedVsRealised: number }>;
}

export interface ContractFact { id: string; deliverGood: GoodSymbol; units: number; unitsDelivered: number; deliverTo: WaypointSymbol; payoutOnFulfil: Credits; payoutOnAccept: Credits; deadlineMs: EpochMs; accepted: boolean } // (A) shape
export interface GateFact { waypoint: WaypointSymbol; complete: boolean; materials: Array<{ good: GoodSymbol; required: number; fulfilled: number }>; completeLatched: boolean } // (A) shape

export interface FittedParams {
  // updated by shell from observation fits, passed to the pure core as data
  travel: { secPerDistanceUnitAtSpeed1: number; fixedSec: number; modeFactors: Record<string, number>; samples: number };
  fuel: { perDistanceUnit: number; samples: number };
  impact: Record<string, number>;                  // key `${waypoint}|${good}` -> fraction per lot
  recovery: Record<string, number>;                // same key
}
```

---------------------------------------------------------------------------------------------------

## 3. Module interfaces (pure; `src/core`)

```ts
// decide.ts: the single entry point
export interface DecideCtx { prng: () => number; ab: (key: string, shareBp: number) => boolean }  // deterministic hash-based A/B
export function decide(s: Snapshot, p: Policy, ctx: DecideCtx): { decisions: Decision[]; skips: Decision[]; phase: Phase };

// marketModel.ts
export function viewMarket(s: Snapshot, p: Policy['market'], wp: WaypointSymbol, good: GoodSymbol): MarketView | null;
export function walkBuy(view: MarketView, units: number, p: Policy['market']): { avg: Credits; last: Credits; lots: number; total: Credits };
export function walkSell(view: MarketView, units: number, p: Policy['market']): { avg: Credits; last: Credits; lots: number; total: Credits };
export function stalenessConfidence(ageMin: number, p: Policy['market']): number;

// travel.ts
export function distance(a: WaypointFact, b: WaypointFact): number;
export function travelSeconds(a: WaypointFact, b: WaypointFact, speed: number, mode: 'CRUISE' | 'DRIFT', f: FittedParams): number;
export function jumpHops(s: Snapshot, from: SystemSymbol, to: SystemSymbol): number | null;  // BFS over gateEdges; null = unreachable
export function fuelNeeded(a: WaypointFact, b: WaypointFact, mode: 'CRUISE' | 'DRIFT', f: FittedParams): number;

// opportunity.ts
export function findRoutes(s: Snapshot, p: Policy, shipClass: ShipFrame): RoutePlan[];     // ranked, all candidates with state + reason
export function scoreRoute(s: Snapshot, p: Policy, ship: ShipState, route: Route): RoutePlan;

// allocator.ts
export function allocate(s: Snapshot, p: Policy, plans: Map<ShipSymbol, RoutePlan[]>): Assignment[];

// purchase.ts
export type PurchaseDecision =
  | { kind: 'buy'; hullType: string; yard: WaypointSymbol; quotedPrice: Credits; targetSystem: SystemSymbol; ruleId: RuleId; reason: string }
  | { kind: 'wait'; ruleId: RuleId; reason: string };
export function planPurchase(s: Snapshot, p: Policy['purchase'], need: PurchaseNeed): PurchaseDecision;

// risk.ts
export type RiskVerdict = { verdict: 'allow' } | { verdict: 'modify'; decision: Decision; why: string } | { verdict: 'veto'; ruleId: RuleId; reason: string };
export function review(s: Snapshot, p: Policy['risk'], d: Decision): RiskVerdict;

// winddown.ts
export function phaseFlags(s: Snapshot, p: Policy['winddown']): { phase: Phase; stopHullClass: Record<string, boolean>; stopKeepers: boolean; liquidate: boolean; finalDump: boolean; noJumps: boolean; noNewBuys: boolean; reason: string };

// telemetry (pure reducers over events)
export function matchedProfit(events: Iterable<Event>): { sells: SellMatch[]; open: OpenLot[]; matched: Credits; unmatchedRevenue: Credits };
export function equity(s: Snapshot): Credits;
```

Module contracts (the tests in `06` assert each):
1. **Total functions.** No throws on any structurally valid Snapshot. Missing data yields a `skip` Decision with a reason, never an exception.
2. **Deterministic.** Same inputs give byte-identical outputs (JSON-compared). No iteration over unordered keys without sorting.
3. **Policy-off equals no-op.** Each module's switch `enabled: false` returns only `skip`/`wait` decisions, never an action.
4. **Reasons.** Every Decision's `reason` is non-empty, at most 240 characters, and contains at least one digit for rules that quote numbers.
5. **No side channel.** A module may not mutate its inputs (tests freeze the Snapshot with `Object.freeze` deeply).

### 3.1 Decision order inside `decide()` (from the design plan 3.2, restated as code order)

```
phase = winddown.phaseFlags(s, p.winddown)                     // W flags computed first, used by everyone
if s.killSwitch or s.autonomy == 0:  return observe-only skips  // still logs "would do" in shadow
constraints = {noNewBuys: phase.noNewBuys, wallet floor, budget headroom}
1. keeper/coverage reads (K)   -> only affects what the BUDGET scheduler gets asked to read; stays below trading priority
2. contracts / gate (C)        -> commitments in flight are never paused (one at a time)
3. opportunity.findRoutes per ship class   (M before T: COOLING/PACED routes are removed or discounted before ranking)
4. allocator.allocate           -> Assignment[] (reservations applied, T-09)
5. purchase.planPurchase        -> hull/keeper decisions (H) only if cash gates and phase allow
6. expansion (E)                -> post-M4
Every decision then passes risk.review (X vetoes always win), then is tagged with overriddenBy if a higher concern preempted it.
Within a concern, lower rule id wins; ties broken by higher estProfit per call (T-11).
```

---------------------------------------------------------------------------------------------------

## 4. Event log (`src/domain/events.ts`)

Append-only truth. All derived tables are rebuildable from it (`npm run rebuild` replays events through `projections.ts`).
Every event has `weekId` (schema `NOT NULL`, no default).

```ts
export type EventBase = { seq: number; tMs: EpochMs; weekId: WeekId; correlationId?: string };

export type Event = EventBase & (
  | { kind: 'observation.market';  payload: MarketObservation }
  | { kind: 'observation.yard';    payload: YardObservation }
  | { kind: 'observation.waypoint';payload: WaypointFact }
  | { kind: 'observation.ship';    payload: ShipState }
  | { kind: 'observation.agent';   payload: { credits: Credits; shipCount: number } }
  | { kind: 'observation.contract';payload: ContractFact }
  | { kind: 'observation.gate';    payload: GateFact }
  | { kind: 'observation.status';  payload: { resetDate: string; nextResetMs: EpochMs | null; announcements: string[] } }
  | { kind: 'api.call';            payload: ApiCallRecord }            // also in table api_calls for fast budget queries
  | { kind: 'decision';            payload: Decision }
  | { kind: 'skip';                payload: Decision }
  | { kind: 'veto';                payload: { decisionId: string; ruleId: RuleId; reason: string } }
  | { kind: 'intent';              payload: Intent }                   // every state change appends a new event
  | { kind: 'trade';               payload: TradeRecord }              // result of a buy or sell call
  | { kind: 'refuel';              payload: { ship: ShipSymbol; units: number; cost: Credits } }
  | { kind: 'navigate';            payload: { ship: ShipSymbol; from: WaypointSymbol; to: WaypointSymbol; departMs: EpochMs; arriveMs: EpochMs; fuelUsed: number; mode: string } }
  | { kind: 'purchase.ship';       payload: { ship: ShipSymbol; hullType: string; yard: WaypointSymbol; price: Credits } }
  | { kind: 'trip.planned';        payload: { tripId: string; ship: ShipSymbol; plan: RoutePlan } }
  | { kind: 'trip.closed';         payload: { tripId: string; ship: ShipSymbol; realisedProfit: Credits; plannedProfit: Credits; durationSec: number; calls: number } }
  | { kind: 'rule.fire';           payload: { ruleId: RuleId; scope: string; paramsVersion: number; detail?: string } }
  | { kind: 'config.change';       payload: { path: string; before: unknown; after: unknown; policyVersion: number; by: 'operator' | 'tuner' } }
  | { kind: 'state.transition';    payload: { from: string; to: string; why: string } }     // process FSM: LIVE, RESET_DETECTED, FREEZE...
  | { kind: 'alert';               payload: { level: 'info' | 'warn' | 'critical'; code: string; text: string } }
  | { kind: 'paper.trade';         payload: PaperTrade }                  // shadow mode only, see 07
);

export interface TradeRecord {
  tripId: string | null; ship: ShipSymbol; waypoint: WaypointSymbol; good: GoodSymbol;
  side: 'BUY' | 'SELL'; units: number; pricePerUnit: Credits; total: Credits; fee: Credits;   // (A) fee may be 0 or absent
  walletAfter: Credits;
  postTradeQuote: GoodQuote | null;                // (A) if the response carries post-trade prices (assumption A3)
  intentId: IntentId | null;
}
export interface ApiCallRecord { callType: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; priority: 0|1|2|3|4; role: string; queuedMs: number; durationMs: number; status: number; retryAfterSec: number | null; ship?: string }
export interface PaperTrade { tradeId: string; ship: string; route: Route; units: number; plannedBuyAvg: Credits; observedBuyAtMs: EpochMs; sellObservedAtMs: EpochMs | null; paperSellAvg: Credits | null; paperProfit: Credits | null; confidence: 'verified' | 'unverified'; }
```

Event handling rules:
1. `seq` is a monotonically increasing integer assigned by SQLite (`INTEGER PRIMARY KEY AUTOINCREMENT`).
2. Every API response of any kind produces at least an `api.call`; responses that carry state also produce observation events (B-07: reuse responses; e.g. a trade response yields `trade` + `observation.agent` + a `observation.market` with `source:'trade-response'`).
3. Payloads are JSON, redacted by `redactSecrets` before insertion.
4. Event retention: whole week files are kept; compaction of `observation.market` older than 7 days is a later optimisation. Raw events are what the replay harness consumes.
5. A `week archive` (see section 6) copies summary rows to `meta.sqlite` and leaves the week file untouched and read-only.

---------------------------------------------------------------------------------------------------

## 5. Database schema (SQLite; files `data/<weekId>.sqlite` and `data/meta.sqlite`)

Pragmas on open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. The writer takes
`BEGIN IMMEDIATE` and holds the lock file `data/<weekId>.lock` (see 01 `shell/lock.ts`).

### 5.1 `migrations/001_core.sql`

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS weeks (
  week_id        TEXT PRIMARY KEY,                       -- callsign@YYYY-MM-DD
  callsign       TEXT NOT NULL,
  reset_date     TEXT NOT NULL,
  started_ms     INTEGER NOT NULL,
  ended_ms       INTEGER,
  start_credits  INTEGER,
  final_credits  INTEGER,
  mode           TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  status         TEXT NOT NULL CHECK (status IN ('active','archived'))
);

CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  t_ms           INTEGER NOT NULL,
  week_id        TEXT    NOT NULL CHECK (length(week_id) > 0),
  kind           TEXT    NOT NULL,
  correlation_id TEXT,
  payload        TEXT    NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS events_kind_t   ON events (kind, t_ms);
CREATE INDEX IF NOT EXISTS events_corr     ON events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  t_ms           INTEGER NOT NULL,                       -- time the request was SENT
  week_id        TEXT    NOT NULL CHECK (length(week_id) > 0),
  call_type      TEXT    NOT NULL,                       -- "<role>:<endpoint kind>" e.g. "trader:sell"
  method         TEXT    NOT NULL,
  path           TEXT    NOT NULL,                       -- path only, no query secrets
  priority       INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
  queued_ms      INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  status         INTEGER NOT NULL,                       -- 0 = network error/timeout
  retry_after_s  REAL,
  ship           TEXT
);
CREATE INDEX IF NOT EXISTS api_calls_t ON api_calls (t_ms);

CREATE TABLE IF NOT EXISTS kv (                           -- small durable scalars: lastResetDate, policyVersion, autonomy, killReason
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ms INTEGER NOT NULL
);
```

### 5.2 `migrations/002_projections.sql` (all rebuildable from events)

```sql
CREATE TABLE IF NOT EXISTS waypoints (
  week_id TEXT NOT NULL, symbol TEXT NOT NULL, system TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
  type TEXT NOT NULL, traits TEXT NOT NULL,              -- JSON array
  is_market INTEGER NOT NULL, is_yard INTEGER NOT NULL, is_gate INTEGER NOT NULL,
  PRIMARY KEY (week_id, symbol)
);

CREATE TABLE IF NOT EXISTS market_latest (
  week_id TEXT NOT NULL, waypoint TEXT NOT NULL, good TEXT NOT NULL,
  kind TEXT NOT NULL, buy_price INTEGER NOT NULL, sell_price INTEGER NOT NULL,
  supply TEXT NOT NULL, activity TEXT, trade_volume INTEGER NOT NULL,
  observed_ms INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (week_id, waypoint, good)
);

CREATE TABLE IF NOT EXISTS market_history (               -- one row per observation of a (waypoint, good); this is the training data
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id TEXT NOT NULL, waypoint TEXT NOT NULL, good TEXT NOT NULL,
  t_ms INTEGER NOT NULL, buy_price INTEGER NOT NULL, sell_price INTEGER NOT NULL,
  supply TEXT NOT NULL, activity TEXT, trade_volume INTEGER NOT NULL, source TEXT NOT NULL,
  event_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS market_history_k ON market_history (week_id, waypoint, good, t_ms);

CREATE TABLE IF NOT EXISTS shipyard_latest (
  week_id TEXT NOT NULL, waypoint TEXT NOT NULL, hull_type TEXT NOT NULL,
  price INTEGER NOT NULL, observed_ms INTEGER NOT NULL,
  PRIMARY KEY (week_id, waypoint, hull_type)
);

CREATE TABLE IF NOT EXISTS ships (
  week_id TEXT NOT NULL, symbol TEXT NOT NULL, hull_type TEXT NOT NULL, hull_class TEXT NOT NULL,
  cargo_capacity INTEGER NOT NULL, fuel_capacity INTEGER NOT NULL, speed INTEGER NOT NULL,
  waypoint TEXT NOT NULL, system TEXT NOT NULL, nav TEXT NOT NULL, arrival_ms INTEGER,
  fuel INTEGER NOT NULL, cargo TEXT NOT NULL,              -- JSON {good: units}
  read_ms INTEGER NOT NULL, bought_ms INTEGER, bought_price INTEGER,
  PRIMARY KEY (week_id, symbol)
);

CREATE TABLE IF NOT EXISTS ship_jobs (                     -- current assignment (one row per ship)
  week_id TEXT NOT NULL, ship TEXT NOT NULL, job TEXT NOT NULL, route_id TEXT, plan TEXT,
  rule_id TEXT NOT NULL, reason TEXT NOT NULL, since_ms INTEGER NOT NULL, fsm_state TEXT NOT NULL,
  PRIMARY KEY (week_id, ship)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT NOT NULL, week_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, target_key TEXT NOT NULL,
  epoch_bucket INTEGER NOT NULL, decision_id TEXT NOT NULL, rule_id TEXT NOT NULL, state TEXT NOT NULL,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, payload TEXT NOT NULL, error TEXT,
  PRIMARY KEY (week_id, id)                                -- identical intent in the same bucket collides: X-03
);

CREATE TABLE IF NOT EXISTS lots (                          -- FIFO cost basis per (ship, good)
  lot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id TEXT NOT NULL, ship TEXT NOT NULL, good TEXT NOT NULL,
  units_open INTEGER NOT NULL, units_bought INTEGER NOT NULL,
  cost_per_unit INTEGER NOT NULL, bought_ms INTEGER NOT NULL, trip_id TEXT, buy_event_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lots_open ON lots (week_id, ship, good, bought_ms) WHERE units_open > 0;

CREATE TABLE IF NOT EXISTS ledger (                        -- credits in/out with cause; the matched-profit source
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id TEXT NOT NULL, t_ms INTEGER NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('BUY','SELL','FUEL','SHIP','CONTRACT','GATE','FEE','OTHER')),
  ship TEXT, good TEXT, units INTEGER, amount INTEGER NOT NULL,   -- signed: negative = credits out
  matched_cost INTEGER,                                    -- for SELL rows: FIFO cost consumed (NULL if unmatched)
  matched_profit INTEGER,                                  -- amount + matched_cost sign handled: revenue - cost
  trip_id TEXT, event_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_t ON ledger (week_id, t_ms);

CREATE TABLE IF NOT EXISTS trips (
  trip_id TEXT PRIMARY KEY, week_id TEXT NOT NULL, ship TEXT NOT NULL, route_id TEXT NOT NULL,
  planned_profit INTEGER NOT NULL, planned_units INTEGER NOT NULL, planned_ms INTEGER NOT NULL,
  closed_ms INTEGER, realised_profit INTEGER, calls INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL  -- OPEN|CLOSED|ABORTED
);
```

### 5.3 `migrations/003_analysis.sql`

```sql
CREATE TABLE IF NOT EXISTS rule_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT, week_id TEXT NOT NULL, t_ms INTEGER NOT NULL,
  rule_id TEXT NOT NULL, scope TEXT NOT NULL, params_version INTEGER NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS rule_fires_r ON rule_fires (week_id, rule_id, t_ms);

CREATE TABLE IF NOT EXISTS skips (                         -- X-06: every silent skip is explicit; rate-limited per key
  id INTEGER PRIMARY KEY AUTOINCREMENT, week_id TEXT NOT NULL, t_ms INTEGER NOT NULL,
  rule_id TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS paper_trades (                  -- shadow mode scoring (07)
  trade_id TEXT PRIMARY KEY, week_id TEXT NOT NULL, ship TEXT NOT NULL, route_id TEXT NOT NULL,
  units INTEGER NOT NULL, planned_buy_avg INTEGER NOT NULL, buy_observed_ms INTEGER NOT NULL,
  sell_observed_ms INTEGER, paper_sell_avg INTEGER, paper_profit INTEGER,
  confidence TEXT NOT NULL CHECK (confidence IN ('verified','unverified')), decided_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  exp_id TEXT PRIMARY KEY, week_id TEXT NOT NULL, param_path TEXT NOT NULL, arm_a TEXT NOT NULL, arm_b TEXT NOT NULL,
  share_bp INTEGER NOT NULL, started_ms INTEGER NOT NULL, ended_ms INTEGER
);
```

### 5.4 `data/meta.sqlite` (kept across resets, no galaxy data)

```sql
CREATE TABLE IF NOT EXISTS week_summary (
  week_id TEXT PRIMARY KEY, mode TEXT NOT NULL, start_credits INTEGER, final_credits INTEGER,
  matched_profit INTEGER, trades INTEGER, api_calls INTEGER, calls_429 INTEGER, hours REAL,
  max_drawdown INTEGER, policy_versions TEXT NOT NULL            -- JSON list
);
CREATE TABLE IF NOT EXISTS policy_versions (
  version INTEGER PRIMARY KEY, created_ms INTEGER NOT NULL, yaml TEXT NOT NULL, changed_by TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS rule_stats (
  rule_id TEXT NOT NULL, policy_version INTEGER NOT NULL, week_id TEXT NOT NULL,
  fires INTEGER NOT NULL, profit_attributed INTEGER, samples INTEGER, notes TEXT,
  PRIMARY KEY (rule_id, policy_version, week_id)
);
CREATE TABLE IF NOT EXISTS config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t_ms INTEGER NOT NULL, week_id TEXT, path TEXT NOT NULL, before TEXT, after TEXT, by TEXT NOT NULL
);
```

Rules: `week_id` is NOT NULL and non-empty on every galaxy-specific table; `meta.sqlite` rows are keyed so that two
weeks never collide (ship symbols repeat every week; the design plan's "rows without `week_id` are forbidden"). A test
inserts a row without `week_id` and expects a constraint error.

---------------------------------------------------------------------------------------------------

## 6. Store interface (`src/store/store.ts`)

```ts
export interface Store {
  openWeek(weekId: WeekId, mode: 'shadow' | 'live', startMs: EpochMs): void;      // takes the writer lock
  appendEvent(e: Omit<Event, 'seq'>): number;                                      // returns seq; projections update in the same tx
  tx<T>(fn: () => T): T;                                                           // BEGIN IMMEDIATE ... COMMIT
  buildSnapshot(nowMs: EpochMs, policy: Policy, budget: BudgetState, extra: SnapshotExtra): Snapshot;
  // intents
  putIntent(i: Intent): 'inserted' | 'duplicate';                                   // PRIMARY KEY collision == X-03 duplicate
  updateIntent(id: IntentId, state: IntentState, error?: string): void;
  recentIntents(kind: DecisionKind, sinceMs: EpochMs): Intent[];
  // cost basis and ledger
  recordBuy(t: TradeRecord, seq: number): void;                                     // inserts lot + ledger row
  recordSell(t: TradeRecord, seq: number): { matched: Credits | null; profit: Credits | null }; // FIFO consume; unmatched stays NULL
  matchedProfit(sinceMs: EpochMs, untilMs: EpochMs): { profit: Credits; sells: number; unmatchedRevenue: Credits };
  // budget
  apiCallsSince(sinceMs: EpochMs): number;
  // kv
  getKv(k: string): string | null; setKv(k: string, v: string, nowMs: EpochMs): void;
  // lifecycle
  archiveWeek(endMs: EpochMs, finalCredits: Credits): void;                        // write week_summary to meta, mark archived, release lock
  rebuildProjections(): void;                                                      // drop and replay events
  close(): void;
}
```

FIFO matching algorithm (`recordSell`), exactly:
```
remaining = units sold
cost = 0
for lot in lots(week, ship, good) where units_open > 0 order by bought_ms, lot_id:
    take = min(remaining, lot.units_open)
    lot.units_open -= take ; cost += take * lot.cost_per_unit ; remaining -= take
    if remaining == 0: break
if remaining > 0:   // sold more than tracked: cost basis happened before tracking started (e.g. start cargo)
    matched = NULL  // report revenue only; do not score a margin
else matched = revenue - cost  (profit), and ledger.matched_cost = cost
```
Fees (A): if the API reports a transaction fee separate from price, `ledger` stores it as a `FEE` row and it is included in
profit. If no fee exists, the column stays 0. OPEN QUESTION Q-FEE.

---------------------------------------------------------------------------------------------------

## 7. Executor contract (`src/shell/executor.ts`)

```ts
export interface Executor {
  readonly mode: 'live' | 'shadow';
  run(intent: Intent, ctx: ExecCtx): Promise<IntentResult>;
}
export type IntentResult =
  | { ok: true; state: 'CONFIRMED' | 'SHADOWED'; events: number }
  | { ok: false; state: 'FAILED' | 'ABORTED'; error: string; needsReadBeforeRetry: boolean };
```

Algorithm for EVERY mutating intent in `LiveExecutor` (X-03, X-04, D9):
```
1. putIntent(PLANNED) -> if 'duplicate' return ABORTED("X-03 duplicate intent")
2. re-validate against a FRESH read where the rule requires it (G-03 for ship price, T-12 for markets); if invalid -> ABORTED(reason)
3. check kill switch, autonomy level, spend cap, wallet floor (RiskGuard final review at send time)
4. updateIntent(SENT); perform the call through the budget scheduler at the intent's priority
5. on success: appendEvent(trade|purchase.ship|...), updateIntent(CONFIRMED)
6. on error or timeout (status 0, 5xx, or any non-2xx except clear client errors):
     - mark intent FAILED but with needsReadBeforeRetry = true
     - READ the relevant state (ship, agent credits, cargo) and decide whether it happened:
         credits dropped by price and ship exists -> treat as CONFIRMED, backfill the events
     - only if the read proves it did not happen, a NEW intent (new epochBucket-independent retry key `attempt+1`) may be created
7. never retry a purchase on 429: wait (retry-after) and re-run from step 2 (the call was not accepted)
```
`ShadowExecutor.run`: performs steps 1-3, appends `decision`/`intent` with `state:'SHADOWED'`, creates a `paper.trade` for
trade intents (see `07`), and returns without any call. It cannot hold a client capable of mutating calls (type-level: it
receives a `ReadOnlyApi`, see `03`).

## 8. Ship worker state machine (`src/shell/shipWorker.ts`)

One async worker per ship; the core only assigns jobs. States and the API calls they need ((A) endpoints named in `03`):

| State | Entry condition | Actions | Exit |
|---|---|---|---|
| IDLE | no assignment | wait for `ship_jobs` row | assignment arrives -> TO_BUY (or POSITION) |
| TO_BUY | assigned route, ship not at buy waypoint | refuel if fuel < `fuelNeeded*1.1` (X-11), orbit if docked, navigate (hops via `jump` per gate edge, `navigate` in-system) | arrival time from the navigate response (X-05: re-read the ship if `now > arrival + arrivalGraceSec`) |
| AT_BUY | at buy waypoint | dock; read market (or reuse last trade-response quote); T-12 revalidate; buy lot by lot with T-05 ceiling | cargo full / units reached / ceiling hit -> TO_SELL; revalidation failed -> IDLE with trip ABORTED |
| TO_SELL | cargo aboard | orbit, navigate | arrival |
| AT_SELL | at sell waypoint | dock; sell lot by lot with T-03 lot abort and T-04 floor; X-13 corroboration if below floor | cargo empty -> close trip (`trip.closed`) -> IDLE; abort leftover -> hold cargo and re-plan a different sell market (a `POSITION` job) |
| HOLD | operator hold, kill switch, or wind-down | do nothing | released |
| ERROR | unexpected API state (e.g. ship already docked, insufficient cargo, not enough credits) | read ship, reconcile, resume at the correct state; log `state.transition` | |

Per-trip API cost model used by scoring: `calls = 2 (orbit+dock) x legs + 1 refuel(optional) + navigateCalls + 1 market read + lotsBuy + lotsSell + 1 ship read`
(about 10-16 calls for a one-jump-free route; the plan scoring uses the exact count from this formula).

---------------------------------------------------------------------------------------------------

## 9. Scheduler and budget interplay (summary; detail in `03`)

`budget.request(call, priority, ship?)` returns a promise resolved when the call is granted. Lower priority numbers go
first; anything waiting over `starveMs` (default 8 s for priority 4, 4 s for priority 3) is promoted one level so nothing
starves. The scheduler never awaits a read on the critical path of a trade: trades are driven by the ship worker using the
response of the previous call (B-07).

## 10. Status/observability surface (read-only)

`GET http://127.0.0.1:8787/status` returns JSON: `{weekId, mode, autonomy, killSwitch, phase, wallet, equity, matchedProfitLast1h, matchedProfitPerHour2h, budget: BudgetState, ships: [{symbol,state,job,reason}], lastSkips: Decision[20], alerts: Alert[20], policyVersion}`.
`GET /metrics` returns Prometheus text (optional). Both are read-only; there is no write endpoint (the kill switch is a file and a signal, see `08`).
