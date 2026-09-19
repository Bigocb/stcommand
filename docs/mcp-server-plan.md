# A hosted MCP server for stcommand — scoping

Not built yet. This is a design pass — tool inventory, auth model,
architecture, and open questions — for an MCP (Model Context Protocol)
server hosted as part of this app, so an agent (Claude or otherwise) can
take the same game actions an operator takes by hand from the dashboard,
instead of the operator relaying instructions through a human in the
loop.

## Why this, why now

Everything this session did — watching THEO-1C, diagnosing the
`tourDestination` bug, checking shipyard inventory, confirming deploys —
involved the operator *telling* me what they'd done or wanted done, and me
reading logs/DB to confirm it, because I had no way to act on the game
directly. A hosted MCP server closes that gap: point an MCP client (this
session, or any other) at it, and "send THEO-1C back to X1-TX45" becomes a
tool call instead of a round-trip through the operator's own clicking.

## Non-goals for this pass

- **Not** replacing the dashboard/Tower UI — this is a second, parallel
  client onto the same engine, not a redesign of the primary interface.
- **Not** exposing admin-level actions (`/api/admin/*` — tenant
  management, reset-cleanup, `ADMIN_KEY`-gated). Those are operator-of-
  the-whole-app actions, not "game related actions" a per-tenant agent
  should ever reach.
- **Not** designing a new autonomous-agent-plays-the-game loop. This is
  about letting an agent take the *same* actions a human takes by hand —
  it's a remote control, not a new AI player. (`ai_mainframe`-flavored
  autonomy is a different, much bigger conversation than "scope an MCP
  server.")
- **Not** deciding today whether this session specifically should be the
  client that connects to it — that's a separate, later choice once the
  server exists.

---

## 1. Transport and hosting

**Streamable HTTP, stateless, mounted directly in the existing Express
app** — not a separate process, not stdio.

- This app already runs one long-lived Node/Express process per Render
  service instance (`src/cli/index.ts`); adding an MCP route is a new
  `app.use("/mcp", ...)` mount, not new infrastructure. stdio is for a
  locally-spawned server talking to a single local client — wrong shape
  for a server other people's agent sessions connect to over the network.
- Stateless (no server-held session state across calls, no SSE-streamed
  long-lived connection) matches this codebase's own established
  philosophy — `src/engine/approvals.ts`'s own doc comment: *"Deliberately
  DB-polled, not an in-memory await: this app restarts on every deploy...
  a Promise held across that would just be lost."* An MCP session pinned
  to one process instance would break the same way on the next deploy.
  Every tool call re-resolves the tenant from its auth token and reads
  live state fresh, the same way every dashboard HTTP request already
  does — no new statefulness class to reason about restart-survival for.
- TypeScript, using `@modelcontextprotocol/sdk`'s `McpServer` +
  `StreamableHTTPServerTransport`, same language and runtime as the rest
  of this codebase — no second language/toolchain to maintain.

## 2. Auth: per-tenant MCP API keys, not the session cookie

The dashboard's existing auth (`src/db/tenants.ts`'s `createSession()` +
signed cookie, resolved by `resolveTenant` in `cli/index.ts`) is built for
a browser holding one cookie at a time — exactly the friction flagged
already in `docs/TODO.md`'s parked "one tenant session per browser, not
per tab" item. An MCP client is a programmatic caller, not a browser, and
needs its own credential:

- **New `tenant_mcp_keys` table**: `tenant_id`, a hashed key (never store
  the raw key, same discipline `src/db/tenants.ts` already uses for the
  co-pilot LLM key — see its `encryptSecret`/`decryptSecret`), `label`
  (so an operator can tell keys apart), `created_at`, `last_used_at`,
  `revoked_at`. A tenant can mint/revoke keys from the dashboard's
  existing Settings area (new small panel next to the co-pilot LLM
  settings) — generate, show once, copy, done; same UX shape as a GitHub
  personal access token.
- **New middleware**, modeled directly on `admin.ts`'s own "its own
  key-based auth, not the tenant session-cookie flow" pattern (see
  `cli/index.ts`'s comment on why `/api/admin` is mounted ahead of
  `resolveTenant`): `Authorization: Bearer <key>` resolves straight to a
  `tenantId`, no cookie, no `req.session`. Mounted at `/mcp`, ahead of the
  cookie-based `resolveTenant` the same way `/api/admin` already is.
- **One key = one tenant**, no cross-tenant scope ever. This matters more
  here than it does for the dashboard: a leaked session cookie is
  bounded by browser session lifetime and same-site cookie behavior; a
  leaked MCP key is a bearer credential an agent could hold indefinitely
  in its own config. Revocation has to be a real, one-click action from
  day one, not a follow-up.

## 3. The core design constraint: route through the SAME functions the dashboard uses

This is the single most important rule for this server, given everything
this session just spent hours on: **`FleetManager` already has, as of
today, three different-but-overlapping manual-action entry points
(`sendShipTo`, `manualJumpShip`, `dispatchTourShip`) that each interact
with the ownership system slightly differently — and the bugs fixed this
session (THEO-1C wandering off after a "manual" jump, repeated
`autoExploreBorrow` spam during a tour-dispatch trip) were exactly bugs of
one manual-action path not fully agreeing with another.** An MCP server
is a **fourth** caller of these same primitives. If its tool
implementations call `this.api.jumpShip()` or similar raw primitives
directly instead of going through `sendShipTo()`/`manualJumpShip()`/
`dispatchTourShip()` — or worse, reimplement their own version of "move
this ship and mark it as operator-controlled" — it reopens the exact
class of bug this session spent the whole day closing, from a fifth
angle nobody has looked at yet.

**Concretely**: every MCP tool that changes fleet state must call the
same `FleetManager` method the corresponding dashboard route calls —
`fleet.sendShipTo()`, `fleet.manualJumpShip()`, `fleet.dispatchTourShip()`,
`fleet.holdShip()`, `fleet.releaseShip()`, `fleet.setShipRole()`, etc. The
MCP tool layer should be a thin adapter (Zod schema in, `FleetManager`
call, structured content out), not a second implementation of dashboard
logic. In practice this means the tool handlers can mostly be direct
ports of `dashboard.ts`'s own route bodies, calling the identical
`FleetManager`/`Store` methods — which also means anything relevant from
`docs/engine-redesign.md`'s `Directive`/`DirectiveBoard` design (§1), if
and when that migration happens, is the thing that eventually makes this
guarantee structural instead of just a rule stated here. Until then, this
document's rule is: **new caller, same functions, always.**

## 4. Tool inventory

Grouped by the dashboard route each maps to (`src/http/dashboard.ts`
unless noted). Naming convention: `stcommand_<verb>_<noun>`, e.g.
`stcommand_dispatch_ship`. Every tool implicitly resolves against the
caller's own tenant (from the Bearer key) — no `tenantId` parameter ever
exists in a tool's input schema.

### Fleet actions (write)

| Tool | Dashboard route | Notes / annotations |
|---|---|---|
| `stcommand_dispatch_ship` | `POST /fleet/dispatch` | `sendShipTo()`. Not idempotent (repeat calls just re-hold at the same spot, harmless but not a no-op on the API budget) |
| `stcommand_hold_ship` | `POST /fleet/hold` | `holdShip()` |
| `stcommand_release_ship` | `POST /fleet/release` | `releaseShip()` |
| `stcommand_jump_ship` | `POST /fleet/jump` | `manualJumpShip()` (per §3 above — NOT the bare `jumpShip()` primitive) |
| `stcommand_dispatch_tour` | `POST /fleet/tour-dispatch` | `dispatchTourShip()` — multi-hop system-level tour assignment |
| `stcommand_set_ship_role` | `POST /fleet/role` | `setShipRole()`. `destructiveHint: true` — reassigning a ship's role interrupts whatever it was doing |
| `stcommand_pin_mining_target` | `POST /fleet/mine` | |
| `stcommand_dock_toggle` | `POST /fleet/dock` | dock/undock |
| `stcommand_transfer_cargo` | `POST /fleet/transfer` | ship-to-ship |
| `stcommand_buy_ship` | `POST /fleet/buy` | `destructiveHint: true` (spends credits) — see §5's confirm-flag requirement |
| `stcommand_refuel_ship` | `POST /fleet/refuel` | |
| `stcommand_scrap_ship` | `POST /fleet/scrap` | `destructiveHint: true`, irreversible — confirm flag required (§5) |
| `stcommand_sell_ship` | `POST /fleet/sell-ship` | `destructiveHint: true`, irreversible — confirm flag required |
| `stcommand_explore` | `POST /fleet/explore` | manual one-shot explore trip |
| `stcommand_buy_install` | `POST /fleet/buy-install` | module/mount purchase, spends credits |
| `stcommand_install_component` | `POST /fleet/install` | |
| `stcommand_remove_component` | `POST /fleet/remove-component` | |
| `stcommand_trade` | `POST /fleet/trade` | manual buy/sell at current market |
| `stcommand_jettison_cargo` | `POST /fleet/jettison` | `destructiveHint: true` |
| `stcommand_repair_ship` | `POST /fleet/repair` | spends credits |
| `stcommand_pause_fleet` / `stcommand_resume_fleet` | `POST /fleet/pause`, `/fleet/resume` | fleet-wide, `destructiveHint: true` (pause) |

### Approvals (write)

| Tool | Dashboard route | Notes |
|---|---|---|
| `stcommand_decide_approval` | `POST /approvals/:id/decide` | approve/deny a pending request — this is how an agent participates in the SAME gate `docs/CHANGELOG.md`'s `autoExploreBorrow`/`buyKeeperProbe`/etc. already use, rather than needing its own parallel confirmation concept |

### Missions / contracts / warehouse (write)

| Tool | Dashboard route |
|---|---|
| `stcommand_accept_contract` | `POST /contracts/accept` |
| `stcommand_decline_contract` | `POST /contracts/decline` |
| `stcommand_undecline_contract` | `POST /contracts/undecline` |
| `stcommand_abandon_contract` | `POST /contracts/abandon` — `destructiveHint: true` |
| `stcommand_resume_contract` | `POST /contracts/resume` |
| `stcommand_assign_contract` | `POST /contracts/assign` |
| `stcommand_start_mission` | `POST /missions/start` |
| `stcommand_pause_mission` / `stcommand_resume_mission` | `POST /missions/pause`, `/resume` |
| `stcommand_assign_mission` | `POST /missions/assign` |
| `stcommand_set_keeper_market` | `POST /keeper/markets` |
| `stcommand_set_warehouse_targets` | `POST /warehouse/targets` (+ `/remove`) |
| `stcommand_designate_warehouse_ship` | `POST /warehouse/designate` |
| `stcommand_release_warehouse_ship` | `POST /warehouse/release` |
| `stcommand_adjust_warehouse` | `POST /warehouse/adjust` |
| `stcommand_set_dispatch_override` | `POST /dispatch` |

### Doctrine (write)

| Tool | Dashboard route |
|---|---|
| `stcommand_set_doctrine` | `POST /doctrine` |
| `stcommand_adopt_doctrine_template` | `POST /doctrine/adopt` |
| `stcommand_onboard_doctrine` | `POST /doctrine/onboard` |

### Read-only (intel / status)

One tool per GET route, all `readOnlyHint: true`, `idempotentHint: true`:
`stcommand_get_state`, `stcommand_get_fleet_status`, `stcommand_get_bridge`,
`stcommand_get_activity`, `stcommand_get_markets`, `stcommand_get_prices`,
`stcommand_get_goods`, `stcommand_get_surveys`, `stcommand_get_missions`,
`stcommand_get_contracts`, `stcommand_get_construction`,
`stcommand_get_approvals`, `stcommand_get_doctrine`,
`stcommand_get_doctrine_stats`, `stcommand_get_warehouse`,
`stcommand_get_loadout`, `stcommand_get_ship_state`,
`stcommand_get_ship_manifest`, `stcommand_get_ship_claims`,
`stcommand_get_galaxy_overview`, `stcommand_get_system_waypoints`,
`stcommand_get_intel`, `stcommand_get_replay`, `stcommand_get_leaderboard`.

This group is intentionally the *largest* by count and the *first*
phase to build (see §7) — per the mcp-builder skill's own guidance,
comprehensive read coverage is what lets an agent actually reason about
what to do next, and every one of these is zero-risk (no state change,
no credits spent, nothing to confirm).

### Deliberately excluded from v1

- **Chat / co-pilot settings** (`/chat`, `/settings/llm`, `/discord*`) —
  meta-configuration of the app itself, not a "game action." Revisit only
  if a real use case shows up.
- **`/api/admin/*`** — see Non-goals above.

## 5. Safety model

**Principle**: an MCP tool call is the same trust level as a logged-in
operator clicking the dashboard — it is *not* routed through
`ApprovalGate` the way the fleet's own autonomous proposals are (per
`approvals.ts`'s own framing, that gate exists for *engine-initiated*
decisions specifically; a tool call is operator-initiated by construction,
same as every existing dashboard POST route). The MCP key itself, scoped
to one tenant and revocable, is the access control — not a second
approval layer on top of every call.

Two things need more than that baseline, though:

- **Irreversible actions require an explicit `confirm: true` input
  field**, not just being callable. `stcommand_scrap_ship`,
  `stcommand_sell_ship`, `stcommand_abandon_contract`, and
  `stcommand_pause_fleet` (fleet-wide, easy to forget) all reject the
  call with a clear error (state exactly what will happen and that
  `confirm: true` is required) unless that field is set — mirroring the
  dashboard's own "Jettison button's confirm-and-post pattern" already
  referenced in `docs/unimplemented-api-features-plan.md`, just moved
  into the tool's own input contract since there's no UI dialog to
  intercept an agent's call the way there is a human's click.
- **Every write tool's response includes what actually changed** —
  structured content with before/after where cheap to compute (e.g.
  `stcommand_dispatch_ship` returns the ship's new hold waypoint and
  confirms `tourDestination` was cleared), not just `{ok: true}`. An
  agent correcting course based on a vague success response is exactly
  the failure mode this session hit *by hand* today (my own early,
  wrong reads of "did the dispatch work" from log lines alone) — a tool
  response that states the resulting state plainly avoids needing a
  second read-only call just to confirm the first one worked.
- **Every write tool's actions are attributed distinctly in logs/ledger/
  activity feed** — resolved (§8): yes, tag them. Every `onActivity()`/
  `recordLedger()`/`this.log()` call a write tool's underlying
  `FleetManager` method already makes takes (or can be threaded) a
  `source` value; MCP-originated calls pass `source: "mcp"` (or, if
  worth the extra granularity later, `"mcp:<key label>"`) instead of
  falling back to whatever the dashboard path defaults to. Cheap to add
  at the tool-adapter layer — each handler just needs to pass its origin
  through to the existing call, not a new logging concept.

Rate limiting is **not** a new concern: every tool call still spends real
SpaceTraders API budget through the same per-tenant `Scheduler`/token-
bucket every dashboard action already shares (per `CLAUDE.md`'s own
architecture notes) — an MCP client is just another caller into the same
budget, no separate throttle needed at this layer.

## 6. Implementation sketch

```
src/mcp/
  server.ts        // McpServer setup, StreamableHTTPServerTransport, mounted at /mcp
  auth.ts           // Bearer-key middleware -> tenantId, modeled on admin.ts's own key auth
  tools/
    fleet.ts        // dispatch/hold/release/jump/tour-dispatch/role/... (§4's write table)
    approvals.ts
    missions.ts
    doctrine.ts
    intel.ts         // every read-only tool
  keys.ts            // mint/revoke/hash, tenant_mcp_keys table access
```

- `src/cli/index.ts`: `app.use("/mcp", mcpAuth, createMcpRouter(registry, store))`,
  mounted the same way `/api/admin` and `/api/cartography` are — ahead of
  the cookie-based `resolveTenant`, since this has its own auth entirely.
- Each tool handler: Zod input schema → resolve the tenant's live
  `FleetManager` via `registry.getOrCreate(tenantId, ...)` (same call
  `cli/index.ts`'s own `/api` middleware already makes) → call the exact
  `FleetManager`/`Store` method the matching dashboard route calls → shape
  a `structuredContent` response.
- New migration: `tenant_mcp_keys` table (tenant-scoped, RLS same as
  every other tenant table per `CLAUDE.md`'s shared-vs-tenant split).
- Dashboard Settings panel: mint/list/revoke keys — small, same shape as
  the existing co-pilot LLM settings panel already in that tab.

## 7. Phasing

Resolved (§8): read-only and write tools are designed and built
**together** in one pass, not split into a standalone read-only release
lived with before writes are even designed. Sequencing within that one
pass:

1. **Auth infrastructure** (`tenant_mcp_keys`, the Bearer-key middleware,
   the dashboard's mint/revoke panel) and **read-only tools** first, since
   nothing else can be tested end-to-end without them and they carry zero
   risk on their own.
2. **Fleet write tools**, routed through existing `FleetManager` methods
   per §3, with the confirm-flag requirement on the destructive subset
   and `source: "mcp"` attribution (§5) built in from the start, not
   bolted on later.
3. **Missions/contracts/warehouse/doctrine write tools.**
4. **Evaluation suite** (per the mcp-builder skill's Phase 4): 10
   realistic questions/tasks an agent should be able to complete using
   only this server's tools against a real tenant — e.g. "find every
   idle trader and report what each one's nearest positive-margin route
   is" (read-only) and "hold every ship currently in X1-TX45" (write,
   verifiable by re-reading fleet status after).

## 8. Resolved questions (operator decision, 2026-09-19)

1. **Who can mint a key for a tenant?** Same trust level as dashboard
   login — no extra confirmation step beyond already being logged into
   that tenant. No new mint-specific auth flow to design.
2. **Should read-only tools ship standalone before write tools are even
   designed?** No — design and build both together in one pass (§7 now
   reflects this: auth + read-only first *within* that single pass for
   testability, not as a separately shipped, lived-with release).
3. **Does an MCP-originated action need its own `source` tag** distinct
   from "dashboard"? Yes — `source: "mcp"` threaded through the existing
   `onActivity()`/`recordLedger()`/`this.log()` calls each write tool's
   underlying `FleetManager` method already makes (§5, §6).
4. **Multi-tenant fan-out**: one key per tenant is sufficient — an
   operator managing several of their own tenants (THEO, THEO-1, THEO-2)
   just holds multiple keys in their MCP client's own config. No
   multi-tenant-scoped key needed; not building that.
