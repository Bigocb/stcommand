# INC-08: dispatch_tour sent a ship to tour its own system first

GitHub: [#39](https://github.com/Bigocb/stcommand/issues/39)

| | |
|---|---|
| When | 2026-11-18 15:47 UTC |
| Severity | Low (~20 min detour) |
| Status | Open |
| Detected by | Claude, checking the wave-1 dispatch |

## What happened
`dispatch_tour THEO-7 X1-JD68` set the role to tour and enqueued the tour task, whose first tick ran at 15:47:13, one second before
the destination was saved (15:47:14). The tick toured VM8 and sent THEO-7 from the VM8 gate to VM8-C16D (arriving 15:58).

## Cause
Ordering in `dispatch_tour`: the role change starts the tour task before `tourDestination` is set.

## Fix
Set the destination before the role change (or before enqueueing the task) ([#46](https://github.com/Bigocb/stcommand/issues/46)).
