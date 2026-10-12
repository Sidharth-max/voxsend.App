# voxsend CLI

Installed as `/workspace/bin/voxsend` (a wrapper around `cli/voxsend.js`). Run `voxsend --help` for the full list.
Add `--json` to any command for machine-readable output.

## Modes

* **DB mode (default)** — talks to Postgres directly using the app's `.env` (`DATABASE_URL`, `PGSCHEMA`,
  `VOXSEND_MASTER_KEY_FILE`). The same guards as the server apply: code outside the production directory refuses
  the production database, schema and key. DB mode never places calls.
* **API mode** — `voxsend --api https://call.s-lab.dev <command>` with `VOXSEND_TOKEN=vxs_...` in the
  environment. Needed for `broadcasts start`, which also requires `--yes`.

## Common tasks

    voxsend status                                  # runner, active broadcast, resumable runs
    voxsend schedules list
    voxsend schedules create --group Members --provider sarvam --agent 2 \
        --daily --from 2027-01-05 --count 3 --time 10:30
    voxsend schedules create --numbers +919800000001,+919800000002 --at 2027-01-05T10:30+05:30
    voxsend schedules cancel <group-id>             # or: schedules cancel-time <time-id>
    voxsend broadcasts resumable                    # interrupted runs with numbers never dialled
    voxsend broadcasts resume <id>                  # dials only those; attempted numbers are skipped
    voxsend calls list --status not_answered --from 2026-10-07
    voxsend calls transcript <attempt-id>
    voxsend agents add --label "Event reminder" --app-id <sarvam-app-id> --default
    voxsend contacts import members.csv             # columns: name,phone,group

## Secrets

Secrets are encrypted (AES-256-GCM) in the database; the CLI only ever prints masked values.

    voxsend secrets list
    voxsend secrets set sarvam_key                  # hidden prompt
    printf %s "$VALUE" | voxsend secrets set sarvam_key --stdin
    voxsend secrets set-pin                         # app login PIN (stored as a scrypt hash)
    voxsend secrets rotate-key                      # re-encrypts everything with a new master key

## Tokens and database

    voxsend tokens create reporting --scopes read --days 90     # value shown once
    voxsend tokens list
    voxsend tokens revoke <id>
    voxsend db status                               # schema version, pending migrations
    voxsend db migrate
    voxsend db backup                               # pg_dump via /workspace/pg/backup.sh
