# Artifacts MMO: project plan (PM: Claude)

Goal (operator, 2026-10-16): (1) maximize season progress with a bot, (2) build a visual game around it. Early days: free account first.
Facts: docs.artifactsmmo.com; OpenAPI spec v8.2.4 in `data/openapi.json` (source: https://api.artifactsmmo.com/openapi.json); public game data is in `data/*.json` (run `npm run fetch-data`).
Constraints: 5 characters; actions are cooldown timers (HTTP 499 when early); buckets account 10/s 300/h, data 10/s 200/min 2000/h, action 10/s 100/min 5000/h (per IP); no account yet, so everything below is built and tested offline.

## House rules (from stcommand CLAUDE.md, adapted)
- New logic = small self-contained pure modules: no I/O, no clock, no globals; clock and data are arguments. Policy is data. One-line reason for each decision. Tested in isolation.
- Only `node:*` built-ins plus `tsx` (resolved from the parent repo's node_modules). No new dependencies.
- TypeScript strict. `npm test` and `npm run typecheck` (run inside artifacts-mmo/) must pass before you report done.
- Stay inside your own directories (ownership below). Do not edit another workstream's files; if you need a change, say so in your report.
- Do NOT touch anything outside artifacts-mmo/. Do NOT git commit or push (PM commits).
- Never put a token in a file. Reading `ARTIFACTS_TOKEN` from env is the only allowed pattern.

## Workstreams (phase 1, parallel)
| ID | Owner dir | Deliverable |
|----|-----------|-------------|
| A api | src/api/, tests/api*.test.ts | typed client, rate limiter (3 buckets, injectable clock), cooldown tracker, error-code table, retry rules |
| B sim | src/sim/, tests/sim*.test.ts | combat simulator, XP formula, cooldown math, win-rate/xp-per-hour picker |
| C world | src/world/, tests/world*.test.ts | data loader, map index, content finder, route planner (A* over tiles + transitions + access conditions) |
| D web | web/ | static visual map viewer (canvas) driven by data/*.json; no build step; local server script |

## Phase 2 (after phase 1 review)
E planner: per-character task scheduler (goal: skill/XP/gold per hour) built on A+B+C. F economy: Grand Exchange price history, crafting-chain profitability. G live: wire D to live character state (poll + websocket later).

## Definition of done per workstream
Report: files created, public API (signatures), tests run + result, what was verified against real data, known gaps. Keep the report under 300 words.

## Status log
- 2026-10-16 phase 1 done and PM-verified (46 tests, typecheck clean, viewer screenshots reviewed at 1280 and 390 px). Committed on the feature branch only.
- Open assumptions to confirm with a real account: base HP 120+5/level (B); 4-neighbour movement, no diagonals (C); move cooldown = rounded Euclidean tiles, min 1 (A); XP penalty direction = player level minus monster level (B).

## Phase 2 (running)
- E planner (src/planner/): pure per-character scheduler built on A+B+C: given character state + goal policy, returns the next action with a one-line reason and the predicted cooldown; covers fight-for-XP, gather, craft-to-level, bank trips, rest, task loop.
- F economy (src/economy/): pure crafting/GE profitability from items.json, npc_items.json and a price snapshot passed in; plus a fetcher for public GE orders/history.
Phase 3 (needs account token via env): G live wiring (poll /my/characters into the viewer, WebSocket later), H run loop with dry-run mode.
