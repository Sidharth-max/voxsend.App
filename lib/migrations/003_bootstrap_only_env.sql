-- v3: everything except the bootstrap settings (DATABASE_URL, VOXSEND_MASTER_KEY_FILE, PORT)
-- lives in the database. The scheduler switch moves from .env (VOXSEND_SCHEDULER) into settings.
-- It only takes effect in the prod app (lib/guard.js isProd); dev/test copies ignore it.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS scheduler_enabled boolean NOT NULL DEFAULT false;
