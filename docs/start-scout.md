# Start scout: pick the week's starting system

The home system you are given decides how hard the gate is. THEO (2026-10-25, X1-BT10) had **one** FAB_MATS producer; buying past its
refill rate sent the ask from 1,200 to 13,500 within a day. The operator's best week (X1-YM69, 34 h) had a second source one gate away,
and players in the community Discord who finish in under 18 hours say they nearly always have two sources at home.

You can register more than one agent on an account. Market import and export lists are public without a ship, so right after
registering you can read the home system and score it, then keep the best agent and drop the rest.

## Run it

```
npm run scout:starts -- --count 5 --prefix SCOUT --faction COSMIC          # dry run: prints the plan, registers nothing
npm run scout:starts -- --count 5 --prefix SCOUT --faction COSMIC --yes    # registers and ranks
```

- Needs `ST_ACCOUNT_TOKEN`. Count is 1 to 10; the prefix is 1 to 9 letters or digits; each symbol gets a random suffix (3 to 14 characters).
- Registrations are paced 1.5 s apart. One that fails (name taken, rate limit) is reported and the rest carry on.
- The console shows rank, agent, system, score, FAB_MATS sources, circuitry sources and market count with the reasons. It never prints a token.
- Full results **with agent tokens** go to `.local/scout-starts-<time>.json` (mode 0600, git-ignored). Treat that file as a secret.

## What the score means (`src/engine/startScore.ts`, policy in `DEFAULT_START_POLICY`)

| Factor | Points |
|---|---|
| Each FAB_MATS source beyond the first (exports or exchange) | +150 |
| No FAB_MATS source at home | -200 |
| An ADVANCED_CIRCUITRY producer at home / none | +40 / -100 |
| Each of IRON, QUARTZ_SAND, ELECTRONICS, MICROPROCESSORS sold somewhere at home / missing | +12 / -30 |
| Markets (2 each, cap 40), distinct goods (0.5 each, cap 30) | small |

It scores what lists show, not prices or supply (those need a ship at the market). A second FAB_MATS source in a neighbouring system
is not seen until the gate is open; the score only counts the home system.

## After picking one

Log in to Tower with the winner's agent token (from the JSON file) and go through standing orders as usual. The agents you do not
keep stay registered but idle; they are not tenants on the box unless you sign in to them.
