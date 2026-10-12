-- v4 (additive only): remember the last known name per number, so a broadcast/call keeps
-- showing a name after its contact is deleted. Live contacts always win; this is the fallback.
CREATE TABLE IF NOT EXISTS contact_name_snapshots (
    phone_key text PRIMARY KEY,               -- last 10 digits
    name text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE call_targets ADD COLUMN IF NOT EXISTS name_snapshot text;

INSERT INTO contact_name_snapshots (phone_key, name)
SELECT DISTINCT ON (k) k, name FROM (
    SELECT right(regexp_replace(phone, '\D', '', 'g'), 10) AS k, name, id FROM contacts
     WHERE COALESCE(name, '') <> '') c
 ORDER BY k, id DESC
ON CONFLICT (phone_key) DO NOTHING;

UPDATE call_targets t SET name_snapshot = s.name
  FROM contact_name_snapshots s
 WHERE t.name_snapshot IS NULL AND s.phone_key = right(regexp_replace(t.phone, '\D', '', 'g'), 10);
