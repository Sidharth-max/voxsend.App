#!/usr/bin/env node
// voxsend CLI. Two modes:
//   DB mode (default): talks to Postgres directly using the app's .env (DATABASE_URL, PGSCHEMA,
//     VOXSEND_MASTER_KEY_FILE). Same safety guards as the server. Calls are placed only by the
//     server, so "broadcasts start" needs API mode; everything else works here.
//   API mode: --api <url> (or VOXSEND_API_URL) with VOXSEND_TOKEN=vxs_... (see "tokens create").
// Run "voxsend help" for commands. Secret values are never printed and never taken from argv.
'use strict';
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) flags[k] = v;
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
        else flags[k] = true;
        if (Array.isArray(flags['_' + k])) flags['_' + k].push(flags[k]); else flags['_' + k] = [flags[k]];
    } else pos.push(a);
}
const many = k => (flags['_' + k] || []).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
const JSON_OUT = !!flags.json;
const API = flags.api || process.env.VOXSEND_API_URL || null;

const HELP = `voxsend <command> [options]          (add --json for machine-readable output)

  status                                   runner, active broadcast, resumable runs
  contacts list [--group G]                contacts add <phone> [--name N] [--group G]
  contacts import <file.csv>               (columns: name,phone,group)
  contacts remove <phone>...
  lists                                    contact groups with counts;  lists show <name>
  agents list                              agents add --label L --app-id ID [--version N] [--default] [--inactive]
  agents set <id> [--label L] [--app-id ID] [--version N|none] [--active yes|no]
  agents default <id>                      agents remove <id>
  schedules list                           schedules show <group-id>
  schedules create (--numbers N,N | --group G ...) [--provider sarvam] [--agent ID] [--message M] [--language hi]
        times:  --at 2027-01-05T10:30+05:30 [--at ...]
            or  --daily|--weekly --from YYYY-MM-DD (--to YYYY-MM-DD | --count N) --time HH:MM [--time ...]
                [--weekdays 1,3,5] [--skip-weekends] [--tz Asia/Kolkata]
            or  --dates 2027-01-05,2027-01-09 --time HH:MM
  schedules move <time-id> <ISO time>      schedules cancel <group-id>   schedules cancel-time <time-id>
  broadcasts list [--status S]             broadcasts show <id>          broadcasts resumable
  broadcasts resume <id>                   broadcasts stop
  broadcasts start (--numbers ...|--group G) [--provider] [--agent] [--message] --yes   (API mode only)
  calls list [--q TEXT] [--status answered|not_answered|failed|<raw>] [--agent ID] [--broadcast ID]
             [--from ISO] [--to ISO] [--limit N] [--offset N]
  calls show <attempt-id>                  calls transcript <attempt-id> [--refresh]
  calls sync [--days N]
  secrets list                             secrets set <name>   (value from a hidden prompt or --stdin)
  secrets clear <name>                     secrets set-pin      secrets rotate-key
  tokens list                              tokens create <name> [--scopes read,write,admin] [--days N]
  tokens revoke <id>
  db status                                db migrate             db backup
  scheduler status|on|off                  settings.scheduler_enabled (prod app only; applies on restart)

Modes: DB mode by default (uses the app .env); API mode with --api URL and VOXSEND_TOKEN.`;

const out = (data, human) => {
    if (JSON_OUT || !human) return console.log(JSON.stringify(data, null, 2));
    human(data);
};
const table = (rows, cols) => {
    if (!rows.length) return console.log('(none)');
    const w = cols.map(c => Math.min(48, Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length))));
    console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
    rows.forEach(r => console.log(cols.map((c, i) => String(r[c] ?? '').slice(0, 48).padEnd(w[i])).join('  ')));
};
const fail = (msg, code = 1) => { console.error('error: ' + msg); process.exit(code); };
const ist = v => v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : '';

async function readSecret(prompt) {
    if (flags.stdin || !process.stdin.isTTY) {
        const chunks = []; for await (const c of process.stdin) chunks.push(c);
        return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    }
    process.stderr.write(prompt);
    return new Promise(resolve => {
        const stdin = process.stdin; let v = '';
        stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
        stdin.on('data', function on(ch) {
            if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); process.stderr.write('\n'); resolve(v); }
            else if (ch === '\u0003') process.exit(130);
            else if (ch === '\u007f') v = v.slice(0, -1);
            else v += ch;
        });
    });
}

// ── schedule body from flags ──
function scheduleFromFlags() {
    const b = { numbers: many('numbers'), groups: many('group'), provider: flags.provider, message: flags.message, language: flags.language || 'hi',
        agentId: flags.agent ? Number(flags.agent) : undefined, sentBy: 'CLI' };
    const tz = flags.tz || 'Asia/Kolkata';
    if (many('at').length) b.runAts = many('at').map(t => { const d = Date.parse(t); if (Number.isNaN(d)) fail(`bad --at ${t}`); return new Date(d).toISOString(); });
    else if (flags.daily || flags.weekly) b.rule = { mode: flags.weekly ? 'weekly' : 'daily', startDate: flags.from, endDate: flags.to || null,
        endAfter: flags.count ? Number(flags.count) : null, times: many('time'), weekdays: many('weekdays').map(Number), skipWeekends: !!flags['skip-weekends'], timezone: tz };
    else if (flags.dates) b.rule = { mode: 'dates', dates: many('dates'), times: many('time'), timezone: tz };
    else fail('give --at, --daily/--weekly, or --dates (see "voxsend help")');
    return b;
}

// ── API mode ──
async function api(method, p, body) {
    const token = process.env.VOXSEND_TOKEN;
    if (!token) fail('API mode needs VOXSEND_TOKEN (create one with "voxsend tokens create" in DB mode).');
    const r = await fetch(API.replace(/\/$/, '') + '/api/v1' + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) fail(j.error || `HTTP ${r.status}`);
    return j.data;
}

// ── DB mode ──
let L = null;
function dbMode() {
    if (L) return L;
    const guard = require('../lib/guard');
    const envFile = process.env.VOXSEND_ENV_FILE || path.join(__dirname, '..', '.env');
    guard.assertEnvFileAllowed(envFile);
    require('dotenv').config({ path: envFile, quiet: true });
    guard.assertDbAllowed();
    const db = require('../lib/db');
    L = { db, guard, config: require('../lib/config'), secrets: require('../lib/secrets'), auth: require('../lib/auth'),
        schedules: require('../lib/schedules'), service: require('../lib/service'), callsync: require('../lib/callsync'),
        broadcaster: require('../lib/broadcaster'), v1: require('../lib/v1'), migrate: require('../lib/migrate') };
    return L;
}

// One implementation per command: [apiCall, dbCall, humanPrinter]
async function run() {
    const [group, cmd, ...rest] = pos;
    const A = !!API;
    const call = async (apiFn, dbFn) => (A ? apiFn() : dbFn(dbMode()));
    switch (`${group || 'help'} ${cmd || ''}`.trim()) {
        case 'help': case 'help help': return console.log(HELP);
        case 'status': return out(await call(() => api('GET', '/status'), async x => {
            const s = await x.db.one('SELECT COUNT(*)::int n FROM broadcasts WHERE status=$1', ['running']);
            return { running: s.n, resumable: await x.broadcaster.resumable(), config: await x.config.publicConfig(),
                schema: x.db.SCHEMA, nextSchedule: await x.db.one(`SELECT id, run_at, provider FROM scheduled_calls WHERE status='pending' ORDER BY run_at LIMIT 1`) };
        }), d => {
            console.log(d.broadcast ? `Active broadcast: ${d.broadcast.active ? `yes (#${d.broadcast.id}, ${d.broadcast.current}/${d.broadcast.total})` : 'no'}` : `Running broadcasts: ${d.running}`);
            if (d.nextSchedule) console.log(`Next scheduled: #${d.nextSchedule.id} ${ist(d.nextSchedule.run_at)} (${d.nextSchedule.provider})`);
            console.log(`Provider: ${d.config.provider}; usable: ${Object.entries(d.config.configured).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
            console.log(`Resumable: ${d.resumable.map(r => `#${r.id} (${r.pending} not dialled)`).join(', ') || 'none'}`);
        });

        case 'contacts list': return out(await call(() => api('GET', '/contacts' + (flags.group ? `?group=${encodeURIComponent(flags.group)}` : '')),
            x => x.service.listContacts(flags.group !== undefined ? { group: flags.group } : {})), d => table(d, ['id', 'name', 'phone', 'group']));
        case 'contacts add': {
            if (!rest[0]) fail('usage: contacts add <phone> [--name N] [--group G]');
            const c = [{ phone: rest[0], name: flags.name || '', group: flags.group || '' }];
            return out(await call(() => api('POST', '/contacts', { contacts: c }), async x => ({ upserted: await x.service.upsertContacts(c) })));
        }
        case 'contacts import': {
            if (!rest[0]) fail('usage: contacts import <file.csv>');
            const lines = fs.readFileSync(rest[0], 'utf8').split(/\r?\n/).filter(Boolean);
            const head = lines[0].toLowerCase().split(',').map(s => s.trim());
            const idx = k => head.indexOf(k);
            if (idx('phone') < 0) fail('the CSV needs a "phone" column');
            const c = lines.slice(1).map(l => l.split(',').map(s => s.trim().replace(/^"|"$/g, ''))).map(r => ({ phone: r[idx('phone')], name: idx('name') >= 0 ? r[idx('name')] : '', group: idx('group') >= 0 ? r[idx('group')] : '' })).filter(c => c.phone);
            return out(await call(() => api('POST', '/contacts', { contacts: c }), async x => ({ upserted: await x.service.upsertContacts(c) })));
        }
        case 'contacts remove': return out(await call(() => api('DELETE', '/contacts', { phones: rest }), async x => ({ deleted: await x.service.deleteContacts(rest) })));
        case 'lists': return out(await call(() => api('GET', '/lists'), x => x.service.listGroups()), d => table(d, ['name', 'count']));
        case 'lists show': return out(await call(() => api('GET', `/lists/${encodeURIComponent(rest[0] || '')}`), x => x.service.groupNumbers([rest[0]])), d => d.forEach(n => console.log(n)));

        case 'agents list': return out(await call(() => api('GET', '/agents'), x => x.config.listAgents(true)),
            d => table(d.map(a => ({ ...a, version: a.version || 'latest', default: a.is_default ? 'yes' : '', active: a.active ? 'yes' : 'no' })), ['id', 'label', 'app_id', 'version', 'active', 'default']));
        case 'agents add': {
            const b = { label: flags.label, app_id: flags['app-id'], version: flags.version, is_default: !!flags.default, active: !flags.inactive };
            return out(await call(() => api('POST', '/agents', b), x => x.config.saveAgent(null, b)), a => console.log(`Agent #${a.id} "${a.label}" saved${a.is_default ? ' (default)' : ''}.`));
        }
        case 'agents set': {
            const ch = {};
            if (flags.label) ch.label = flags.label;
            if (flags['app-id']) ch.app_id = flags['app-id'];
            if (flags.version) ch.version = flags.version === 'none' ? '' : flags.version;
            if (flags.active) ch.active = /^(yes|true|1)$/i.test(flags.active);
            return out(await call(() => api('PATCH', `/agents/${rest[0]}`, ch), async x => {
                const cur = await x.config.getAgent(Number(rest[0])); if (!cur) fail('agent not found');
                return x.config.saveAgent(cur.id, { ...cur, ...ch });
            }), a => console.log(`Agent #${a.id} updated.`));
        }
        case 'agents default': return out(await call(() => api('POST', `/agents/${rest[0]}/default`), x => x.config.setDefaultAgent(Number(rest[0]))), a => console.log(`Default agent: #${a.id} ${a.label}`));
        case 'agents remove': return out(await call(() => api('DELETE', `/agents/${rest[0]}`), async x => { await x.config.deleteAgent(Number(rest[0])); return { deleted: true }; }));

        case 'schedules list': return out(await call(() => api('GET', '/schedules'), x => x.schedules.list()),
            d => table(d.filter(r => flags.all || ['pending', 'starting', 'started', 'interrupted'].includes(r.status)).map(r => ({ ...r, when: ist(r.run_at), agent: r.agent_label || '', left: r.resumable ? `${r.not_dialled} (resumable)` : '' })),
                ['id', 'when', 'status', 'provider', 'total', 'agent', 'left', 'group_id']));
        case 'schedules show': return out(await call(() => api('GET', `/schedules/${rest[0]}`), x => x.schedules.getGroup(rest[0])), d => {
            const g = d.group; console.log(`${g.id}  ${g.provider}  ${g.mode}  ${g.recipients.length} numbers  agent: ${g.agent_label || '-'}  status: ${g.status}`);
            table(d.rows.map(r => ({ ...r, when: ist(r.run_at) })), ['id', 'when', 'status', 'note']);
        });
        case 'schedules create': {
            const b = scheduleFromFlags();
            return out(await call(() => api('POST', '/schedules', b), async x => {
                const nums = await x.v1.recipients(b); const t = x.v1.times(b);
                return x.schedules.create({ nums, msg: b.message, lang: b.language, provider: b.provider, agentId: b.agentId, sentBy: 'CLI', runAts: t.runAts, rule: t.rule });
            }), d => console.log(`Scheduled ${d.occurrences} time(s) for ${d.total} numbers: ${ist(d.firstRunAt)} → ${ist(d.lastRunAt)} (group ${d.groupId})`));
        }
        case 'schedules move': return out(await call(() => api('PATCH', `/schedule-times/${rest[0]}`, { runAt: rest[1] }), x => x.schedules.moveTime(Number(rest[0]), rest[1])), d => console.log(`Moved #${d.id} to ${ist(d.run_at)}`));
        case 'schedules cancel': return out(await call(() => api('DELETE', `/schedules/${rest[0]}`), x => x.schedules.cancel({ group: rest[0] })), d => console.log(`Cancelled ${d.cancelled} pending time(s).`));
        case 'schedules cancel-time': return out(await call(() => api('DELETE', `/schedule-times/${rest[0]}`), x => x.schedules.cancel({ id: Number(rest[0]) })), d => console.log(`Cancelled ${d.cancelled}.`));

        case 'broadcasts list': return out(await call(() => api('GET', '/broadcasts' + (flags.status ? `?status=${flags.status}` : '')), x => x.service.listBroadcasts({ status: flags.status })),
            d => table(d.map(b => ({ ...b, started: ist(b.started_at), agent: b.agent_label || '' })), ['id', 'started', 'status', 'provider', 'total', 'successful', 'failed', 'not_dialled', 'agent']));
        case 'broadcasts show': return out(await call(() => api('GET', `/broadcasts/${rest[0]}`), x => x.service.getBroadcast(Number(rest[0]))), d => {
            console.log(`#${d.id} ${d.status} ${d.provider} total ${d.total} sent ${d.successful} failed ${d.failed} not dialled ${d.not_dialled}${d.note ? ' — ' + d.note : ''}`);
            table(d.targets, ['phone', 'status', 'attempts', 'error']);
        });
        case 'broadcasts resumable': return out(await call(() => api('GET', '/broadcasts/resumable'), x => x.broadcaster.resumable()),
            d => table(d.map(b => ({ ...b, started: ist(b.started_at) })), ['id', 'started', 'status', 'pending', 'note']));
        case 'broadcasts resume': return out(await call(() => api('POST', `/broadcasts/${rest[0]}/resume`), x => x.broadcaster.requestResume(Number(rest[0]))),
            d => console.log(`Resume requested for #${d.id}: ${d.pending} number(s) not dialled yet will be called by the server; ${d.attempted} already attempted are skipped.`));
        case 'broadcasts stop': return out(await call(() => api('POST', '/broadcasts/stop'), async x => ({ requested: (await x.db.query(`UPDATE broadcasts SET stop_requested=true WHERE status='running'`)).rowCount })));
        case 'broadcasts start': {
            if (!A) fail('starting a broadcast places real calls and is done by the server: use API mode (--api URL with VOXSEND_TOKEN).');
            if (!flags.yes) fail('this places real calls; add --yes to confirm.');
            return out(await api('POST', '/broadcasts', { numbers: many('numbers'), groups: many('group'), provider: flags.provider, message: flags.message,
                language: flags.language || 'hi', agentId: flags.agent ? Number(flags.agent) : undefined, confirm: true }));
        }

        case 'calls list': {
            const q = { q: flags.q, status: flags.status, agentId: flags.agent, broadcastId: flags.broadcast, from: flags.from, to: flags.to, limit: flags.limit || 50, offset: flags.offset || 0 };
            const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== true)).toString();
            return out(await call(() => api('GET', '/calls?' + qs), x => x.callsync.list(q)), d => {
                table(d.items.map(c => ({ ...c, when: ist(c.started_at || c.sort_at), secs: c.duration ? Math.round(c.duration) : '', agent: c.agent_label || '' })), ['when', 'phone', 'status', 'secs', 'agent', 'attempt_id']);
                console.log(`${d.items.length} of ${d.total}`);
            });
        }
        case 'calls show': return out(await call(() => api('GET', `/calls/${rest[0]}`), x => x.callsync.get(rest[0])));
        case 'calls transcript': return out(await call(() => api('GET', `/calls/${rest[0]}/transcript${flags.refresh ? '?refresh=1' : ''}`), x => x.callsync.transcript(rest[0], { refresh: !!flags.refresh })),
            d => { if (!d.turns.length) console.log(d.note || '(no transcript)'); d.turns.forEach(t => console.log(`${t.role.padEnd(6)} ${t.text}`)); });
        case 'calls sync': return out(await call(() => api('POST', '/calls/sync', { days: flags.days }), x => x.callsync.syncNow({ days: Number(flags.days) || null })));

        case 'secrets list': return out(await call(() => api('GET', '/secrets'), x => x.secrets.listMasked()), d => table(d, ['name', 'label', 'masked', 'updated_at']));
        case 'secrets set': {
            const name = rest[0];
            if (!name) fail('usage: secrets set <name>   (names: ' + require('../lib/config').FIELDS.join(', ') + ')');
            const value = await readSecret(`${name}: `);
            if (!value) fail('empty value; use "secrets clear" to remove');
            return out(await call(() => api('PUT', `/secrets/${name}`, { value }), async x => {
                if (!x.config.FIELDS.includes(name)) fail('unknown credential name');
                await x.config.saveCredentials({ [name]: value }); return { saved: name };
            }), () => console.log(`Saved ${name} (encrypted).`));
        }
        case 'secrets clear': return out(await call(() => api('DELETE', `/secrets/${rest[0]}`), async x => { await x.config.saveCredentials({ clear: [rest[0]] }); return { cleared: rest[0] }; }));
        case 'secrets set-pin': {
            if (A) fail('set the PIN in DB mode');
            const x = dbMode(); const a = await readSecret('New PIN: '); const b = flags.stdin ? a : await readSecret('Repeat: ');
            if (a !== b) fail('PINs differ');
            await x.secrets.setPin(a); return console.log('PIN updated (scrypt hash stored).');
        }
        case 'secrets rotate-key': {
            if (A) fail('rotate the key in DB mode');
            const r = await dbMode().secrets.rotateMasterKey();
            return out({ reencrypted: r.rows, version: r.version, keyId: r.keyId, oldKeyBackup: r.oldKeyBackup }, d => console.log(`Re-encrypted ${d.reencrypted} secret(s) with key ${d.keyId}; old key kept at ${d.oldKeyBackup}. Restart the server.`));
        }
        case 'tokens list': return out(await call(() => api('GET', '/tokens'), x => x.auth.listTokens()), d => table(d.map(t => ({ ...t, scopes: t.scopes.join(','), revoked: t.revoked_at ? 'yes' : '' })), ['id', 'name', 'prefix', 'scopes', 'last_used_at', 'expires_at', 'revoked']));
        case 'tokens create': {
            const scopes = many('scopes').length ? many('scopes') : ['read'];
            return out(await call(() => api('POST', '/tokens', { name: rest[0], scopes, days: flags.days ? Number(flags.days) : null }),
                x => x.auth.createToken(rest[0], scopes, flags.days ? Number(flags.days) : null)),
                t => { console.log(`Token #${t.id} "${t.name}" (${t.scopes.join(',')}). Shown once, store it now:`); console.log(t.token); });
        }
        case 'tokens revoke': return out(await call(() => api('DELETE', `/tokens/${rest[0]}`), async x => ({ revoked: await x.auth.revokeToken(Number(rest[0])) })));

        case 'scheduler status': case 'scheduler on': case 'scheduler off': {
            if (A) fail('scheduler commands run in DB mode');
            const x = dbMode();
            if (cmd !== 'status') {
                await x.db.query('UPDATE settings SET scheduler_enabled=$1, updated_at=now() WHERE id=1', [cmd === 'on']);
            }
            const enabled = await x.config.schedulerEnabled();
            return out({ scheduler_enabled: enabled, instance: x.guard.isProd() ? 'prod' : 'dev/test' }, d => console.log(
                `settings.scheduler_enabled = ${d.scheduler_enabled}` + (d.instance === 'prod' ? '' : ' (ignored: only the prod app honours it)') +
                (cmd === 'status' ? '' : '. Takes effect when the server restarts.')));
        }
        case 'db status': {
            if (A) fail('db commands run in DB mode');
            const x = dbMode(); const c = await x.db.getPool().connect();
            try {
                const have = await x.migrate.currentVersion(c);
                const counts = {};
                for (const t of ['contacts', 'schedule_groups', 'scheduled_calls', 'broadcasts', 'call_targets', 'history', 'call_history', 'agents', 'secrets']) counts[t] = (await c.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
                return out({ schema: x.db.SCHEMA, database: x.guard.dbName(), instance: x.guard.isProd() ? 'prod' : 'dev/test', version: have, latest: x.migrate.latestVersion(), counts },
                    d => { console.log(`${d.database}/${d.schema} (${d.instance}) schema v${d.version} (code v${d.latest})`); table(Object.entries(d.counts).map(([t, n]) => ({ table: t, rows: n })), ['table', 'rows']); });
            } finally { c.release(); }
        }
        case 'db migrate': {
            if (A) fail('db commands run in DB mode');
            const x = dbMode(); const c = await x.db.getPool().connect();
            try { const applied = await x.migrate.migrate(c); return out({ applied }, d => console.log(d.applied.length ? `Applied: ${d.applied.join(', ')}` : 'Schema is up to date.')); }
            finally { c.release(); }
        }
        case 'db backup': {
            const script = '/workspace/pg/backup.sh';
            if (!fs.existsSync(script)) fail('no backup script at ' + script);
            const r = require('child_process').spawnSync('bash', [script], { stdio: 'inherit' });
            process.exitCode = r.status; return;
        }
        default: console.error(`unknown command "${pos.join(' ')}"\n`); console.log(HELP); process.exitCode = 2;
    }
}

run().then(async () => { if (L) await L.db.close(); }).catch(async e => { console.error('error: ' + e.message); if (L) await L.db.close().catch(() => {}); process.exit(1); });
