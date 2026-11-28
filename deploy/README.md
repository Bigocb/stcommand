# How stcommand is deployed on the Lennox box

This is the **actual** deployment as of 2026-11-28, copied from the box. It is
here so design work (notably #89, splitting the engine into processes) can see
what exists rather than inferring it. The older `docs/lennox-migration.md` is
still the runbook for the first cutover, but its systemd section is not what is
running now.

## TL;DR for #89

- **There is no application image.** The compose file runs the stock
  `node:22-bookworm-slim` image and bind-mounts the checkout at `/app`. The
  build happens **on the host** (`npm ci` → postinstall `npm run build`); the
  container only executes `node scripts/start.mjs`.
- **Two services, both `network_mode: host`:**
  - `stcommand` — the engine + Express + MCP, listens on `0.0.0.0:3002`.
  - `stcommand-db` — `postgres:16-alpine`, listens on `127.0.0.1:5432` only.
- **Health checks:** the app runs `fetch('http://127.0.0.1:3002/healthz')`
  (the endpoint returns the text `ok`); Postgres runs `pg_isready`.
- **Deploy loop:** a cron every five minutes runs `autodeploy.sh`: skip on a
  dirty tree, `git pull --ff-only`, `npm ci` when package files changed (else
  `npm run build`), then `docker compose up -d --force-recreate stcommand`.
  **Every commit on `main` restarts the app**, even docs-only commits.
- **Public routing:** Cloudflare tunnel → Traefik `:8088` → `http://172.19.0.1:3002`
  (the host-network app reached through the Docker bridge gateway).
- **Database:** one database, schema `stcommand`, RLS keyed on
  `app.tenant_id`. The app must connect as an ordinary role, never a superuser
  (see `docs/lennox-migration.md`).
- **Runtime flag:** `NODE_OPTIONS=--max-old-space-size=8192` was added on
  2026-11-27 after a 4 GB V8 heap OOM; it is a headroom stopgap, not a fix.

## Topology

```
Cloudflare tunnel (cloudflared, host network, :8088)
        │  traders.cloutier.work
        ▼
Traefik (container, :8088)
        │  Host(`traders.cloutier.work`) → stcommand-svc
        ▼
http://172.19.0.1:3002          (bridge gateway → host network)
        │
┌───────┴──────────────────────────────────────────────┐
│ host network                                         │
│  stcommand (node:22-bookworm-slim) 0.0.0.0:3002      │
│  stcommand-db (postgres:16-alpine) 127.0.0.1:5432    │
└──────────────────────────────────────────────────────┘

The repo is bind-mounted, not copied:
  /home/bigocb/dev/stcommand  →  /app
  pgdata                     →  /pgdata
```

## Files on the box

| Path | Role |
|---|---|
| `/home/bigocb/media-stack/configs/stcommand/docker-compose.yml` | the compose file below |
| `/home/bigocb/media-stack/configs/stcommand/stcommand.env` | app environment, mode `600` |
| `/home/bigocb/media-stack/configs/stcommand/.env` | just `PG_SUPER_PASSWORD` for compose interpolation |
| `/home/bigocb/media-stack/configs/stcommand/autodeploy.sh` | the five-minute deploy loop |
| `/home/bigocb/media-stack/configs/stcommand/pgdata/` | Postgres data directory |
| `/home/bigocb/dev/stcommand` | the checkout the container runs from |
| `/home/bigocb/media-stack/observability/traefik-dynamic.yml` | `traders` router + `stcommand-svc` |
| `/home/bigocb/media-stack/cloudflared/config.yml` | `traders.cloutier.work` → `localhost:8088` |

## Build and start

`scripts/start.mjs` imports `dist/cli/index.js` in the same process. If `dist/`
is missing it falls back to `tsx` and uses roughly 2.5× the memory, logging
that it did so. That fallback is why the host build matters.

```sh
# on the host (autodeploy does both, then recreates the container)
cd /home/bigocb/dev/stcommand
npm ci                 # runs the postinstall build
npm run build          # tsc -p tsconfig.build.json (when deps unchanged)

docker compose -f /home/bigocb/media-stack/configs/stcommand/docker-compose.yml \
  up -d --force-recreate stcommand
```

## Environment (names only — never values)

`stcommand.env`, mode `600`, loaded with `env_file:`. Nineteen keys:

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Postgres DSN. `localhost`/`127.0.0.1` disables TLS in `src/db/pool.ts`. |
| `PORT` | HTTP/MCP port (`3002` on the box). |
| `NODE_ENV` | `production`. |
| `NODE_OPTIONS` | `--max-old-space-size=8192` (2026-11-27 stopgap). |
| `SESSION_SECRET` | dashboard session signing. |
| `ADMIN_KEY` | admin API key. |
| `ST_ACCOUNT_TOKEN` | SpaceTraders account token. |
| `OPERATOR_AGENTS` | operator allow-list. |
| `AUTO_RESET_RECOVERY` | behaviour around the weekly universe reset. |
| `API_BURST` | API token bucket burst. |
| `API_LANE_PROXY_URLS` | proxy lanes for API calls. |
| `API_LANE_PROXY_RATE` | per-lane request rate. |
| `CRAWLER_PROXY_URL` | crawler proxy. |
| `CRAWLER_PROXY_RATE` | crawler rate. |
| `TRADE_LANE_AVOID` | routes to avoid for trades. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | web-push identity. |

`deploy/stcommand.env.example` lists the same keys with placeholders.

## Health checks in detail

| Service | Test | Interval / timeout / retries / start period |
|---|---|---|
| `stcommand` | `node -e "fetch('http://127.0.0.1:3002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` | 15s / 5s / 6 / 20s |
| `stcommand-db` | `pg_isready -h 127.0.0.1 -U postgres` | 10s / 5s / 12 / — |

`/healthz` is registered in `src/cli/index.ts` and returns `200 text/plain "ok"`.
It is a liveness check only: it does not touch the database or the engine.

## Notes for a multi-process split (#89)

1. **There is no image to tag per process today.** Today's "image" is upstream
   Node plus a bind mount. A split needs either a Dockerfile with a build stage
   (preferred) or a pinned image + a host-built `dist/` shared into each
   container.
2. **Host networking means fixed ports.** Each process needs its own port and
   its own healthcheck; two services cannot both bind `3002`.
3. **The database is the only shared state.** Dispatcher memory is per process;
   #70's copy-the-world approach hit a 3 GB heap. A route-builder process needs
   a request/response boundary, not a copied world.
4. **Supervision is `restart: unless-stopped`.** There is no queue, supervisor
   or orchestration beyond compose: a crash restarts that one service only.
5. **Every `main` commit restarts the app** through autodeploy, including docs.
   A split should either keep that cadence or teach `autodeploy.sh` to skip
   when only docs changed.
6. **Memory headroom is 8 GB, not solved.** The 4 GB OOM on 2026-11-27 is the
   reason for the flag; any new process needs its own ceiling and a heap
   measurement.

## Files in this directory

| File | Source |
|---|---|
| `docker-compose.yml` | the box's compose file, verbatim except secrets are interpolation |
| `stcommand.env.example` | the env key inventory, no values |
| `autodeploy.sh` | the box's deploy script |
| `traefik.traders.yml` | the `traders` router + service from `traefik-dynamic.yml` |
