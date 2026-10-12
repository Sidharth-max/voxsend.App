#!/usr/bin/env node
// Rollback helper: writes the current Postgres data back into a SQLite file the old app can run.
//   node scripts/export-pg-to-sqlite.js --base <pre-cutover backup.db> --out <new.db>
// Starts from a copy of the pre-cutover SQLite backup and, in one SQLite transaction, makes
// contacts, messages, settings, schedule_groups, scheduled_calls, history, call_failures and
// sarvam_calls equal to Postgres (rows deleted in Postgres are deleted; ids are kept). Data that
// only exists in Postgres (broadcasts, call_targets, call_history, agents, tokens) has no SQLite
// home and stays in the Postgres backup. Time strings keep their original text when unchanged.
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const BASE = opt('base'), OUT = opt('out');
if (!BASE || !OUT) { console.error('usage: --base <backup.db> --out <new.db>'); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} already exists`); process.exit(2); }
require('../lib/guard').assertDbAllowed();
const Database = require('better-sqlite3');
const db = require('../lib/db');

const COLS = {
    contacts: ['id', 'name', 'phone', 'group_name', 'created_at'],
    messages: ['id', 'name', 'content', 'language', 'created_at'],
    schedule_groups: ['id', 'message', 'language', 'voice', 'provider', 'recipients', 'sent_by', 'repeat_mode', 'dates', 'start_date', 'end_date', 'end_after',
        'weekdays', 'skip_weekends', 'times', 'timezone', 'settings', 'occurrences', 'status', 'created_at', 'updated_at'],
    scheduled_calls: ['id', 'message', 'language', 'voice', 'provider', 'recipients', 'run_at', 'status', 'note', 'sent_by', 'group_id', 'created_at', 'updated_at'],
    history: ['id', 'message', 'language', 'total', 'successful', 'recipients', 'results', 'created_at'],
    call_failures: ['id', 'phone', 'error', 'broadcast_started_at', 'failed_at'],
    sarvam_calls: ['attempt_id', 'phone', 'status', 'duration', 'failure_reason', 'transcript', 'agent_variables', 'message', 'broadcast_started_at', 'created_at', 'updated_at']
};
const KEY = { sarvam_calls: 'attempt_id' };
const ISO_COLS = new Set(['scheduled_calls.run_at', 'history.created_at']);
const sqlTs = d => d.toISOString().replace('T', ' ').slice(0, 19);
const epoch = v => { if (!v) return null; const s = String(v); return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s); };

(async () => {
    fs.copyFileSync(BASE, OUT);
    const s = new Database(OUT);
    const summary = {};
    const pg = {};
    for (const t of Object.keys(COLS)) pg[t] = await db.many(`SELECT ${COLS[t].join(',')} FROM ${t}`);
    const settings = await db.one('SELECT parallel_calls, retry_failed, default_language, delay_ms, org_name FROM settings WHERE id=1');
    s.transaction(() => {
        for (const [t, cols] of Object.entries(COLS)) {
            const key = KEY[t] || 'id';
            const have = new Set(s.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
            const use = cols.filter(c => have.has(c));
            const base = new Map(s.prepare(`SELECT * FROM ${t}`).all().map(r => [String(r[key]), r]));
            const keep = new Set(pg[t].map(r => String(r[key])));
            let deleted = 0;
            for (const k of base.keys()) if (!keep.has(k)) { s.prepare(`DELETE FROM ${t} WHERE ${key}=?`).run(k); deleted++; }
            const ins = s.prepare(`INSERT OR REPLACE INTO ${t} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`);
            for (const r of pg[t]) {
                const old = base.get(String(r[key]));
                ins.run(use.map(c => {
                    const v = r[c];
                    if (v instanceof Date) {
                        if (old && old[c] && epoch(old[c]) === v.getTime()) return old[c];
                        return ISO_COLS.has(`${t}.${c}`) ? v.toISOString() : sqlTs(v);
                    }
                    if (typeof v === 'boolean') return v ? 1 : 0;
                    if (v !== null && typeof v === 'object') return JSON.stringify(v);
                    return v;
                }));
            }
            summary[t] = { postgres: pg[t].length, deletedFromSqlite: deleted };
        }
        if (settings) s.prepare('UPDATE settings SET parallel_calls=?, retry_failed=?, default_language=?, delay_ms=?, org_name=? WHERE id=1')
            .run(settings.parallel_calls, settings.retry_failed ? 1 : 0, settings.default_language, settings.delay_ms, settings.org_name);
    })();
    s.close(); await db.close();
    console.log(JSON.stringify(summary));
})().catch(e => { console.error('EXPORT FAILED:', e.message); try { fs.unlinkSync(OUT); } catch (x) {} process.exit(1); });
