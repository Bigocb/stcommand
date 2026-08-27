# Additive, dual-write migration discipline for engine redesigns

Every structural engine change in this codebase (ShipRegistry, the
Scheduler, ship-state/cargo-manifest persistence) lands in the same
sequence: build the new mechanism for real against a real migration and
real tests, run it in parallel with the existing mechanism as a pure
observer (no behavior gated on it yet), then — only once it's run stable —
cut it over to actually gate real decisions, in a separate, later, and
explicitly higher-risk step. No table is removed and no old mechanism is
deleted until its replacement has demonstrably run stable in parallel.

This is a *migration* discipline, not a long-term feature-flag
architecture: once a capability's cutover lands, the pre-cutover code path
is kept only as the fallback for callers that haven't adopted the new one
(e.g. `FleetManager.run()` without a `scheduler` still starts the old
`runLoop()`s — see `FleetOptions.scheduler`'s own comment), never
re-offered as a supported alternate mode to toggle back to. The payoff
this buys, demonstrated in practice: a 100-tick integration scenario
(`tests/integration.test.ts`) caught a real pre-existing ordering bug in
`syncShipClaims()`'s mirror logic that a single-tick test structurally
could not have caught, specifically because the dual-write period had
already produced a stable, exercisable mechanism to run that scenario
against before anything depended on its correctness.

Every phase's own write-up in README states explicitly where its
dual-write line is drawn and what remains a fallback versus what's now
live — treat a phase description that doesn't say "cutover" as still
observational, regardless of how complete or tested it sounds.
