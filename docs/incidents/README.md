# Incident reports

One file per incident: what happened, impact, cause, resolution, follow-ups. Bugs and follow-up work are tracked as GitHub
issues ([incident label](https://github.com/Bigocb/stcommand/issues?q=label%3Aincident), [bugs](https://github.com/Bigocb/stcommand/issues?q=is%3Aopen+label%3Abug)); each incident issue links its report
and its follow-ups are sub-issues. Write a new report when something costs real money or hours, and open the issue with it.

## Week of 2026-11-15 (agent THEO)

| # | Incident | When (UTC) | Severity | Status | Issue | Follow-ups |
|---|---|---|---|---|---|---|
| [INC-01](INC-01-engine-stall.md) | Engine stall, trading stopped ~1.5 h | 11-16 23:10 to 11-17 00:46 | High | Mitigated | [#32](https://github.com/Bigocb/stcommand/issues/32) | [#41](https://github.com/Bigocb/stcommand/issues/41) watchdog |
| [INC-02](INC-02-keeper-queue-starvation.md) | Keeper queue starved systems; Approve did nothing | 11-17 | Medium | Fixed | [#33](https://github.com/Bigocb/stcommand/issues/33) (closed) | |
| [INC-03](INC-03-tour-ships-stopped.md) | Tour ships stopped touring; releases stopped | 11-17 13:44 to 11-18 00:35 | High | Fixed | [#34](https://github.com/Bigocb/stcommand/issues/34) | [#42](https://github.com/Bigocb/stcommand/issues/42) log wording |
| [INC-04](INC-04-jump-fees-overnight.md) | Jump fees above profit overnight | 11-18 00:00 to 02:55 | High | Mitigated (see INC-05) | [#35](https://github.com/Bigocb/stcommand/issues/35) (closed) | |
| [INC-05](INC-05-self-claim-jump-bleed.md) | Self-claim and discovery zigzags, -2.65M jump fees | 11-18 05:17 to 11:45 | Critical | Fixed | [#36](https://github.com/Bigocb/stcommand/issues/36) | [#43](https://github.com/Bigocb/stcommand/issues/43) jump-fee brake |
| [INC-06](INC-06-cash-floor-empties-routes.md) | Route list emptied below the cash floor | 11-18 ~10:00 to 14:45 | High | Fixed | [#37](https://github.com/Bigocb/stcommand/issues/37) (closed) | |
| [INC-07](INC-07-fleet-idle-no-spread.md) | Every trader unassigned: no local spread, positioning test | 11-18 14:45, ongoing | High | Open | [#38](https://github.com/Bigocb/stcommand/issues/38) | [#44](https://github.com/Bigocb/stcommand/issues/44) positioning test, [#45](https://github.com/Bigocb/stcommand/issues/45) debug line |
| [INC-08](INC-08-dispatch-tour-race.md) | dispatch_tour toured the ship's own system first | 11-18 15:47 | Low | Open | [#39](https://github.com/Bigocb/stcommand/issues/39) | [#46](https://github.com/Bigocb/stcommand/issues/46) |
| [INC-09](INC-09-big-hulls-thin-wallet.md) | Two heavy freighters bought on a thin wallet (decision) | 11-17 19:24, 22:11 | High | Lesson recorded | [#40](https://github.com/Bigocb/stcommand/issues/40) (closed) | |

Other open bugs from the week: [#47](https://github.com/Bigocb/stcommand/issues/47) keeper count jumps, [#48](https://github.com/Bigocb/stcommand/issues/48) dashboard buy "Load failed".
