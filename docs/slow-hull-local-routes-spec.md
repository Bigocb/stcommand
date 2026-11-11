# Spec: slow-hull local / one-gate routes (per-speed route-shape gate)

Status: proposed (2026-11-11). Owner: engineer agent. Origin: operator + advisory session.

## Problem

The fleet's revenue is capacity- and load-bound. Measured 2026-11-11:
- `ops_deadhead`: fleet **loaded share 0.35** — 65% of trader time is travel/positioning, not loaded.
- `ops_dispatch_explain.routeBuild`: of ~1,300 stored legs, only ~270 are offered; ~1,030 are dropped as
  "not profitable after fuel, slippage and jump costs."
- Every trader is speed 15 (light haulers/shuttles). The profitable-looking long cross-system legs still leave
  speed-15 hulls empty most of the time.

The only route-shape limits today are **global**:
- `hauledHops` (`src/engine/haulLimit.ts`, applied in `fleet.ts:2211` / `2425`) caps the loaded leg for **every** hull.
- `positioningHops` (`src/engine/galaxy.ts`) caps empty positioning for **every** hull.
- `shipSpeedWeight` (`src/engine/dispatcher.ts:1714`) only *values* faster hulls; it does not gate route shape.

So a blunt `hauledHops=1` also refuses 2-gate legs for the heavy/bulk freighters we intend to buy for long premium
runs. We need the limit to apply **only to slow hulls**.

## Goal

Add a per-speed route-shape clause: when a ship's engine speed is at or below a threshold, it may only be offered
routes whose **loaded leg** is short (and, optionally, whose **positioning** is short). Fast hulls keep the current
behaviour.

## Non-goals

- Do not change the semantics of `hauledHops` or `positioningHops` (they remain global backstops).
- Do not change `shipSpeedWeight`, prices, or the route board.
- Do not affect manual routes (`stcommand_assign_route`) — the existing rule "manual routes need no switch" stands.
- No deploy in this spec; the engineer agent handles build, test, and deploy.

## Doctrine keys

Add to `src/engine/doctrine.ts` (near `hauledHops`, ~line 230), same shape as existing entries
(`key, name, description, value, min, max, step, unit, enabled, enforced, category: "trading", defaultAdopted`).
Ship them **`enabled: false`** so deploy changes nothing; the operator turns them on live.

| Key | Default | Range | Unit | Meaning |
|---|---|---|---|---|
| `slowHullSpeed` | 15 | 1–100, step 5 | speed | Hulls at or below this engine speed count as "slow". |
| `slowHullHauledHops` | 1 | 0–10, step 1 | jumps | Max gate jumps on the **loaded** leg for a slow hull. `0` = same system only. |
| `slowHullPositioningHops` | 2 | 0–10, step 1 | jumps | Max gate jumps a slow hull may travel **empty** to a route's buy market. `0` = must already be there. |

Suggested names/descriptions:
- "Slow hulls: speed threshold" — "Hulls with engine speed at or below this are limited by the slow-hull route
  clause below. Most light hulls are 15; freighters are 36-60."
- "Slow hulls: most loaded jumps" — "A hull at or below the slow-hull speed may only take a route whose buy-to-sell leg
  is at most this many gate jumps. 0 = same system only. Fast hulls are unaffected; the global Hauled jumps clause
  still applies to everyone."
- "Slow hulls: most positioning jumps" — "A hull at or below the slow-hull speed may only take a route whose buy market
  is at most this many gate jumps from where it is. 0 = must buy in its current system. Fast hulls are unaffected."

Each key's `enabled` flag gates its own effect; all three off = today's behaviour.

## Semantics

For a candidate route/work item `w` and ship `t`:

```
slow = t.speed === undefined || t.speed <= slowHullSpeed        // unknown speed counts as slow
if slow:
    if slowHullHauledHopsEnabled and crossSystemHops(w.buySystem, w.sellSystem) > slowHullHauledHops: refuse
    if slowHullPositioningHopsEnabled and crossSystemHops(t.system, w.buySystem) > slowHullPositioningHops: refuse
```

- `crossSystemHops` is already available in the dispatcher (`src/engine/dispatcher.ts:1616`).
- Fast hulls skip both checks; the existing global `hauledHops` / `positioningHops` still apply to them.
- Same-system routes have `crossSystemHops = 0` and always pass.
- Unknown speed → treat as slow (conservative; most hulls are 15).

## Implementation points

1. **`src/engine/haulLimit.ts`** — add a pure helper, e.g.
   `slowHullVerdict(shipSpeed, hops, policy: { speed, hauledHops?: number, positioningHops?: number })`
   returning `{ ok: true } | { ok: false, reason }`. Keep it pure and unit-testable. Reuse the existing
   `haulLegVerdict` wording style.
2. **`src/engine/dispatcher.ts`**
   - Extend the `tuning` type (~line 1063) with `slowHullSpeed?`, `slowHullHauledHops?`, `slowHullPositioningHops?`
     (`undefined` = clause off).
   - In the per-ship matching block (~1714–1870, where `t.speed`, `speedGain`, `matchShips`, `positioningSeconds`,
     `reachableFor` are used), exclude a work item for a slow hull when its loaded leg exceeds the cap, and refuse
     positioning beyond the cap. Apply the same predicate to the `soonFree` matching path and to the circuit path
     (`src/engine/chain.ts` uses `crossSystemHops` at ~111).
   - Make sure the refusal surfaces in `ops_dispatch_explain` with a clear reason, e.g.
     `"slow hull: loaded leg is 2 gate jumps, over the slow-hull limit of 1"`.
3. **`src/engine/fleet.ts`** — where the dispatcher `tuning` is built (~line 11217), pass:
   ```
   slowHullSpeed: this.doctrine.value("slowHullSpeed", 15),
   slowHullHauledHops: this.doctrine.isEnabledOr("slowHullHauledHops", false) ? this.doctrine.value("slowHullHauledHops", 1) : undefined,
   slowHullPositioningHops: this.doctrine.isEnabledOr("slowHullPositioningHops", false) ? this.doctrine.value("slowHullPositioningHops", 2) : undefined,
   ```
   Leave `hauledHopsLimit()` / `haulLegRefusal()` global as they are.
4. **`CHANGELOG.md`** — one entry referencing this spec.

## Edge cases

- **Manual routes** (`assign_route`): operator override; do not apply the slow-hull gate.
- **Circuits / chains**: apply the gate to each leg; drop the circuit for a slow hull if either leg violates.
- **Soon-free matching**: use the soon-free ship's own speed.
- **Unknown speed**: treat as slow.
- **Staged systems**: a slow hull positioned in a staged system still cannot trade (existing fresh-gate behaviour);
  the clause does not change that.
- **`slowHullHauledHops = 0`**: same-system loaded routes only.
- **Freighters**: speed 36/60 > 15, so unaffected; long premium runs stay available to them.

## Tests

- `tests/haulLimit.test.ts` — pure `slowHullVerdict`: speed 15 + 2 hops refused; speed 15 + 1 hop allowed; speed 36
  + 3 hops allowed; clause off = allowed; unknown speed = slow.
- `tests/dispatcherLocality.test.ts` (or a new `tests/dispatcherSlowHull.test.ts`) — with the clause on, a speed-15
  trader is not offered a 2-gate leg but a speed-36 trader is; positioning cap respected; manual route unaffected.
- `tests/doctrine.test.ts` — the three keys exist, ship disabled, and have valid ranges.
- `tests/dispatchExplain.test.ts` — the refusal reason appears for a slow hull.

## Acceptance criteria

1. With `slowHullSpeed=15, slowHullHauledHops=1, slowHullPositioningHops=2` enabled: a speed-15 hull is never
   offered a route whose buy→sell leg is >1 gate, nor a buy market >2 gates away. A speed-36 hull is unaffected.
2. All three off (default): byte-for-byte same route offers as today.
3. `ops_dispatch_explain` shows the slow-hull refusal reason.
4. Unit + dispatcher tests green; `CHANGELOG.md` updated.
5. No change to route prices, the route board, or manual routes.

## Rollout

- Build with the keys **disabled** (no behaviour change on deploy).
- After deploy, the operator enables them live:
  `set_doctrine slowHullSpeed=15`, `slowHullHauledHops=1`, `slowHullPositioningHops=2`.
- Watch `ops_deadhead` loaded-share and `ops_dispatch_explain` route counts for ~1h; if the offered board collapses,
  raise `slowHullHauledHops` to 2 (covers the 2-hop premium systems AR37/BY84/DJ26/FR76).
