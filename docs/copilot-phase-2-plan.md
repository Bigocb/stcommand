# Co-pilot phase 2: let the co-pilot act, through the same handlers as everything else

Status: plan, not started. Written 2026-10-11 from the state of `main` at `2c196d8`.
Design rule (from `docs/mcp-server-plan.md` §3 and §9): the co-pilot never gets its own
execution code. Every action it can take is a call to a handler that the dashboard routes
and the MCP server already use. One implementation of "what can an agent do to this
fleet", reached through three front doors: the dashboard HTTP routes, the MCP server
(`src/mcp/tools.ts`), and the co-pilot chat (`src/engine/agentChat.ts`).

## Where we are

- `ChatAgent` (`src/engine/agentChat.ts`) has 19 read-only tools (fleet status, gate status,
  markets, ledger totals, missions, surveys, and so on) and one action tool,
  `propose_fleet_action`, with five kinds: `set_role`, `hold`, `release`, `pause_fleet`,
  `resume_fleet`.
- A proposal is queued with an id and runs only when the captain replies `/confirm <id>`.
  Proposals expire after `PROPOSAL_TTL_MS` (30 minutes). `/cancel <id>` drops one.
- `/confirm` and `/cancel` are intercepted in `POST /chat` (`src/http/dashboard.ts`).
  `executeCopilotAction(w, action)` runs the confirmed action. It only knows the five kinds
  above, and it writes an operator-action row with `via: "copilot"`.
- The system prompt forbids buying, selling, dispatching, jumping and doctrine changes.
- MCP tools in `src/mcp/tools.ts` already cover dispatch, jump, tour, refuel, mine-at, feed
  start, approvals, missions and so on. They are the logic that must be shared, not copied.

The gap: the co-pilot's confirm path and the MCP path are two separate pieces of code that
can drift apart. Phase 2 closes that gap before adding any new action.

## Principles

1. **One handler per action.** Each action has one function in a shared module. The
   dashboard route, the MCP tool and the co-pilot proposal all call it. No second copy.
2. **Propose, then confirm, for every write the co-pilot can make.** The co-pilot never
   executes directly. Its output is a queued proposal with a one-line human summary.
3. **Attribution.** Every executed action records its source (`dashboard`, `mcp`, `copilot`)
   in the operator-action log. The existing `via` field already does this for the co-pilot.
4. **Destructive actions need an explicit flag.** Selling a ship, scrapping, pausing the
   whole fleet for more than a set time, and changing a doctrine bound are gated by a
   `confirm: true` argument on the shared handler, not only by the chat confirm.
5. **Read-only tools stay as they are.** Phase 2 adds nothing to the read side except what
   a new write needs to show before it runs.

## Phases

Each phase ends with its own tests and a `CHANGELOG.md` entry. Do not start a phase until
the previous one is on `main` and checked against the live fleet.

### Phase 2.0: extract the shared action layer (no behaviour change)

Goal: every existing write goes through one module.

- New module `src/engine/actions.ts`, pure where possible, exporting one function per
  action: `setShipRole`, `holdShip`, `releaseShip`, `pauseFleet`, `resumeFleet` to start.
  Each takes the tenant worker (or the fleet manager) and typed arguments and returns a
  result object. No I/O of its own beyond the fleet calls.
- `executeCopilotAction` and the five dashboard routes that do these things call the
  module. The MCP tools for the same five call it too.
- Tests: the existing `tests/chatActions.test.ts` and the MCP tool tests must pass
  unchanged. Add one test per action proving the dashboard path and the MCP path produce
  the same fleet state.
- Definition of done: `grep` finds the five actions in exactly one module.

### Phase 2.1: fleet movement and trading through proposals

Goal: the co-pilot can propose the actions a captain actually asks for most.

Actions, in this order:
1. `dispatch_ship` (same-system waypoint), `jump_ship` (one hop), `dispatch_tour` (system
   symbol, multi-hop). Movement reuses `FleetManager.dispatchShip`, `jumpShip` and
   `dispatchTour` through the shared layer.
2. `refuel_ship`, `mine_at` (with `release`), `set_feed_limits`.
3. `buy_ship` and `sell_ship`. `sell_ship` requires `confirm: true` in the handler (see
   principle 4). `buy_ship` checks the cash floor and `shipBudget` doctrine before it queues.

Tool shape: keep one generic `propose_action` with `kind` and typed `args` per kind, and a
JSON schema per kind. Replace the five-kind enum with the shared list so the co-pilot's
schema is generated from the same table the MCP server uses (no hand-written duplicate).

System prompt: remove the "You cannot buy or sell ships, dispatch or jump ships" line only
for the actions that have shipped. Keep the rest.

Tests:
- Each kind: propose, confirm, expect the same fleet change as the dashboard route.
- Expiry: a proposal older than the TTL is refused with a clear message.
- Two proposals for the same ship: the second is refused while the first is pending.
- `sell_ship` without `confirm: true`: refused by the handler, not just the chat.

### Phase 2.2: approvals

Goal: the co-pilot can list and decide pending approvals (the operator gate that already
exists for keeper probes and other autonomous purchases).

- Read: `get_approvals` (list) — a read tool, no proposal needed.
- Write: `decide_approval` with `id` and `approve: true|false`, proposed then confirmed like
  everything else. Approving is an action that spends credits, so the proposal summary must
  show the cost.

Tests: approve and reject both route through `decideApproval` in the shared layer; the cost
line in the summary matches the approval's own amount.

### Phase 2.3: missions, contracts and warehouse

- Read tools already exist for missions. Add read for warehouse targets and contracts
  status if missing.
- Writes: `start_mission`, `pause_mission`, `resume_mission`, `set_mission_crew`,
  `set_mission_pacing`, `set_warehouse_target`. Each goes through the shared layer.
- Mission pacing and crew changes interrupt work in progress. Their summaries must say so.

Tests: one per write, plus a test that a paused mission's crew is not reassigned by the
co-pilot without a fresh proposal.

### Phase 2.4: doctrine

- Read: `get_doctrine` (rules, values, enabled state).
- Write: `set_doctrine` with `key`, `value` and/or `enabled`. The shared handler enforces
  the rule's own `min`/`max` (the same bounds the Tower value box uses) and refuses keys
  that do not exist.
- The proposal summary shows the old and new value, and for the cross-system switches,
  the cost consequence in plain words (for example, "positioning jumps 3 -> 5: routes up to
  5 gate jumps become eligible; each jump costs about 5,000 credits").

Tests: out-of-range value refused; unknown key refused; a valid change round-trips through
`GET /api/doctrine`.

### Phase 2.5: the destructive subset and the evaluation suite

- Confirm flag: every destructive action (sell_ship, pause_fleet longer than an hour,
  decide_approval with approve on a spend over a threshold) requires `confirm: true` in
  the shared handler. The chat confirm is the second check, not the only one.
- Evaluation suite (per `docs/mcp-server-plan.md` §7 step 4): ten realistic tasks an agent
  must complete using only the co-pilot's tools against a real tenant. Examples:
  - "Find every idle trader and say what each one's nearest positive-margin route is."
    (read only)
  - "Hold every ship in X1-TX45, then confirm with a fresh fleet status." (write)
  - "Raise positioning jumps to 4 and tell me what that costs per trip." (doctrine, read
    back the change)
  Run the suite against a staging tenant or a copy of the fleet state. Record pass/fail in
  `docs/copilot-eval-results.md`.

## Risks to watch

- **Divergence.** The point of phase 2.0 is that there is one code path. If a phase adds
  logic inside `agentChat.ts` instead of the shared module, it is wrong, even if it passes.
- **Chat as a write path.** Every write needs a proposal the captain sees. A tool that
  mutates state during a read turn is a bug.
- **Context size.** Each action's schema adds tokens to every co-pilot turn. Generate the
  schema list from the shared table and keep argument names short.
- **Cash.** `buy_ship`, approvals and some feed actions spend credits. Check the cash floor
  inside the handler, not in the prompt.

## Where to look

- `src/engine/agentChat.ts`: `ChatAgent`, the tool list, the system prompt, proposals.
- `src/http/dashboard.ts`: `POST /chat`, `executeCopilotAction`, the fleet routes.
- `src/mcp/tools.ts`: the MCP tools and their handlers.
- `src/mcp/server.ts`: `PLAYER_INSTRUCTIONS`, the instructions MCP clients see.
- `tests/chatActions.test.ts`, `tests/agentChat.test.ts`, `tests/dashboard.test.ts`.
- `docs/mcp-server-plan.md` §3, §7, §9 — the design this plan follows.
