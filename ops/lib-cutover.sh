# Shared helpers for cutover.sh / rollback.sh (sourced). Never prints secret values.
# Real values by default. CUTOVER_* overrides exist ONLY for the rehearsal in a sandbox
# (/workspace/vx-test/cutover-rehearsal), which uses the test database and port 3100.
APP=${CUTOVER_APP:-/home/box/voxsend.App}
TUN=${CUTOVER_TUN:-/workspace/voxsend-tunnel}
LOG=$TUN/logs
BKROOT=${CUTOVER_BKROOT:-/workspace/voxsend-cutover}
PGCREDS=${CUTOVER_PGCREDS:-/workspace/pg/credentials}
PORT=${CUTOVER_PORT:-3000}
PGDB=${CUTOVER_PGDB:-voxsend}
PGSCHEMA_T=${CUTOVER_PGSCHEMA:-voxsend}
KEYFILE=${CUTOVER_KEYFILE:-/workspace/pg/master.key}
PUBLIC_URL=${CUTOVER_PUBLIC_URL-https://call.s-lab.dev}
EXPECT_INSTANCE=${CUTOVER_EXPECT_INSTANCE:-Instance: prod}
NEW_SCHEDULER=${CUTOVER_SCHEDULER:-on}

say()  { echo "$(TZ=Asia/Kolkata date '+%H:%M:%S IST') $*"; }
die()  { say "ABORT: $*" >&2; exit 1; }

ist_minutes() { local h m; h=$(TZ=Asia/Kolkata date +%-H); m=$(TZ=Asia/Kolkata date +%-M); echo $((h * 60 + m)); }
# Refuse 10:00-12:30 IST (the daily broadcast window).
check_window() {
  local now; now=$(ist_minutes)
  # the window override exists only for the sandbox rehearsal, never for the real app dir
  [[ -n ${CUTOVER_IGNORE_WINDOW:-} && $APP != /home/box/voxsend.App ]] && return 0
  # daily broadcasts at 10:30 and 17:30 IST: stay clear of both
  if (( now >= 600 && now < 750 )); then die "it is $(TZ=Asia/Kolkata date +%H:%M) IST: no cutover/rollback between 10:00 and 12:30 IST"; fi
  if (( now >= 1020 && now < 1170 )); then die "it is $(TZ=Asia/Kolkata date +%H:%M) IST: no cutover/rollback between 17:00 and 19:30 IST"; fi
}

port_pid() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
port_busy() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

# Processes whose working directory is the app dir (the node server).
app_procs() { local p; for p in /proc/[0-9]*; do [[ "$(readlink "$p/cwd" 2>/dev/null)" == "$APP" ]] && echo "${p#/proc/}"; done; true; }

# Stops supervisor (first) and node, then holds the supervisor flock on fd 9 so neither
# bootstrap nor start.sh can bring a server back until release_supervisor_lock.
stop_prod() {
  local sup child
  sup=$(cat "$LOG/supervisor.pid" 2>/dev/null || true)
  child=$(cat "$LOG/server.pid" 2>/dev/null || true)
  if [[ -n $sup ]] && kill -0 "$sup" 2>/dev/null; then
    grep -q run-server.sh "/proc/$sup/cmdline" 2>/dev/null || die "supervisor pid $sup is not run-server.sh"
    say "stopping supervisor pid=$sup"
    kill "$sup"
  fi
  for _ in $(seq 1 30); do
    [[ -n $child ]] && kill -0 "$child" 2>/dev/null || break
    sleep 1
  done
  [[ -n $child ]] && kill -0 "$child" 2>/dev/null && { say "node pid=$child still up; TERM"; kill "$child" || true; sleep 3; }
  for _ in $(seq 1 30); do port_busy $PORT || break; sleep 1; done
  port_busy $PORT && die ":$PORT still in use (pid $(port_pid $PORT)) after stopping"
  local left; left=$(app_procs)
  [[ -z $left ]] || die "processes still running in $APP: $left"
  exec 9>"$LOG/supervisor.lock"
  flock -n 9 || die "could not take the supervisor lock (another supervisor running?)"
  say "prod stopped; :$PORT free; supervisor lock held"
}
release_supervisor_lock() { flock -u 9 2>/dev/null || true; exec 9>&- 2>/dev/null || true; }

start_prod() {
  release_supervisor_lock
  bash "$TUN/start.sh" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 5 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1 || return 1
  local n; n=$(ss -ltnp 2>/dev/null | grep -c ":$PORT ")
  [[ $n == 1 ]] || return 1
  say "prod up: supervisor pid=$(cat "$LOG/supervisor.pid" 2>/dev/null), node pid=$(cat "$LOG/server.pid" 2>/dev/null)"
}

# Runs a command inside dir with that dir's .env loaded into a clean environment.
with_env() {
  local dir=$1; shift
  ( cd "$dir" && exec env -i PATH="$PATH" HOME="$HOME" bash -c 'set -a; . ./.env; set +a; exec "$@"' with_env "$@" )
}
