#!/usr/bin/env node
// One-shot copy of the voxsend SQLite database into PostgreSQL, with verification.
//
//   node scripts/migrate-sqlite-to-pg.js --sqlite /home/box/voxsend.App/voxsend.db [options]
//
// Options
//   --sqlite <file>        source SQLite DB (read only; a consistent snapshot is taken first)
//   --schema <name>        target schema (else $PGSCHEMA; there is no default)
//   --replace              target already has data: empty it first (same transaction). Refused
//                          when the target holds data born in Postgres (broadcasts, call targets,
//                          API tokens, synced call history): that would lose post-cutover data.
//   --import-env <file|->  also move credentials/PIN/provider from that .env file into the
//                          encrypted secrets table + settings, and seed the agents table
//   --scrub-before <date>  TEST COPIES ONLY: cancel pending/starting rows that run before
//                          <date> (e.g. 2027-01-01) so a test server can never act on real rows
//   --dry-run              do everything (including schema creation), verify, then ROLLBACK:
//                          the database is left exactly as it was
//   --report <file>        write the verification report (JSON) there
//
// Needs DATABASE_URL (role that owns the schema). Secrets need VOXSEND_MASTER_KEY_FILE.
// Everything runs in ONE transaction: on any error or verification mismatch nothing is
// committed and the exit code is 1. Secret VALUES are never printed, only their names.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const SQLITE = opt('sqlite');
if (opt('schema')) process.env.PGSCHEMA = opt('schema');
const REPLACE = !!opt('replace');
const DRY = !!opt('dry-run');
const IMPORT_ENV = opt('import-env');
// "-" reads the .env from stdin (cutover pipes it out of the encrypted vault: no plaintext file).
const IMPORT_ENV_TEXT = IMPORT_ENV ? require('fs').readFileSync(IMPORT_ENV === '-' ? 0 : IMPORT_ENV) : null;
const SCRUB = opt('scrub-before');
const REPORT = opt('report');
if (!SQLITE || SQLITE === true) { console.error('Usage: --sqlite <file> is required'); process.exit(2); }
if (SCRUB && !/^\d{4}-\d{2}-\d{2}$/.test(SCRUB)) { console.error('--scrub-before needs YYYY-MM-DD'); process.exit(2); }

const Database = require('better-sqlite3');
try { require('../lib/guard').assertDbAllowed(); } catch (e) { console.error(e.message); process.exit(2); }
const db = require('../lib/db');
const { migrate } = require('../lib/migrate');

// Source columns we deliberately do not copy (anything else unmapped fails the run).
const IGNORED_COLUMNS = { settings: ['id'] };
// Independent raw-time parser for the verification (does not share code with toTs):
// SQLite "YYYY-MM-DD HH:MM[:SS[.fff]]" is UTC; ISO strings carry Z or an offset.
function rawEpoch(v) {
    if (v === null || v === undefined || v === '') return null;
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!m) return NaN;
    const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
    if (m[8] && m[8] !== 'Z') {
        const sign = m[8][0] === '-' ? -1 : 1, d = m[8].slice(1).replace(':', '');
        t -= sign * (Number(d.slice(0, 2)) * 60 + Number(d.slice(2))) * 60000;
    }
    return t;
}

// ── value normalisers (the same functions are used to compare both sides) ──
// SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; the app also stored ISO strings.
function toTs(v) {
    if (v === null || v === undefined || v === '') return null;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
function toDate(v) {
    if (!v) return null;
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : undefined;
}
function toJson(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback === undefined ? null : fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return { __unparsed: v }; }
}
const canon = v => {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
};

// Table map: column -> type. Order matters for FKs (parents first).
const T = {
    settings: { parallel_calls: 'int', retry_failed: 'bool', default_language: 'text', delay_ms: 'int', org_name: 'text' },
    contacts: { id: 'int', name: 'text', phone: 'text', group_name: 'text', created_at: 'ts' },
    messages: { id: 'int', name: 'text', content: 'text', language: 'text', created_at: 'ts' },
    schedule_groups: {
        id: 'text', message: 'text', language: 'text', voice: 'text', provider: 'text', recipients: 'json[]', sent_by: 'text',
        repeat_mode: 'text', dates: 'json[]', start_date: 'date', end_date: 'date', end_after: 'int', weekdays: 'json[]',
        skip_weekends: 'bool', times: 'json[]', timezone: 'text', settings: 'json{}', occurrences: 'int', status: 'text',
        created_at: 'ts', updated_at: 'ts'
    },
    scheduled_calls: {
        id: 'int', group_id: 'text', message: 'text', language: 'text', voice: 'text', provider: 'text', recipients: 'json[]',
        run_at: 'ts', status: 'text', note: 'text', sent_by: 'text', created_at: 'ts', updated_at: 'ts'
    },
    history: { id: 'int', message: 'text', language: 'text', total: 'int', successful: 'int', recipients: 'text', results: 'json', created_at: 'ts' },
    call_failures: { id: 'int', phone: 'text', error: 'text', broadcast_started_at: 'text', failed_at: 'ts' },
    sarvam_calls: {
        attempt_id: 'text', phone: 'text', status: 'text', duration: 'real', failure_reason: 'text', transcript: 'json',
        agent_variables: 'json', message: 'text', broadcast_started_at: 'text', created_at: 'ts', updated_at: 'ts'
    }
};
const KEY = { settings: null, schedule_groups: 'id', sarvam_calls: 'attempt_id' }; // default key: id

const warnings = [];
function norm(table, col, type, v, side) {
    switch (type) {
        case 'int': return v === null || v === undefined || v === '' ? null : Math.trunc(Number(v));
        case 'real': return v === null || v === undefined || v === '' ? null : Number(v);
        case 'bool': return v === null || v === undefined ? false : (v === true || v === 1 || v === '1' || v === 't');
        case 'text': return v === null || v === undefined ? null : String(v);
        case 'ts': {
            if (v instanceof Date) return v.toISOString();
            const t = toTs(v);
            if (t === undefined) { if (side === 'src') warnings.push(`${table}.${col}: unreadable time ${JSON.stringify(v)} -> NULL`); return null; }
            return t;
        }
        case 'date': {
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            const d = toDate(v);
            if (d === undefined) { if (side === 'src') warnings.push(`${table}.${col}: unreadable date ${JSON.stringify(v)} -> NULL`); return null; }
            return d;
        }
        case 'json': return toJson(v, null);
        case 'json[]': return toJson(v, []);
        case 'json{}': return toJson(v, {});
        default: throw new Error('type ' + type);
    }
}
const normRow = (table, row, side) => {
    const out = {};
    for (const [c, t] of Object.entries(T[table])) out[c] = norm(table, c, t, row[c], side);
    return out;
};
// Postgres parameter for a normalised value.
const param = (type, v) => (type.startsWith('json') ? (v === null ? null : JSON.stringify(v)) : v);

function sqliteSnapshot(file) {
    if (!fs.existsSync(file)) throw new Error(`SQLite file not found: ${file}`);
    const snap = path.join(os.tmpdir(), `voxsend-snapshot-${process.pid}-${Date.now()}.db`);
    return { snap };
}

(async () => {
    const started = Date.now();
    // 1. Consistent snapshot of the live SQLite DB (online backup API; the source is opened read-only).
    const { snap } = sqliteSnapshot(SQLITE);
    const live = new Database(SQLITE, { readonly: true, fileMustExist: true });
    await live.backup(snap);
    live.close();
    const src = new Database(snap, { readonly: true });
    const srcSha = crypto.createHash('sha256').update(fs.readFileSync(snap)).digest('hex');
    const has = name => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

    const source = {}, raw = {}, unmapped = [];
    for (const table of Object.keys(T)) {
        if (!has(table)) { source[table] = []; raw[table] = []; warnings.push(`source has no ${table} table`); continue; }
        const cols = new Set(src.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        for (const c of cols) if (!(c in T[table]) && !(IGNORED_COLUMNS[table] || []).includes(c)) unmapped.push(`${table}.${c}`);
        raw[table] = src.prepare(`SELECT * FROM ${table}`).all();
        source[table] = raw[table].map(r0 => {
            const r = { ...r0 };
            for (const c of Object.keys(T[table])) if (!cols.has(c)) r[c] = null;
            return normRow(table, r, 'src');
        });
    }
    const knownTables = new Set([...Object.keys(T), 'sqlite_sequence']);
    src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        .forEach(t => { if (!knownTables.has(t.name)) unmapped.push(`${t.name} (whole table)`); });
    const sqliteSeq = has('sqlite_sequence') ? Object.fromEntries(src.prepare('SELECT name, seq FROM sqlite_sequence').all().map(r => [r.name, r.seq])) : {};
    src.close();
    for (const f of [snap, snap + '-wal', snap + '-shm', snap + '-journal']) { try { fs.unlinkSync(f); } catch (e) {} }
    // Old rows without a group get the same id the app gives them.
    source.scheduled_calls.forEach(r => { if (!r.group_id) r.group_id = 'single-' + r.id; });
    // Every scheduled row needs its group (FK); create minimal groups for orphans.
    const groupIds = new Set(source.schedule_groups.map(g => g.id));
    for (const r of source.scheduled_calls) {
        if (groupIds.has(r.group_id)) continue;
        groupIds.add(r.group_id);
        warnings.push(`scheduled_calls ${r.id}: group ${r.group_id} missing in source, created from the row`);
        source.schedule_groups.push(normRow('schedule_groups', {
            id: r.group_id, message: r.message, language: r.language, voice: r.voice, provider: r.provider,
            recipients: JSON.stringify(r.recipients), sent_by: r.sent_by, repeat_mode: 'dates', status: 'active', created_at: r.created_at
        }, 'src'));
    }
    if (!source.settings.length) source.settings.push(normRow('settings', {}, 'src'));

    // 2. One transaction in Postgres.
    const client = await db.getPool().connect();
    const report = { schema: db.SCHEMA, sqlite: path.resolve(SQLITE), sqliteSnapshotSha256: srcSha, dryRun: DRY, tables: {}, checks: [], warnings };
    let ok = false;
    try {
        if (unmapped.length) throw new Error(`Source has columns/tables this script does not map: ${unmapped.join(', ')}`);
        // Schema creation happens inside the same transaction, so --dry-run leaves no trace.
        await client.query('BEGIN');
        await migrate(client, { log: m => console.log(m), inTransaction: true });
        await client.query(`SET LOCAL search_path TO ${db.SCHEMA}`);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('voxsend:sqlite-import'))");

        const dataTables = ['contacts', 'messages', 'schedule_groups', 'scheduled_calls', 'history', 'call_failures', 'sarvam_calls',
            'broadcasts', 'call_targets', 'call_history', 'agents', 'sessions', 'api_tokens', 'secrets'];
        const counts = {};
        for (const t of dataTables) counts[t] = (await client.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
        const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
        if (nonEmpty.length && !REPLACE) {
            throw new Error(`Target schema ${db.SCHEMA} already has data (${nonEmpty.map(([t, n]) => `${t}=${n}`).join(', ')}). Use --replace to empty it first.`);
        }
        const pgBorn = ['broadcasts', 'call_targets', 'api_tokens'].filter(t => counts[t] > 0);
        const synced = (await client.query("SELECT COUNT(*)::int n FROM call_history WHERE source IS DISTINCT FROM 'import'")).rows[0].n;
        if (synced) pgBorn.push(`call_history (${synced} synced/webhook rows)`);
        if (nonEmpty.length && pgBorn.length) {
            throw new Error(`Refusing --replace: ${db.SCHEMA} holds data created in Postgres (${pgBorn.join(', ')}); replacing it would lose that data.`);
        }
        if (nonEmpty.length) {
            await client.query(`TRUNCATE ${dataTables.join(', ')} RESTART IDENTITY CASCADE`);
            console.log(`Emptied target tables (${nonEmpty.map(([t]) => t).join(', ')})`);
        }

        // 3. Copy rows, keeping ids.
        await client.query(`UPDATE settings SET parallel_calls=$1, retry_failed=$2, default_language=$3, delay_ms=$4, org_name=$5, updated_at=now() WHERE id=1`,
            ['parallel_calls', 'retry_failed', 'default_language', 'delay_ms', 'org_name'].map(c => {
                const v = source.settings[0][c];
                return v === null && c !== 'org_name' ? { parallel_calls: 12, default_language: 'hi-IN', delay_ms: 200, retry_failed: false }[c] : v;
            }));
        for (const table of ['contacts', 'messages', 'schedule_groups', 'scheduled_calls', 'history', 'call_failures', 'sarvam_calls']) {
            const cols = Object.keys(T[table]);
            const types = cols.map(c => T[table][c]);
            const rows = source[table];
            for (let i = 0; i < rows.length; i += 200) {
                const chunk = rows.slice(i, i + 200);
                const values = [];
                const tuples = chunk.map((r, j) => '(' + cols.map((c, k) => {
                    let v = param(types[k], r[c]);
                    // NOT NULL columns with defaults in the new schema
                    if (v === null && ['created_at', 'failed_at'].includes(c)) v = new Date(0).toISOString();
                    if (v === null && table === 'scheduled_calls' && c === 'message') v = '';
                    values.push(v);
                    return '$' + values.length;
                }).join(',') + ')');
                await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
            }
            if (T[table].id === 'int') {
                // Continue after SQLite's own counter too, so ids SQLite already handed out are never reused.
                const seq = Number(sqliteSeq[table] || 0);
                await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), $1::bigint, 1),
                    (SELECT COUNT(*) > 0 FROM ${table}) OR $1::bigint > 0)`, [seq]);
            }
            console.log(`Copied ${rows.length} ${table} row(s)`);
        }

        // 4. Optional: secrets, settings and agents from the old .env.
        if (IMPORT_ENV) {
            const secrets = require('../lib/secrets');
            const envimport = require('../lib/envimport');
            const env = require('dotenv').parse(IMPORT_ENV_TEXT);
            // Every key of the old .env goes into the database (see lib/envimport.js) ...
            await envimport.apply(client, env);
            const wh = crypto.randomBytes(32).toString('base64url');
            await secrets.set('webhook_secret', wh, client);
            // ... and is proven there before anything commits: decrypt + SHA-256 compare.
            const check = await envimport.verify(client, env);
            const bad = check.filter(c => c.ok === false);
            report.envImport = check;
            if (bad.length) throw new Error(`.env import verification failed for: ${bad.map(c => c.key).join(', ')}`);
            const imported = check.filter(c => c.ok).map(c => `${c.key} -> ${c.dest}`).concat(['webhook_secret (new)']);
            const provider = (await client.query('SELECT provider FROM settings WHERE id=1')).rows[0].provider;
            report.secretsImported = imported;
            report.settingsFromEnv = { provider, public_url: env.PUBLIC_URL ? '(set)' : '(empty)' };
            check.filter(c => c.ok === null).forEach(c => console.log(`  .env ${c.key}: ${c.dest}`));
            // Agents: the agent in use becomes the default; an inactive example shows the format.
            if (env.SARVAM_APP_ID) {
                const v = parseInt(env.SARVAM_APP_VERSION, 10);
                const a = await client.query(`INSERT INTO agents (label, app_id, version, notes, active, is_default)
                    VALUES ('Current agent', $1, $2, 'Imported from the old .env', true, true) RETURNING id`, [env.SARVAM_APP_ID, v > 0 ? v : null]);
                const agentId = a.rows[0].id;
                await client.query("UPDATE schedule_groups SET agent_id=$1 WHERE provider='sarvam' AND agent_id IS NULL", [agentId]);
                await client.query("UPDATE scheduled_calls SET agent_id=$1 WHERE provider='sarvam' AND agent_id IS NULL", [agentId]);
                report.agents = [{ id: agentId, label: 'Current agent', default: true }];
            }
            await client.query(`INSERT INTO agents (label, app_id, version, notes, active, is_default)
                VALUES ('Example agent (edit me)', 'example-app-id', NULL, 'Example only: inactive, so it is not offered in the picker', false, false)`);
            console.log(`Imported from .env (each verified by decrypting and comparing SHA-256):\n  ${imported.join('\n  ')}`);
        }

        // 4b. Call history: seed from the Sarvam webhook results we already have.
        const ch = await client.query(`INSERT INTO call_history (attempt_id, phone, status, duration, failure_reason, transcript, transcript_fetched_at,
                agent_variables, started_at, app_id, agent_id, source, synced_at)
            SELECT s.attempt_id, s.phone, s.status, s.duration, s.failure_reason, s.transcript, CASE WHEN s.transcript IS NULL THEN NULL ELSE s.updated_at END,
                s.agent_variables, s.created_at, a.app_id, a.id, 'import', now()
            FROM sarvam_calls s LEFT JOIN agents a ON a.is_default
            ON CONFLICT (attempt_id) DO NOTHING`);
        report.callHistoryImported = ch.rowCount;
        console.log(`Seeded ${ch.rowCount} call_history row(s) from sarvam_calls`);

        // 5. Verify: counts and a row-by-row comparison of every copied column.
        for (const table of Object.keys(T)) {
            const cols = Object.keys(T[table]);
            const key = table === 'settings' ? null : (KEY[table] || 'id');
            const pgRows = (await client.query(`SELECT ${cols.join(',')} FROM ${table}${table === 'settings' ? ' WHERE id=1' : ''}`)).rows
                .map(r => normRow(table, r, 'pg'));
            const want = source[table];
            const byKey = rows => new Map(rows.map(r => [key ? String(r[key]) : '1', canon(r)]));
            const a = byKey(want), b = byKey(pgRows);
            const mismatched = [...a.keys()].filter(k => a.get(k) !== b.get(k));
            const extra = [...b.keys()].filter(k => !a.has(k));
            const hash = m => crypto.createHash('sha256').update([...m.entries()].sort().map(e => e.join('=')).join('\n')).digest('hex').slice(0, 16);
            report.tables[table] = { source: want.length, postgres: pgRows.length, mismatched: mismatched.slice(0, 10), extra: extra.slice(0, 10), sourceHash: hash(a), postgresHash: hash(b) };
            if (want.length !== pgRows.length || mismatched.length || extra.length) {
                report.checks.push({ table, ok: false });
            } else report.checks.push({ table, ok: true });
        }
        // 5b. Raw check, independent of the normalisers: every time column as epoch ms
        //     (Postgres side computed by Postgres) against the raw SQLite text, every date as text.
        for (const table of Object.keys(T)) {
            const key = table === 'settings' ? null : (KEY[table] || 'id');
            const tsCols = Object.keys(T[table]).filter(c => T[table][c] === 'ts');
            const dateCols = Object.keys(T[table]).filter(c => T[table][c] === 'date');
            if (!key || (!tsCols.length && !dateCols.length)) continue;
            const sel = [`${key}::text AS k`, ...tsCols.map(c => `(EXTRACT(EPOCH FROM ${c}) * 1000)::bigint AS "${c}"`), ...dateCols.map(c => `${c}::text AS "${c}"`)];
            const pgMap = new Map((await client.query(`SELECT ${sel.join(',')} FROM ${table}`)).rows.map(r => [r.k, r]));
            const bad = [];
            for (const r of raw[table]) {
                const pr = pgMap.get(String(r[key]));
                if (!pr) { bad.push(`${r[key]}: missing`); continue; }
                for (const c of tsCols) {
                    const want = rawEpoch(r[c]);
                    const fallback = ['created_at', 'failed_at'].includes(c) && want === null ? 0 : want;
                    if (Number.isNaN(want)) bad.push(`${r[key]}.${c}: unreadable ${JSON.stringify(r[c])}`);
                    else if ((pr[c] === null ? null : Number(pr[c])) !== fallback) bad.push(`${r[key]}.${c}: sqlite ${JSON.stringify(r[c])} pg ${pr[c]}`);
                }
                for (const c of dateCols) {
                    const want = r[c] ? String(r[c]).slice(0, 10) : null;
                    if (pr[c] !== want) bad.push(`${r[key]}.${c}: sqlite ${JSON.stringify(r[c])} pg ${pr[c]}`);
                }
            }
            report.rawTimeChecks = report.rawTimeChecks || {};
            report.rawTimeChecks[table] = { rows: raw[table].length, columns: [...tsCols, ...dateCols], bad: bad.slice(0, 10), badCount: bad.length };
            report.checks.push({ table: `${table} (raw times)`, ok: bad.length === 0 });
        }
        if (warnings.some(w => /unreadable/.test(w))) report.checks.push({ table: 'unreadable values', ok: false });

        // Explicit checks the cutover cares about: every pending/started schedule row and all history.
        const pending = (await client.query("SELECT id, group_id, run_at, status, jsonb_array_length(recipients) n, provider, agent_id FROM scheduled_calls WHERE status IN ('pending','starting','started') ORDER BY run_at")).rows;
        report.pendingSchedules = pending.map(r => ({ id: r.id, run_at: r.run_at.toISOString(), status: r.status, recipients: r.n, provider: r.provider, agent_id: r.agent_id }));
        report.history = (await client.query('SELECT id, created_at, total, successful FROM history ORDER BY id')).rows
            .map(r => ({ id: r.id, created_at: r.created_at.toISOString(), total: r.total, successful: r.successful }));

        // 6. Test copies only: neutralise real upcoming rows (after verification, so it is visible in the report).
        if (SCRUB) {
            const r = await client.query(`UPDATE scheduled_calls SET status='cancelled', note='Scrubbed in test copy', updated_at=now()
                WHERE status IN ('pending','starting','started') AND run_at < $1::date RETURNING id`, [SCRUB]);
            await client.query(`UPDATE schedule_groups g SET status='cancelled' WHERE NOT EXISTS
                (SELECT 1 FROM scheduled_calls s WHERE s.group_id=g.id AND s.status IN ('pending','starting','started'))`);
            report.scrubbed = r.rows.map(x => x.id);
            console.log(`Scrubbed (cancelled) ${r.rowCount} pre-${SCRUB} row(s) in this TEST copy: ${report.scrubbed.join(', ') || '-'}`);
        }

        ok = report.checks.every(c => c.ok);
        if (!ok) throw new Error('Verification failed: ' + report.checks.filter(c => !c.ok).map(c => c.table).join(', '));
        if (DRY) { await client.query('ROLLBACK'); console.log('Dry run: verified, rolled back.'); }
        else { await client.query('COMMIT'); console.log('Committed.'); }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        report.error = e.message;
        console.error('MIGRATION FAILED (nothing committed):', e.message);
        ok = false;
    } finally {
        client.release();
        await db.close();
    }
    report.ok = ok;
    report.seconds = Math.round((Date.now() - started) / 100) / 10;
    for (const [t, r] of Object.entries(report.tables)) console.log(`  ${t.padEnd(16)} sqlite=${String(r.source).padStart(4)} postgres=${String(r.postgres).padStart(4)} ${r.mismatched.length || r.extra.length ? 'MISMATCH' : 'ok'}`);
    if (warnings.length) console.log(`Warnings (${warnings.length}):\n  ` + warnings.slice(0, 20).join('\n  '));
    if (REPORT && REPORT !== true) { fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); console.log('Report: ' + REPORT); }
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
