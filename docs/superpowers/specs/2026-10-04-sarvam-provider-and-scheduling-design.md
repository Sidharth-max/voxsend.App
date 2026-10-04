# Sarvam provider + server-side scheduling

## Goal
Add Sarvam AI Voice Agents as a third broadcast provider (one-way announcement
calls from a Sarvam phone number) and let any broadcast be scheduled for a
later time. The server owns the schedule.

## Decisions (agreed with the user)
- Calls are one-way announcements. One generic Sarvam agent is configured in
  the Sarvam dashboard ("say the opening message, then end the call"). Each
  call passes the typed text as `app_overrides.initial_bot_message` and the
  language as `app_overrides.initial_language_name`.
- Scheduling lives in our server (SQLite + a 30s timer), not in Sarvam
  campaigns. It works for every provider, not only Sarvam.
- Secrets live in `.env` (written by the existing API tab), never in code.

## Sarvam API used
`POST {base}/api/outbounds/v1/orgs/{org}/workspaces/{ws}/outbounds`, header
`X-API-Key`. Body: `app_config {app_id, app_version, connection_config
{connection_id, agent_phone_number}, app_overrides}`, `user_config
{user_phone_number}`, optional `webhook_config {url, metadata}`. Response
`{attempt_id}`. Result arrives by webhook POST (`attempt_id`, `status` =
connected | no_answer | busy | failed, `failure_reason`).

## Components
- `sarvam.js` — `placeCall()` and `missingSarvamConfig()`; no Express/DB deps.
- `server.js`
  - `startBroadcast()` extracted from the `/api/broadcast` handler; the
    handler and the scheduler both call it.
  - Sarvam branch in `callOne`; slot held until webhook (or timeout) when a
    public URL exists, released immediately otherwise.
  - `POST /api/sarvam/webhook` — resolves the pending call, logs the outcome.
  - `scheduled_calls` table; `POST/GET/DELETE /api/schedule`; timer
    `runDueSchedules()` every 30s.
  - `POST /api/credentials` now merges into `.env` instead of overwriting it,
    and carries the Sarvam keys.
- Frontend: Sarvam option + fields on the API tab; date/time + "Schedule"
  button and an upcoming-calls list (with cancel) on the Broadcast tab.

## Behaviour details
- Times are stored as UTC ISO strings; the browser converts from local time.
- Only one broadcast runs at a time; a due schedule waits until the current
  one finishes.
- A schedule more than `SCHEDULE_GRACE_MINUTES` (default 60) late, e.g. because
  the server was down, is marked `missed` and not sent.
- Scheduled runs use credentials from `.env` (not from the browser).
- Missing credentials are rejected when scheduling and again when it runs.

## Out of scope
Two-way conversations, Sarvam campaigns, per-call cost tracking for Sarvam,
authentication of the server API (existing gap, unchanged).
