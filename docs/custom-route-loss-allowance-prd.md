# PRD: Custom Route Loss Allowance (Subsidized Trading)

## Problem Statement
The current fleet-wide "Loss Floor" (`maxLossPct`) is a global safety net that prevents all ships from selling cargo if the market price drops too far below the cost basis. While this protects the wallet from unexpected crashes, it creates a rigid barrier that prevents the operator from strategically subsidizing specific trades. For example, an operator may want to sell goods at a loss to ensure a construction mission's producer is supplied, or simply to clear a hold to make room for a more profitable route, even if that specific sale violates the global loss floor.

## Solution
Introduce a route-specific loss allowance for "Custom Routes." A manually pinned ("direct") route already outranks the fleet-wide `maxLossPct` — that override predates this work, so an operator's pin can sell at any price. This adds the missing middle setting: when the pin carries a credit-per-unit allowance, the ship may sell down to `cost - allowance` and no further. That turns a pinned route from all-or-nothing into a bounded subsidy, without touching any other trader.

## User Stories
1. As an operator, I want to assign a Custom Route with a specific loss allowance, so that I can force a ship to sell cargo below what I paid for it, by a bounded amount.
2. As an operator, I want to specify the loss allowance in absolute credits per unit, so that I have precise control over the maximum subsidy for that specific trade.
3. As an operator, I want the global loss floor to still protect all my other traders, so that I don't accidentally expose the whole fleet to uncontrolled losses.
4. As an operator, I want a Custom Route with a blank allowance to behave exactly as pinned routes always have (no cap), so that routes I pinned before this setting existed keep working unchanged.
5. As an operator, I want the ship to still refuse to sell if the loss exceeds even the custom route's specific cap, so that I have a safety limit on my subsidies.
6. As an operator, I want to easily set this value via the Custom Route form in the Deck UI, so that I don't have to use the CLI for routine assignments.

## Implementation Decisions

### Data Schema
- No schema change. The allowance is a field (`maxLossPerUnit`, Integer | null) on the manual route assignment, which is already persisted as the `dispatchManual` `fleet_flags` JSON blob and restored in `FleetManager.init()`. It therefore survives a restart without touching the `held_route` table, which records cargo positions (cost basis, lot size) and is written when cargo is actually bought, not when a route is assigned.
- A `null` value means "no allowance": the route keeps the pre-existing uncapped behaviour. A positive number caps the loss at that many credits per unit.

### API Contract
- `POST /api/dispatch` accepts an optional `maxLossPerUnit` (number). Values that are absent, non-numeric or `<= 0` are stored as `null`.
- The `stcommand_assign_route` MCP tool accepts the same optional field.

### Sale Execution Logic
- `src/engine/lossAllowance.ts` is the single source of truth (`sellFloor` / `belowSellFloor`), used by both the pre-sale check and the between-lots check so the two cannot drift apart:
    1. **Pinned with an allowance**: floor is `Cost Basis - maxLossPerUnit`. An allowance larger than the cost basis gives a negative floor, i.e. effectively no limit.
    2. **Pinned without an allowance**: no floor at all (unchanged pre-existing behaviour).
    3. **Not pinned**: floor is `Cost Basis * (1 - maxLossPct / 100)`, the fleet doctrine.
- No cost basis (`undefined` or `0`) means no floor in every case: there is nothing to measure a loss against.

### UI Integration
- Add a numeric input field "Max loss c/unit (optional)" to the Custom Route form in `deck.js`.
- Bind this input to the assignment API call; blank sends `null`.

## Testing Decisions
- **Unit tests**: `tests/lossAllowance.test.ts` covers all three floor states, an allowance looser and tighter than the fleet percentage, an allowance larger than cost, and the exact-floor boundary.
- **Live verification**: compare a pinned route's sells against its cost basis in the ledger / "Attention" feed.
- **Test Scenarios**:
    - **Not pinned**: refuses a sale at 20% loss with the global floor at 15%.
    - **Pinned, blank allowance**: sells at 20% loss (unchanged behaviour).
    - **Pinned, allowance covers it**: sells at 20% loss when the allowance exceeds the per-unit loss.
    - **Pinned, allowance exceeded**: refuses the sale when the loss exceeds the allowance.
- **Prior Art**: the `Feeds` subsidy (`feed_missions.max_loss_per_unit`, `stcommand_set_feed_limits`) solves the same problem on the buy side and is the reference for what an operator expects "subsidised" to mean.

## Out of Scope
- Adding loss allowances to automatic routes (handled by the global floor).
- Adding loss allowances to standard Feeds (already implemented).
- Dynamic adjustment of loss caps based on wallet balance.

## Further Notes
A blank allowance deliberately does **not** fall back to the global floor. Doing so would silently change every route pinned before this feature existed, from "sells regardless" to "may refuse to sell", and a pinned route that refuses to sell strands its cargo — the exact failure this override was added to prevent.
