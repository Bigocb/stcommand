# Dominion API balance simulation

A small, self-contained simulation that tests the balance rules of the "Dominion API" game pitch. It has no
connection to the rest of this repository: no database, no network, no new dependencies.

## Running it

From the repository root:

```sh
node --import tsx sim/dominion/run.ts                 # 200 seasons + sweeps, writes sim/dominion/report.md (about 3 minutes)
node --import tsx sim/dominion/run.ts --seasons 60 --sweep 40   # a quicker, noisier run
node --import tsx --test sim/dominion/rules.test.ts   # the tests
```

Options: `--seasons N` (main run, default 200), `--sweep N` (seasons per swept value, default half of N, at least 40),
`--out path` (report file). Everything is seeded, so the same command always gives the same report.

## Files

- `rules.ts`: the rules engine. `DEFAULT_CONFIG` holds every tunable number, with a comment on each.
  `generateMap` builds the map, `newGame` places the players, `step(state, actions)` resolves one tick and returns a
  new state (it never changes its input). `makeView` builds the stale view a bot sees.
- `bots.ts`: the four strategy bots.
- `run.ts`: the season runner, the statistics and the report.
- `rules.test.ts`: determinism, upkeep, the square-root bandwidth curve, stripping decay.
- `report.md`: the last generated report.

## The model in plain words

**The map.** 40 to 80 worlds in four rings: core, inner, outer and edge. Each ring is cut into sectors (1, 3, 4
and 5 of them). Core worlds yield the most (about 5 per tick) and cost the most to claim; edge worlds yield less
(about 2) but carry an extra edge-only resource (+1.2) and are cheap. Each world is linked by lanes to its two or three
nearest neighbours, and the map is always connected. There are ten fixed map seeds.

**A season** is 168 ticks (an hour each, so a week). Four players, one per strategy, start with 60 resources on a
home world in a random ring. In 40% of seasons one player joins late, 20-30% into the season, at the edge. The winner
is the player with the most resources banked at the end. Everything resets for the next season.

**Each tick:**
1. Players due to join take their home world.
2. Each player's actions run in order until its bandwidth is used up. Players' lists are interleaved in a random order,
   so two claims on the same world are settled fairly. An action that turns out to be invalid on the real state (the
   bot's view was stale) still uses its bandwidth, like a failed API call.
3. Every held world produces its yield, reduced by unrest, raised by held lanes and by any charting premium.
4. Upkeep is paid for every world, lane and garrison unit. Worlds next to another player's world are contested and
   cost more. A player whose bank goes below zero carries the debt, and all its worlds gain unrest until it is repaid.
5. The leader (the player with the most "power": bank plus 24 ticks of current yield) may suffer a hostile event.
6. Unrest moves, and any world at 100 unrest revolts and becomes unowned.

**Command bandwidth** is the number of actions a player can take per tick:
`base + k * holdings^exponent - upkeepBw * holdings`, never below a floor. With the exponent at 0.5, doubling an empire
gives about 41% more on the growth term. Each world also costs bandwidth, so at the defaults net actions peak at about
5 per tick with 4-5 worlds and fall back to the floor of 2 at about 23 worlds. A bigger empire trades actions for
yield, which is what caps the scorcher at about 20 worlds.

**Actions** (bandwidth cost in brackets):
- `claim` (1): take an unowned world next to one of yours. Cost depends on the ring and is up to 40% cheaper in
  sparsely held sectors. A player with no worlds left may restart on any free edge world.
- `attack` (2): try to take a neighbouring enemy world. Win chance falls with the garrison. If the defender loses and
  scorched earth is on, the defender strips the world on the way out, keeping part of the burst.
- `strip` (1): take 8 ticks of the world's yield at once, cut its yield by 20% for the rest of the season, and add
  unrest (more with a thin garrison).
- `terraform` (1): pay 30 to raise the world's yield by 0.6 for the rest of the season, up to 3x its base yield.
- `garrison` (1): pay 8 for a garrison unit, which calms unrest and defends against attacks and raids.
- `chart` (1): chart a sector within two hops. The first charter gets a one-off reward (bigger at the edge) and a
  1.7x output premium on its worlds there that fades over 36 ticks and is divided down as other players move in.
- `raid` (1): hit an enemy world within two hops. On success it takes half the world's output since its last raid (up
  to 8 ticks) plus 1% of the owner's bank. The owner can be pushed into debt.
- `raidLane` (1): cut an enemy-held lane for 6 ticks and take a share of both ends' output.
- `abandon` (free): let a world go.

**Stale intel.** A bot sees its own worlds as they are now, and everyone else's worlds and banks as they were three
ticks ago. Charts are public and current.

## The bots

They are about the level of a first-week player script: a priority list, no lookahead, no cooperation.

- **Scorcher**: claims and attacks neighbours for yield, strips conquered worlds and its own rich ones, garrisons only
  when a world is close to revolt, and abandons stripped-out worlds when it hits its bandwidth limit.
- **Terraformer**: claims good worlds nearby, garrisons by how rich a world is, and terraforms its best worlds as long
  as the investment still pays back before the season ends.
- **Prospector**: charts every sector it can reach (uncharted and outer ones first) and claims outward, favouring the
  edge, empty sectors and sectors it charted first.
- **Raider**: keeps a small, garrisoned base, raids the richest worlds and lanes in range (preferring the leader), and
  claims worlds that bring it closer to other players.

## The knobs that matter most

All are in `DEFAULT_CONFIG` in `rules.ts`.

| knob | default | what it does |
|---|---|---|
| `bandwidthExponent` | 0.5 | How much bigger empires gain in actions. 1.0 is linear growth, 0.5 the square root. |
| `bandwidthBase`, `bandwidthK` | 3, 1.5 | The flat budget everyone gets, and the scale of the growth term. |
| `bandwidthFloor` | 2 | Nobody drops below this many actions per tick (the newcomer floor). |
| `upkeepBw`, `upkeepRes` | 0.35, 1.0 | Bandwidth and resources each held world costs per tick. |
| `contestedMult` | 1.8 | Upkeep multiplier on a world bordering another player. |
| `sparseDiscount` | 0.4 | How much cheaper claims and charting are in empty sectors (the edge advantage). |
| `leaderWeight` | 1 | Pressure on the leader: hostile event rate (12% per tick per point) and bots' raid preference. |
| `stripBurst`, `stripDecay` | 8, 0.2 | The size of a strip's payout and how much yield it destroys. |
| `occupationUnrest`, `garrisonCalm` | 2, 0.6 | How fast conquered worlds riot, and how much a garrison unit calms them. |
| `terraformCost`, `terraformStep`, `terraformCap` | 30, 0.6, 3 | Price, gain per action and ceiling of terraforming. |
| `raidShare`, `raidBankShare`, `raidRange` | 0.5, 0.01, 2 | How much a raid takes, and how far raiders reach. |
| `firstChartPremium`, `premiumHours` | 1.7, 36 | The first charter's premium and how long it lasts. |
| `lateJoinGrant` | 0 | Extra resources for a late joiner per tick of lateness. Off by default; the report tests it. |
| `intelDelay` | 3 | Ticks of delay on what bots see of others. |

## How to read the report

The report answers the pitch's two questions with numbers: does one strategy always win (win rates overall, by map
and by start ring), and does the early leader stay ahead (how often the leader at 25% and 50% of the season wins). It
also shows how late starters finish, a sweep of the key knobs, and, when one strategy wins more than 40% of seasons,
the knob changes aimed at that strategy and a full run with the best one. A last section combines the best changes.

The bots are simple, so a result is a statement about these rules played by these scripts. A strategy that does badly
may only be badly played.
