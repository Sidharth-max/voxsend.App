#!/bin/bash
# voxsend cutover: SQLite app -> PostgreSQL app, in place at /home/box/voxsend.App.
#
#   bash /workspace/voxsend-dev/cutover.sh --check        # preflight only, changes nothing
#   bash /workspace/voxsend-dev/cutover.sh --go           # do it
#   options: --expect-pending 2,3,4,14,15,16   ids that must be pending in SQLite and Postgres (default:
#                                     the Oct 8-10 runs of both daily groups, 10:30 and 17:30 IST)
#            --expect-groups 0a207f15-...,91325022-...   schedule groups that must match exactly (default: both)
#            --expect-history-date 2026-10-07  --expect-history-count 2   both Oct 7 runs must be in history
#            --due-margin 30          refuse if a scheduled run is due within N minutes (default 30)
#
# Guards: refuses 10:00-12:30 and 17:00-19:30 IST, while a broadcast runs, if any schedule row is starting/started,
# if a run is due within 30 min (or overdue), if Postgres is down, if the dev tree is not committed.
# Steps (--go): stage new code from the committed dev tree (npm ci) -> stop supervisor + node and
# hold the supervisor lock -> snapshot SQLite AFTER the stop -> back up db/code/start.sh/pg, and the
# old .env file(s) ENCRYPTED with the master key (env-files.vault, 600; no plaintext copy) -> swap
# code dirs -> migrate with --import-env (every .env key into the DB, verified by decrypting and
# comparing SHA-256 inside the migration transaction) -> explicit SQL + group + .env verification ->
# delete the plaintext .env from the old app and neuter it (voxsend.db moved aside) -> enable the
# scheduler in settings -> install the Postgres start.sh -> start under the same supervisor -> checks.
# The new .env holds only DATABASE_URL (with ?schema=), VOXSEND_MASTER_KEY_FILE and PORT.
# Any failure after the stop runs rollback.sh automatically (it restores .env from the vault).
set -Eeuo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DEV=${VOXSEND_DEV:-/workspace/voxsend-dev}
. "$DEV/ops/lib-cutover.sh"

MODE=""; EXPECT_PENDING="2,3,4,14,15,16"; HIST_DATE="2026-10-07"; HIST_COUNT=2; MARGIN=30
EXPECT_GROUPS="0a207f15-bbc0-4970-8f1e-cc1a78b67a89,91325022-88d1-4915-9466-4390241d816e"
while [[ $# -gt 0 ]]; do case "$1" in
  --check) MODE=check ;; --go) MODE=go ;;
  --expect-pending) EXPECT_PENDING=$2; shift ;; --expect-history-date) HIST_DATE=$2; shift ;;
  --expect-history-count) HIST_COUNT=$2; shift ;; --expect-groups) EXPECT_GROUPS=$2; shift ;;
  --due-margin) MARGIN=$2; shift ;; *) die "unknown option $1" ;; esac; shift; done
[[ -n $MODE ]] || die "use --check or --go"

STAMP=$(TZ=Asia/Kolkata date +%Y%m%d-%H%M%S)
BK=$BKROOT/$STAMP
OLD=$APP.sqlite-$STAMP
NEW=$APP.new-$STAMP
SQLITE_NODE_MODULES=$DEV/node_modules   # better-sqlite3 for the read-only preflight

# ---------------------------------------------------------------- preflight (read-only)
sqlite_q() {  # sqlite_q <db> <js expression using d>  (read-only)
  NODE_PATH=$SQLITE_NODE_MODULES node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true,fileMustExist:true});const r=(()=>{$2})();d.close();console.log(typeof r==='string'?r:JSON.stringify(r))" "$1"
}
preflight() {
  say "preflight"
  check_window
  [[ -f $APP/voxsend.db && -f $APP/server.js ]] || die "$APP does not look like the SQLite app"
  grep -q "better-sqlite3" "$APP/server.js" || die "$APP/server.js is not the SQLite app (already cut over?)"
  [[ -x $TUN/run-server.sh ]] || die "supervisor script missing"
  # git: a frozen commit
  [[ -z $(git -C "$DEV" status --porcelain) ]] || die "dev tree has uncommitted changes: commit first (local commit only)"
  COMMIT=$(git -C "$DEV" rev-parse --short HEAD)
  # broadcast running?
  local st; st=$(curl -fsS -m 5 http://127.0.0.1:$PORT/api/broadcast/status 2>/dev/null || echo '{"active":false,"down":true}')
  echo "$st" | grep -q '"active":true' && die "a broadcast is running right now"
  # schedule rows
  local rows; rows=$(sqlite_q "$APP/voxsend.db" "
    const now=Date.now(), m=$MARGIN*60000;
    const live=d.prepare(\"SELECT id, run_at, status FROM scheduled_calls WHERE status IN ('pending','starting','started')\").all();
    const busy=live.filter(r=>r.status!=='pending').map(r=>r.id);
    const soon=live.filter(r=>r.status==='pending' && Date.parse(r.run_at)-now < m).map(r=>r.id+'@'+r.run_at);
    const want='$EXPECT_PENDING'.split(',').filter(Boolean).map(Number);
    const notPending=want.filter(id=>!live.some(r=>r.id===id && r.status==='pending'));
    return {busy, soon, notPending, pending: live.filter(r=>r.status==='pending').map(r=>r.id)};")
  say "sqlite schedule: $rows"
  echo "$rows" | grep -q '"busy":\[\]' || die "a schedule row is starting/started (broadcast in progress)"
  echo "$rows" | grep -q '"soon":\[\]' || die "a scheduled run is due within $MARGIN minutes (or overdue)"
  echo "$rows" | grep -q '"notPending":\[\]' || die "expected pending rows not pending: $EXPECT_PENDING"
  if [[ -n $HIST_DATE ]]; then
    local h; h=$(sqlite_q "$APP/voxsend.db" "return d.prepare('SELECT created_at FROM history').all().map(x=>String(x.created_at)).filter(s=>new Date(s.includes('T')?s:s.replace(' ','T')+'Z').toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})==='$HIST_DATE').length")
    [[ "$h" -ge $HIST_COUNT ]] || die "only $h history row(s) from $HIST_DATE (IST), need $HIST_COUNT: wait until those broadcasts have completed"
    say "history rows on $HIST_DATE: $h"
  fi
  if [[ -n $EXPECT_GROUPS ]]; then
    local g; g=$(sqlite_q "$APP/voxsend.db" "const ids='$EXPECT_GROUPS'.split(',').filter(Boolean);
      return ids.filter(id=>!d.prepare(\"SELECT 1 FROM scheduled_calls WHERE group_id=? AND status='pending'\").get(id)).join(',')")
    [[ -z $g ]] || die "expected schedule group(s) without pending rows in SQLite: $g"
    say "groups with pending rows: $EXPECT_GROUPS"
  fi
  # Postgres
  local PGREADY=/usr/lib/postgresql/$(cat /workspace/pgdata/PG_VERSION 2>/dev/null || echo 17)/bin/pg_isready
  "$PGREADY" -q -h 127.0.0.1 -p 5432 -d $PGDB || die "postgres not ready"
  local born; born=$(psql -h /workspace/pg/run -d $PGDB -Atc "SELECT CASE WHEN to_regclass('$PGSCHEMA_T.broadcasts') IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM $PGSCHEMA_T.broadcasts) END")
  [[ $born == 0 ]] || die "prod Postgres already has broadcasts ($born): it is live data, not a migration target"
  [[ -r $KEYFILE && -r $PGCREDS ]] || die "master key or pg credentials missing"
  [[ -f $APP/.env ]] || die "$APP/.env missing"
  grep -m1 '^DATABASE_URL=' "$PGCREDS" | grep -q "['?&\"]" && die "DATABASE_URL in $PGCREDS has characters this script does not quote (' ? & \")"
  # every .env key must have a destination (lib/envimport.js); listed by name only
  ( cd "$DEV" && node -e "
    const env=require('dotenv').parse(require('fs').readFileSync(process.argv[1]));
    for (const p of require('./lib/envimport').plan(env)) console.log('  .env '+p.key+' -> '+p.dest);" "$APP/.env" ) \
    || die "could not read $APP/.env"
  # processes
  local n; n=$(ss -ltnp 2>/dev/null | grep -c ":$PORT " || true)
  [[ $n -le 1 ]] || die "more than one listener on :$PORT"
  local free; free=$(df -Pm /home/box /workspace | awk 'NR>1{print $4}' | sort -n | head -1)
  (( free > 1024 )) || die "less than 1 GB free disk"
  say "preflight OK (dev commit $COMMIT)"
}

preflight
[[ $MODE == check ]] && { say "check only: nothing changed. Run with --go to cut over."; exit 0; }

# ---------------------------------------------------------------- stage (prod untouched)
umask 077
mkdir -p "$BK"; chmod 700 "$BKROOT" "$BK"
exec > >(tee -a "$BK/cutover.log") 2>&1
say "cutover $STAMP, dev commit $COMMIT, backups in $BK"
say "staging new code in $NEW"
mkdir -p "$NEW"
git -C "$DEV" archive HEAD | tar -x -C "$NEW"
( cd "$NEW" && npm ci --omit=dev --no-audit --no-fund >"$BK/npm-ci.log" 2>&1 ) || { say "npm ci failed; copying dev node_modules"; cp -a "$DEV/node_modules" "$NEW/"; }
[[ -d $NEW/node_modules/pg && -d $NEW/node_modules/better-sqlite3 ]] || die "staged node_modules incomplete"
DBURL=$(grep -m1 '^DATABASE_URL=' "$PGCREDS" | cut -d= -f2-)
{
  # Bootstrap only. Provider keys, tokens, SIDs, numbers, base URL, agent ids, PIN and the
  # scheduler switch are in the database (encrypted where secret).
  echo "# voxsend (PostgreSQL). Written by cutover.sh $STAMP. Bootstrap settings only."
  echo "DATABASE_URL='$DBURL?schema=$PGSCHEMA_T'"
  echo "VOXSEND_MASTER_KEY_FILE='$KEYFILE'"
  echo "PORT=$PORT"
} > "$NEW/.env"
chmod 600 "$NEW/.env"; unset DBURL
[[ -z $(grep -vE '^(#|$|DATABASE_URL=|VOXSEND_MASTER_KEY_FILE=|PORT=)' "$NEW/.env") ]] || die "new .env has non-bootstrap keys"
mkdir -p "$NEW/logs"

# ---------------------------------------------------------------- the switch
STOPPED=0; DONE=0
on_exit() {
  local code=$?
  (( DONE )) && return 0
  if (( STOPPED )); then
    say "FAILED (exit $code) after prod was stopped — rolling back"
    release_supervisor_lock
    bash "$DEV/rollback.sh" "$STAMP" --auto --yes || say "ROLLBACK FAILED: see $BK; prod may be down"
  else
    say "FAILED (exit $code) before prod was stopped: prod untouched (staged dir $NEW can be deleted)"
  fi
}
trap on_exit EXIT

preflight   # again, right before stopping
STOPPED=1
stop_prod

say "backing up (after the stop)"
NODE_PATH=$NEW/node_modules node -e "
const D=require('better-sqlite3');const s=new D('$APP/voxsend.db',{readonly:true});
s.backup('$BK/voxsend.db').then(()=>{s.close();const b=new D('$BK/voxsend.db',{readonly:true});const ok=b.pragma('integrity_check',{simple:true});b.close();if(ok!=='ok'){console.error('integrity '+ok);process.exit(1)}console.log('sqlite snapshot ok')}).catch(e=>{console.error(e.message);process.exit(1)})"
mkdir -p "$BK/raw"; cp -p "$APP"/voxsend.db* "$BK/raw/"
# the old .env file(s): encrypted with the master key, never copied in plaintext
VAULT=$BK/env-files.vault
node "$NEW/ops/envvault.js" seal --key "$KEYFILE" --dir "$APP" --out "$VAULT"
tar --exclude=node_modules --exclude='.env*' -czf "$BK/app-sqlite.tgz" -C "$(dirname "$APP")" "$(basename "$APP")"
cp -p "$TUN/start.sh" "$BK/start.sh.sqlite"
pg_dump -h /workspace/pg/run -d $PGDB -n $PGSCHEMA_T -Fc -f "$BK/pg-before.dump"
sha256sum "$BK"/voxsend.db "$BK"/app-sqlite.tgz "$VAULT" > "$BK/SHA256SUMS"

say "swapping code: $APP -> $OLD, $NEW -> $APP"
mv "$APP" "$OLD"
mv "$NEW" "$APP"

say "migrating SQLite snapshot -> Postgres (schema voxsend)"
envcat() { node "$APP/ops/envvault.js" cat --key "$KEYFILE" --in "$VAULT" --name .env; }   # plaintext only inside a pipe
VERIFY_OPTS=(--sqlite "$BK/voxsend.db" --expect-history-date "$HIST_DATE" --expect-history-count "$HIST_COUNT" --expect-pending "$EXPECT_PENDING" --expect-groups "$EXPECT_GROUPS" --env -)
envcat | with_env "$APP" node scripts/migrate-sqlite-to-pg.js --sqlite "$BK/voxsend.db" --replace --import-env - --report "$BK/migration-report.json"
say "explicit verification (every live row, both groups, history, every .env key decrypted from the DB and compared by SHA-256)"
envcat | with_env "$APP" node scripts/verify-cutover.js "${VERIFY_OPTS[@]}" | tee "$BK/verify.txt"
[[ ${PIPESTATUS[1]} == 0 ]] || { say "verification failed"; false; }
for id in ${EXPECT_PENDING//,/ }; do
  s=$(psql -h /workspace/pg/run -d $PGDB -Atc "SELECT status FROM $PGSCHEMA_T.scheduled_calls WHERE id=$id")
  [[ $s == pending ]] || { say "row $id is '$s' in Postgres"; false; }
done
say "rows $EXPECT_PENDING pending in Postgres"

say "removing the plaintext .env file(s) from the old app (kept only in the encrypted vault) and neutering it"
for f in "$OLD"/.env "$OLD"/.env.*; do
  [[ -f $f && $(basename "$f") != .env.example ]] || continue
  if command -v shred >/dev/null 2>&1; then shred -u "$f"; else rm -f "$f"; fi
done
printf 'VOXSEND_SCHEDULER=off\n' > "$OLD/.env"; chmod 600 "$OLD/.env"   # no secrets: the old app cannot dial
for f in "$OLD"/voxsend.db*; do mv "$f" "$f.cutover-$STAMP"; done
left=$(find "$OLD" -maxdepth 1 -name '.env*' ! -name .env.example ! -name .env -print; find "$BK" -name '*env*' ! -name env-files.vault -print)
[[ -z $left ]] || { say "plaintext env copies remain: $left"; false; }

if [[ $NEW_SCHEDULER == on ]]; then
  say "enabling the scheduler (settings.scheduler_enabled; honoured only by the prod app)"
  psql -h /workspace/pg/run -d $PGDB -qAtc "UPDATE $PGSCHEMA_T.settings SET scheduler_enabled=true, updated_at=now() WHERE id=1"
fi

say "installing Postgres start.sh"
if [[ -n ${CUTOVER_START_SH:-} ]]; then install -m 755 "$CUTOVER_START_SH" "$TUN/start.sh"; else install -m 755 "$APP/ops/voxsend-start.sh" "$TUN/start.sh"; fi

say "starting under the supervisor"
LOGPOS=$(stat -c %s "$LOG/server.log" 2>/dev/null || echo 0)
start_prod || { say "health check failed"; false; }
sleep 8
NEWLOG=$(tail -c +$((LOGPOS + 1)) "$LOG/server.log")
grep -q "$EXPECT_INSTANCE" <<<"$NEWLOG" || { say "server did not report '$EXPECT_INSTANCE'"; false; }
grep -q "Server running at http://localhost:$PORT (schema $PGSCHEMA_T)" <<<"$NEWLOG" || { say "server log lacks the startup line"; false; }
if [[ $NEW_SCHEDULER == on ]]; then grep -q "Scheduler is ON" <<<"$NEWLOG" || { say "scheduler did not start"; false; }
else grep -q "Scheduler is OFF" <<<"$NEWLOG" || { say "scheduler should be off"; false; }; fi
envcat | with_env "$APP" node scripts/verify-cutover.js "${VERIFY_OPTS[@]}" >/dev/null || { say "verification after start failed"; false; }
for id in ${EXPECT_PENDING//,/ }; do
  s=$(psql -h /workspace/pg/run -d $PGDB -Atc "SELECT status FROM $PGSCHEMA_T.scheduled_calls WHERE id=$id")
  [[ $s == pending ]] || { say "row $id is '$s' after start"; false; }
done
[[ -z $PUBLIC_URL ]] || { curl -fsS -m 10 "$PUBLIC_URL/api/health" >/dev/null 2>&1 && say "public URL healthy" || say "WARN: public URL check failed (tunnel?)"; }
DONE=1
say "CUTOVER DONE. Old app: $OLD (neutered, no .env secrets). Backups: $BK (old .env only in env-files.vault, encrypted)."
say "Rollback: bash $DEV/rollback.sh $STAMP [--export-pg]"
