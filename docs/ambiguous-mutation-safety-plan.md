# Ambiguous mutations — retrying safely when the response is lost, not just wrong

Of the four gaps found comparing our API-governance design against another
SpaceTraders app's approach, this is the one worth prioritizing over the
other three regardless of scale — it's a real-money-loss shape, not a
performance/fairness concern.

## Current state

`Client.request()` (`src/core/client.ts:260-321`) wraps the `fetch()` call
itself (lines 278-285) with **no try/catch**. Retry logic exists only for
responses that successfully come back — 429 handling (line 289) and 5xx
handling (line 298) both act on a resolved `Response`. A thrown network
exception — a dropped connection, DNS blip, request abort mid-flight — has
no handling at all: it propagates straight out of `request()` uncaught. For
a read (`getMyShips`, `getMarket`), an uncaught throw is annoying but safe —
the caller retries next tick and nothing was lost. For a **mutation**
(`purchaseCargo`, `purchaseShip`, `jumpShip`, `navigateShip`, `refuelShip`,
`extractWithSurvey`, `sellCargo`), it's a different problem: the request may
have reached SpaceTraders and succeeded server-side, with only the
*response* lost to the dropped connection. The caller has no way to
distinguish "definitely didn't happen, safe to retry" from "maybe happened,
retrying would duplicate it."

SpaceTraders' own schema (`src/core/schema.d.ts`) documents idempotency for
exactly two endpoints — `orbitShip` (line 534) and `dockShip` (line 628),
both stating "successive calls will succeed even if already in
orbit/docked." Nothing else in the schema makes this guarantee, and nothing
in stcommand compensates for it. `TraderAgent.heldRoute`/`heldCost`
(trader.ts:243,271, now persisted per
`docs/adr/` — see the held-route persistence work) records "I bought this,
here's the cost basis" **after** a purchase call already returned
successfully; it's a bookkeeping/restart-recovery mechanism, not a
pre-mutation reconciliation guard, and does nothing for a call that never
returns at all. `fleet.ts`'s `buyShip()` (2009-2046) and `jumpShip()`
(~2376-2431) each call their mutating endpoint exactly once, with no
live-state check before or after, and no retry path if the call throws
rather than resolves.

Concretely, today: if `purchaseShip()`'s `fetch()` throws after the server
already processed the purchase, the throw propagates uncaught, the caller
sees no ship added to its fleet, and if any retry logic exists upstream (or
a later tick just tries again), it would issue a second, real,
double-charged purchase. The same shape applies to `jumpShip` (double jump
= double the (large) jump cost) and `purchaseCargo` (double buy).

## Proposed design

Two layers, deliberately kept separate: (1) make `request()` itself safe to
retry for reads, (2) add a narrow reconciliation step for the specific
endpoints where retrying blind is dangerous.

### 1. Catch and classify the throw

Wrap the `fetch()` call in `request()` in try/catch. On a caught exception
(vs. an HTTP error status, which is already handled), retry with backoff
**only if the request is a GET** (reads are always safe to retry) or if the
caller has explicitly marked the call idempotent (see below). Otherwise,
rethrow with an explicit `AmbiguousMutationError` wrapping the original
error, so calling code can tell "this network call failed" apart from "this
network call's outcome is unknown" — today both look identical to a caller
(an uncaught throw), which is itself part of the problem.

### 2. Reconciliation for the endpoints where it matters

Not all mutations need this — only ones with a cheap, reliable way to check
"did this already happen" after the fact:

- **`purchaseShip`**: on `AmbiguousMutationError`, re-fetch
  `listAllShips()` (or `getMyAgent()` for a credits-delta check) and look
  for a new ship of the requested type/frame that wasn't there before
  attempting. Present → treat as succeeded, don't retry. Absent → safe to
  retry.
- **`jumpShip`**: re-fetch the ship's own state (`getShip(symbol)`). If
  its system already matches the jump's destination, treat as succeeded.
  Otherwise retry.
- **`purchaseCargo`/`sellCargo`**: re-fetch the ship's cargo manifest; if
  the expected unit delta for that good is already reflected, don't retry.
  This is the same "did the ship's real state already move" check as the
  other two — reconciliation via live state, not via a stored idempotency
  key, since SpaceTraders doesn't offer one.
- **`refuelShip`**: fuel level is the check; same pattern.
- **`extractWithSurvey`**: lower priority — extraction failures are already
  handled defensively elsewhere (survey exhaustion, etc.) and a duplicate
  extraction attempt isn't a money-loss shape the way a duplicate purchase
  is; a spurious retry here just wastes a call, not credits. Include for
  completeness but implement last.

Each of these is the same shape: **re-check live ship/agent state before
retrying an ambiguous mutation**, rather than trusting any local record of
"did I already send this." That's a deliberate choice — a stored
idempotency key would require SpaceTraders to honor one, which it doesn't;
live-state reconciliation works with the API as it actually behaves today.

### Where this lives

A small helper, e.g. `withReconciliation(fn, check)` in `client.ts` or a new
`src/core/reconciliation.ts`, wrapping the specific call sites above at
their existing locations in `fleet.ts`/`trader.ts`. Not a generic mechanism
applied blindly to every mutating call — only the ones listed have a cheap,
reliable "did it happen" check. Endpoints without one (nothing observable
changes on success, or checking costs as much as the risk it avoids) stay
as they are; that's a smaller set once the five above are covered.

## Tradeoffs

- **Cost of a reconciliation check**: one extra read call per ambiguous
  failure — rare by construction (only fires on a caught network exception,
  not on ordinary error responses) — so this doesn't add steady-state API
  load, only load in the already-rare failure path.
- **Not perfectly safe**: a reconciliation check has its own tiny race
  window (state could change between the ambiguous mutation and the
  recheck, e.g. another process buys the same ship type). Accepted — this
  closes the overwhelming majority of the real risk (a network blip losing
  a response) without chasing a theoretical residual race that would need
  server-side idempotency keys to fully close, which SpaceTraders doesn't
  offer.
- **Scope discipline**: resist generalizing this into a framework before
  the five listed endpoints prove the pattern out. Wrong endpoints,
  wrong to over-generalize; wrong to also skip the two most money-
  sensitive ones (`purchaseShip`, `purchaseCargo`) just because the
  mechanism feels reusable — build all five to the same shape, don't build
  a sixth "just in case."

## Phased implementation

1. Add `AmbiguousMutationError` and the try/catch classification in
   `Client.request()` — this alone makes the failure mode observable
   (logged, distinguishable) even before any reconciliation exists.
2. Implement reconciliation for `purchaseShip` and `purchaseCargo`/
   `sellCargo` first — highest money-loss risk.
3. `jumpShip` and `refuelShip` next.
4. `extractWithSurvey` last, if at all.
5. Test: for each endpoint, a test that throws mid-`fetch()` (mock),
   confirms the live-state recheck runs, and asserts no duplicate mutation
   is issued when the recheck shows the original attempt already landed.
