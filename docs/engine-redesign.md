# Engine redesign — a ground-up design

This is a fresh design against `docs/engine-requirements.md` alone. It
does not describe, and was not built by reshaping, `src/engine/`'s
current classes — where it lands close to the current shape, that is
stated and justified from the requirement, not inherited by default.

## Where the complexity actually is — a short audit up front

The operator's question is "where does this system have more
complexity than the problem requires, and where is the complexity
earned." Answering that before the design, not after, so it's a
prediction to check rather than a conclusion to back into:

**Earned, and this design keeps it, in full:**

- **Exactly-one-owner arbitration for a ship.** The domain has real,
  simultaneous, conflicting reasons to want a hull doing something
  (rescue, repair, trade, the operator). Something has to pick one.
  This is not optional complexity; §2 below is not simpler than the
  current `IntentBoard` in spirit, because the current `IntentBoard`
  already *is* the right shape for this problem — a priority arbiter
  over proposals, level-triggered, versioned. What's earned is the
  concept; what was accidental (per the requirements doc) was having
  eight other mechanisms competing with it instead of routing through
  it.
- **A non-blocking, step-at-a-time execution model.** One API budget,
  shared across tenants, with rescue-priority admission — a scheduler
  that never lets one ship's cooldown or transit hold every other ship
  hostage is a real requirement, not a nicety. This design's executor
  is exactly as careful about "one call, then yield" as the current
  `Pending`/`NavigationPending`/`CooldownPending` scheme, because
  nothing simpler satisfies "rescue must get through even when the
  fleet is saturated."
- **Re-verifying a decision's precondition at the moment it executes,
  not at the moment it was made.** The keeper-probe saga (three fixes
  for one underlying rule) is exactly as much work to do right in this
  design as it would have been to do right the first time in the old
  one — the fix isn't fewer checks, it's one general rule instead of
  three specific patches, which is a complexity-*shape* win, not a
  complexity-*amount* win.
- **Shared vs. tenant-scoped data ownership.** `CLAUDE.md`'s galaxy-wide
  vs. per-tenant split is correct and this design keeps it verbatim as
  a requirement, not an implementation detail to revisit.

**Where this design is genuinely simpler, and what it deletes:**

- **One ownership record instead of eight.** The single biggest change
  this document makes (see §1) is collapsing role maps + hold flag +
  suspension boolean + route-manual-map + warehouse field + mission
  field + keeper map + mining pin into one per-ship `Directive` record
  with one resolution function. This isn't a rename of `ShipRegistry` —
  it's deleting the six other things it was supposed to have replaced
  but coexisted with, and making the registry the *only* place
  ownership is asked or answered, ever, with no fallback path that can
  bypass it.
- **One copy of the world, not N decaying copies.** No per-agent seeded
  snapshot of positions/markets. A ship's step function reads the
  shared registry by reference. This deletes an entire class of bug
  (stale private copy) rather than papering over it with more refresh
  calls, and it's the second-biggest deletion in this document.
- **One generalized "doomed action" memory, not four ad-hoc copies.**
  A single blocked-endpoint concept (§4) replaces the four independently
  discovered "stop retrying this jump" patches.
- **Manual directive and automatic proposal go through the *same* data
  structure, always** — there is no role (like today's scout) that gets
  its own private manual-goal channel because nobody migrated it yet.
  This removes the precedence race at the type level: an automatic
  controller cannot even construct a proposal that bypasses the
  arbiter, because there is no other path to act on a ship at all.

**Where this design is honestly not simpler, on purpose:**

- **Multi-hop fuel/route planning, DRIFT/CRUISE tradeoffs, and
  cross-system jump-cost learning** stay as complex as they are today.
  Nothing about a cleaner ownership model makes "which flight mode for
  this leg, given this tank and this distance" easier — that's real
  domain economics, and this design doesn't touch it beyond giving it
  a cleaner home (the executor's endpoint-selection layer, §3).
- **The approval gate's timeout/cooldown/re-verify state machine** is
  reproduced essentially as-is (§5) — it was already correctly shaped
  for its constraints (DB-polled, not in-memory; auto-decide on
  timeout; re-verify at execution). There was nothing accidental here
  to remove.
- **Restart survival** doesn't get any structurally new trick — it gets
  the same discipline (durable-first, replay at boot) applied
  *consistently*, because this design has fewer places state can hide
  in memory to begin with (a side effect of §1's consolidation, not an
  independent win).

---

## 1. Ownership: one `Directive` per ship, one arbiter, no side doors

### The data model

```ts
type DirectiveKind =
  | "manual-hold"      // operator: sit here, do nothing
  | "manual-dispatch"  // operator: go here and hold on arrival
  | "manual-scrap"     // operator: go here and be sold
  | "rescue"           // fleet: this ship is fuel-ferrying or being ferried to
  | "repair"           // fleet: condition below floor, go get fixed
  | "trade"            // fleet: router-assigned leg
  | "mine" | "siphon" | "survey"
  | "tour" | "explore" | "keep"
  | "warehouse"        // operator-designated, indefinite
  | "idle";            // nothing wants this ship right now

interface Directive {
  ship: string;
  kind: DirectiveKind;
  origin: "operator" | "fleet";
  priority: 0 | 1 | 2 | 3 | 4;   // 0 manual, 1 rescue, 2 repair, 3 earn, 4 upkeep/idle
  detail: Record<string, unknown>;  // e.g. { waypoint }, { yard }, { good, buyAt, sellAt }
  version: number;               // bumped only when detail materially changes
  issuedAt: number;
  source: string;                // which controller/HTTP handler proposed it, for the dashboard
}
```

**One priority band above everything else — manual.** Not "priority 0
among several" the way today's rescue-at-0 scheme reads; manual is a
distinct band that the arbiter refuses to let any automatic proposal
win against, structurally, not by number comparison alone (see below).
This directly encodes requirement §3.2/§3.3 from the requirements doc:
manual isn't merely ranked first, it makes automatic proposals for that
ship *ineligible*, full stop, while it holds.

### The single ownership table

One durable table, `ship_directives`, one row per ship, replacing every
one of the eight mechanisms the requirements doc's §9 catalogues:

| Old mechanism | Gone. Replaced by |
|---|---|
| Role maps as an ownership signal | Role maps still exist (§3) but only decide *how* a ship executes a directive, never *whether* it's allowed to have one |
| `operatorHolds` / `manualGoal` / `manualWaypoint` | `Directive{kind: "manual-hold" \| "manual-dispatch"}` |
| `suspended` boolean | Absence of any non-manual directive with `priority <= current`, derived, never stored separately |
| Route-assignment `manual` map (dispatcher) | A `"trade"` directive's `detail` simply *is* the assignment; there is no second, parallel manual-route channel |
| `warehouseShip` field | `Directive{kind: "warehouse"}`, indefinite, cleared only by a new designation |
| Mission `assignedShip` | `Directive{kind: "trade", detail: {missionId}}` or equivalent — the mission never independently claims a ship outside this table |
| `keeperMarkets` map | `Directive{kind: "keep", detail: {waypoint}}` |
| `pinnedMiningTarget` | Part of a `"mine"` directive's `detail`, not a fourth meaning of "manual" |

**Rule, stated once, enforced by construction, not convention**: *the
only way to change what a ship is doing is to write a row to
`ship_directives` through the arbiter's `propose()`/`commit()` path.*
No subsystem reads `Ship.role` maps, a private flag, or a cached
snapshot to decide whether it may act on a hull. There is no second
availability function to accidentally disagree with the first, because
there is only one function: `Directive.for(ship)`.

### Resolution

```ts
class DirectiveBoard {
  propose(p: Proposal): void;   // "I'd like this ship to do X, at priority P, because Y"
  commit(): DirectiveChange[];  // resolves this pass's proposals to one directive per ship
  current(ship): Directive | undefined;
}
```

Resolution rule, one function, no exceptions:

1. Collect every proposal for a ship this pass.
2. If any proposal's `origin === "operator"`, it wins outright — every
   `origin === "fleet"` proposal for that ship is discarded before
   priority comparison even runs. This is the structural fix for the
   motivating bug: automatic logic literally cannot out-race manual
   intent, because a fleet-origin proposal for a manually-directed ship
   never reaches the priority comparison at all.
3. Otherwise, lowest `priority` number wins (0 highest urgency); ties
   go to proposal order (deterministic, not iteration-order-dependent).
4. If the ship is **busy in a way that costs real money to interrupt**
   (cargo aboard, a leg pinned) and the winning proposal is only
   equal-or-lower priority than the current committed directive, and
   the goal differs, the current directive is kept until the ship's
   next natural decision point (dock, delivery, arrival) — this is
   `sameGoal`/`isEarning`'s hysteresis rule from the current
   `IntentBoard`, kept unchanged, because it is correct as designed.
5. `version` bumps only when `detail` materially changes for the same
   `kind` — carried over from the current design's `sameGoal()`
   verbatim, because a re-proposal of identical work must not look like
   a new assignment to anything comparing "started under v12" against
   "board says v14 now."

### How a manual directive ends

Three, and only three, ways, each explicit (requirement §3.4):

- **Release** — an explicit operator action (`POST /fleet/release`)
  deletes the `manual-*` row. The arbiter re-derives the ship's
  directive from whatever automatic proposals exist next pass —
  nothing needs to "remember" to fall back, because falling back is
  simply what happens when nothing overrides it. This closes the
  "released ship still reporting `want: hold`" bug at the type level:
  there is no separate committed-directive cache to forget to clear,
  because `commit()` always re-derives from this pass's proposals plus
  the durable manual row, never latches.
- **Completion** — a one-shot manual directive (`manual-dispatch`,
  `manual-scrap`) is deleted by the executor itself the moment its
  terminal condition is observed (arrived and held; sold), through the
  same `propose(release)` path an operator action would use — not a
  special internal shortcut.
- **Supersession** — a new manual directive for the same ship
  overwrites the row outright; `version` bumps.

A `manual-hold` with no natural completion (park here, do nothing) is
its own terminal state, matching the requirements doc's framing:
standing down *is* fully executing it.

### Mid-transit and restart

- **The directive row is the durable source, not the in-memory
  committed board.** `DirectiveBoard.commit()` is re-run from scratch
  every tick from (a) durable manual rows and (b) this pass's fresh
  controller proposals — never from an in-memory latch surviving
  across restarts. A restart loses nothing: the next boot's first tick
  reconstructs the exact same directive for every ship, because nothing
  about it depended on process memory.
- **A directive issued while a ship is mid-transit is recorded
  immediately** (durable write, same tick) but the executor cannot act
  on it until the ship's current step yields (arrival is the next
  observed state) — this is not a race, because the ship was never
  polling anything but the durable row in the first place; it simply
  hasn't had a decision point yet. The dashboard shows "manual-dispatch
  to X (pending arrival at <current leg's destination>)" rather than
  a bare directive with no visible reason it hasn't taken effect.

### Sequence walkthrough: the motivating case

*Operator sends a manual dispatch while the automatic system has just
proposed something else for the same ship.*

```
t0   TradeController.reconcile() proposes {ship: S, kind: "trade",
     origin: "fleet", priority: 2, detail: {buyAt: A, sellAt: B}}
     — pushed onto this tick's proposal batch, not yet committed.

t0+ε Operator clicks "Send to waypoint W" on the dashboard.
     POST /fleet/dispatch writes Directive{ship: S, kind:
     "manual-dispatch", origin: "operator", priority: 0, detail: {W}}
     DIRECTLY to the durable ship_directives table — this does not
     wait for the next tick's commit() pass; it is authoritative the
     instant it's written, same table the arbiter reads from.

t1   FleetManager's tick reaches DirectiveBoard.commit(). It sees:
       - the fleet's "trade" proposal from t0 (still in this pass's
         batch — proposals don't survive across ticks unconsumed)
       - the durable operator row from t0+ε (re-read fresh every
         commit(), not cached)
     Rule 2 fires: an operator-origin directive exists for S, so the
     "trade" proposal is discarded before priority comparison. Ship S's
     resolved directive is manual-dispatch to W, unconditionally.

t2   The executor's next step for S reads Directive.for(S) — this is
     the ONLY place it gets its marching orders — sees manual-dispatch,
     and issues the navigate-to-W action. It never sees, and was never
     structurally capable of seeing, the trade proposal at all.

t3   TradeController's NEXT reconcile() pass (t1's tick, or the one
     after) reads the registry, sees S is not eligible (an operator
     directive is in force), and simply does not propose anything for
     S — the router hands that leg to a different idle trader instead
     of leaving it dangling. This is requirement §2's "no two ships
     converge on one leg" protection extending naturally to "a manually
     grabbed ship's leg gets reassigned, not orphaned."

t4   Ship S arrives at W. The executor observes arrival matches the
     directive's target and marks the manual-dispatch directive
     "in force, holding" — no further action, since a dispatch's
     terminal state (per the requirements doc) is holding there until
     released, same as a plain manual-hold.

t5   Operator clicks Release. The manual row is deleted. Next commit()
     pass: no operator-origin proposal exists for S anymore, so
     whatever the fleet's controllers propose this pass (trade, tour,
     whatever's live) wins normally, under ordinary priority rules —
     "fall through to the engine choice" happens automatically, because
     there was never a separate fallback path to wire up.
```

No step in this sequence depends on timing luck. The race the operator
described — an automatic proposal reaching the ship before or after a
manual one, depending on tick alignment — cannot occur here, because
step t1's rule 2 discards competing fleet-origin proposals *before* any
priority number is compared, regardless of which one was proposed
first.

---

## 2. Registry: one copy of the world, read by reference

```ts
interface Registry {
  version: number;
  position(wp: string): Coordinates | undefined;   // undefined ⇒ unknown, fail closed
  systemOf(wp: string): string;
  isMarket(wp: string): boolean;
  isShipyard(wp: string): boolean;
  gateStatus(wp: string): "unknown" | "confirmed-complete" | "confirmed-incomplete";
  endpoints(cluster: Cluster, opts?: { locality?: string }): Endpoint[];
}
type Cluster = "fuel" | "market" | "shipyard" | "gate" | `buy:${string}` | `sell:${string}`;
```

One instance per tenant, in memory, mutated by the events that actually
observe the galaxy (a dock records a market snapshot into it; a chart
records waypoint traits; a jump attempt records gate status) — never by
a periodic full re-push. Every controller and every ship step reads
this by reference. No agent seeds a private copy at construction; there
is nothing to seed, and nothing to go stale independently, because
there is exactly one live object.

This directly eliminates the requirements doc's §9 "four separate live
bugs in two days from stale private copies" pattern — not by refreshing
copies more aggressively, but by there being no copy.

Persistence split matches the requirements doc's §4 exactly and is
non-negotiable: anything in the registry that's a fact about the galaxy
(systems, market snapshots, jump costs, gate status) is durably shared,
no tenant column; anything that's this tenant's own ships/cargo/credits
is durably tenant-scoped with row-level security. A tenant-scoped *view*
over shared data (e.g., "routes across systems I've actually charted")
is a query-time filter over the shared registry, not a second copy of
it per tenant.

---

## 3. Ship executor: one implementation, roles are policy, not code

**The current system has roughly eight role classes, each with its own
copy of navigate/dock/refuel/record logic bolted on over time.** That
shape isn't wrong because "one class per role" is inherently bad — it's
wrong because *movement, fueling, and market-recording are not actually
role-specific behavior*. A trader docking to sell and a tour ship
docking to record a snapshot both need: get to the waypoint, refuel per
policy, dock, do the one role-specific thing, record what was observed.
Only that one middle step differs.

```ts
function step(directive: Directive, observed: Ship, registry: Registry): Action;

type Action =
  | { do: "navigate"; to: string }
  | { do: "dock" } | { do: "orbit" } | { do: "setFlightMode"; mode: FlightMode }
  | { do: "refuel" }
  | { do: "buy" | "sell"; good: string; units: number }
  | { do: "extract" | "siphon" | "survey" | "chart" | "repair" | "jump"; }
  | { do: "wait"; until: number }
  | { do: "blocked"; reason: string };
```

- **One executor function**, parameterized by the directive's `kind`
  and `detail` — not eight classes. A "role" becomes a thin
  `reconcile()` function that only ever *produces directives*
  (§1/§4), never moves a ship. There is no `TraderAgent.navigateTo()`
  override with its own cross-system logic living nowhere else — cross-
  system routing (multi-hop, fuel-aware, DRIFT/CRUISE) is one function
  inside the executor, used by every directive kind that needs to get
  somewhere.
- **One API call per step, never a sleep.** A transit in progress
  returns `{do: "wait", until: arrivalTime}`; a cooldown does the same.
  The scheduler reschedules for exactly that time. This is the current
  `Pending`/`NavigationPending`/`CooldownPending` pattern, kept as-is —
  it is correctly shaped for the "one shared, rate-limited API budget"
  requirement and there's no simpler mechanism that still satisfies it.
- **Local, policy-bounded endpoint selection only** — nearest healthy
  fuel stop, nearest shipyard, which gate to use for a route already
  chosen. The executor never decides *which good to trade* or *whether
  to explore*; that's the directive's `detail`, set entirely by a
  controller. This split (route = control, endpoint = data) is what
  keeps role-specific economics (§7 of the requirements doc: DRIFT vs.
  CRUISE tradeoffs, cross-system jump-cost learning) as one piece of
  logic instead of duplicated per role.
- **A failed primitive raises, never logs-and-returns.** No navigate,
  dock, buy, or sell call may fail silently and let the caller's next
  statement act on the desired world instead of the real one — this was
  the DAGGER-F "phantom trades" bug, and it's structurally prevented
  here because the executor's every action either genuinely changes
  observed state or throws; there is no third outcome a caller could
  mistake for success.
- **Blocked, not retried blind.** An intent the executor cannot execute
  (`no healthy fuel endpoint in locality`, `leg exceeds tank`, `gate
  confirmed incomplete`) returns `blocked(reason)` once. The controller
  that proposed it sees the block on the next reconcile and replans —
  no ten-second identical-retry loop against a call already known to
  fail, closing the requirements doc's §8 "doomed retry" pattern for
  every directive kind at once, rather than per-path.

Role identity survives only as **which controller proposes what**
(§4) — a miner's controller proposes `mine` directives, a trader's
controller proposes `trade` directives — and as **role-specific policy
values** carried on the directive (`fuelReserve`, allowed flight modes,
`conditionFloor`), the same shape the current `IntentPolicy` already
uses correctly. What's deleted is role-specific *movement* code, which
was accidental duplication, not earned role behavior.

---

## 4. Controllers: pure functions, one blocked-endpoint memory shared by all

```ts
type Controller = (registry: Registry, doctrine: Doctrine, board: DirectiveBoard) => void;
```

Each controller reads the registry and the board's currently-committed
directives, and calls `board.propose(...)` for whatever it thinks needs
to change. **No controller ever calls the executor or awaits a ship.**
This is the one rule that, if violated even once (as exploration and
rescue still do in the current codebase, per the requirements doc's §9
finding), reopens the exact repair-vs-tour race the rest of this design
exists to close. It is enforced here by type signature, not by
discipline: `Controller` has no access to anything that could issue an
`Action` — the executor and the controller layer simply don't share an
import that would let a controller reach a ship.

| Controller | Invariant | Emits |
|---|---|---|
| Trade | no idle trader while a positive-margin route exists; no two traders on the same (good, market) leg; recent per-market sold volume discounts route ranking (requirement §2) | `trade` |
| Fleet | ship counts vs. doctrine targets; cash ≥ floor | buy/scrap proposals → approval gate (§5) |
| Explore/Tour | no charted market unsnapshotted past its staleness window; no reachable system uncharted; a fully-toured system's ships back-track toward the nearest unsurveyed one | `tour`, `explore` |
| Keeper | configured keeper coverage list vs. actual coverage | `keep` |
| Repair | any ship's condition below the doctrine floor | `repair`, at priority 2 (fleet-origin, still beats trade/tour, never beats manual) |
| Rescue | any ship below its fuel reserve with no reachable fuel endpoint, across **every** role, not a subset | `rescue`, at priority 1 |

**One shared "blocked/doomed" memory**, not four separate copies. A
single `BlockedEndpoints` structure — keyed on `(action kind, target)`,
e.g. `(jump, X1-MJ67-I55)` — records a live rejection and its
expiry/re-check policy; every controller and every executor call
consults it before attempting the identical thing again. This is the
direct fix for the requirements doc's §9 "recurred independently in
four code paths" finding: there's exactly one place this memory lives,
so a fifth path (were one ever added) gets the protection for free
instead of needing its own copy discovered the hard way.

`FleetManager.tick()` becomes: refresh registry inputs → run every
controller → `DirectiveBoard.commit()` → done. No controller step in
this list can block on a ship, so this pass is always fast and always
completes, every cycle, regardless of how many ships are mid-transit.

---

## 4.1 Trade: route selection and pricing

The controller table above gave Trade one line ("no idle trader while a
positive-margin route exists"). That's the invariant, not the design —
here is the actual mechanism, at the same depth as §1, because the
operator's own fleet is visibly shaped by this logic today (half the
fleet sitting in VJ42 because that's where the margins are) and a
redesign that doesn't say *how* routes get picked and priced hasn't
actually addressed trading.

### The data model

```ts
interface RouteCandidate {
  good: string;
  buyAt: string; sellAt: string;
  buyPrice: number; sellPrice: number;      // most recent registry snapshot
  observedAt: number;                        // snapshot age, for staleness discount
  recentSoldVolume: number;                  // this tenant's own fills against buyAt/sellAt in the lookback window
  distance: number;                          // registry-derived, already system/gate-aware
  marginPerUnit: number;                     // sellPrice - buyPrice, before any discount
  score: number;                             // what ranking actually sorts on
}
```

`score` is not `marginPerUnit` alone — that's the bug this design has to
not repeat (the current router already learned this the hard way:
naive best-margin ranking sends every idle trader at the same juicy
route simultaneously, crashes `buyAt`'s price and `sellAt`'s price
within a few fills, and the fleet arrives at a route that was only
good empty-handed). The score function:

```ts
score = marginPerUnit
      * stalenessDiscount(observedAt)      // older snapshot ⇒ less trusted
      * saturationDiscount(recentSoldVolume, buyAt, sellAt)  // requirement §2
      / max(1, travelCostFor(distance, shipInHand))
```

`saturationDiscount` is the concrete form of requirement §2's "recent
sold volume discounts route ranking" — every unit this tenant has
already sold into `sellAt` (or bought out of `buyAt`) in the lookback
window lowers that route's score for the *next* trader being assigned,
without needing to wait for a fresh market snapshot to prove the price
actually moved. This is deliberately a tenant-local adjustment, not a
registry mutation: the registry's `buyPrice`/`sellPrice` stay the
shared, objective last-observed snapshot (per §2's persistence split);
`recentSoldVolume` lives beside the Trade controller's own state,
because it's this tenant's *prediction* of the market's reaction, not
an observed fact about the galaxy.

### Assignment rule — the actual "no two traders converge" mechanism

```ts
function reconcile(registry, doctrine, board): void {
  const idle = shipsWithoutEligibleDirective(board, kind: "trade");
  const candidates = registry.endpoints("market")
    .flatMap(buildCandidatesFrom)
    .filter(c => !blockedEndpoints.has("trade", c.buyAt, c.sellAt))
    .sort(byScoreDesc);

  const claimed = new Set(currentTradeLegs(board));  // (good, buyAt, sellAt) already committed THIS pass
  for (const ship of idle) {
    const best = candidates.find(c => !claimed.has(legKeyOf(c)) && fitsCargo(ship, c));
    if (!best) continue;
    board.propose({ ship, kind: "trade", origin: "fleet", priority: 3, detail: best });
    claimed.add(legKeyOf(best));   // reserved for the REST of this same pass, not committed yet
  }
}
```

The `claimed` set inside one `reconcile()` pass is what actually
prevents two idle traders proposing the same leg in the same tick —
today's per-tenant single-threaded tick already makes this safe (no
concurrent `reconcile()` calls), so no lock is needed, only the
in-pass bookkeeping. Cross-tick convergence (two ships becoming idle on
consecutive ticks, both wanting the same now-best leg) is handled the
same way §1 handles a re-proposal: the second ship's proposal loses to
whichever ship's directive already committed that leg, because
`currentTradeLegs(board)` reads the board's *committed* state at the
start of the next `reconcile()`, not just this pass's claims.

### Sequence walkthrough: a route gets crowded

```
t0  Trader A idle. Best-scored candidate: (FUEL, VJ42-B3→VJ42-D1),
    score 8.4. Proposed and committed.

t1  Trader B idle same tick. VJ42-B3→VJ42-D1 is in `claimed` (t0's
    reservation) even though not yet committed — B's candidate list
    skips it, picks the next-best leg instead. No collision.

t2  Trader A completes one round trip, sells 40 units into VJ42-D1.
    Trade's own `recentSoldVolume[VJ42-D1]` +=40. Next reconcile(),
    that leg's score drops via saturationDiscount — not because the
    registry's sellPrice snapshot updated yet (it may not have, if
    nobody's re-visited to re-snapshot it), but because this tenant's
    own fill history already predicts the price softened.

t3  A third idle trader C reconciles. VJ42-B3→VJ42-D1's discounted
    score now ranks below a previously-second-place route in a
    different system — C gets sent there instead of stacking a third
    ship on the same leg. This is the fleet-placement behavior the
    operator already observed ("half the fleet is now in VJ42"),
    made an explicit, inspectable rule instead of an emergent side
    effect of no rule at all.
```

### What this doesn't solve, on purpose

Price discovery itself — how fast a stale snapshot gets refreshed — is
Tour/Explore's job (§4.3), not Trade's; Trade only *ranks* against
whatever the registry currently reports, discounted by staleness. A
genuinely stale snapshot (no one has re-visited in a long time) is
handled by `stalenessDiscount` pushing that route down regardless of
its last known margin, which naturally routes idle traders toward
freshly-known, currently-good routes and idle tour capacity toward
long-unvisited markets — the two controllers aren't coordinated
explicitly, but their incentives point the same direction because they
both read the same `observedAt`.

**Not designed in here, flagged for later (`docs/TODO.md`, raised
2026-09-19): buy-side price manipulation via the game's own supply-chain
graph** (`GET /market/supply-chain`'s `exportToImportMap`) — selling a
good's upstream production inputs into a market that exports it drives
that market's sell price down over successive trades, strongest at
low-`tradeVolume` markets. This is a real lever on the buy side of
`RouteCandidate.score` (a route's `buyPrice` isn't just observed, it's
*influenceable*), but it's a genuinely new strategy axis — a controller
that spends trades pushing a price down before a different trader (or
mission) exploits it, which is a form of coordination this design's
Trade controller doesn't currently model at all. Deliberately left open
rather than folded into §4.1's scoring above pending a manual trial (see
TODO) confirming the effect is real and large enough to be worth the
added complexity.

---

## 4.2 Navigation: fuel economics and flight-mode selection

§3 stated that endpoint selection is "local, policy-bounded" and that
routing is "one function inside the executor, used by every directive
kind" — here is what that function actually decides, because "stays as
complex as today" was true of the *problem*, not an excuse to leave the
*design* silent on it.

### The data model

```ts
interface Leg {
  from: string; to: string;
  distance: number;
  mode: "DRIFT" | "CRUISE" | "BURN";
  fuelCost: number;        // mode-dependent, registry/ship-derived
  timeCost: number;        // mode-dependent
}

interface RoutePlan {
  legs: Leg[];             // multi-hop when direct travel exceeds tank or requires a gate
  totalFuel: number;
  totalTime: number;
  refuelStops: string[];   // subset of legs' `from` where a stop is required, not optional
}
```

### Planning rule — one function, three inputs, no per-role variant

```ts
function planRoute(from: string, to: string, ship: ShipCapabilities, registry: Registry, policy: NavPolicy): RoutePlan
```

`ship: ShipCapabilities` (tank size, current fuel, current condition) and
`policy: NavPolicy` (a directive's carried `fuelReserve`, allowed flight
modes — §3 already established this lives on the directive, not the
role) are the only two things that vary call to call. There is no
`TraderNavigator` vs. `TourNavigator`; a tour ship and a trade ship
asking to get from A to B run the identical function with different
policy values, which is the concrete meaning of §3's "cross-system
routing is one function used by every directive kind."

The function's actual decisions, stated explicitly (this is the part
the current system already does correctly and this design keeps, per
the audit's "honestly not simpler" admission — but "kept as-is" still
needs to be *said*, not left as a black box):

1. **Reachability first.** If `distance(from, to)` exceeds the ship's
   max range even at its most fuel-generous mode (DRIFT), the direct
   leg is infeasible — `planRoute` decomposes via the registry's known
   waypoints between them (multi-hop), preferring hops that are
   themselves markets or fuel stations (a hop that isn't refuelable and
   isn't the final destination is only chosen when no refuelable
   alternative exists, and is flagged `refuelStops` accordingly so the
   executor knows it's flying past a comfortable margin on that leg).
2. **Mode selection per leg is a time/fuel tradeoff against
   `policy.fuelReserve`, not a fixed rule.** BURN is chosen only when
   `policy` explicitly allows it (a rescue ferrying fuel to a stranded
   ship reasonably prioritizes time over its own reserve; a routine
   trade leg does not) and the resulting fuel-on-arrival still clears
   `fuelReserve`. CRUISE is the default when the leg fits the tank with
   reserve to spare. DRIFT is chosen only when neither BURN's time cost
   nor CRUISE's fuel cost is acceptable and the ship can afford to be
   slow — a low-urgency directive (idle repositioning, tour) tolerates
   DRIFT; a trade leg with a market-timing component generally doesn't,
   which `policy` encodes as a mode allowlist rather than the function
   hardcoding "traders never drift."
3. **Gate usage is a registry query, not route-planning logic.**
   `registry.gateStatus(wp)` returning `confirmed-incomplete` makes that
   jump path ineligible for this call and every subsequent one, via the
   same shared `BlockedEndpoints` structure §4 already introduced for
   controllers — `planRoute` and every controller consult the identical
   memory, so a gate learned incomplete by a trade leg's failed attempt
   is already known-bad the next time a tour ship's `planRoute` call
   considers the same gate, without either needing to ask the other.
4. **Cross-system jump-cost learning updates the registry, not a
   private table.** A successful or failed jump attempt is itself an
   observation (§2's "events that actually observe the galaxy") —
   `galaxy_jump_costs` gets the real cost/outcome, available to every
   tenant's next `planRoute` call against that same gate, which is
   `SHARED_GALAXY_TABLES`'s existing split doing exactly the job it was
   already scoped for.

### Sequence walkthrough: a leg gets replanned mid-route

```
t0  Trade directive for ship S: {buyAt: A, sellAt: C}, distance too far
    for direct CRUISE. planRoute(A, C, S, registry, tradePolicy) returns
    a two-leg plan: A→B (CRUISE, refuel at B), B→C (CRUISE).

t1  S arrives at B, refuels, executor calls planRoute again for the
    remaining leg (not re-planning the whole trip from scratch each
    step — the executor re-derives per §3's "one call, then yield," and
    a fresh planRoute call on arrival is cheap and always current,
    rather than trusting a plan computed before conditions could have
    changed).

t2  Between t0 and t1, another tenant's failed jump attempt through a
    gate near B marked it confirmed-incomplete in the SHARED registry.
    S's plan never used that gate (CRUISE leg, not a jump), so nothing
    changes here — but if S's leg B→C had required that gate, t1's
    fresh planRoute call would already see the shared block and route
    around it without S ever having attempted the doomed jump itself.
```

This is the concrete form of §2's registry-by-reference claim actually
paying off for navigation specifically: cross-tenant learning isn't a
navigation feature bolted on, it falls out of `planRoute` reading the
same registry every controller and every other ship's plan already
reads.

---

## 4.3 Galaxy knowledge acquisition: what Tour/Explore actually optimizes

The controller table gave Explore/Tour one line ("no charted market
unsnapshotted past its staleness window"). Stated fully, because §4.1
above depends on this controller keeping registry data fresh enough to
rank routes against, and that dependency is exactly the kind of
cross-controller coupling this design otherwise avoids stating
explicitly:

### What "knowledge" means here

Three distinct facts the registry can be missing or stale about a
waypoint, each with its own acquisition action:

| Fact | Registry field | Acquired by |
|---|---|---|
| Does this waypoint exist / its traits | `systemOf`, `isMarket`, `isShipyard` | one-time chart, from any ship arriving |
| Current prices | market snapshot (`observedAt` + goods) | a market dock, any ship |
| Gate reachability | `gateStatus` | an actual jump attempt (success or the specific failure reason) |

### The acquisition rule

```ts
function reconcile(registry, doctrine, board): void {
  const stale = registry.marketsOlderThan(doctrine.staleness.market);
  const unchartered = registry.reachableUnchartedWaypoints();
  const idle = shipsWithoutEligibleDirective(board, kind: ["tour", "explore"]);

  for (const ship of idle) {
    const target = pickNearest(ship, [...unchartered, ...stale], registry);
    if (!target) continue;   // fully charted and fresh — genuinely nothing to do
    board.propose({
      ship, origin: "fleet", priority: 4,
      kind: target.chartered ? "tour" : "explore",
      detail: { waypoint: target.waypoint },
    });
  }
}
```

`priority: 4` (upkeep, per §1's band table) is deliberate and is the
answer to an implicit question the requirements doc raised but didn't
resolve: knowledge acquisition never outranks trade, repair, or rescue
for the same ship — a tour ship that's also cargo-capable and needed
for an urgent trade leg loses that ship to Trade's `priority: 3`
proposal under §1's ordinary priority rule, no special case needed,
because both controllers are just proposals into the same arbiter.

**"A fully-toured system's ships back-track toward the nearest
unsurveyed one"** (the controller table's own invariant) is
`pickNearest` operating over the *reachable* set, not the local-system
set — once every waypoint in a tour ship's current system is fresh,
`unchartered`/`stale` for that ship's position naturally resolves to
the nearest waypoint in an adjacent system, without a separate
"system exhausted, move on" state machine: it falls out of "nearest
target in the full reachable set" the same way §1's fallback-to-engine-
choice falls out of "re-derive from proposals every pass" rather than
needing an explicit transition.

### Sequence walkthrough: staleness feeds back into trading

```
t0  Market at VJ42-D1 last snapshotted 6 hours ago; doctrine's market
    staleness threshold is 2 hours. registry.marketsOlderThan(2h)
    includes it.

t1  An idle tour ship's reconcile() picks VJ42-D1 as nearest stale
    market (ahead of a fresh one twice as far), proposes `tour` there.

t2  Tour ship arrives, docks, records a fresh snapshot — the registry
    write, per §2, updates `observedAt` and prices for every tenant
    reading that shared table, not just this one.

t3  Trade's NEXT reconcile() (§4.1) reads the now-fresh snapshot;
    `stalenessDiscount` no longer penalizes VJ42-D1-involving routes,
    so a route through it can now compete on price alone. If the
    refreshed price is actually still good, an idle trader picks it up
    next pass — the knowledge-acquisition and trading controllers
    never called each other directly, but the registry they share
    made the handoff happen for free.
```

### Where this is genuinely open, same honesty as §8

Exactly how aggressively staleness should be chased — an idle tour
fleet re-visiting every market every 2 hours regardless of whether
anyone's trading through it is arguably wasted travel — is a doctrine-
tunable threshold (§8.6 already flags this), not something this
design resolves harder than the requirements doc asked for. What this
section adds beyond §8.6's one-line mention is that the threshold's
effect is now traceable end-to-end: raise it, and Trade's rankings
lean more on stale data for longer; lower it, and tour ships spend more
idle-priority cycles refreshing markets nobody's currently trading
through. That tradeoff is visible in this design, not hidden inside an
opaque "background crawl" process the way the current `galaxyCrawler`
runs independent of what Trade actually needs fresh.

---

## 5. Operator approval gate

Kept close to the current design, deliberately (per the audit above,
this piece was already correctly shaped):

- DB-polled, never an in-memory await — a request row with `pending` /
  `approved` / `denied` / `auto_approved` / `expired` status, re-checked
  every tick by the function that would act on it.
- Timeout-driven auto-decision (`approve` or `deny` per request kind),
  and a cooldown window after a denial before the same kind may ask
  again.
- **One added, explicit rule this design states once, generally**,
  rather than as three separate historical patches: *a decision that
  authorizes a `do: "buy"` action is not safe to execute until the
  executor re-verifies, at that exact moment, every real-world
  precondition the action needs* — the buying ship is still there, is
  in the nav state (docked, not orbiting) the action requires, and the
  target hasn't changed underneath it. This lives as a single
  `verifyPrecondition(action)` check the executor runs immediately
  before any approval-gated action, not as a per-decision-kind ad hoc
  check re-invented per feature.
- Gating remains a judgment call per decision kind, not automatic for
  "costs money": ship purchases, module installs, and other
  consequential-but-infrequent spends are gated; repairs stay ungated
  (urgency argues against a pause), matching the requirements doc's
  explicit reasoning.

---

## 6. Multi-tenancy and scheduling

Unchanged from the requirements doc's hard constraints, because nothing
about ownership/precedence redesign touches them:

- One `Scheduler` per tenant, priority-queue admission against a shared
  token-bucket budget (rescue admitted even when saturated), a per-tenant
  forward proxy opting a tenant out of the shared budget entirely.
- `SHARED_GALAXY_TABLES` vs. `TENANT_GAME_TABLES` split kept verbatim,
  including the deliberate exclusions (doctrine, chat log, sessions,
  play-profile tracking) from any reset-cleanup operation.
- Multi-tenant boot: each tenant's `FleetManager` (Registry + Directive-
  Board + Scheduler + Executor) is an independent instance; nothing
  about the redesign changes the "one process, N tenants, N independent
  fleets sharing an IP's rate budget" shape.

---

## 7. Restart survival as a designed-in property

Because ownership now lives in exactly one durable table
(`ship_directives`) instead of eight scattered mechanisms, restart
survival stops being "remember to persist this too" applied
per-mechanism and becomes a property of the design: **anything that can
affect what a ship does is, definitionally, either a row in
`ship_directives`, a row in the shared galaxy tables, or recomputed
fresh from live ship state on the next tick.** There is no fourth
category (a private agent field, a second manual map) left to
accidentally leave in memory.

Concretely, at boot:
1. Load the shared registry from `SHARED_GALAXY_TABLES` (systems,
   markets, jump costs, gate status, blocked-endpoint memory).
2. Load every tenant's `ship_directives` rows — this alone replaces
   both the "replay persisted holds" and "replay persisted manual
   roles" boot-time logic the current system needs as two separate
   steps.
3. Run one `tick()`. Controllers reconcile against durable state
   immediately; nothing needs a grace period or a "was this mid-flight
   when we died" special case, because the executor's first step for
   any ship simply re-observes real ship state and proceeds from there
   — level-triggered, per requirement §8, not edge-triggered.

The one thing genuinely *not* durable, deliberately: in-memory rate-
limiter tokens and scheduler task timers. Both are safe to reset to a
conservative default on every boot (a full token bucket, an immediate
re-check of every ship) — matching the requirements doc's explicit
"acceptable to lose" list.

---

## 8. Explicit tradeoffs and open questions

Left genuinely open, not silently resolved, because they need the
operator's judgment:

1. **Does a manual directive ever expire on its own?** This design
   currently has manual directives persist indefinitely until
   explicitly released, matching current behavior. An alternative
   (auto-expire a manual hold after N hours with a dashboard nudge)
   was considered and rejected here only because nothing in the
   requirements doc asked for it — but it's a real product decision,
   not an engineering one, and belongs to the operator.
2. **Should `rescue` be able to preempt a `manual-hold`?** This design
   keeps manual strictly above rescue (per requirement §3.2's explicit
   "ahead even of rescue" framing), meaning an operator who holds a
   ship at 0 fuel deliberately (e.g., for inspection) will not get it
   auto-rescued. That's almost certainly right, but it's worth stating
   plainly since it means a held, stranded ship stays stranded until
   released — the design does not second-guess an explicit "do
   nothing" instruction, even when it looks dangerous from outside.
3. **How aggressively should the Trade controller reassign a leg
   orphaned by a manual grab (step t3 in the walkthrough)?** Immediately
   (next tick) risks route churn if the operator releases the ship
   moments later; waiting risks leaving a profitable leg idle. This
   design proposes "immediately, since the router already treats an
   idle trader as available and a released ship simply re-enters the
   pool the normal way," but a short grace period is a defensible
   alternative the operator may prefer.
4. **Collapsing all eight ownership mechanisms into one table is a real
   migration, not a paint job**, and this document does not scope that
   migration (out of bounds per this exercise's own instructions) —
   but it's worth being honest that `ship_directives` replacing
   `fleet_flags`' `shipManualState` blob, `RouteDispatcher`'s manual
   map, `warehouseShip`, mission's `assignedShip`, and `keeperMarkets`
   all at once is exactly the "Phase 2 — claims become the gate" step
   `docs/ship-control-state-audit.md` already scoped and flagged as
   the real surgery, done in one commit. This design doesn't make that
   migration smaller; it just states clearly, once, what the end state
   should look like so that migration has an unambiguous target.
5. **Should the Registry ever become more than one process's in-memory
   object?** Out of scope here (matches the requirements doc: one
   process, one registry per tenant, in memory) but flagged, as the
   current design doc also flags it, as the thing that would need
   rethinking (`LISTEN/NOTIFY` or an equivalent channel) if this ever
   ran as more than one instance per tenant.
6. **Exact staleness thresholds** (how old is "stale" for a market
   snapshot before a tour controller proposes a re-visit; how long a
   blocked-endpoint entry should be trusted before a background sweep
   re-checks it) are left as doctrine-tunable values, not fixed in this
   design, matching the current system's own philosophy that these are
   operator-tunable policy, not engineering constants.

---

## 9. The thesis generalizes past ship ownership: any shared action surface needs one gate, not several

Added 2026-09-19, prompted by a live example that landed the same day
this document's §1 was written to justify itself: `docs/mcp-server-plan.md`
scoped and shipped a hosted MCP server so an agent could dispatch/hold/
jump ships the same way an operator does from the dashboard. Getting that
server *right* required stating, explicitly, a rule this whole design
already assumes implicitly — every write path has to call the exact same
`FleetManager` methods every other caller uses, never a parallel
reimplementation — because the two live bugs fixed earlier that same
session (a manual jump not registering as a hold; a tour-dispatch trip
not excluded from the auto-explore borrow pool) were both instances of
exactly that failure, just between *existing* callers (dashboard routes,
`autoExplore()`) rather than a new one.

Writing that rule down for the MCP server surfaced a third, not-yet-real
instance already latent in the codebase: the co-pilot (`agentChat.ts`'s
`ChatAgent`) has its own separate tool-calling system, currently
read-only, with its own header comment inviting exactly this mistake —
*"Adding an execution tool later is one object in `tools` — nothing else
changes."* It would not, in fact, be nothing else — it would be a fourth
independent implementation of "what can an agent do to this ship,"
alongside dashboard HTTP routes, the engine's own autonomous controllers,
and now an MCP client.

**The generalization**: §1's `Directive`/`DirectiveBoard` collapses eight
mechanisms that each answered "who owns this ship right now" into one.
That was never really a fact about ships specifically — it's the general
shape of what happens when several independent systems can each decide
to *act* on something without going through a shared gate first. Ship
ownership was this codebase's worst, most-incident-generating instance of
that shape (per the requirements doc's own audit), which is why §1 solves
it first and in the most depth. But the same shape now visibly applies to
a second axis this design didn't originally scope: **who is allowed to
*execute* an action at all**, distinct from *whose priority wins* when
two proposals compete for the same ship. §1-§4's `Directive`/`Controller`/
executor split already answers the priority question generally; this
section names the execution-surface question as the same family of
problem, not yet folded into the design above because — same honesty as
§8's other open items — it needs its own pass, not a rushed addition
here.

**Concretely, not building today, but worth stating as the target
shape**: every caller that can make a fleet *do* something — a dashboard
click, an MCP tool call, a co-pilot tool call, the engine's own
controllers — should end up calling into the same layer this design's §1
`propose()`/`commit()` and §3 executor already define, never a
surface-specific reimplementation of "how do I move a ship." The MCP
server's own tool handlers already follow this rule today (they call
`FleetManager` methods directly, per its own §3); the natural next step,
if and when the co-pilot grows execution tools, is for it to call those
*same* handlers rather than inventing a `ChatTool`-shaped equivalent of
them. Not scoped further here — flagged as the concrete reason this
design's core thesis extends past the ship-ownership problem it was
written to solve.
