# PRD: Custom Route Loss Allowance (Subsidized Trading)

## Problem Statement
The current fleet-wide "Loss Floor" (`maxLossPct`) is a global safety net that prevents all ships from selling cargo if the market price drops too far below the cost basis. While this protects the wallet from unexpected crashes, it creates a rigid barrier that prevents the operator from strategically subsidizing specific trades. For example, an operator may want to sell goods at a loss to ensure a construction mission's producer is supplied, or simply to clear a hold to make room for a more profitable route, even if that specific sale violates the global loss floor.

## Solution
Introduce a route-specific loss allowance for "Custom Routes." When a Custom Route is assigned with a defined credit-per-unit loss cap, that specific ship is granted an exemption from the global loss floor for the duration of that route. The ship will instead use the route's specific cap to determine if a sale is permissible.

## User Stories
1. As an operator, I want to assign a Custom Route with a specific loss allowance, so that I can force a ship to sell cargo even if the price is below the global loss floor.
2. As an operator, I want to specify the loss allowance in absolute credits per unit, so that I have precise control over the maximum subsidy for that specific trade.
3. As an operator, I want the global loss floor to still protect all my other traders, so that I don't accidentally expose the whole fleet to uncontrolled losses.
4. As an operator, I want the system to fall back to the global loss floor if I create a Custom Route but leave the loss allowance blank.
5. As an operator, I want the ship to still refuse to sell if the loss exceeds even the custom route's specific cap, so that I have a safety limit on my subsidies.
6. As an operator, I want to easily set this value via the Custom Route form in the Deck UI, so that I don't have to use the CLI for routine assignments.

## Implementation Decisions

### Data Schema
- Extend the manual route assignment storage to include an optional `maxLossPerUnit` field (Integer).
- A `null` value for `maxLossPerUnit` indicates that no specific exemption is granted and the global safety net applies.

### API Contract
- Update the Custom Route assignment endpoint to accept an optional `maxLossPerUnit` parameter in the request body.

### Sale Execution Logic
- Modify the cargo sale gate to follow a hierarchical check:
    1. **Exemption Check**: If the ship is on a Custom Route AND `maxLossPerUnit` is defined $\rightarrow$ Permitted if `(Cost Basis - Current Price) <= maxLossPerUnit`.
    2. **Global Check**: If no exemption applies $\rightarrow$ Permitted if `Current Price >= Cost Basis * (1 - maxLossPct)`.

### UI Integration
- Add a numeric input field "Max Loss per Unit" to the Custom Route form in `deck.js`.
- Bind this input to the assignment API call.

## Testing Decisions
- **Black-Box Testing**: Verify behavior via the fleet's trade logs and the "Attention" feed.
- **Test Scenarios**:
    - **Baseline**: Automatic trader refuses sale at 20% loss (Global floor = 10%).
    - **Custom Route (No Cap)**: Custom route trader refuses sale at 20% loss (Falls back to global floor).
    - **Custom Route (Under Cap)**: Custom route trader sells at 20% loss when `maxLossPerUnit` is set high enough to cover it.
    - **Custom Route (Over Cap)**: Custom route trader refuses sale when loss exceeds the `maxLossPerUnit`.
- **Prior Art**: Similar logic exists in the `Feeds` implementation, which should be used as the reference for "subsidized" trading behavior.

## Out of Scope
- Adding loss allowances to automatic routes (handled by the global floor).
- Adding loss allowances to standard Feeds (already implemented).
- Dynamic adjustment of loss caps based on wallet balance.

## Further Notes
This feature transforms the "Loss Floor" from a mandatory law into a default law that can be explicitly overridden by the operator on a per-case basis.
