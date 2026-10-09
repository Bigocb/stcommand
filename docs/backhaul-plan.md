# Backhaul and circuits — plan

Status: proposal (2026-10-09), nothing built. Owner decision points are at the end.

## The gap

A trader's trip today is: fly to A, buy, fly to B, sell, then fly **empty** to wherever the next best buy is. The
dispatcher (`src/engine/dispatcher.ts`, `recompute()`) ranks every route on its own:

- `scoreRoute()` = `profitPerTrip × REFERENCE_TRIP_SECONDS / tripSeconds`, decayed for volume we recently dumped there.
  `tripSeconds` is a *round trip* A→B→A, so the return flight is already charged as time but earns nothing.
- Per idle trader, `recompute()` multiplies that by `tripSeconds / (tripSeconds + positioning)`, where positioning is
  the empty flight from where the ship stands to the buy market (cross-system: minus a third of the jump cost).

So a trader picks well **from where it is**, but nothing looks at **where it will be after the sale**. Observed
2026-10-09 03:50–04:00: every THEO trader empty and in flight for ~10 minutes, no sells for 11 minutes, two of them
repositioning across the GY77 gate. Dead time is what keeps matched net near 280k/hr against the 380k/hr target.

## Principles

1. **One pure module owns the idea** (`src/engine/chain.ts`), no I/O, fully unit-testable. The dispatcher and, later,
   the trader call it. Complexity grows inside it, behind a stable interface.
2. **Policy is data.** Weights and limits live in a `ChainPolicy` (doctrine-backed, editable with `set_doctrine`), so
   `followOnWeight = 0` reproduces today's behaviour exactly. Every step ships behind that switch.
3. **Explain everything.** Each chain carries an `explain` string. This is also the missing `dispatch_explain` tool and
   what answers "why isn't the top route chosen?".
4. **Measure first, tune from data.** Prices move and other traders interfere, so predicted value is discounted and
   checked against realized.

## Interface (stable across versions)

```ts
// src/engine/chain.ts
export interface ChainPolicy {
  followOnWeight: number;   // v1: share of the follow-on's value credited (0 = off)
  maxLegs: number;          // v1: 1 (+ follow-on estimate); v2: 2; v3: 3+
  horizonMinutes: number;   // ignore follow-ons that would start later than this after the sale
  reserveFollowOn: boolean; // a follow-on may be counted for only one trader per cycle
}

export interface Chain {
  legs: DispatchRoute[];    // v1: one leg; v2+: executed in order
  score: number;            // what the dispatcher ranks by
  followOn?: { route: DispatchRoute; value: number };  // v1 estimate shown, not flown
  explain: string;
}

export function planChains(input: {
  ship: { waypoint?: string; system?: string; capacity: number; fuelCapacity?: number };
  routes: readonly DispatchRoute[];
  reservations: ChainReservations;      // (market, good) already promised this cycle
  ctx: ChainContext;                    // distance, jump cost, scoreRoute: injected, no globals
  policy: ChainPolicy;
}): Chain[];                            // best first
```

Everything the dispatcher already computes (positioning, impact cost, reachability, caps, declined legs) is passed in
through `ctx`, not re-implemented, so the two cannot drift.

## Versions

**Step 0 — measure (no behaviour change).** New read-only tool `stcommand_ops_deadhead`: per trader and per hour, share
of time loaded vs empty in transit, revenue per loaded hour, from `ship_position_history` + the ledger. Gives the size of
the prize and the baseline to judge every later step against. Also log each recompute's chosen chain and its estimate.

**v1 — follow-on lookahead (dispatcher only, no executor change).**
`score(R, ship) = score(R) + followOnWeight × best follow-on`, where the follow-on is the best other route starting at
or near R's sell market, scored with the same positioning discount the dispatcher already uses (ship "standing" at
`R.sellAt`). A follow-on is reserved for one trader per cycle. Default weight 0.5 (prices drift and another trader may
take it). The trader needs no change: after selling at B it picks its next route as usual, and a route that starts at B
has ~zero positioning, so it wins on its own. The assignment gains an informational `followOn` shown on Tower's route
card ("then: GOOD at X").

**v2 — committed two-leg circuits (executor change).** First-class `legs[]` on `TraderAssignment`. Enumerate pairs where
leg 2 starts near leg 1's sell and ends near leg 1's buy (the true return-leg backhaul A→B→A), scored
`Σprofit × REF / Σtime`. `TraderAgent.runArbitrage` carries the pin across legs (extend `held_route` so a restart
mid-circuit resumes). Cash check at leg 2's buy, hold-capacity split, and a bail-out if leg 2's margin has collapsed.

**v3 — longer and cross-system.** Beam search to `maxLegs` 3+, jump costs on cross-system legs, market-depth and
recovery models (replace `BUY_IMPACT_PER_UNIT` with learned per-market values), fleet-wide reservation ledger.

## Testing and evaluation

- Unit tests with synthetic route sets: (a) two equal routes, one ends where a good follow-on starts → picks it;
  (b) the follow-on is already reserved → no credit; (c) `followOnWeight = 0` equals today's pick, every time;
  (d) cross-system follow-on pays the path cost.
- **Backtest harness:** the 60-second `dispatch recompute` log lines already hold the full work list and positions. Replay
  them through greedy vs v1 and compare estimated profit per hour before anything goes live.
- Live: compare matched net/hr and empty-time share against the Step 0 baseline over like-for-like windows, and log
  predicted-vs-realized follow-on value per trip. A fleet this size is noisy; trust the share-of-time-empty measure over
  a single hour's profit.

## Risks

- Stale prices: a follow-on estimated at assignment time may be 20–30 minutes old when used. Hence the weight < 1 and the horizon.
- Double-counting the same follow-on across traders: the reservation set.
- Cash: several traders each planning a second buy can drain the wallet (it hit 13k on 2026-10-09). Leg 2 must check cash after leg 1's proceeds, and the cash floor still applies.
- Restarts: assignments live in memory; deploys idle every trader. v1 is unaffected; v2 must persist the circuit.
- Don't fight the missions and feeds that use traders.

## Decisions needed

1. Start with Step 0 + v1 (one dispatcher change, one restart), then decide on v2 from the data? (recommended)
2. `followOnWeight` default 0.5, adjustable live through doctrine?
3. Build the backtest harness before v1 goes live, or ship v1 behind the switch at 0 and turn it up while watching?
