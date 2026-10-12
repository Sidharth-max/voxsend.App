-- v2: crash-resume bookkeeping for broadcasts, richer call history.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS resume_requested boolean NOT NULL DEFAULT false;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS resumed_count    integer NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS started_key      text;        -- key echoed in webhook metadata
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS interrupted_at   timestamptz;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS note             text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS recipients_total integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS broadcasts_status_idx ON broadcasts (status);
CREATE INDEX IF NOT EXISTS call_targets_broadcast_status_idx ON call_targets (broadcast_id, status);

ALTER TABLE call_history ADD COLUMN IF NOT EXISTS source       text;   -- webhook | sync | import
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS language     text;
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS ended_by     text;
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS num_messages integer;
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS audio_url    text;   -- provider URL; served only through the proxy
ALTER TABLE call_history ADD COLUMN IF NOT EXISTS target_id    bigint REFERENCES call_targets(id) ON DELETE SET NULL;
