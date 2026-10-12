# voxsend token API (`/api/v1`)

All responses are JSON: `{ "ok": true, "data": ... }` on success, `{ "success": false, "message": "..." }`
(or `"error"`) with a 4xx/5xx status on failure.

## Authentication

Create a token with the CLI (shown once, stored only as a SHA-256 hash):

    voxsend tokens create reporting --scopes read --days 90

Send it as a bearer token:

    curl -H "Authorization: Bearer vxs_..." https://call.s-lab.dev/api/v1/status

A signed-in browser session (cookie from the PIN login) also works and has every scope.

| Scope   | Allows |
|---------|--------|
| `read`  | every `GET` |
| `write` | `read` plus changes: contacts, agents, schedules, starting/stopping/resuming broadcasts, call sync |
| `admin` | everything, including `/secrets` (masked values only) and `/tokens` |

Requests from a browser on another origin are refused (same-origin check; extra origins only via
`VOXSEND_ALLOWED_ORIGINS`). Webhooks (`/api/sarvam/webhook`, Vobiz callbacks) are the only routes without
a session or token, and they are verified by HMAC signature.

## Status

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | `{ broadcast, resumable, config }` — active run, interrupted runs, provider readiness |

## Contacts and lists

| Method | Path | Body / query |
|---|---|---|
| GET | `/contacts` | `?group=Name` optional |
| POST | `/contacts` | `{ "contacts": [{ "name", "phone", "group" }] }` — upsert by phone |
| DELETE | `/contacts` | `{ "phones": ["+91..."] }` |
| GET | `/lists` | groups with counts |
| GET | `/lists/:name` | numbers in a group (`*` = all contacts) |

## Agents (Sarvam)

| Method | Path | Body |
|---|---|---|
| GET | `/agents` | all agents (active and inactive) |
| POST | `/agents` | `{ "label", "app_id", "version": null\|N, "notes", "active", "is_default" }` |
| PUT | `/agents/:id` | same fields |
| POST | `/agents/:id/default` | make default |
| DELETE | `/agents/:id` | refused (409) while pending schedules use it |

## Schedules

Recipients: `numbers` (array or comma/space separated string) and/or `groups` (array of group names, `"*"` = all).
Times: either `runAts` (ISO strings with offset) or a `rule`.

    POST /api/v1/schedules
    {
      "groups": ["Members"], "provider": "sarvam", "agentId": 2,
      "rule": { "mode": "daily", "startDate": "2027-01-05", "endAfter": 3, "times": ["10:30"], "timezone": "Asia/Kolkata" }
    }

Rule fields: `mode` (`once`/`dates`/`daily`/`weekly`), `dates`, `startDate`, `endDate` or `endAfter`, `weekdays`
(0=Sun..6=Sat), `skipWeekends`, `times` (`HH:MM`), `timezone`. At most 200 times per schedule.

| Method | Path | Notes |
|---|---|---|
| GET | `/schedules` | every scheduled time with group, status, `agent_label`, `broadcast_id`, `not_dialled`, `resumable` |
| GET | `/schedules/:groupId` | group + its times |
| POST | `/schedules` | create (body above; `message`, `language`, `voice` optional) |
| PUT | `/schedules/:groupId` | replace the pending times/recipients of a group (past times stay as history) |
| DELETE | `/schedules/:groupId` | cancel every pending time of the group |
| DELETE | `/schedule-times/:id` | cancel one time |

## Broadcasts

| Method | Path | Notes |
|---|---|---|
| GET | `/broadcasts` | `?status=` optional |
| GET | `/broadcasts/active` | live progress of the running broadcast |
| GET | `/broadcasts/resumable` | interrupted/stopped runs that still have numbers never dialled |
| GET | `/broadcasts/:id` | one run with per-number targets |
| POST | `/broadcasts` | **places real calls.** Requires `"confirm": true`, plus recipients, `provider`, `agentId`, `message` |
| POST | `/broadcasts/stop` | stop the running broadcast |
| POST | `/broadcasts/:id/resume` | dial only the numbers never attempted; anyone already dialled (answered, failed or unknown) is skipped |

Resume rules: after a crash or restart, a run is resumed automatically only if the scheduler is on and the run
started less than `VOXSEND_RESUME_MINUTES` (default 30) ago. Older runs wait for this endpoint, the CLI, or the
Resume button in the app.

## Call history (Sarvam analytics)

| Method | Path | Notes |
|---|---|---|
| GET | `/calls` | `q` (phone digits or attempt id), `status` (`answered`/`not_answered`/`failed`/raw), `agentId`, `broadcastId`, `from`, `to` (ISO), `limit` (≤500), `offset` → `{ total, items }` |
| GET | `/calls/:attemptId` | one call |
| GET | `/calls/:attemptId/transcript` | `{ turns: [{ role, text, time }] }`, cached; `?refresh=1` refetches |
| GET | `/calls/:attemptId/recording` | audio streamed through the server (the provider URL is never exposed) |
| POST | `/calls/sync` | `{ "days": 7 }` optional; pulls attempts from Sarvam (also runs in the background) |
| GET | `/history` | broadcast summaries |

## Secrets and tokens (admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/secrets` | names with masked values (`••••abcd`) — plaintext is never returned |
| PUT | `/secrets/:name` | `{ "value": "..." }` |
| DELETE | `/secrets/:name` | clear |
| GET | `/tokens` | list (no token values) |
| POST | `/tokens` | `{ "name", "scopes": ["read"], "days": 90 }` → the token value, shown once |
| DELETE | `/tokens/:id` | revoke |
