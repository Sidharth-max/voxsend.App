// Applies lib/migrations/NNN_*.sql in order, each in its own transaction, recording
// them in schema_migrations. Safe to run repeatedly. Uses the given pool/client config.
const fs = require('fs');
const path = require('path');
const { SCHEMA } = require('./db');

const DIR = path.join(__dirname, 'migrations');

function listMigrations() {
    return fs.readdirSync(DIR).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()
        .map(f => ({ version: parseInt(f.slice(0, 3), 10), name: f, sql: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

// client: a connected pg Client/PoolClient. asRole: role that should own the objects.
// inTransaction: the caller already ran BEGIN; apply everything inside it (so a ROLLBACK,
// e.g. in --dry-run, leaves the database exactly as it was).
async function migrate(client, { asRole = null, log = console.log, inTransaction = false } = {}) {
    if (asRole) await client.query(`SET ROLE ${asRole}`);
    // The app role may not create schemas; only try when it is missing.
    const exists = (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [SCHEMA])).rowCount;
    if (!exists) await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialise concurrent runners.
    await client.query(inTransaction ? "SELECT pg_advisory_xact_lock(hashtext('voxsend:migrate'))" : "SELECT pg_advisory_lock(hashtext('voxsend:migrate'))");
    try {
        const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        const applied = [];
        for (const m of listMigrations()) {
            if (done.has(m.version)) continue;
            if (!inTransaction) await client.query('BEGIN');
            try {
                await client.query(m.sql);
                await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
                if (!inTransaction) await client.query('COMMIT');
            } catch (e) {
                if (!inTransaction) await client.query('ROLLBACK');
                throw new Error(`Migration ${m.name} failed: ${e.message}`);
            }
            applied.push(m.name);
            log(`Applied migration ${m.name} (schema ${SCHEMA})`);
        }
        return applied;
    } finally {
        if (!inTransaction) await client.query("SELECT pg_advisory_unlock(hashtext('voxsend:migrate'))");
        if (asRole) await client.query('RESET ROLE');
    }
}

async function currentVersion(client) {
    try {
        const r = await client.query(`SELECT COALESCE(MAX(version), 0) AS v FROM ${SCHEMA}.schema_migrations`);
        return r.rows[0].v;
    } catch (e) { return 0; }
}

const latestVersion = () => Math.max(0, ...listMigrations().map(m => m.version));

module.exports = { migrate, currentVersion, latestVersion, listMigrations };
