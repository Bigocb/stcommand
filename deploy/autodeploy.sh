#!/usr/bin/env bash
# stcommand auto-deploy: pull origin/main, rebuild if it moved, restart the container.
#
# Guarded so a no-op run is cheap and never restarts a running engine:
#   - only acts when local HEAD != origin/main
#   - npm ci only when package-lock.json/package.json changed (it rebuilds via postinstall)
#   - otherwise just `npm run build`
#   - restarts only after a successful build
# Intended to be run from cron (see crontab) under the `bigocb` user.
set -euo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
REPO=/home/bigocb/dev/stcommand
DEPLOY_DIR=/home/bigocb/media-stack/configs/stcommand
LOG=$DEPLOY_DIR/autodeploy.log
COMPOSE=$DEPLOY_DIR/docker-compose.yml
DOCKER=/usr/bin/docker

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cd "$REPO"

# Never fight a dirty tree (someone editing the checkout) — skip and log.
if [ -n "$(git status --porcelain)" ]; then
  echo "$(ts) skip: working tree dirty" >> "$LOG"; exit 0
fi

git fetch --quiet origin main || { echo "$(ts) fetch failed" >> "$LOG"; exit 1; }
PREV=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$PREV" = "$REMOTE" ] && exit 0

echo "$(ts) deploying $PREV -> $REMOTE" >> "$LOG"
git pull --ff-only --quiet origin main

if git diff --name-only "$PREV" "$REMOTE" | grep -qE '^package(-lock)?\.json$'; then
  npm ci >>"$LOG" 2>&1
else
  npm run build >>"$LOG" 2>&1
fi

$DOCKER compose -f "$COMPOSE" up -d --force-recreate stcommand >>"$LOG" 2>&1
echo "$(ts) deployed -> $REMOTE, container restarted" >> "$LOG"
