# Buy-side guards: amendment plan (sink check, between-lot buy stop, round limit)

Status: plan only, nothing built (2026-10-18). Written for a model that has not seen this repo. Do exactly what is written. Where a rule is stated, do not choose another.
This is an amendment to the trading engine, not a new feature: it changes how `trader.ts` buys and how the dispatcher offers routes, behind doctrine clauses that ship **off**.

## 0. Why (the evidence, so you know what a correct result looks like)

Every below-floor approval seen on 2026-10-18 came from the BUY side: a ship bought into a price its own earlier lots (or its own earlier rounds) had pushed up, then reached a sink that
no longer paid what the plan assumed. THEOREM-5 ran MEDICINE E52 -> G58/E51/A1 four times in six minutes. Buy prices per unit, lots of 20: round 1 3409, 3626; round 2 3894, 4223;
round 3 4628, 5126. Sink bids it met: 4213 and 4062 (round 1), 4746 and 4569 (round 2), 4549 (round 3, with 20 units then held, cost 4877, bid 4327, loss 11,000). Nothing recovered between rounds
(measured recovery of MEDICINE at E52 is a median of 124 minutes). Rounds 1 and 2 made about +24k each; round 3 lost. The same shape cost THEOREM-1 a MEDICINE loop earlier.

What the code does today, which is why it did not stop this (all in `src/engine/trader.ts`, `runArbitrage`, around the comment "Re-verify the live buy price before committing"):
- The live check compares the live ASK with the PLANNED sell price (`route.sellPrice`, a snapshot up to 30 minutes old), and only when the live ask is above the snapshot ask. The sink is never read live before buying.
- Between lots, the loop stops when `route.sellPrice - lastPrice < effectiveMarginFloor(...)`: again the planned sell price, and it ignores that the lots already bought will push the sink down when sold.
- The route cool-off (`src/engine/routeHeat.ts`) rests a route only after a trip that made under 40% of its promise. Rounds 1 and 2 beat their promise, so the route stayed open for round 3.

The three guards, in order of build:
1. **Sink check** (before the first lot): read the sink's live bid; refuse the trip if the margin, after our own expected impact on both ends, is under the margin floor.
2. **Between-lot buy stop** (after each lot): buy the next lot only if the sink, after the lots already held are sold into it, still pays more than the next ask by the margin floor.
3. **Round limit** (dispatcher): no more than N trips on the same good and buy-to-sell route in any 60 minutes, whichever ship runs them.

## 1. Rules for the implementing model (read before writing any code)

1. Work on branch `claude/stcommand-ui-parallel-versions-fd5p9q`. Commit after each work package (section 5) with the message given there. **Do not push and do not merge.** The box deploys from `main`; the operator pushes after review.
2. **Never run the test suite against the production database.** `npm test` runs `scripts/assert-test-schema.mjs` first and refuses if `DB_SCHEMA` is `stcommand`. Every test in this plan is a pure or fake-API test and needs no database: run them as `node --test --import tsx tests/<file>.test.ts`.
3. **The full suite has about 187 failures that were there before you started (they need a database). Do not try to fix them and do not count them as yours.** Before your first change, run `npm run typecheck` and write down the result. It must be exit code 0 before you start; if it is not, stop and report that (the branch you were given is broken).
4. **Do not touch**: `src/engine/windDownScrap.ts`, `src/engine/lotGuard.ts` (read it, copy its style, do not edit it), `src/engine/transactionLimit.ts`, any existing migration, any existing test file except to add a case to `tests/routeHeat.test.ts` or `tests/doctrine.test.ts` if section 5 says so. Do not weaken or delete an existing assertion to make something pass.
5. Style: match the surrounding file (comment density, naming, 2-space indent, double quotes, `.js` suffix on relative imports). New logic goes in its own small pure module (CLAUDE.md "Build new logic as self-contained modules"): no I/O, no clock, no globals; policy is data; every decision returns a one-line `reason`; the caller stays thin.
6. A guard that is OFF must change nothing. Each package has a test that proves it (section 5).
7. Never call anything that spends credits or changes the real fleet, never call the SpaceTraders API, never call the stcommand MCP server. All tests use fakes.
8. Do not print, write or commit any token, key or secret. Do not put a model name in any file.
9. If the plan contradicts the code you find (a function or field it names does not exist, a line is not where it says), do not guess: write the contradiction under "Discrepancies" at the end of this file, make the smallest change that keeps the plan's behaviour, and say so in the final report.

## 2. DONE means compiled, wired, tested, and real. Stubs do not count.

### 2.1 What a stub is (each of these makes a package NOT complete)

- A function that returns a constant, an empty value, or a fake value (`return { ok: true }`, `return []`, `"NEW-SHIP"`, `spendable: 0`) where the plan specifies a computation.
- A body that is `// TODO`, `throw new Error("not implemented")`, a bare `return;`, or a comment saying what it will do.
- A branch that reports success without doing the work (a step marked done that never ran).
- An exported function, class, doctrine clause or constant with no caller outside its own file and its tests (dead code). A guard that exists but is never consulted does not guard anything.
- A test that only checks "does not throw", that asserts `true`, that re-states the implementation, or that does not fail when the guard is removed.
- Code that compiles only because of `as any` / `@ts-ignore` / `@ts-expect-error` added to silence an error you caused. (Existing test files already use `as any` for private access; copy that only for reaching a private member in a test, never in `src/`.)
- Code that is wired to a function which is not reachable from the live tick (the 2026-10-18 opening-tasks branch put its runner in `FleetManager.tick()`, which `run()` never calls, so it could never run).

### 2.2 How to prove it compiled (run these, paste their output in the final report)

Run all of these from the repository root, in this order, after EVERY package. Each must exit 0 with no error lines. "The tests passed" is not evidence of compiling: tests run through `tsx`, which does not type-check.

```
npm run typecheck ; echo "typecheck exit=$?"
npm run build ; echo "build exit=$?"
```

- `npm run typecheck` runs `tsc --noEmit` and must print nothing and `typecheck exit=0`.
- `npm run build` runs `tsc -p tsconfig.build.json` and must print `build exit=0`. (This is what `postinstall` runs on the box, so a build error is a failed deploy.) It writes `dist/`; do not commit `dist/` (check `git status` shows no `dist/` changes staged).
- If either prints an error, the package is not done. Fix it. Do not commit a package with a failing typecheck or build.

### 2.3 How to prove it is wired (run these, paste the output)

For every new exported symbol, show at least one caller in `src/` outside its own module and outside tests. Commands, exactly (replace nothing; they are written out):

```
grep -rn "sinkCheck" src | grep -v "^src/engine/buyGuard.ts"
grep -rn "nextBuyLotDecision" src | grep -v "^src/engine/buyGuard.ts"
grep -rn "roundsReason" src | grep -v "^src/engine/routeRounds.ts"
grep -rn "buyGuardImpactPct\|routeRoundsMax" src | grep -v "^src/engine/doctrine.ts"
```

Each of the four must print at least one line. An empty output means that symbol is dead code and the package is not done.

### 2.4 How to prove it works (behaviour, not just shape)

- Every pure function has tests with the exact numbers in section 5.
- Guards 1 and 2 also have a **seam test** that drives the real `TraderAgent` with a fake API (copy the structure of `tests/lotGuardSeam.test.ts`) and asserts, with call counters, that in the blocked case `purchaseCargo` was called **0 times** and in the allowed case it was called with the expected lot sizes. A seam test that only inspects the source text does not satisfy this; a source-text check is allowed in addition, never instead.
- Guard 4 has a dispatcher-level test (copy the structure of the existing `routeCoolOff` tests in `tests/routeHeat.test.ts` or `tests/dispatcher.test.ts`) showing the route is absent from the offered list while resting and present after the window.
- Each package has an "off" test: with its clause off, the behaviour is exactly today's (same calls, same lots).
- **Mutation check (required, once per package):** temporarily make the guard always return `ok: true` (or the round limit return `undefined`), run that package's tests, confirm at least one fails, then restore the code. Report which test failed. A package whose tests all still pass with the guard disabled has tests that prove nothing, and is not done.

## 3. Doctrine clauses (all ship OFF)

Add to `src/engine/doctrine.ts`, next to `routeCoolOffMin` (same object shape, `category: "risk"`, `enforced: true`, `defaultAdopted: true`, `enabled: false`):

| key | name | value | min | max | step | unit |
| --- | --- | --- | --- | --- | --- | --- |
| `buyGuardImpactPct` | Buy guards: expected price impact per lot | 6 | 1 | 30 | 1 | `%` |
| `routeRoundsMax` | Route round limit | 2 | 1 | 10 | 1 | ` trips` |

Descriptions (write them in the same plain style as the neighbours, one paragraph each):
- `buyGuardImpactPct`: "Before a trader buys, it reads the destination's live price and refuses the trip if, after our own expected price impact on both ends (this percentage per lot of the market's trade volume), the margin would fall under the margin floor; and between lots it stops buying once the next lot would no longer clear the floor against the destination after the lots already held are sold. Measured impact on 2026-10-18 was 4 to 13% a lot. Off = today's behaviour. Takes effect on the next buy."
- `routeRoundsMax`: "No more than this many trips on the same good and buy-to-sell route in any 60 minutes, whichever ship runs them, so a market recovers from our own buying and selling instead of being run again straight away. Measured recovery after our buys is often over an hour. Off = today's behaviour. Takes effect within a minute."

`value` of a clause is read with `this.doctrine.value(key, fallback)` and its on/off with `this.doctrine.isEnabledOr(key, false)` (see how `resetWindDown` is read in `src/engine/fleet.ts`). **When a clause is off, treat the feature as off, whatever the value says.** Check how `routeCoolOffMin` is read in `fleet.ts` (search `routeCoolOffMin`) and read the new clauses the same way. If a test enumerates every clause key or counts clauses (`tests/doctrine.test.ts`, `tests/doctrineRetired.test.ts`), update only that count or list, and say so in the report.

## 4. The three modules (pure; exact signatures and rules)

### 4.1 `src/engine/buyGuard.ts`

```ts
export interface BuyGuardPolicy {
  /** Expected price move per lot, as a fraction (the clause's percent / 100). 0 or less = guards off. */
  impactPerLot: number;
}
export interface GuardDecision { ok: boolean; reason: string }

/** Before the first lot of a trip. */
export interface SinkCheckInput {
  liveBuy: number;                 // the buy market's ask read just now
  liveSink: number | undefined;    // the destination's bid read just now; undefined when the read failed
  lots: number;                    // lots this trip plans to buy
  marginFloor: number;             // already effective: effectiveMarginFloor(flatFloor, liveBuy)
  policy: BuyGuardPolicy;
}
export function sinkCheck(i: SinkCheckInput): GuardDecision;

/** After each lot, before the next. */
export interface NextBuyLotInput {
  lotsBought: number;              // lots already bought in this trip (>= 1)
  lastPrice: number;               // per-unit price the lot just bought was paid at (the price BEFORE that lot's own impact)
  prevPrice?: number;              // per-unit price of the lot before that, when there was one
  liveSink: number | undefined;    // the same live destination bid read for sinkCheck (not read again)
  fallbackSink: number;            // the planned sell price, used only when liveSink is undefined
  marginFloor: number;             // effective, as above, computed on lastPrice
  policy: BuyGuardPolicy;
}
export function nextBuyLotDecision(i: NextBuyLotInput): GuardDecision;
```

`sinkCheck` rules, in this order:
1. `policy.impactPerLot <= 0` -> `{ ok: true, reason: "guard off" }`.
2. `liveSink === undefined` -> `{ ok: true, reason: "destination bid unreadable: not judged" }` (today's behaviour).
3. `n = Math.max(1, Math.floor(lots))`; `half = (n - 1) / 2`; `avgBuy = liveBuy * (1 + impactPerLot * half)`; `avgSell = liveSink * (1 - impactPerLot * half)`; `margin = avgSell - avgBuy`.
4. `margin < marginFloor` -> `{ ok: false, reason }` where reason is exactly `` `destination pays ${Math.round(liveSink)}c against an ask of ${Math.round(liveBuy)}c: expected margin ${Math.round(margin)}c over ${n} lot(s) is under the floor ${Math.round(marginFloor)}c` ``.
5. Otherwise `{ ok: true, reason: `expected margin ${Math.round(margin)}c over ${n} lot(s), floor ${Math.round(marginFloor)}c` }`.

`nextBuyLotDecision` rules, in this order:
1. `impactPerLot <= 0` -> `{ ok: true, reason: "guard off" }`.
2. Next ask estimate: `growth = prevPrice !== undefined && prevPrice > 0 ? Math.max(1, lastPrice / prevPrice) : 1 + impactPerLot`; `nextAsk = lastPrice * growth`.
3. If `liveSink === undefined`: `sell = fallbackSink`, `margin = sell - nextAsk` (no impact discount: this is today's rule); else `sell = liveSink * (1 - impactPerLot * lotsBought)` and `margin = sell - nextAsk`. (`lotsBought` lots are already held and will be sold into the sink before the next lot's units: the next lot is sold at the sink price after those.)
4. `margin < marginFloor` -> `{ ok: false, reason: `next lot would cost about ${Math.round(nextAsk)}c against about ${Math.round(sell)}c at the destination after the ${lotsBought} lot(s) held: margin ${Math.round(margin)}c under the floor ${Math.round(marginFloor)}c` }`.
5. Otherwise `{ ok: true, reason: `next lot about ${Math.round(nextAsk)}c, destination about ${Math.round(sell)}c, margin ${Math.round(margin)}c` }`.

### 4.2 `src/engine/routeRounds.ts`

```ts
import type { RouteTrip } from "./routeHeat.js";
export interface RoundsPolicy { maxRounds: number; windowMin: number }   // maxRounds 0 = off
export const ROUNDS_WINDOW_MIN = 60;
export function roundsReason(trips: readonly RouteTrip[], good: string, buyAt: string, sellAt: string, now: number, policy: RoundsPolicy): string | undefined;
```
Rules:
1. `policy.maxRounds <= 0` or `policy.windowMin <= 0` -> `undefined`.
2. `inWindow` = the trips whose `good`, `buyAt` and `sellAt` all equal the arguments and whose `at >= now - policy.windowMin * 60_000`. Trips from any ship count (the market does not care which ship ran them).
3. `inWindow.length < policy.maxRounds` -> `undefined`.
4. Otherwise the route rests until the oldest counted trip leaves the window: `oldest = Math.min(...inWindow.map(t => t.at))`; `leftMin = (oldest + policy.windowMin * 60_000 - now) / 60_000`; return `` `resting ${Math.ceil(leftMin)} more min: ${inWindow.length} trips on this route in the last ${policy.windowMin} min (limit ${policy.maxRounds})` ``. (`leftMin` is always > 0 here because every counted trip is inside the window.)

## 5. Work packages (do in this order; commit after each; each ends with "Done when")

### Package 1: the pure modules and the clauses

Files: `src/engine/buyGuard.ts`, `src/engine/routeRounds.ts`, `src/engine/doctrine.ts` (the two clauses of section 3), `tests/buyGuard.test.ts`, `tests/routeRounds.test.ts`.

`tests/buyGuard.test.ts` must contain these cases with these exact expectations (policy `impactPerLot` 0.06; `marginFloor` in the cases below is `Math.max(10, liveBuy * 0.02)` computed in the test, matching `effectiveMarginFloor` with a flat floor of 10 and `MIN_MARGIN_PCT` 0.02):
- `sinkCheck`, THEOREM-5 round 1: `liveBuy 3409, liveSink 4213, lots 2` -> `ok true` (avg buy 3511.27, avg sell 4086.61, margin 575).
- round 2: `liveBuy 3894, liveSink 4746, lots 2` -> `ok true`.
- round 3: `liveBuy 4628, liveSink 4549, lots 2` -> `ok false`, and `reason` contains `"under the floor"`.
- `liveSink undefined` -> `ok true`, reason contains `"unreadable"`.
- `impactPerLot 0` -> `ok true`, reason `"guard off"`.
- `lots 1` takes no impact discount: `liveBuy 1000, liveSink 1030, lots 1` -> `ok true` (margin 30 >= floor 20); `liveSink 1015` -> `ok false` (margin 15 < floor 20).
- `lots 0` or negative is treated as 1.
- `nextBuyLotDecision`, round 2 lot 2: `lotsBought 1, lastPrice 3894, prevPrice undefined, liveSink 4746` -> next ask 3894*1.06 = 4127.64, sell 4746*0.94 = 4461.24 -> `ok true`.
- round 3 lot 2: `lotsBought 1, lastPrice 4628, liveSink 4549` -> `ok false`.
- with a previous price: `lotsBought 2, lastPrice 4223, prevPrice 3894, liveSink 4569` -> growth 4223/3894 = 1.0845, next ask 4579.9, sell 4569*0.88 = 4020.7 -> `ok false`.
- `liveSink undefined, fallbackSink 5000, lastPrice 4000, prevPrice undefined, lotsBought 1` -> next ask 4240, margin 760 -> `ok true` (today's rule, no discount); with `fallbackSink 4200` -> `ok false`.
- `impactPerLot 0` -> `ok true`.

`tests/routeRounds.test.ts`: build `RouteTrip` values with `at` relative to a fixed `now`; `maxRounds 2, windowMin 60`:
- zero or one trip on the route in the window -> `undefined`.
- two trips (30 and 10 minutes ago) -> a string containing `"resting"` and `"2 trips"`; with the oldest 30 minutes ago the text says `resting 30 more min`.
- two trips but the older one 61 minutes ago -> `undefined` (it left the window).
- two trips on a DIFFERENT sell market, or a different good -> `undefined`.
- trips by different ships are the same route: nothing in `RouteTrip` names a ship, so just check three trips of one route return the string.
- `maxRounds 0` -> `undefined`.

Add to `tests/doctrine.test.ts` (or the existing clause tests) only what is needed so a test asserts both new keys exist with `enabled: false`.

Verify: section 2.2 (typecheck and build, exit 0), the two new test files pass, and the wiring greps are NOT yet expected to show callers (they do after packages 2 and 3). Run the mutation check on `sinkCheck` (make it return `{ ok: true, reason: "" }` always), see a test fail, restore.
Commit: `Buy guards: pure sink check, next-lot stop and round limit, with clauses (off)`.

### Package 2: guards 1 and 2 in the trader

Files: `src/engine/trader.ts`, `src/engine/fleet.ts`, `tests/buyGuardSeam.test.ts`.

Read first, in `src/engine/trader.ts`: `runArbitrage` (search the comment `Re-verify the live buy price before committing`), `liveBuyPrice`, `liveSellPrice`, the buy loop (search `let lotCap = route.lotSize`), and the `deadRoutes` handling (search `this.deadRoutes.clear()`). Then:

1. **Options.** Add to `TraderOptions` (near `maxLotsPerTrip`): `buyGuardImpactPct?: () => number;` ("percent per lot; 0 or undefined = off, read live at each buy"). Store it in the constructor like the neighbours. In `fleet.ts` `traderOptions()` (next to `maxLotsPerTrip:`) pass `buyGuardImpactPct: () => (this.doctrine.isEnabledOr("buyGuardImpactPct", false) ? this.doctrine.value("buyGuardImpactPct", 0) : 0)`.
2. **Guard 1, exact placement.** Immediately after the existing live-margin block (the `if (liveBuy !== undefined && liveBuy > route.buyPrice) { ... }` block ends with `continue; } }`) and **before** the line `let liveCredits = await this.spendableNow();`:
   - Skip entirely when `this.isPinnedRoute(route)` (a manual route is the operator's explicit choice; its existing negative-margin stop stays as is) or when `this.buyGuardImpactPct?.() ` is falsy.
   - `const lots = Math.max(1, Math.ceil(Math.min(route.volume, this.ship.cargo.capacity - this.ship.cargo.units) / Math.max(1, route.lotSize)));`
   - `const liveSink = await this.liveSellPrice(route.sellAt, route.good);` (one market read; also store it in a local `sinkNow` that the buy loop uses for guard 2).
   - `const verdict = sinkCheck({ liveBuy: liveBuy ?? route.buyPrice, liveSink, lots, marginFloor: effectiveMarginFloor(this.marginFloor, liveBuy ?? route.buyPrice), policy: { impactPerLot: pct / 100 } });`
   - If `!verdict.ok`: `this.recordDoctrineFire?.("buyGuardImpactPct");` log `` `skipping buy: ${verdict.reason}` ``; add `${route.good}@${route.buyAt}` to a new `private sinkBlockedUntil = new Map<string, number>()` with value `Date.now() + SINK_BLOCK_MS` where `const SINK_BLOCK_MS = 5 * 60_000;` (declare next to `HOLD_BEFORE_FLOOR_APPROVAL_MS`); also `this.deadRoutes.add(...)`; then `continue;`.
   - **Why the map:** `this.deadRoutes.clear()` runs every tick, so a bare `deadRoutes.add` would make the ship re-read two markets and re-log every few seconds (the 2026-10-18 floor-hold logging problem). Where `deadRoutes` is cleared (the lines that read `this.deadRoutes.clear(); for (const key of this.unreachableRoutes) this.deadRoutes.add(key);`) add directly after them: delete expired entries of `sinkBlockedUntil` and add the keys of the unexpired ones to `deadRoutes`.
3. **Guard 2, exact placement.** In the buy loop, right after the existing `if (route.sellPrice - lastPrice < effectiveMarginFloor(this.marginFloor, lastPrice)) break;`, add (only when `this.buyGuardImpactPct?.()` is truthy and `bought > 0`): keep `let prevLotPrice: number | undefined;` declared before the loop and updated at the end of every iteration (`prevLotPrice = <price of the lot before the one just bought>`: set it to the `lastPrice` value that existed BEFORE this iteration's `lastPrice = res.transaction.pricePerUnit;` assignment, so at the check `lastPrice` is the lot just bought and `prevLotPrice` the one before). `lotsBought = Math.ceil(bought / Math.max(1, lotCap))`. Call `nextBuyLotDecision({ lotsBought, lastPrice, prevPrice: prevLotPrice, liveSink: sinkNow, fallbackSink: route.sellPrice, marginFloor: effectiveMarginFloor(this.marginFloor, lastPrice), policy })`. If `!d.ok`: record the doctrine fire, log `` `stopping at ${bought}u ${route.good}: ${d.reason}` ``, `break;`. The existing code after the loop (`if (bought <= 0) return true; this.notePlannedTrip(...)`) then runs with the part-full hold: that is the intended behaviour (the ship takes what it has to the sink).
4. **Off means off.** With the option unset or returning 0, neither guard may add a market read, a log line, a `deadRoutes` entry or a changed lot. The seam test below proves it by counting `getMarket` calls.

`tests/buyGuardSeam.test.ts` (fake API, copy the `setup()` structure of `tests/lotGuardSeam.test.ts`; the trader must be constructed with `buyGuardImpactPct: () => 6` for the "on" cases and without it for the "off" cases; give the fake API counters for `getMarket`, `purchaseCargo` and a market whose `tradeGoods` returns different prices for the buy market and the sink market):
- **Blocked at the door.** Buy market ask 4628, sink bid 4549, route `volume 40, lotSize 20`: `purchaseCargo` called **0 times**; the route key is in the blocked map.
- **Allowed.** Ask 3409, sink bid 4213: `purchaseCargo` called twice with lot 20 each.
- **Stops between lots.** Ask 3894 for lot 1 and 4223 for lot 2 (fake `purchaseCargo` returns those prices), sink bid 4,100 (so lot 1 passes the door check and the check after lot 1 fails): exactly **1** purchase of 20, and the trader still reaches the "bought > 0" path (the held cargo is 20).
- **Off.** Same blocked inputs without the option: `purchaseCargo` is called (today's behaviour) and `getMarket` is called the same number of times as before your change (record that number from the unchanged code first, and assert it).
- **Block does not repeat every tick.** After a block, a second `runArbitrage` pass within the same test makes no further `getMarket` call for that route.

Verify: section 2.2; section 2.3 greps for `sinkCheck`, `nextBuyLotDecision` and `buyGuardImpactPct` each print a caller; `tests/buyGuard.test.ts`, `tests/buyGuardSeam.test.ts`, and the existing `tests/lotGuard.test.ts`, `tests/lotGuardSeam.test.ts`, `tests/trader.test.ts`, `tests/floorApprovalWiring.test.ts`, `tests/transactionLimit.test.ts` all pass. Mutation check: make `sinkCheck` always return ok, see the "blocked at the door" test fail; restore.
Commit: `Buy guards: read the destination's live bid before buying and stop between lots (off by default)`.

### Package 3: guard 4 in the dispatcher

Files: `src/engine/dispatcher.ts`, `src/engine/fleet.ts`, `tests/routeRoundsSeam.test.ts`.

Read first: `Dispatcher.recordTrip`, `routeCoolOff`, the line `this.coolOffMin = Math.max(0, tuning?.coolOffMin ?? 0);` and the block that follows it (`if (this.coolOffMin > 0) { const open = routes.filter((r) => !this.routeCoolOff(...)) ...`), and the `tuning` parameter type. Then:

1. Add `roundsMax?: number` to the `tuning` type; add `private roundsMax = 0;` next to `coolOffMin`; set `this.roundsMax = Math.max(0, tuning?.roundsMax ?? 0);` next to the `coolOffMin` assignment.
2. Make `routeCoolOff` return the first defined of the two reasons: `coolOffReason(...)` (unchanged) then `roundsReason(this.closedTrips, good, buyAt, sellAt, Date.now(), { maxRounds: this.roundsMax, windowMin: ROUNDS_WINDOW_MIN })`. **Careful:** `routeCoolOff` today is only consulted inside `if (this.coolOffMin > 0)`. Change that condition to `if (this.coolOffMin > 0 || this.roundsMax > 0)`, so the rounds limit applies even when the plain cool-off is off, and make sure `coolOffReason` is still called with `minutes` 0 (it returns undefined at 0, which is today's off behaviour). Keep the existing log line format for rested routes.
3. `closedTrips` keeps trips for 6 hours and at most 200: enough for a 60-minute window; do not change it.
4. In `fleet.ts`, in the `tuning` object next to `coolOffMin: this.doctrine.value("routeCoolOffMin", 0)` add `roundsMax: this.doctrine.isEnabledOr("routeRoundsMax", false) ? this.doctrine.value("routeRoundsMax", 0) : 0`. Read how `coolOffMin` honours its clause being off (it uses `value(key, 0)`, which returns the `whenOff` argument when the clause is off) and make `roundsMax` behave identically; if `value("routeRoundsMax", 0)` already returns 0 when the clause is off, say so in a comment and drop the `isEnabledOr` part.

`tests/routeRoundsSeam.test.ts` (build a `Dispatcher` the way `tests/dispatcher.test.ts` does, with two `DispatchRoute`s, feed it `recordTrip` calls with a controllable clock if the dispatcher allows one, else with trips just recorded now):
- `roundsMax 2`: after two `recordTrip` calls on route A, a recompute offers route B but not route A, and the rested log/explain mentions `resting`.
- After a third route C with only one trip, C is still offered.
- `roundsMax 0`: after the same two trips, route A is offered exactly as today.
- Plain cool-off still works with `roundsMax 0` (add one case reusing the existing cool-off scenario) and with both on, a route that disappointed is rested by the cool-off text, not the rounds text.
Mutation check: make `roundsReason` always return `undefined`, see the `roundsMax 2` test fail; restore.

Verify: section 2.2; section 2.3 greps for `roundsReason` and `routeRoundsMax` each print a caller; `tests/routeRounds.test.ts`, `tests/routeRoundsSeam.test.ts`, `tests/routeHeat.test.ts`, `tests/dispatcher.test.ts`, `tests/dispatcherCircuit.test.ts`, `tests/dispatcherMatch.test.ts`, `tests/dispatchExplain.test.ts` pass.
Commit: `Buy guards: round limit per route in the dispatcher (off by default)`.

### Package 4: docs

Files: `CHANGELOG.md` (one entry at the top, in the existing style, dated 2026-10-18 or the day you build it: what each guard does, the evidence in section 0, that all three ship off with the two clause keys, and the first values suggested: `buyGuardImpactPct` 6 and `routeRoundsMax` 2), `docs/TODO.md` (in the entry "Market impact book" add a line saying guards 1, 2 and 4 of `docs/buy-guards-plan.md` are built and the impact book is what remains; do not delete the entry), `docs/buy-guards-plan.md` (fill "Discrepancies" if you wrote any, else leave it empty).
Verify: section 2.2 once more (the doc change cannot break it, but it must still be exit 0), `git status` clean except your commits.
Commit: `Buy guards: docs`.

## 6. Final report (required format)

For each package: the commit hash; the full output of the section 2.2 commands (typecheck and build, each with its `exit=` line); the output of the section 2.3 greps; the list of test files run with pass/fail counts; the mutation check (which test failed with the guard disabled); anything you could not run and why. State plainly what was not verified. **Do not write "done" or "complete" for a package unless every item in sections 2.2, 2.3 and 2.4 holds for it and you pasted the evidence.** If a package is partly done, say which parts are stubs.

## 7. Out of scope (do not build)

Using measured per-market impact instead of the single percentage (the analysis engine has the numbers; that is a later step); the shared impact book and the dispatcher skipping cooling markets (see `docs/TODO.md`); a stash ship for parked cargo; any change to selling, to the loss floor, to approvals, or to `lotGuard.ts`; any UI.

## Discrepancies

(Implementing model: write here anything in this plan that did not match the code. Leave empty if none.)
