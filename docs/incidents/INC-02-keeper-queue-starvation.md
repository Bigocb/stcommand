# INC-02: Keeper queue starved most systems; Approve did nothing

GitHub: [#33](https://github.com/Bigocb/stcommand/issues/33)

| | |
|---|---|
| When | 2026-11-17 (all day) |
| Severity | Medium |
| Status | Fixed (`f5100f9`, `81f4f4a`) |
| Detected by | Operator |

## What happened
- SN86 (12 gaps) held the single keeper-card slot all day; B64 (the heavy-freighter yard) never got a card.
- Tapping "Approve" on a Coming-up keeper row returned ok and did nothing.

## Impact
Fresh systems went without keepers, so their prices went stale and routes there were invisible to the dispatcher.

## Cause
- `advanceKeeperMarketQueue` raises one card at a time, in score order, so the same system won every turn.
- The Approve tap could not raise a card while another pending card held the slot.

## Resolution
- Cards rotate by system (`keeperRotation.ts`, clause `keeperRotateSystems`), plus a system filter on Approvals in Tower and Ops.
- Approve on a Coming-up row closes the other pending card as expired (no denial cooldown) and raises the tapped one
  (`shouldDisplaceCard`).

## Follow-ups
- None open. Rule kept in CLAUDE.md "Keeper cards": answer or deny an open card at once.
