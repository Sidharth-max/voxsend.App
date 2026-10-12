-- voxsend schema v1 (PostgreSQL). Runs inside one transaction with search_path set
-- to the target schema. All times are timestamptz (UTC on the wire).

CREATE TABLE IF NOT EXISTS settings (
    id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    parallel_calls   integer NOT NULL DEFAULT 12,
    retry_failed     boolean NOT NULL DEFAULT false,
    default_language text    NOT NULL DEFAULT 'hi-IN',
    delay_ms         integer NOT NULL DEFAULT 200,
    org_name         text,
    provider         text    NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio','vobiz','sarvam')),
    public_url       text,
    updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Encrypted provider credentials and other secrets (AES-256-GCM, done in Node).
-- kind='aes-256-gcm': value = base64 ciphertext, iv/tag base64, key_id = master key fingerprint.
-- kind='scrypt':      value = scrypt hash string (the PIN); never decryptable.
CREATE TABLE IF NOT EXISTS secrets (
    name        text PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('aes-256-gcm','scrypt')),
    value       text NOT NULL,
    iv          text,
    tag         text,
    key_id      text,
    key_version integer NOT NULL DEFAULT 1,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id           text PRIMARY KEY,               -- sha256 of the cookie value
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    ip           text,
    user_agent   text
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           serial PRIMARY KEY,
    name         text NOT NULL,
    prefix       text NOT NULL,                  -- first chars, shown in lists
    token_hash   text NOT NULL UNIQUE,           -- sha256 of the full token
    scopes       text[] NOT NULL DEFAULT ARRAY['read'],
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz
);

CREATE TABLE IF NOT EXISTS agents (
    id          serial PRIMARY KEY,
    label       text NOT NULL,
    app_id      text NOT NULL,
    version     integer CHECK (version IS NULL OR version > 0),   -- NULL = latest committed
    notes       text,
    active      boolean NOT NULL DEFAULT true,     -- inactive agents are hidden from the picker
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_default ON agents (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS contacts (
    id         bigserial PRIMARY KEY,
    name       text,
    phone      text NOT NULL UNIQUE,
    group_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_group_idx ON contacts (group_name);

CREATE TABLE IF NOT EXISTS messages (
    id         bigserial PRIMARY KEY,
    name       text,
    content    text,
    language   text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedule_groups (
    id            text PRIMARY KEY,
    message       text,
    language      text,
    voice         text,
    provider      text NOT NULL,
    recipients    jsonb NOT NULL DEFAULT '[]',
    sent_by       text,
    agent_id      integer REFERENCES agents(id) ON DELETE SET NULL,
    repeat_mode   text NOT NULL DEFAULT 'daily',
    dates         jsonb NOT NULL DEFAULT '[]',
    start_date    date,
    end_date      date,
    end_after     integer,
    weekdays      jsonb NOT NULL DEFAULT '[]',
    skip_weekends boolean NOT NULL DEFAULT false,
    times         jsonb NOT NULL DEFAULT '[]',
    timezone      text,
    settings      jsonb NOT NULL DEFAULT '{}',
    occurrences   integer NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per scheduled time. Status: pending, starting, started, completed,
-- interrupted, missed, failed, cancelled.
CREATE TABLE IF NOT EXISTS scheduled_calls (
    id          bigserial PRIMARY KEY,
    group_id    text NOT NULL REFERENCES schedule_groups(id) ON DELETE CASCADE,
    message     text NOT NULL DEFAULT '',
    language    text,
    voice       text,
    provider    text NOT NULL,
    recipients  jsonb NOT NULL DEFAULT '[]',
    run_at      timestamptz NOT NULL,
    status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','starting','started','completed','interrupted','missed','failed','cancelled')),
    note        text,
    sent_by     text,
    agent_id    integer REFERENCES agents(id) ON DELETE SET NULL,
    broadcast_id bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz,
    UNIQUE (group_id, run_at)
);
CREATE INDEX IF NOT EXISTS scheduled_calls_status_run_idx ON scheduled_calls (status, run_at);

-- One row per broadcast run (manual or scheduled).
CREATE TABLE IF NOT EXISTS broadcasts (
    id             bigserial PRIMARY KEY,
    occurrence_id  bigint REFERENCES scheduled_calls(id) ON DELETE SET NULL,
    provider       text NOT NULL,
    agent_id       integer REFERENCES agents(id) ON DELETE SET NULL,
    message        text,
    language       text,
    voice          text,
    sent_by        text,
    total          integer NOT NULL DEFAULT 0,
    successful     integer NOT NULL DEFAULT 0,
    failed         integer NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','stopped','interrupted')),
    stop_requested boolean NOT NULL DEFAULT false,
    logs           jsonb NOT NULL DEFAULT '[]',
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS broadcasts_started_idx ON broadcasts (started_at DESC);
DO $$ BEGIN
    ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_broadcast_fk
        FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per number per broadcast. Claimed (pending -> dialling) before dialling,
-- so a number is never dialled twice; 'dialling' left over after a restart becomes 'unknown'.
CREATE TABLE IF NOT EXISTS call_targets (
    id              bigserial PRIMARY KEY,
    broadcast_id    bigint NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    occurrence_id   bigint REFERENCES scheduled_calls(id) ON DELETE SET NULL,
    phone           text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','dialling','queued','connected','no_answer','busy','failed','unknown','skipped')),
    attempt_id      text UNIQUE,
    interaction_id  text,
    attempts        integer NOT NULL DEFAULT 0,
    error           text,
    duration        double precision,
    agent_variables jsonb,
    transcript      jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    dialled_at      timestamptz,
    finished_at     timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (broadcast_id, phone)
);
CREATE UNIQUE INDEX IF NOT EXISTS call_targets_occurrence_phone ON call_targets (occurrence_id, phone) WHERE occurrence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_targets_status_idx ON call_targets (status);

CREATE TABLE IF NOT EXISTS history (
    id           bigserial PRIMARY KEY,
    message      text,
    language     text,
    total        integer,
    successful   integer,
    recipients   text,
    results      jsonb,
    broadcast_id bigint REFERENCES broadcasts(id) ON DELETE SET NULL,
    agent_id     integer REFERENCES agents(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS history_created_idx ON history (created_at DESC);

CREATE TABLE IF NOT EXISTS call_failures (
    id                   bigserial PRIMARY KEY,
    phone                text NOT NULL,
    error                text,
    broadcast_started_at text,          -- kept verbatim: the broadcast's start key from the old app
    broadcast_id         bigint REFERENCES broadcasts(id) ON DELETE SET NULL,
    failed_at            timestamptz NOT NULL DEFAULT now()
);

-- Sarvam webhook results as received (kept from the SQLite app).
CREATE TABLE IF NOT EXISTS sarvam_calls (
    attempt_id           text PRIMARY KEY,
    phone                text,
    status               text,
    duration             double precision,
    failure_reason       text,
    transcript           jsonb,
    agent_variables      jsonb,
    message              text,
    broadcast_started_at text,          -- kept verbatim (also the webhook's broadcast key)
    broadcast_id         bigint REFERENCES broadcasts(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz
);

-- Call history synced from the Sarvam analytics API (one row per attempt).
CREATE TABLE IF NOT EXISTS call_history (
    attempt_id            text PRIMARY KEY,
    interaction_id        text,
    app_id                text,
    agent_id              integer REFERENCES agents(id) ON DELETE SET NULL,
    phone                 text,
    status                text,
    duration              double precision,
    failure_reason        text,
    summary               text,
    agent_variables       jsonb,
    started_at            timestamptz,
    ended_at              timestamptz,
    broadcast_id          bigint REFERENCES broadcasts(id) ON DELETE SET NULL,
    occurrence_id         bigint REFERENCES scheduled_calls(id) ON DELETE SET NULL,
    raw                   jsonb,
    transcript            jsonb,
    transcript_fetched_at timestamptz,
    synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_history_started_idx ON call_history (started_at DESC);
CREATE INDEX IF NOT EXISTS call_history_phone_idx ON call_history (phone);
CREATE INDEX IF NOT EXISTS call_history_status_idx ON call_history (status);
CREATE INDEX IF NOT EXISTS call_history_interaction_idx ON call_history (interaction_id);

-- Bookkeeping for the background sync (last window per app).
CREATE TABLE IF NOT EXISTS sync_state (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
