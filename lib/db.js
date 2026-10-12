// PostgreSQL access: one shared Pool, small helpers, transactions.
// Connection settings come from DATABASE_URL; its "?schema=" parameter (or PGSCHEMA)
// picks the schema, so tests can run against a separate schema. No default.
const { Pool, types } = require('pg');
require('./bootenv').apply();

// int8 (bigserial ids, COUNT(*)) as JS numbers; our ids stay far below 2^53.
types.setTypeParser(20, v => (v === null ? null : Number(v)));
// numeric (e.g. durations) as numbers
types.setTypeParser(1700, v => (v === null ? null : Number(v)));
// date as plain 'YYYY-MM-DD' strings (no time-zone shifting)
types.setTypeParser(1082, v => v);

// No default schema: prod uses voxsend, tests voxsend_test (see lib/guard.js).
const SCHEMA = process.env.PGSCHEMA || '';
if (!SCHEMA) throw new Error('PGSCHEMA is not set (no default).');
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error(`Invalid PGSCHEMA: ${SCHEMA}`);

let pool = null;

function makePool(connectionString, opts = {}) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const p = new Pool({
        connectionString,
        max: opts.max || 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        application_name: opts.name || 'voxsend',
        // search_path is set at connection start, so no query can run before it.
        options: `-c search_path=${SCHEMA}`
    });
    p.on('error', err => console.error('Postgres pool error:', err.message));
    return p;
}

function getPool() {
    if (!pool) pool = makePool(process.env.DATABASE_URL, { name: process.env.PG_APP_NAME || 'voxsend' });
    return pool;
}

const query = (text, params) => getPool().query(text, params);
const one = async (text, params) => (await query(text, params)).rows[0] || null;
const many = async (text, params) => (await query(text, params)).rows;

// Runs fn(client) inside BEGIN/COMMIT on one connection; rolls back on error.
async function tx(fn) {
    const client = await getPool().connect();
    try {
        await client.query(`SET search_path TO ${SCHEMA}`);
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

// Waits until Postgres answers (used at startup).
async function waitForDb(timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < until) {
        try { await query('SELECT 1'); return; } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error(`Postgres not reachable: ${lastErr && lastErr.message}`);
}

async function close() { if (pool) { await pool.end(); pool = null; } }

module.exports = { SCHEMA, makePool, getPool, query, one, many, tx, waitForDb, close };
