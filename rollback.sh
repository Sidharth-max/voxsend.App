#!/bin/bash
# voxsend rollback: PostgreSQL app -> the SQLite app saved by cutover.sh <STAMP>.
#
#   bash /workspace/voxsend-dev/rollback.sh <STAMP> [--export-pg] [--yes] [--force]
#     --export-pg  carry Postgres changes made since the cutover back into SQLite (contacts,
#                  schedules, history, ...) via scripts/export-pg-to-sqlite.js; without it the
#                  SQLite snapshot taken at cutover is restored as it was
#     --force      allow during 10:00-12:30 / 17:00-19:30 IST or while a broadcast runs (emergencies only)
#     --auto       used by cutover.sh when it fails (implies --force, no export: nothing changed yet)
# Postgres data is left in place (and dumped to the backup dir) for a later retry.
set -Eeuo pipefail
DEV=${VOXSEND_DEV:-/workspace/voxsend-dev}
. "$DEV/ops/lib-cutover.sh"
STAMP=${1:-}; shift || true
EXPORT=0; YES=0; FORCE=0; AUTO=0
while [[ $# -gt 0 ]]; do case "$1" in
  --export-pg) EXPORT=1 ;; --yes) YES=1 ;; --force) FORCE=1 ;; --auto) AUTO=1; FORCE=1 ;; *) die "unknown option $1" ;; esac; shift; done
[[ -n $STAMP ]] || die "usage: rollback.sh <STAMP> [--export-pg] [--yes] [--force]"
BK=$BKROOT/$STAMP
OLD=$APP.sqlite-$STAMP
[[ -d $BK ]] || die "no backup dir $BK"
SWAPPED=1
if [[ ! -d $OLD ]]; then
  # The cutover failed before the code swap: the SQLite app is still in place, untouched.
  grep -q "better-sqlite3" "$APP/server.js" 2>/dev/null || die "old app dir $OLD missing and $APP is not the SQLite app"
  SWAPPED=0
else
  [[ -f $BK/voxsend.db && -f $BK/env-files.vault ]] || die "backup $BK incomplete"
  [[ -r $KEYFILE ]] || die "master key $KEYFILE missing: the old .env is encrypted with it"
  node "$DEV/ops/envvault.js" list --key "$KEYFILE" --in "$BK/env-files.vault" >/dev/null || die "cannot open $BK/env-files.vault"
fi
(( FORCE )) || check_window
exec > >(tee -a "$BK/rollback.log") 2>&1
say "rollback of cutover $STAMP (export-pg=$EXPORT auto=$AUTO)"

# Is the running app the Postgres one? (After a failed cutover it may be either, or none.)
PGAPP=0; grep -q "lib/db" "$APP/server.js" 2>/dev/null && PGAPP=1
if (( PGAPP )) && ! (( FORCE )); then
  st=$(curl -fsS -m 5 -H 'Accept: application/json' http://127.0.0.1:$PORT/api/health >/dev/null 2>&1 && \
       with_env "$APP" node cli/voxsend.js broadcasts list --status running --json 2>/dev/null || echo '[]')
  echo "$st" | grep -q '"status": "running"' && die "a broadcast is running (use --force only in an emergency)"
fi
(( YES )) || { read -r -p "Stop prod and restore the SQLite app from $STAMP? [y/N] " a; [[ $a == y ]] || die "cancelled"; }

stop_prod

if (( ! SWAPPED )); then
  say "code was never swapped: restarting the untouched SQLite app"
  start_prod || die "SQLite app did not come up: check $LOG/server.log"
  say "ROLLBACK DONE (nothing to restore)."; exit 0
fi
DBSRC=$BK/voxsend.db
if (( PGAPP )); then
  pg_dump -h /workspace/pg/run -d $PGDB -n $PGSCHEMA_T -Fc -f "$BK/pg-at-rollback-$(date +%H%M%S).dump" || say "WARN: pg_dump failed"
  if (( EXPORT )); then
    say "exporting Postgres data into SQLite"
    OUT=$BK/voxsend-from-pg-$(date +%H%M%S).db
    with_env "$APP" node scripts/export-pg-to-sqlite.js --base "$BK/voxsend.db" --out "$OUT"
    DBSRC=$OUT
  fi
fi

say "restoring code dirs"
if [[ -e $APP ]]; then mv "$APP" "$APP.pg-rolledback-$STAMP-$(date +%H%M%S)"; fi
mv "$OLD" "$APP"
rm -f "$APP/.env"                                                  # the no-secrets stub left by cutover
node "$DEV/ops/envvault.js" unseal --key "$KEYFILE" --in "$BK/env-files.vault" --dir "$APP"   # .env (+ .env.*), mode 600
rm -f "$APP"/voxsend.db "$APP"/voxsend.db-wal "$APP"/voxsend.db-shm
cp -p "$DBSRC" "$APP/voxsend.db"
[[ -f $BK/start.sh.sqlite ]] && install -m 755 "$BK/start.sh.sqlite" "$TUN/start.sh"

say "starting the SQLite app under the supervisor"
start_prod || die "SQLite app did not come up: check $LOG/server.log"
NODE_PATH=$APP/node_modules node -e "const D=require('better-sqlite3');const d=new D('$APP/voxsend.db',{readonly:true});console.log('pending rows:',JSON.stringify(d.prepare(\"SELECT id, run_at, status FROM scheduled_calls WHERE status IN ('pending','starting','started') ORDER BY run_at\").all()));d.close()"
say "ROLLBACK DONE. Postgres data kept (dumps in $BK)."
