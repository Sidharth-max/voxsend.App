MIGRATION READY FOR REVIEW

# voxsend: SQLite → PostgreSQL migration

Script: `scripts/migrate-sqlite-to-pg.js` (Node, uses `better-sqlite3` + `pg`, same versions as the app).
Schema: `lib/migrations/001_init.sql`, applied by `lib/migrate.js` (versioned in `schema_migrations`,
serialised with an advisory lock).

## What it does
1. Takes a consistent snapshot of the live SQLite DB with SQLite's online backup API into a temp file
   (the source is opened read-only; prod keeps running). Records the snapshot's SHA-256 in the report.
2. Applies pending schema migrations to the target schema (default `voxsend`, or `--schema` / `PGSCHEMA`).
3. In ONE transaction (plus `pg_advisory_xact_lock('voxsend:sqlite-import')`):
   - refuses if the target already has data, unless `--replace` (then `TRUNCATE ... RESTART IDENTITY CASCADE`);
   - copies settings, contacts, messages, schedule_groups, scheduled_calls, history, call_failures,
     sarvam_calls, keeping every primary key; sets each sequence to MAX(id);
   - with `--import-env <old .env>`: encrypts the provider credentials into `secrets` (AES-256-GCM,
     master key from `VOXSEND_MASTER_KEY_FILE`), stores APP_PIN as an scrypt hash, creates a new
     webhook secret, moves PROVIDER / PUBLIC_URL into `settings`, seeds `agents` with the agent in use
     (`SARVAM_APP_ID`/`SARVAM_APP_VERSION`, default) and an inactive example agent, and links existing
     Sarvam schedules to the default agent;
   - VERIFIES before commit: per table, row count and a row-by-row comparison of every copied column
     after normalising both sides the same way (times → ISO UTC, JSON → canonical form, booleans,
     numbers). Any mismatch → ROLLBACK, exit 1. The report also lists every pending/starting/started
     schedule row and every history row, for the cutover check;
   - `--scrub-before YYYY-MM-DD` (TEST COPIES ONLY) cancels pending/starting/started rows that run
     before that date, after verification;
   - `--dry-run` does all of the above, then ROLLBACK.
4. Writes a JSON report (`--report`). Secret values are never printed, only names.

## Type mapping
| SQLite | Postgres |
|---|---|
| `DATETIME DEFAULT CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC) | `timestamptz` (read as UTC) |
| ISO strings (`run_at`) | `timestamptz` |
| `start_date` / `end_date` text | `date` |
| JSON stored as TEXT (recipients, dates, times, weekdays, settings, results, transcript, agent_variables) | `jsonb` (unparseable text is kept as `{"__unparsed": "..."}` and reported) |
| 0/1 integers (`skip_weekends`, `retry_failed`) | `boolean` |
| REAL durations | `double precision` |
| `broadcast_started_at` (the old broadcast key) | `text`, kept verbatim |
Rows without `group_id` get `single-<id>`, as the app already does; a schedule row whose group is
missing gets a minimal group (reported as a warning). New tables (`broadcasts`, `call_targets`,
`call_history`, `sessions`, `api_tokens`, `sync_state`) start empty.

## Roles / where
Postgres 17 on 127.0.0.1:5432 (`/workspace/pg/start.sh`), database `voxsend`, schema `voxsend`
owned by the app role `voxsend` (`DATABASE_URL` in `/workspace/pg/credentials`, never printed).
Tests use schema `voxsend_test` and a separate master key (`/workspace/vx-test/pg/test-master.key`).

## Running it
```
# dry run against prod data, nothing kept:
DATABASE_URL=... VOXSEND_MASTER_KEY_FILE=/workspace/pg/master.key \
  node scripts/migrate-sqlite-to-pg.js --sqlite /home/box/voxsend.App/voxsend.db \
  --import-env /home/box/voxsend.App/.env --dry-run --report /tmp/report.json
```
Note: even a dry run applies the empty schema (tables only) if it is missing, and uses up a few
sequence numbers; no data is kept.

## Cutover (not tonight)
`cutover.sh` (in this folder) does: preflight (time window: not 10:00–12:30 IST, no broadcast running,
no schedule due in the next 30 min, Postgres up) → stop the supervisor → back up voxsend.db (+wal),
.env, the code dir, and `pg_dump` → migrate with `--import-env` → check the report (all tables ok,
the expected pending rows present, Oct 7 history present) → switch the code and the slimmed .env →
start the supervisor → health checks (HTTP 200, login, schedules list, one node process) → on any
failure: restore the SQLite code/.env, start the supervisor again on SQLite, and leave Postgres data
for inspection. See the script header for details.

## Test run (Oct 6, schema voxsend_test, prod snapshot, dummy .env)
All 8 tables matched (contacts 106, schedule_groups 1, scheduled_calls 4, history 3,
call_failures 100, sarvam_calls 235, settings 1, messages 0). Rows 1–4 were then scrubbed
(cancelled) in the test copy only. Prod SQLite untouched.
