# Trade-route buying/selling — the volume bug, the fix, and what's still open

Written up after a live incident on 2026-09-08/09 (tenant `af9154b7`,
system `X1-S84`). Three fixes shipped same-night; this records the actual
mechanism, why each fix was necessary but not sufficient on its own, and
what's still a placeholder worth revisiting.

## The original complaint

DRUGS showed a huge buy/sell spread in the Markets panel (buy 2,985c at
J63, sell 5,628c at H56 — an 88.7% margin) but never appeared as a route.
Same for IRON, ALUMINUM, COPPER. Investigation traced it to real fuel-cost
economics *combined with* a modeling bug — the two turned out to be the
same root cause.

## Root cause: one transaction's volume was treated as the whole trip

`computeDispatchRoutes()` (`fleet.ts`) and the trader's own live route
scoring (`viableRoute()`/`freeChoice()` in `trader.ts`) both sized a leg's
profit as `(sellPrice - buyPrice) * volume`, where `volume` was
`LEAST(buy.tradeVolume, sell.tradeVolume)` — the market's own advertised
**per-transaction** limit ("SILVER has a limit of 60 units per
transaction," confirmed live and already commented in the code before this
pass). A ship can and does issue several back-to-back `purchaseCargo()`
calls at the same dock to fill its hold past that limit — the code had
just never done it.

Treating the per-transaction cap as the whole trip meant:
- A market capped at 20u/tx scored identically to a trip that could only
  ever move 20 units, even when a Light Freighter's 80-unit hold (and its
  wallet) could carry four times that.
- For a high-margin, modest-trade-volume good (DRUGS at 20u/tx, ~2,643c
  margin/unit), the 20-unit trip's gross didn't clear the one-way fuel bill
  for a long haul across a large system — so the route silently vanished
  from the ranking, `.filter(r => r.profitPerTrip > 0)` dropping it with no
  trace of *why*.

## Fix 1 — size the trip against cargo/credits, not the transaction cap

`computeDispatchRoutes()` now computes:

```ts
const maxTraderCargo = Math.max(15, ...traders.map(a => a.getShip().cargo.capacity));
const affordable = buyPrice > 0 ? Math.floor(spendable / buyPrice) : maxTraderCargo;
const volume = Math.min(maxTraderCargo, affordable, /* see Fix 3 */);
```

and the market's real per-transaction cap moved to a new `lotSize` field on
`DispatchRoute`/`Route`, kept separate from `volume`. `trader.ts`'s
`runArbitrage()` buy loop chunks `purchaseCargo()` calls in `lotSize`-sized
lots up to `volume`, tracking a spend-weighted average cost basis across
lots and re-checking the margin floor between lots (price can drift as
supply depletes lot over lot).

This alone made DRUGS/IRON/ALUMINUM/COPPER-style routes visible and
flyable. It also exposed the next two bugs, both pre-existing but
previously unreachable because nothing had ever bought more than one lot's
worth before.

## Fix 2 — the sell side has the exact same per-transaction cap

Buying in chunks was only half the trip. `deliverHeldCargo()` and
`clearLeftoverCargo()` (`trader.ts`) still made **one** `sellCargo()` call
for the entire held quantity. The instant a trip bought more than one
lot's worth (now the normal case), that single oversized sell failed with
the same "limit of Nu per transaction" error — on the *sell* side this
time.

- In `deliverHeldCargo()`: the ship had already spent real credits on the
  buy, then failed to sell any of it, tick after tick, forever (no catch
  block there at all — an uncaught exception per tick).
- In `clearLeftoverCargo()`: worse. The trade-volume-exceeded error was
  indistinguishable from "this market won't buy the good at all," and the
  `catch` block jettisoned — **destroyed** — the entire held quantity on
  that assumption. A full-hold buy of an expensive, thin-trade-volume good
  paid for in full, then thrown overboard for nothing. This is what
  actually drained the fleet's credits during the incident (749,747c down
  to 149,569c in well under an hour).

Both sell sites now loop `sellCargo()` in `lotSize`-sized chunks, the same
loss-floor check applied between lots, and the jettison fallback re-reads
the ship's actual cargo before destroying anything — it only ever
jettisons what a genuine, non-volume-related failure left really sitting
in the hold, never the pre-sale quantity.

## Fix 3 — a market's real depth is not a ship's whole cargo hold

With fixes 1 and 2 live, live logs showed a third problem: mechanically
successful, full-sized trades landing at real losses —
`DRAGOM-8 sold 80u AMMUNITION (-3,115c)`,
`DRAGOM-B sold 40u LAB_INSTRUMENTS (-40,540c)`.

Sizing `volume` against the whole cargo hold implicitly assumed a market
has as much depth as a ship has cargo space, all tradeable at one flat
snapshot price. It doesn't — each successive lot draws down supply and
moves the price further, which a flat `buyPrice`/`sellPrice` can't see. A
route ranked profitable at the snapshot price for an 80-unit trip on a
20u/tx market (4 lots) turned into a real loss once the later lots
actually executed against a price that had already crashed.

Fix: cap `volume` at `MAX_LOTS_PER_TRIP` (currently **3**) times the
market's own `lotSize`, in both `computeDispatchRoutes()` and
`viableRoute()`/`freeChoice()`:

```ts
// dispatcher.ts
export const MAX_LOTS_PER_TRIP = 3;
```

```ts
const volume = Math.min(maxTraderCargo, affordable, lotSize * MAX_LOTS_PER_TRIP);
```

Confirmed live post-deploy: `DRUGS@X1-S84-H56` dropped from a ranked
149,592c/trip (assuming an 80-unit trip on a 20u/tx market) to 96,532c/trip
(capped at 60 units) — still solidly profitable, without assuming market
depth that doesn't exist. A subsequent real trade
(`DRAGOM-B bought 60u+20u COPPER, sold 80u for +3,960c`) shows the cap
correctly *not* binding when a market's own lot size is large enough (60u
COPPER only needs 2 lots to fill an 80-unit hold, and the price only moved
255c → 278c across them) — the cap only kicks in for genuinely thin
markets.

## What's still a placeholder

`MAX_LOTS_PER_TRIP = 3` is picked to fix the observed bug (a trip capped
at exactly one transaction, hiding every route that needed more than one)
without assuming unlimited depth — the same kind of stopgap as the
pre-existing `CROSS_SYSTEM_JUMP_COST_ESTIMATE`. It is **not** derived from
any real SpaceTraders price-decay curve. Ideas for a real fix, roughly in
order of effort:

1. **Learn per-good price decay from executed trades.** Every
   `purchaseCargo()`/`sellCargo()` response already returns the actual
   price paid per lot — log the delta between successive lots (already
   partially visible in the buy-loop's `lastPrice` tracking) and use a
   learned decay curve per good/market pair instead of a flat multiplier,
   the same way `GalaxyAtlas.recordJumpCost()` learns real per-gate-pair
   jump costs instead of using `CROSS_SYSTEM_JUMP_COST_ESTIMATE` forever.
2. **Spread a large trip across multiple ships instead of one hold.**
   Rather than one ship buying 3 lots at one market, split the same total
   volume across two or three ships arriving over time — lets the market
   partially recover supply between visits instead of hitting it with a
   single concentrated buy. Bigger dispatcher change; only worth it once
   (1) shows the real decay curve is steep enough to matter.
3. **Re-price mid-trip instead of trusting the snapshot.** The buy loop
   already re-fetches a live price once before starting; extending that to
   re-check against a live *sell*-side price before committing to the
   trip at all (not just between lots once already selling) would catch a
   route whose snapshot has gone stale in a way the current margin-floor
   check doesn't.
4. **Surface excluded-but-close routes in the UI**, the same "why isn't
   this showing" gap that started this whole investigation. Right now a
   route below the profit floor just disappears with no trace. A debug
   view listing near-miss legs with their computed volume/fuelCost/why-
   excluded reason would make the next version of this bug self-
   diagnosable without a log dive.

None of these are blocking — the fleet is trading profitably on the
current fix as of this writing (`+93,600c/hr` in the last confirmed
window). This is a punch list for whoever revisits `MAX_LOTS_PER_TRIP`
once there's real data to tune it against, not a todo blocking anything
today.
