# Builder prompt (hand this to the implementing agent)

You are building `starengine`: an autonomous, no-LLM trading engine for the SpaceTraders API (v2), in the
repository https://github.com/Bigocb/starengine. The plan is already written: read `docs/plan/README.md`,
then `docs/plan/05-milestones-and-build-order.md`, then the other files in the order the README gives.
Work on a branch (for example `feat/m0-scaffolding`), never on `main`, and open a pull request for each milestone.

## What to build first
1. Milestone M0 as far as it can go WITHOUT the real game: repo scaffolding (file 01), the pure core and its
   interfaces (file 02), the API client and the hard per-minute request budget (file 03), the decision engine
   modules (file 04), and the tests and fake API server (file 06). Use a fake API server and recorded or
   hand-written market data. Every module returns a one-line reason for each decision.
2. Stop at the M0 smoke test that needs the real API. Do not call api.spacetraders.io until the operator gives you
   a token and a proxy (see "Stop points").

## Rules
- TypeScript on Node 22 with SQLite (better-sqlite3), as the plan decided. `src/core` must stay pure (no I/O, no clock,
  no globals); a lint rule and a test enforce it.
- The request budget is a first-class feature: a hard calls-per-minute cap below the token bucket (60 a minute in shadow,
  105 live), 429 back-off, and weekly reset detection. The game's limit is per source IP (2 requests a second, burst 30).
- It will run on the same machine as another live fleet, under its own OS user, process and database, with a free-disk
  watchdog and CPU/memory limits. It must never read or write the other system's database or files.
- It will use its own proxy IP. Refuse to start if the IP-echo check shows the machine's own address.
- Secrets (the SpaceTraders token, proxy credentials) are environment variables only. Never commit them, never log
  them, never put them in a test fixture. `.gitignore` already excludes env files.
- Hull purchases are off by default, and enabled only inside an operator-opened window (`purchase.enabledUntil`, at most 24 h).
- Mark anything about the game API you cannot verify as an open question; verify shapes in M0 task M0-3 against the real API
  when you have access. Do not invent game facts.

## Stop points (ask the operator before going past them)
- Before the first real API call: you need the operator's token and proxy. Ask; do not guess or reuse any token you find.
- Before any purchase or trade call on the real game.
- Before merging a milestone PR.

## Operator answers (2026-11-14, already decided)
Separate source IP via a Webshare proxy; same box as the live fleet; go straight to trading (M0 is a short smoke test);
trade live in a universe where the other fleet also plays; live from a later reset (target the 2026-11-22 13:00 UTC reset
unless told otherwise). Open questions and their defaults are in `docs/plan/08-go-live-and-safety.md`, section 6.

## What to report after each milestone
The files changed, test results (counts and any failures), what you could not verify, and the questions you need answered.
