// Broadcast engine on Postgres. One `broadcasts` row per run and one `call_targets` row
// per number. A target is claimed (pending -> dialling) in the DB *before* it is dialled,
// so after a crash we know exactly which numbers were never attempted: only those
// ('pending') are ever dialled again. 'dialling' left behind by a crash becomes 'unknown'
// (attempted, outcome unknown) and is never re-dialled.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const secrets = require('./secrets');
const sarvam = require('../sarvam');
const guard = require('./guard');
const { dedupeRecipients, validatePhone, PROVIDERS, httpError } = require('./util');

const AGENT_GREETING_LABEL = '(Sarvam agent greeting)';
// Read when used: these may be set from the database at boot (config.applyDbEnv).
const sarvamMaxCallMs = () => (parseInt(process.env.SARVAM_MAX_CALL_MINUTES, 10) || 10) * 60 * 1000;
const resumeWindowMs = () => (parseInt(process.env.VOXSEND_RESUME_MINUTES, 10) || 30) * 60 * 1000;
const VOBIZ_PLAN_LIMIT = 12;
const SUCCESS = ['queued', 'connected', 'no_answer', 'busy'];

let active = null;                       // in-memory view of the running broadcast (for the UI)
const sarvamWaiters = new Map();         // attempt_id -> done()
const vobizWaiters = new Map();          // call uuid -> done()
let canRun = () => true;                 // set by the scheduler: only the lock holder dials
let autoResumeOk = () => false;          // automatic resumes only when the scheduler is on
const setRunGate = (fn, autoFn) => { canRun = fn; if (autoFn) autoResumeOk = autoFn; };

const log = (type, text) => {
    if (!active) return;
    active.logs.push({ type, text, time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) });
    if (active.logs.length > 3000) active.logs.splice(0, active.logs.length - 3000);
};
// Capability tokens for the provider-facing endpoints (derived from the webhook secret).
const derive = async label => crypto.createHmac('sha256', await secrets.ensureWebhookSecret()).update(label).digest('hex').slice(0, 32);
const vobizHangupToken = () => derive('vobiz-hangup');
const xmlSignature = (msg, voice, lang, p) => derive(`xml|${msg}|${voice}|${lang}|${p}`);
async function checkToken(given, expected) {
    const a = Buffer.from(String(given || '')), b = Buffer.from(await expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const status = () => active ? { ...active, logs: active.logs.slice(-400) } : { active: false };
const isBusy = () => !!(active && active.active);

// ── webhook signing (per-call metadata echoed back by Sarvam) ──
async function signer() {
    const secret = await secrets.ensureWebhookSecret();
    return (key, to) => crypto.createHmac('sha256', secret).update(`${key}|${to}`).digest('hex');
}
async function verifyWebhookMeta(meta = {}) {
    if (!meta || !meta.sig || !meta.to) return false;
    const given = Buffer.from(String(meta.sig));
    const check = expected => { const e = Buffer.from(expected); return e.length === given.length && crypto.timingSafeEqual(e, given); };
    const secret = await secrets.get('webhook_secret').catch(() => null);
    if (secret && check(crypto.createHmac('sha256', secret).update(`${meta.broadcast}|${meta.to}`).digest('hex'))) return true;
    // Calls placed by the old SQLite app were signed with the Sarvam API key.
    const key = await secrets.get('sarvam_key').catch(() => null);
    return !!key && sarvam.verifyMetadata(key, meta);
}

// ── create ──
async function create({ nums, msg, lang, sentBy, provider, voice, agentId, occurrenceId, occurrenceNote }) {
    const { unique, duplicates, invalid } = dedupeRecipients(nums || []);
    if (!unique.length) throw httpError(400, invalid.length ? `No valid recipients: ${invalid.length} invalid number${invalid.length > 1 ? 's' : ''} (${invalid[0].phone}: ${invalid[0].reason}).` : 'No valid recipients provided.');
    provider = provider || 'twilio';
    if (!PROVIDERS.includes(provider)) throw httpError(400, 'Unknown provider.');
    const message = provider === 'sarvam' ? '' : String(msg || '').trim();
    if (!message && provider !== 'sarvam') throw httpError(400, 'Message is empty.');
    const agent = provider === 'sarvam' ? await config.resolveAgent(agentId) : null;
    return db.tx(async client => {
        const b = (await client.query(`INSERT INTO broadcasts (occurrence_id, provider, agent_id, message, language, voice, sent_by, total, recipients_total, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'running') RETURNING *`,
            [occurrenceId || null, provider, agent ? agent.id : null, message, lang || 'hi', voice || null, sentBy || null, unique.length])).rows[0];
        await client.query(`UPDATE broadcasts SET started_key=$2 WHERE id=$1`, [b.id, `bc:${b.id}`]);
        const values = [];
        const tuples = unique.map((p, i) => { values.push(p); return `($1, $2, $${i + 3})`; });
        await client.query(`INSERT INTO call_targets (broadcast_id, occurrence_id, phone) VALUES ${tuples.join(',')}`,
            [b.id, occurrenceId || null, ...values]);
        // Invalid numbers are recorded but never dialled.
        for (const bad of invalid) {
            await client.query(`INSERT INTO call_targets (broadcast_id, occurrence_id, phone, status, error) VALUES ($1,$2,$3,'skipped',$4)`,
                [b.id, occurrenceId || null, bad.phone, `skipped: invalid number (${bad.reason})`]);
        }
        if (occurrenceId) await client.query(`UPDATE scheduled_calls SET broadcast_id=$2, status='started', note=$3, updated_at=now() WHERE id=$1`,
            [occurrenceId, b.id, occurrenceNote || null]);
        return { broadcast: { ...b, started_key: `bc:${b.id}` }, duplicates };
    });
}

// Validates, creates and starts a broadcast in the background.
async function start(opts) {
    if (!canRun()) throw httpError(503, 'This server is not the active call runner (another voxsend process holds the scheduler lock).');
    if (isBusy()) throw httpError(400, 'A broadcast is already in progress.');
    const provider = opts.provider || (await config.getCredentials()).provider;
    const blocked = guard.dialBlockedReason(provider);
    if (blocked) throw httpError(400, blocked);
    const creds = await credsFor(provider, opts.agentId);
    const missing = config.missingCredentials(provider, creds);
    if (missing) throw httpError(400, `${missing}. Save credentials in the API tab first.`);
    const { broadcast, duplicates } = await create({ ...opts, provider });
    run(broadcast.id).catch(e => console.error('Broadcast run error:', e));
    return { id: broadcast.id, duplicates, total: broadcast.total };
}

async function credsFor(provider, agentId) {
    const creds = await config.getCredentials();
    if (provider !== 'sarvam') return creds;
    return config.withAgent(creds, await config.resolveAgent(agentId));
}

// ── run (fresh or resumed): dials only targets still 'pending' ──
async function run(broadcastId, { resumed = false } = {}) {
    const b = await db.one('SELECT * FROM broadcasts WHERE id=$1', [broadcastId]);
    if (!b) throw new Error('broadcast not found');
    const provider = b.provider;
    const creds = provider === 'sarvam' ? config.withAgent(await config.getCredentials(), b.agent_id ? await config.getAgent(b.agent_id) : await config.defaultAgent())
        : await config.getCredentials();
    const counts = await targetCounts(broadcastId);
    const pending = (await db.many("SELECT id, phone FROM call_targets WHERE broadcast_id=$1 AND status='pending' ORDER BY id", [broadcastId]));
    const settings = await config.getSettings();
    active = {
        active: true, id: b.id, total: b.total, current: b.total - counts.pending, successful: counts.successful, failed: counts.failed,
        logs: [], startTime: b.started_at.toISOString(), msg: b.message, lang: b.language, sentBy: b.sent_by,
        provider, voice: b.voice || 'Polly.Aditi', occurrenceId: b.occurrence_id, resumed, stopped: false
    };
    // Never dial an invalid number (also catches numbers edited straight in the DB).
    const skipped = await db.many("SELECT phone, error FROM call_targets WHERE broadcast_id=$1 AND status='skipped' AND error LIKE 'skipped: invalid number%'", [broadcastId]);
    for (let i = pending.length - 1; i >= 0; i--) {
        const v = validatePhone(pending[i].phone);
        if (v.ok) continue;
        await db.query("UPDATE call_targets SET status='skipped', error=$2, updated_at=now() WHERE id=$1", [pending[i].id, `skipped: invalid number (${v.reason})`]);
        skipped.push({ phone: pending[i].phone, error: `skipped: invalid number (${v.reason})` });
        pending.splice(i, 1);
    }
    if (!resumed) skipped.forEach(x => log('error', `${x.phone} ${x.error}`));
    if (resumed) log('info', `Resuming: ${pending.length} number${pending.length === 1 ? '' : 's'} not dialled yet; ${b.total - pending.length} already attempted are skipped.`);
    const flush = setInterval(() => saveProgress(b.id).catch(() => {}), 5000);

    const sign = provider === 'sarvam' ? await signer() : null;
    const baseUrl = (creds.public_url || '').replace(/\/$/, '');
    const msg = b.message || '';
    const voice = active.voice;
    const language = voice.includes('Aditi') || voice.includes('Kajal') ? 'hi-IN' : (voice.includes('Joanna') ? 'en-US' : 'en-IN');
    let ttsUrl = null;
    const xmlUrl = async p => `${baseUrl}/api/vobiz/xml?msg=${encodeURIComponent(msg)}&voice=${voice}&lang=${language}&p=${p}&s=${await xmlSignature(msg, voice, language, p)}`;
    if (provider === 'vobiz') ttsUrl = await xmlUrl('vobiz');
    else if (provider === 'twilio') ttsUrl = baseUrl ? await xmlUrl('twilio')
        : `http://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(msg)}`;
    const hangupToken = provider === 'vobiz' ? await vobizHangupToken() : null;

    const configured = parseInt(settings.parallel_calls, 10) || VOBIZ_PLAN_LIMIT;
    const MAX = provider === 'vobiz' ? Math.min(configured, VOBIZ_PLAN_LIMIT) : configured;
    let slots = 0;
    const waiting = [];
    const acquire = () => new Promise(r => { if (slots < MAX) { slots++; r(); } else waiting.push(r); });
    const release = () => { if (waiting.length) waiting.shift()(); else slots--; };
    const callTimeoutMs = Math.max((Math.ceil((msg.length / 750) * 60) + 60) * 1000, 180000);

    const finishTarget = async (t, st, fields = {}) => {
        const sql = `UPDATE call_targets SET status=$2, error=$3, attempt_id=COALESCE($4, attempt_id), finished_at=CASE WHEN $2 IN ('failed') THEN now() ELSE finished_at END, updated_at=now() WHERE id=$1`;
        try {
            await db.query(sql, [t.id, st, fields.error || null, fields.attemptId || null]);
        } catch (e) {
            if (e.code !== '23505') throw e;
            // Provider reused an attempt id we already know: keep the outcome, note the id in the error text.
            await db.query(sql, [t.id, st, `${fields.error || ''} (duplicate provider attempt id ${fields.attemptId})`.trim(), null]);
        }
    };

    const blocked = guard.dialBlockedReason(provider);
    if (blocked) { log('err', blocked); active.stopped = true; }
    const callOne = async t => {
        await acquire();
        let waitForEnd = null;
        try {
            if (!active || active.stopped) return;
            // Lost the runner lock (e.g. DB connection dropped): stop claiming numbers.
            // The rest stay pending and can be resumed; nothing is dialled twice.
            if (!canRun()) {
                if (!active.paused) { active.paused = true; log('err', 'Paused: this process lost the call-runner lock. Numbers not dialled yet stay pending (Resume later).'); }
                return;
            }
            const claim = await db.query(`UPDATE call_targets SET status='dialling', attempts=attempts+1, dialled_at=now(), updated_at=now()
                WHERE id=$1 AND status='pending' RETURNING id`, [t.id]);
            if (claim.rowCount !== 1) return; // already attempted elsewhere: never dial twice
            const n = t.phone.startsWith('+') ? t.phone : '+' + t.phone;
            let ok = false, detail = '', attemptId = null;
            try {
                if (provider === 'vobiz') {
                    for (let attempt = 1; attempt <= 10; attempt++) {
                        const body = { from: creds.vobiz_from, to: n, answer_url: ttsUrl, answer_method: 'GET' };
                        if (baseUrl) { body.hangup_url = `${baseUrl}/api/vobiz/hangup-callback/${hangupToken}`; body.hangup_method = 'POST'; }
                        const r = await fetch(`https://api.vobiz.ai/api/v1/Account/${creds.vobiz_id}/Call/`, {
                            method: 'POST', headers: { 'X-Auth-ID': creds.vobiz_id, 'X-Auth-Token': creds.vobiz_token, 'Content-Type': 'application/json' },
                            body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
                        });
                        const j = await r.json().catch(() => ({}));
                        ok = r.ok; detail = ok ? `Call UUID: ${j.call_uuid}` : (j.message || JSON.stringify(j));
                        const busy = !ok && (r.status === 429 || /concurren|limit|capacity/i.test(detail));
                        if (busy && attempt < 10) { log('info', `[Vobiz] Concurrency limit hit. Waiting 15s before retry (${attempt}/10)...`); await new Promise(x => setTimeout(x, 15000)); continue; }
                        if (ok && j.call_uuid) { attemptId = j.call_uuid; waitForEnd = vobizWait(creds, j.call_uuid, callTimeoutMs); }
                        break;
                    }
                } else if (provider === 'sarvam') {
                    const key = b.started_key || `bc:${b.id}`;
                    const webhookUrl = baseUrl ? `${baseUrl}/api/sarvam/webhook` : null;
                    const r = await sarvam.placeCall(creds, { to: n, message: '', lang: b.language, webhookUrl,
                        metadata: { broadcast: key, to: n, target: t.id, sig: sign(key, n) } });
                    ok = r.ok; detail = ok ? `Call queued (attempt ${r.attemptId})` : r.message; attemptId = r.attemptId || null;
                    if (ok) {
                        await db.query(`INSERT INTO sarvam_calls (attempt_id, phone, status, message, broadcast_started_at, broadcast_id)
                            VALUES ($1,$2,'queued',NULL,$3,$4) ON CONFLICT (attempt_id) DO NOTHING`, [attemptId, n, key, b.id]).catch(() => {});
                        if (webhookUrl) waitForEnd = new Promise(resolve => {
                            const timer = setTimeout(() => { sarvamWaiters.delete(attemptId); resolve(); }, sarvamMaxCallMs());
                            sarvamWaiters.set(attemptId, () => { clearTimeout(timer); resolve(); });
                        });
                    }
                } else {
                    const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString('base64');
                    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/Calls.json`, {
                        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ To: n, From: creds.from, Url: ttsUrl }), signal: AbortSignal.timeout(30000)
                    });
                    const j = await r.json().catch(() => ({}));
                    ok = r.ok; detail = ok ? 'Call queued' : (j.message || `HTTP ${r.status}`); attemptId = j.sid || null;
                }
            } catch (err) { ok = false; detail = `Network error: ${err.message}`; }

            if (ok) {
                await finishTarget(t, 'queued', { attemptId });
                active.successful++;
                log('ok', `[${provider}] Queued to ${n}`);
            } else {
                await finishTarget(t, 'failed', { error: String(detail).slice(0, 500), attemptId });
                active.failed++;
                log('err', `[${provider}] Failed ${n}: ${detail}`);
                await db.query('INSERT INTO call_failures (phone, error, broadcast_started_at, broadcast_id) VALUES ($1,$2,$3,$4)',
                    [n, String(detail).slice(0, 1000), b.started_key || `bc:${b.id}`, b.id]).catch(() => {});
            }
        } catch (e) {
            console.error('callOne error:', e.message);
        } finally {
            if (active) active.current++;
            if (waitForEnd) await waitForEnd;
            if (provider === 'vobiz') await new Promise(r => setTimeout(r, 1000));
            release();
        }
    };

    try {
        await Promise.all(pending.map(callOne));
    } finally {
        clearInterval(flush);
        await finish(b.id).catch(e => console.error('Broadcast finish error:', e.message));
    }
}

function vobizWait(creds, uuid, timeoutMs) {
    return new Promise(resolve => {
        const done = () => { vobizWaiters.delete(uuid); resolve(); };
        vobizWaiters.set(uuid, done);
        (async () => {
            for (let i = 0; i < Math.ceil(timeoutMs / 5000) && vobizWaiters.has(uuid); i++) {
                try {
                    const r = await fetch(`https://api.vobiz.ai/api/v1/Account/${creds.vobiz_id}/Call/${uuid}/`, {
                        headers: { 'X-Auth-ID': creds.vobiz_id, 'X-Auth-Token': creds.vobiz_token }, signal: AbortSignal.timeout(15000) });
                    if (r.ok) {
                        const d = await r.json();
                        const s = String(d.call_status || d.status || '').toLowerCase();
                        if (['completed', 'failed', 'busy', 'no-answer', 'canceled', 'hangup'].includes(s)) return done();
                    }
                } catch (e) {}
                await new Promise(x => setTimeout(x, 5000));
            }
            if (vobizWaiters.has(uuid)) done();
        })();
    });
}
const vobizHangup = uuid => { const w = vobizWaiters.get(uuid); if (w) w(); };

async function targetCounts(broadcastId, client = db) {
    const r = (await client.query(`SELECT COUNT(*) FILTER (WHERE status='pending')::int pending,
        COUNT(*) FILTER (WHERE status = ANY($2))::int successful, COUNT(*) FILTER (WHERE status='failed')::int failed,
        COUNT(*) FILTER (WHERE status IN ('dialling','unknown'))::int unknown, COUNT(*)::int total
        FROM call_targets WHERE broadcast_id=$1`, [broadcastId, SUCCESS])).rows[0];
    return r;
}

async function saveProgress(id) {
    if (!active || active.id !== id) return;
    // A stop requested from elsewhere (CLI in DB mode, another server process).
    const sr = await db.one('SELECT stop_requested FROM broadcasts WHERE id=$1', [id]);
    if (sr && sr.stop_requested && !active.stopped) await stop();
    const c = await targetCounts(id);
    await db.query('UPDATE broadcasts SET successful=$2, failed=$3, logs=$4 WHERE id=$1', [id, c.successful, c.failed, JSON.stringify(active.logs)]);
}

async function finish(id) {
    const c = await targetCounts(id);
    const mine = active && active.id === id;
    const stopped = !!(mine && active.stopped && !active.paused);
    const paused = !!(mine && active.paused);
    const st = c.pending > 0 ? (stopped ? 'stopped' : 'interrupted') : 'completed';
    const logs = active && active.id === id ? active.logs : [];
    await db.tx(async client => {
        const b = (await client.query(`UPDATE broadcasts SET status=$2, successful=$3, failed=$4, logs=CASE WHEN $5::jsonb = '[]'::jsonb THEN logs ELSE $5::jsonb END,
            finished_at=CASE WHEN $2='completed' OR $2='stopped' THEN now() ELSE finished_at END, stop_requested=false WHERE id=$1 RETURNING *`,
            [id, st, c.successful, c.failed, JSON.stringify(logs)])).rows[0];
        if (st === 'interrupted') {
            const ref = b.occurrence_id ? ((await client.query('SELECT run_at FROM scheduled_calls WHERE id=$1', [b.occurrence_id])).rows[0] || {}).run_at : b.started_at;
            const auto = paused && autoResumeOk() && Date.now() - new Date(ref || b.started_at).getTime() <= resumeWindowMs();
            await client.query('UPDATE broadcasts SET interrupted_at=now(), resume_requested=$2, note=$3 WHERE id=$1', [id, auto,
                paused ? `Paused: lost the call-runner lock; ${c.pending} not dialled${auto ? ' (resuming automatically)' : '. Resume available.'}` : `${c.pending} not dialled. Resume available.`]);
        }
        const recipients = (await client.query('SELECT phone FROM call_targets WHERE broadcast_id=$1 ORDER BY id', [id])).rows.map(r => r.phone).join('\n');
        const h = await client.query(`UPDATE history SET total=$2, successful=$3, results=$4, recipients=$5 WHERE broadcast_id=$1`,
            [id, b.total, c.successful, JSON.stringify(b.logs), recipients]);
        if (!h.rowCount) {
            await client.query(`INSERT INTO history (message, language, total, successful, recipients, results, created_at, broadcast_id, agent_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [b.message || AGENT_GREETING_LABEL, b.language, b.total, c.successful, recipients,
                JSON.stringify(b.logs), b.started_at, id, b.agent_id]);
        }
        if (b.occurrence_id) {
            const note = st === 'completed' ? `Sent ${c.successful}, failed ${c.failed}${c.unknown ? `, ${c.unknown} unknown` : ''}`
                : `${st === 'stopped' ? 'Stopped' : 'Interrupted'}: ${c.pending} of ${b.total} not dialled yet`;
            await client.query(`UPDATE scheduled_calls SET status=$2, note=$3, updated_at=now() WHERE id=$1 AND status IN ('started','starting','interrupted')`,
                [b.occurrence_id, st === 'completed' ? 'completed' : 'interrupted', note]);
            const g = (await client.query('SELECT group_id FROM scheduled_calls WHERE id=$1', [b.occurrence_id])).rows[0];
            if (g) await refreshGroup(client, g.group_id);
        }
    });
    console.log(`Broadcast ${id} ${st}: sent ${c.successful}, failed ${c.failed}, not dialled ${c.pending}`);
    if (active && active.id === id) active.active = false;
}

async function refreshGroup(client, groupId) {
    const c = (await client.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE status IN ('pending','starting','started','interrupted'))::int p,
        COUNT(*) FILTER (WHERE status='cancelled')::int x FROM scheduled_calls WHERE group_id=$1`, [groupId])).rows[0];
    if (!c.n) return;
    const st = c.p > 0 ? 'active' : (c.x === c.n ? 'cancelled' : 'completed');
    await client.query('UPDATE schedule_groups SET status=$2, updated_at=now() WHERE id=$1', [groupId, st]);
}

async function stop() {
    if (!isBusy()) return false;
    active.stopped = true;
    await db.query('UPDATE broadcasts SET stop_requested=true WHERE id=$1', [active.id]).catch(() => {});
    log('info', 'Stop requested: numbers not dialled yet stay pending (you can resume later).');
    // Calls already placed carry on at the provider; stop holding slots for them.
    [...sarvamWaiters.values(), ...vobizWaiters.values()].forEach(done => done());
    sarvamWaiters.clear();
    return true;
}

// ── crash recovery (called once by the lock holder at boot) ──
// Never touches the broadcast this process is still running (lock re-acquired mid-run).
async function recoverAfterRestart({ allowAuto = false } = {}) {
    const out = [];
    const own = isBusy() ? active.id : 0;
    await db.tx(async client => {
        await client.query(`UPDATE call_targets SET status='unknown', error=COALESCE(error, 'Server stopped while this call was being placed: outcome unknown, not re-dialled'), updated_at=now()
            WHERE status='dialling' AND broadcast_id IN (SELECT id FROM broadcasts WHERE status='running' AND id<>$1)`, [own]);
        const rows = (await client.query(`UPDATE broadcasts SET status='interrupted', interrupted_at=now() WHERE status='running' AND id<>$1
            RETURNING id, occurrence_id, started_at, total`, [own])).rows;
        for (const b of rows) {
            const c = await targetCounts(b.id, client);
            let ref = b.started_at;
            if (b.occurrence_id) {
                const o = (await client.query('SELECT run_at FROM scheduled_calls WHERE id=$1', [b.occurrence_id])).rows[0];
                if (o) ref = o.run_at;
            }
            const auto = allowAuto && c.pending > 0 && Date.now() - new Date(ref).getTime() <= resumeWindowMs();
            await client.query(`UPDATE broadcasts SET resume_requested=$2, note=$3 WHERE id=$1`, [b.id, auto,
                c.pending ? (auto ? 'Interrupted by a restart; resuming automatically' : `Interrupted by a restart; ${c.pending} not dialled. Resume available.`) : null]);
            if (b.occurrence_id) {
                await client.query(`UPDATE scheduled_calls SET status='interrupted', note=$2, updated_at=now() WHERE id=$1 AND status IN ('started','starting')`,
                    [b.occurrence_id, c.pending ? `Interrupted by a restart: ${c.pending} of ${b.total} not dialled${auto ? ' (resuming automatically)' : ' — Resume available'}` : 'Interrupted by a restart']);
            }
            out.push({ id: b.id, pending: c.pending, auto });
        }
    });
    for (const r of out.filter(x => !x.pending)) await finish(r.id);
    return out;
}

// Marks a broadcast for resuming; the call runner picks it up on its next tick.
async function requestResume(id) {
    const b = await db.one('SELECT * FROM broadcasts WHERE id=$1', [id]);
    if (!b) throw httpError(404, 'Broadcast not found.');
    if (!['interrupted', 'stopped'].includes(b.status)) throw httpError(409, `Only an interrupted or stopped broadcast can be resumed (this one is ${b.status}).`);
    const c = await targetCounts(id);
    if (!c.pending) throw httpError(409, 'Every number in this broadcast was already attempted; nothing to resume.');
    await db.query('UPDATE broadcasts SET resume_requested=true, note=$2 WHERE id=$1', [id, 'Resume requested']);
    return { id, pending: c.pending, attempted: c.total - c.pending };
}

// Called by the scheduler tick (lock holder, nothing running): starts one requested resume.
async function runRequestedResume() {
    if (isBusy() || !canRun()) return null;
    const b = await db.one(`UPDATE broadcasts SET resume_requested=false, status='running', resumed_count=resumed_count+1, interrupted_at=NULL, note=NULL
        WHERE id=(SELECT id FROM broadcasts WHERE resume_requested AND status IN ('interrupted','stopped') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`);
    if (!b) return null;
    if (b.occurrence_id) {
        await db.query(`UPDATE scheduled_calls SET status='started', note=$2, updated_at=now() WHERE id=$1`, [b.occurrence_id, 'Resumed after interruption']);
    }
    run(b.id, { resumed: true }).catch(e => console.error('Resume run error:', e));
    return b.id;
}

// Broadcasts that can be resumed (for the UI, API and CLI).
const resumable = () => db.many(`SELECT b.id, b.status, b.provider, b.total, b.started_at, b.interrupted_at, b.note, b.resume_requested, b.occurrence_id,
        b.agent_id, (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=b.id AND t.status='pending') AS pending
    FROM broadcasts b WHERE b.status IN ('interrupted','stopped')
      AND EXISTS (SELECT 1 FROM call_targets t WHERE t.broadcast_id=b.id AND t.status='pending') ORDER BY b.id DESC`);

// ── Sarvam webhook result ──
const MAP_STATUS = s => (['connected', 'no_answer', 'busy', 'failed'].includes(s) ? s : (s ? 'failed' : 'unknown'));
async function sarvamResult(p) {
    const attemptId = p.attempt_id;
    const meta = (p.webhook_config && p.webhook_config.metadata) || {};
    const st = p.status || 'unknown';
    const reason = p.failure_reason || null;
    const transcript = p.interaction_transcript ? JSON.stringify(p.interaction_transcript) : null;
    const vars = p.final_agent_variables ? JSON.stringify(p.final_agent_variables) : null;
    const target = (await db.one('SELECT t.*, b.agent_id, b.occurrence_id AS b_occ FROM call_targets t JOIN broadcasts b ON b.id=t.broadcast_id WHERE t.attempt_id=$1', [attemptId]));
    await db.tx(async client => {
        await client.query(`INSERT INTO sarvam_calls (attempt_id, phone, status, duration, failure_reason, transcript, agent_variables, broadcast_started_at, broadcast_id, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
            ON CONFLICT (attempt_id) DO UPDATE SET status=EXCLUDED.status, duration=EXCLUDED.duration, failure_reason=EXCLUDED.failure_reason,
              transcript=EXCLUDED.transcript, agent_variables=EXCLUDED.agent_variables, updated_at=now()`,
            [attemptId, meta.to || (target && target.phone) || null, st, p.duration ?? null, reason, transcript, vars, meta.broadcast || null, target ? target.broadcast_id : null]);
        if (target) {
            await client.query(`UPDATE call_targets SET status=$2, error=$3, duration=$4, transcript=$5, agent_variables=$6, interaction_id=COALESCE($7, interaction_id),
                finished_at=now(), updated_at=now() WHERE id=$1`,
                [target.id, MAP_STATUS(st), reason, p.duration ?? null, transcript, vars, p.interaction_id || null]);
        }
        await client.query(`INSERT INTO call_history (attempt_id, interaction_id, phone, status, duration, failure_reason, agent_variables, transcript,
                transcript_fetched_at, broadcast_id, occurrence_id, agent_id, target_id, raw, source, ended_at, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::jsonb IS NULL THEN NULL ELSE now() END, $9,$10,$11,$12,$13,'webhook', now(), now())
            ON CONFLICT (attempt_id) DO UPDATE SET status=EXCLUDED.status, duration=COALESCE(EXCLUDED.duration, call_history.duration),
              failure_reason=EXCLUDED.failure_reason, agent_variables=COALESCE(EXCLUDED.agent_variables, call_history.agent_variables),
              transcript=COALESCE(EXCLUDED.transcript, call_history.transcript), interaction_id=COALESCE(EXCLUDED.interaction_id, call_history.interaction_id),
              transcript_fetched_at=COALESCE(call_history.transcript_fetched_at, EXCLUDED.transcript_fetched_at),
              broadcast_id=COALESCE(call_history.broadcast_id, EXCLUDED.broadcast_id), target_id=COALESCE(call_history.target_id, EXCLUDED.target_id),
              raw=EXCLUDED.raw, synced_at=now()`,
            [attemptId, p.interaction_id || null, meta.to || (target && target.phone) || null, st, p.duration ?? null, reason, vars, transcript,
             target ? target.broadcast_id : null, target ? target.occurrence_id : null, target ? target.agent_id : null, target ? target.id : null,
             JSON.stringify({ ...p, interaction_transcript: undefined })]);
        if (st !== 'connected' && target) {
            await client.query('INSERT INTO call_failures (phone, error, broadcast_started_at, broadcast_id) VALUES ($1,$2,$3,$4)',
                [target.phone, reason || st, meta.broadcast || null, target.broadcast_id]);
        }
    });
    if (active && target && target.broadcast_id === active.id) {
        const phone = target.phone;
        if (st === 'connected') log('ok', `[sarvam] Answered ${phone}${p.duration ? ` (${Math.round(p.duration)}s)` : ''}`);
        else if (st === 'no_answer' || st === 'busy') log('info', `[sarvam] ${phone}: ${st === 'busy' ? 'line busy' : 'no answer'}`);
        else { active.successful = Math.max(0, active.successful - 1); active.failed++; log('err', `[sarvam] Failed ${phone}: ${reason || st}`); }
    }
    const w = sarvamWaiters.get(attemptId);
    if (w) { sarvamWaiters.delete(attemptId); w(); }
}

module.exports = {
    start, run, stop, status, isBusy, setRunGate, recoverAfterRestart, requestResume, runRequestedResume, resumable,
    targetCounts, sarvamResult, verifyWebhookMeta, vobizHangup, vobizHangupToken, xmlSignature, checkToken, refreshGroup, AGENT_GREETING_LABEL,
    get RESUME_WINDOW_MS() { return resumeWindowMs(); }
};
