#!/usr/bin/env node
// Explicit post-migration checks for the cutover (independent of the migration's own report):
//   node scripts/verify-cutover.js --sqlite <backup.db> [--expect-history-date YYYY-MM-DD [--expect-history-count N]]
//       [--expect-pending 2,3,4,14,15,16] [--expect-groups <id>,<id>] [--env <old .env>|-] [--json]
// Compares, with plain SQL on both sides: row counts of every copied table; every SQLite
// pending/starting/started schedule row (same id, same instant, same status, same numbers);
// every history row (id, created_at instant, totals). With --env (a file, or "-" for stdin so
// no plaintext copy is needed on disk): every key of the old .env is decrypted from the
// database and compared by SHA-256 (only key names and ok/mismatch are printed).
// Exit 0 only if everything matches.
'use strict';
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const SQLITE = opt('sqlite'), HDATE = opt('expect-history-date'), ENVF = opt('env');
const HCOUNT = Number(opt('expect-history-count') || 1);
const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const WANT_PENDING = list(opt('expect-pending')).map(Number), WANT_GROUPS = list(opt('expect-groups'));
if (!SQLITE) { console.error('--sqlite required'); process.exit(2); }
require('../lib/guard').assertDbAllowed();
const Database = require('better-sqlite3');
const db = require('../lib/db');
const utc = v => { // SQLite text -> epoch ms (UTC for "YYYY-MM-DD HH:MM:SS")
    if (!v) return null; const s = String(v).trim();
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
};
(async () => {
    const s = new Database(SQLITE, { readonly: true, fileMustExist: true });
    const fails = [], info = {};
    for (const t of ['contacts', 'messages', 'schedule_groups', 'scheduled_calls', 'history', 'call_failures', 'sarvam_calls']) {
        const a = s.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
        const b = (await db.one(`SELECT COUNT(*)::int n FROM ${t}`)).n;
        info[t] = `${a}/${b}`;
        if (a !== b) fails.push(`${t}: sqlite ${a} vs postgres ${b}`);
    }
    const live = s.prepare(`SELECT id, run_at, status, recipients, provider, message FROM scheduled_calls WHERE status IN ('pending','starting','started') ORDER BY run_at`).all();
    const rows = [];
    for (const r of live) {
        if (r.status !== 'pending') fails.push(`sqlite row ${r.id} is ${r.status}: a broadcast was running`);
        const p = await db.one(`SELECT id, (EXTRACT(EPOCH FROM run_at)*1000)::bigint ms, status, jsonb_array_length(recipients) n, recipients, provider, message
            FROM scheduled_calls WHERE id=$1`, [r.id]);
        const nums = JSON.parse(r.recipients || '[]');
        const ok = p && Number(p.ms) === utc(r.run_at) && p.status === r.status && p.n === nums.length
            && JSON.stringify(p.recipients) === JSON.stringify(nums) && p.provider === r.provider && (p.message || '') === (r.message || '');
        rows.push({ id: r.id, run_at: new Date(utc(r.run_at)).toISOString(), status: p ? p.status : 'MISSING', numbers: nums.length, ok: !!ok });
        if (!ok) fails.push(`scheduled_calls ${r.id} differs in Postgres`);
    }
    const hist = s.prepare('SELECT id, created_at, total, successful FROM history ORDER BY id').all();
    for (const h of hist) {
        const p = await db.one('SELECT (EXTRACT(EPOCH FROM created_at)*1000)::bigint ms, total, successful FROM history WHERE id=$1', [h.id]);
        if (!p || Number(p.ms) !== utc(h.created_at) || p.total !== h.total || p.successful !== h.successful) fails.push(`history ${h.id} differs`);
    }
    if (HDATE) {
        const day = hist.filter(h => new Date(utc(h.created_at)).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === HDATE);
        info.historyOnDate = `${HDATE}: ${day.length}`;
        if (day.length < HCOUNT) fails.push(`${day.length} history row(s) on ${HDATE} (IST) in SQLite, expected at least ${HCOUNT}`);
    }
    // Named rows: pending on both sides.
    for (const id of WANT_PENDING) {
        const a = s.prepare('SELECT status FROM scheduled_calls WHERE id=?').get(id);
        const b = await db.one('SELECT status FROM scheduled_calls WHERE id=$1', [id]);
        if (!a || a.status !== 'pending' || !b || b.status !== 'pending') fails.push(`row ${id}: sqlite ${a ? a.status : 'missing'}, postgres ${b ? b.status : 'missing'} (expected pending)`);
    }
    if (WANT_PENDING.length) info.expectedPending = WANT_PENDING.join(',');
    // Named groups: the group row and every one of its scheduled rows (any status) match.
    const groups = [];
    for (const gid of WANT_GROUPS) {
        const a = s.prepare('SELECT * FROM schedule_groups WHERE id=?').get(gid);
        const b = await db.one('SELECT * FROM schedule_groups WHERE id=$1', [gid]);
        const g = { id: gid, ok: false, rows: 0, pending: 0, numbers: 0 };
        groups.push(g);
        if (!a || !b) { fails.push(`group ${gid}: sqlite ${a ? 'ok' : 'missing'}, postgres ${b ? 'ok' : 'missing'}`); continue; }
        const j = v => { try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v || 'null') : v); } catch (e) { return String(v); } };
        const diffs = [];
        if (j(a.recipients) !== j(b.recipients)) diffs.push('recipients');
        if ((a.message || '') !== (b.message || '')) diffs.push('message');
        if (a.provider !== b.provider) diffs.push('provider');
        if ((a.repeat_mode || '') !== (b.repeat_mode || '')) diffs.push('repeat_mode');
        if (j(a.times || '[]') !== j(b.times || [])) diffs.push('times');
        if ((a.status || '') !== (b.status || '')) diffs.push('status');
        const ra = s.prepare('SELECT id, run_at, status FROM scheduled_calls WHERE group_id=? ORDER BY id').all(gid);
        const rb = await db.many('SELECT id, (EXTRACT(EPOCH FROM run_at)*1000)::bigint ms, status FROM scheduled_calls WHERE group_id=$1 ORDER BY id', [gid]);
        const ka = ra.map(r => `${r.id}@${utc(r.run_at)}:${r.status}`).join(' '), kb = rb.map(r => `${r.id}@${Number(r.ms)}:${r.status}`).join(' ');
        if (ka !== kb) diffs.push('scheduled rows');
        g.rows = ra.length; g.pending = ra.filter(r => r.status === 'pending').length;
        g.numbers = (JSON.parse(j(a.recipients)) || []).length; g.ok = !diffs.length;
        if (diffs.length) fails.push(`group ${gid} differs: ${diffs.join(', ')}`);
    }
    let envCheck = null;
    if (ENVF) {
        const env = require('dotenv').parse(require('fs').readFileSync(ENVF === '-' ? 0 : ENVF));
        const c = await db.getPool().connect();
        try { envCheck = await require('../lib/envimport').verify(c, env); } finally { c.release(); }
        envCheck.filter(e => e.ok === false).forEach(e => fails.push(`.env ${e.key} does not match ${e.dest}`));
        info.envKeys = `${envCheck.filter(e => e.ok).length} verified, ${envCheck.filter(e => e.ok === null).length} not stored`;
    }
    const res = { ok: !fails.length, counts: info, liveScheduleRows: rows, groups, historyRows: hist.length, envCheck, fails };
    if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
    else {
        console.log('counts (sqlite/postgres):', Object.entries(info).map(([k, v]) => `${k}=${v}`).join(' '));
        rows.forEach(r => console.log(`  schedule row ${r.id}: ${r.run_at} ${r.status} ${r.numbers} numbers ${r.ok ? 'OK' : 'MISMATCH'}`));
        groups.forEach(g => console.log(`  group ${g.id}: ${g.rows} rows (${g.pending} pending), ${g.numbers} numbers ${g.ok ? 'OK' : 'MISMATCH'}`));
        (envCheck || []).forEach(e => console.log(`  .env ${e.key} -> ${e.dest}: ${e.ok === null ? '-' : e.ok ? 'OK (decrypted, sha256 match)' : 'MISMATCH'}`));
        console.log(res.ok ? 'VERIFY OK' : 'VERIFY FAILED:\n  ' + fails.join('\n  '));
    }
    s.close(); await db.close();
    process.exit(res.ok ? 0 : 1);
})().catch(e => { console.error('VERIFY ERROR:', e.message); process.exit(1); });
