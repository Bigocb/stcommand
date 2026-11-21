# Memory analysis, 2026-11-21

Operator request: "do an analysis of the code and see where we can save memory. Not that I want to rewrite it, but different
language / architecture have fared better with this type of work."

Context: the box restarted at 20:40 with no deploy behind it, and memory was high soon after every boot (3.7 GB resident three
minutes in). This note is the evidence and a ranked list of fixes. Nothing in it has been changed yet, except the instance-id
fix at the end.

## What was measured (live box, 21:40-21:55, process up 6-15 min)

| Reading | Value | Source |
|---|---|---|
| Resident memory (RSS) | 3.1-4.1 GB, swinging by ~1 GB within a minute | `ops profile`, `ops container` |
| JS heap used | 1.4-1.9 GB of a 4.1 GB limit | same |
| Container memory limit | none set (cgroup v2, `memory.max` = max); peak 4.2 GB; 0 OOM kills | `ops container` |
| `external` / `arrayBuffers` | 6 MB to 1.1 GB, in bursts | `ops profile` |
| Event-loop delay p99 | up to 2.1 s | `ops profile` |
| Route rebuild | 1,381,097 legs read, 433,496 offered, 17.7 s (query 5.0 s, pricing 9.6 s) | `dispatch_explain` routeBuild |

The heap sampler (`ops profile heap_start`, then `heap_report` about 6 minutes later) shows where the bytes still held at the
report were allocated:

| Allocation site | Bytes still held | Share |
|---|---|---|
| `res.json` in `src/http/gzipJson.ts`, called from `GET /api/state` | 752 MB | 66% |
| `priceLeg` in the route build (`buildDispatchRoutes`, `src/engine/fleet.ts`) | 218 MB | 19% |
| `pg` driver row buffers (`parseDataRowMessage`), the trade-legs query | 75 MB | 7% |
| `recordMarketSnapshot` (`Object.fromEntries`) | 42 MB | 4% |
| everything else | under 10 MB each | |

"Held" includes garbage not yet collected, so this measures churn as much as retention: these are the places that create
the most memory between collections. RSS stays well above the heap because V8 and glibc keep freed pages, and large objects
(strings over about 1 MB, big Buffers) live in their own space. Those pages are only slowly given back to the system.

## Where the memory goes, and the fixes, biggest first

### 1. `GET /api/state` sends every ship's full game object, on every poll

- `FleetSnapshot.ships` (`src/engine/state.ts`) holds the complete SpaceTraders `Ship` for all ~2,470 ships: frame,
  reactor, engine, modules and mounts with their description text, crew, and nav route.
- Each open Deck or Tower screen polls `/api/state`. `gzipJson` calls `JSON.stringify` on the whole snapshot for every
  request, then gzips it, and the full string stays alive until gzip finishes.
- The response is too large for the MCP transport to carry. An estimate from the summary view (540 KB for short rows) is
  10-15 MB per response.
- Two screens polling every 5-15 s means hundreds of MB of strings a minute. These are large-object-space allocations,
  which is exactly the RSS pattern seen.

Fixes, in order of effort:

- **a. Cache the serialised and gzipped body per snapshot version.** The snapshot only changes on a refresh, so every
  screen polling the same version gets the same bytes. One stringify per change instead of one per request. Small change,
  in `/api/state` and `gzipJson`.
- **b. Send slim ship rows.** The screens read symbol, role, nav (status, waypoint, system, arrival), cargo, fuel and frame
  type. `src/engine/shipRows.ts` already builds slim rows for the live feed. The full ships stay available on a detail
  route. This cuts the body by roughly 10x. Medium effort: every field the UIs read must be checked.
- **c. Stop copying all ships for one ship's change.** `FleetState.setShipCargo()` copies the whole 2,470-entry array on
  every buy and sell. Minor next to a and b.

Expected saving: most of the 750 MB of churn, and the ~1 GB RSS swings with it.

### 2. The route build reads 1.38 million buy/sell pairs every cycle

- `Store.tradeLegs()` joins every fresh market price to every other market selling the same good at a higher price. Its
  comment says about 110,000 rows; with 205 live systems it now returns 1.38 million.
- Each row exists twice: as the driver's row object and as the mapped object. Six chained `.filter()` calls in
  `computeDispatchRoutes()` then each build a new array. Only 433k pairs survive.
- Most filters (blocked goods, charted systems, the gate network, the gate supply chain, protected goods) could run in
  SQL, or on the streamed rows, before any object is built.

Fixes:

- **a. Push the cheap filters into the query.** Pass the blocked goods, charted systems and reachable systems as arrays
  (`= ANY($n)`), and add a margin floor (`sell_price > purchase_price * (1 + x)`). This should cut the rows by a large
  factor and the 5 s query with them.
- **b. Keep only the top K sell markets per (good, buy market).** The dispatcher never uses the 50th-best sell market for
  the same load. `ROW_NUMBER() OVER (PARTITION BY good, buy ORDER BY sell_price DESC) <= K` bounds the list whatever the
  galaxy size.
- **c. Filter in one pass, not six arrays.** One loop that counts each drop reason.

Expected saving: the 218 MB `priceLeg` churn and the 75 MB of driver buffers shrink roughly in proportion to the rows cut.
The 17 s rebuild and the 2 s event-loop stalls should shrink too. This is also what made the worker thread (#70) run out
of memory: the route list it was sent was this big.

### 3. Market snapshots

`recordMarketSnapshot` builds about 42 MB of short-lived objects (`Object.fromEntries`) across about 2,400 keepers' reads.
Worth a look once 1 and 2 are done; it is small next to them.

### 4. Runtime settings (no code)

- **Set a container memory limit** (for example `mem_limit: 6g` in the compose file). Today the container can grow until the
  host itself runs out, and a host-level OOM kill takes the process with no record. With a limit, the kernel's OOM counter
  (which `ops container` reads) shows when it happens.
- **`MALLOC_ARENA_MAX=2`** in the container environment. glibc keeps one malloc arena per thread and returns little memory
  to the system; with many native threads (zlib, TLS for 100 proxies, the pg driver) that inflates RSS. This is a common,
  low-risk setting for Node.
- **Keep the heap limit just under the container limit** (`--max-old-space-size`). That way V8 collects harder before the
  kernel kills the process, rather than the other way round.

## On language and architecture

- **Most of this cost is design, not language.** Re-reading an all-pairs price matrix every minute and serialising 2,470
  full ship objects per poll would be expensive in any language.
- **A compiled language would make each object smaller.** Go or Rust store a row in about a third to a fifth of the bytes a
  JS object takes, and return memory to the system more readily. The same churn would still be there.
- **The architectural changes that would help fit the current code:**
  - compute routes in Postgres, or in a separate small process that holds only the price table;
  - serve the UIs slim, cached views instead of the engine's working state;
  - keep the engine's working set to what decisions read.
- Fixes 1 and 2 are that kind of change, done in place. Measure after them before considering a rewrite of any part.

## Fixed with this note: every process had the same instance id

`INSTANCE_ID` was `hostname-pid`. In Docker every process is PID 1 with the same hostname, so every boot since 2026-10-10
wrote to one heartbeat row. That made restarts, deploy overlap and the new "Last restart" tile invisible. The id now includes
the process start time (`src/core/rateLimitMonitor.ts`). The old row ages out after 7 days.
