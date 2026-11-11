# PRD: Approve any item in the approval queue

Status: proposed (2026-11-11, corrected). Owner: TBD. Origin: operator request.

## What the keeper flow actually does today (corrected)

Earlier versions of this PRD assumed a keeper purchase waits for one of our ships to visit the target waypoint. That is **wrong**:

- **Tagging a waypoint triggers an approval immediately.** The keeper tag (`POST /api/keeper/markets`, `toggleKeeperPriority` in `public/v6.js` / `m.js` / `deck.js`) adds the market to the keeper priority list and runs an immediate coverage check, which raises the keeper-probe approval card (or auto-approves it under `autoApproveKeeperProbes`).
- **No visit to the target waypoint is required.** Keepers can be bought at any yard in the target's system (`pickKeeperYardWithShip` — a keeper at any yard of the system can buy for the rest), and `keeperDeliveryHops` lets a probe be bought at a yard in another system and moved through gates (`src/engine/keeperDelivery.ts`).
- `keeperYardWaitMin` is a **stall grace** for a queued purchase, not a rule that a ship must stand at the waypoint.

So the operator's current workflow — tag a waypoint, get a card, approve it, keeper bought — already works and must not be replaced.

## Problem (the real, narrow gap)

The Approvals screen (`GET /api/approvals`, `src/engine/approvalsView.ts`) returns three groups:

1. **`approvals`** — open cards (have an id; Approve/Deny works via `POST /api/approvals/:id/decide`).
2. **`decided`** — decided rows not yet consumed.
3. **`upcoming`** — priority markets with **no open ask yet**.

Only group 1 is actionable. An `upcoming` row is informational: the operator can see the market, but cannot act on it from that screen. And the copy says "waiting for a ship to dock there", which is stale — a tag would raise the ask immediately.

The operator's ask: **approve any row in the Approvals view** — for an `upcoming` market, do what the keeper tag does (tag it → immediate coverage check → card → purchase).

## Goal

Every row in the Approvals view is actionable. Approving an `upcoming` market tags it as keeper priority (the existing behaviour), which raises the approval card immediately. No new approval store, no wait-for-ship.

## Design

### UI
- On each `upcoming` row, add **Approve** (label: "Tag as keeper priority / approve") and optionally **Skip**.
- Approve calls the existing `POST /api/keeper/markets` with the market appended to the current `keeperMarkets` list (exactly what `toggleKeeperPriority` does), then refreshes — the card appears immediately.
- Fix the stale `upcoming` copy: "priority markets with no open ask (tagging one raises a keeper card immediately)", not "waiting for a ship."
- For `decided` rows, optionally show the decision and allow re-decide while the engine has not consumed it (small, separate).
- Badge count stays open-cards only.

### MCP
- Add a convenience tool `stcommand_approve_upcoming { market }` that appends the market to the keeper priority list (delegating to the existing `set_keeper_markets` path), so an agent can do what the tag does.
- Optionally add `includeUpcoming` to `stcommand_get_approvals` so an agent sees the same rows as the dashboard.

### Backend
- No schema change, no migration, no pre-approval table. The existing keeper-queue path (`setKeeperPriorityMarkets` → coverage check → `ApprovalGate.request`) does all the work.

## Acceptance criteria

1. Every `upcoming` row in the Approvals view has an Approve action.
2. Clicking it adds the market to the keeper priority list and a keeper card appears immediately (or auto-approves under the 60k cap), with no ship required at the waypoint.
3. The keeper is bought and delivered per the existing rules (`pickKeeperYardWithShip`, `keeperDeliveryHops`).
4. The stale "waiting for a ship" copy is corrected.
5. MCP can do the same via `stcommand_approve_upcoming`.
6. No new table, no migration, and the existing tag/card behaviour is unchanged.

## Non-goals

- No pre-approval table or `upcoming:` synthetic ids.
- No auto-dispatch of a ship to a yard.
- No change to the keeper purchase, delivery, cash-floor, or price-cap mechanics.
