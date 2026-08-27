# ShipRegistry as the single ownership arbiter

`ShipRegistry` (`src/engine/shipRegistry.ts`) replaces what used to be up to
eight independent mechanisms that could each believe they controlled a
given ship — role maps, the dispatcher, mission carrier assignment,
warehouse designation, keeper stationing, and manual hold/mine-pin flags —
with one claim per ship, ranked by a fixed precedence (`operator > rescue >
mission > warehouse > keeper > auto`) and enforced in one place. A claim
from a stronger owner always wins; a weaker owner's claim against a
stronger one is rejected unless the caller explicitly passes `preempt:
true`, reserved for mirroring one real decision rather than letting two
genuinely competing authorities silently overwrite each other.

This landed in two stages, deliberately: **Phase 4** (dual-write) added the
table (`ship_claims`, RLS'd like every other tenant-scoped table) and had
`syncShipClaims()` mirror the existing role/dispatcher/mission/warehouse
state into it once per tick — real and persisted, but not yet gating
anything, so there was nothing to log a disagreement about because only
one decision-maker existed. **Cutover, part 1** made it a real gate:
`holdShip`, `designateWarehouseShip`, `pickMissionCarrier`,
`assignMissionCarrier`, and `maybeAssignKeepers` now call `claim()`/
`release()` inline at the moment of mutation, and a rejected claim actually
blocks the action (e.g. `designateWarehouseShip` now throws instead of
silently succeeding against an operator-held ship). `syncShipClaims()`
still runs every tick as a self-healing resync on top of the inline calls.
A 100-tick integration test caught a real ordering bug in the mirror logic
itself (warehouse-ship detection was checked after, not before, the
manual-hold check, silently flipping a warehouse claim back to `operator`
on the very next resync) — the kind of bug only a multi-tick scenario
surfaces, which is why `tests/integration.test.ts` exists.

See CONTEXT.md's Owner/Claim/preempt entries and README's Phase 4 and
"Cutover, part 1" sections for the full narrative.
