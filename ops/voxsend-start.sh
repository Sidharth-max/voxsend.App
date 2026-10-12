#!/bin/bash
# call.s-lab.dev -> voxsend on 127.0.0.1:3000 (PostgreSQL version). Safe to re-run.
# Installed by cutover.sh as /workspace/voxsend-tunnel/start.sh (the SQLite version is backed up).
# Rebuilds node_modules after a container wipe, waits for Postgres, keeps the supervisor.
set -euo pipefail
DIR=/workspace/voxsend-tunnel
APP=/home/box/voxsend.App
LOG=$DIR/logs
mkdir -p "$LOG"
CFBIN=/workspace/bin/cloudflared

[[ -f "$APP/package.json" ]] || { echo "ERROR: voxsend app missing at $APP" >&2; exit 1; }
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { echo "ERROR: node or npm missing; bootstrap apt step should install them" >&2; exit 1; }

# A wiped node_modules (or missing native addon) means a clean install from the lockfile.
if [[ ! -d "$APP/node_modules/pg" || ! -d "$APP/node_modules/express" || ! -d "$APP/node_modules/better-sqlite3" ]]; then
  echo "==> npm ci voxsend dependencies"
  (cd "$APP" && npm ci --omit=dev)
else
  echo "voxsend dependencies already installed"
fi

# CLI on PATH (durable /workspace/bin).
mkdir -p /workspace/bin
ln -sfn "$APP/bin/voxsend" /workspace/bin/voxsend

if [[ -f $LOG/cloudflared.pid ]] && kill -0 "$(cat $LOG/cloudflared.pid)" 2>/dev/null; then
  echo "cloudflared already pid=$(cat $LOG/cloudflared.pid)"
else
  rm -f "$LOG/cloudflared.pid"
  nohup "$CFBIN" tunnel --config "$DIR/config.yml" --no-autoupdate run >>"$LOG/cloudflared.log" 2>&1 &
  echo $! > "$LOG/cloudflared.pid"
  echo "started cloudflared pid=$(cat $LOG/cloudflared.pid)"
fi

# The app needs Postgres: do not start it (it would only crash-loop) until Postgres answers.
PGREADY=/usr/lib/postgresql/$(cat /workspace/pgdata/PG_VERSION 2>/dev/null || echo 17)/bin/pg_isready
pg_ok() { [[ -x $PGREADY ]] && "$PGREADY" -q -h 127.0.0.1 -p 5432 -d voxsend; }
if ! pg_ok; then
  [[ -x /workspace/pg/start.sh ]] && bash /workspace/pg/start.sh || true
  for _ in $(seq 1 30); do pg_ok && break; sleep 1; done
fi
pg_ok || { echo "ERROR: postgres not ready on 127.0.0.1:5432; voxsend not started (see /workspace/pg/logs/postgres.log)" >&2; exit 1; }

if [[ -f $LOG/supervisor.pid ]] && kill -0 "$(cat $LOG/supervisor.pid)" 2>/dev/null; then
  echo "voxsend supervisor already pid=$(cat $LOG/supervisor.pid)"
elif ss -ltn 2>/dev/null | grep -q ':3000 '; then
  echo "voxsend already on :3000 (unsupervised)"
else
  nohup setsid "$DIR/run-server.sh" >/dev/null 2>&1 < /dev/null &
  sleep 3
  echo "started voxsend supervisor pid=$(cat $LOG/supervisor.pid 2>/dev/null)"
fi
