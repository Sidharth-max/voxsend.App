// Call history from the Sarvam analytics API: background sync of call attempts into
// call_history, transcripts fetched on demand (and cached), recordings proxied so the
// browser never sees provider URLs or the API key.
const db = require('./db');
const config = require('./config');
const sarvam = require('../sarvam');
const guard = require('./guard');
const { httpError } = require('./util');

const syncMinutes = () => parseInt(process.env.VOXSEND_SYNC_MINUTES, 10) || 5; // read when used
const FIRST_WINDOW_DAYS = parseInt(process.env.VOXSEND_SYNC_FIRST_DAYS, 10) || 14;
let timer = null, running = null, lastResult = null, backoffUntil = 0;
const MIN_GAP_MS = 45000; // automatic syncs closer together than this reuse the last result

const analyticsBase = c => `${sarvam.baseUrl()}/api/analytics/v1/${encodeURIComponent(c.sarvam_org)}/${encodeURIComponent(c.sarvam_workspace)}`;

async function sarvamGet(c, path, params) {
    const blocked = guard.sarvamHttpBlockedReason();
    if (blocked) throw httpError(400, blocked);
    const url = new URL(analyticsBase(c) + path);
    Object.entries(params || {}).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
    const r = await fetch(url, { headers: { 'X-API-Key': c.sarvam_key, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch (e) { j = null; }
    if (r.status === 429 || r.status === 402) { const e = httpError(502, `Sarvam rate limit (HTTP ${r.status})`); e.backoff = true; throw e; }
    if (!r.ok) throw httpError(502, `Sarvam ${path.split('/')[2] || 'API'} error: ${(j && (j.message || (j.error && j.error.message) || j.detail)) || `HTTP ${r.status}`}`);
    return j;
}

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return null; };
const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Maps one analytics attempt to call_history columns.
function mapAttempt(a, appId, agentId) {
    const status = String(pick(a, 'connectivity_status', 'status') || '').toLowerCase() || null;
    return {
        attempt_id: String(pick(a, 'attempt_id', 'id')),
        interaction_id: pick(a, 'interaction_id'),
        app_id: appId, agent_id: agentId,
        phone: pick(a, 'user_contact', 'user_phone_number', 'phone', 'user_identifier'),
        status, duration: pick(a, 'duration_in_seconds', 'duration'),
        failure_reason: pick(a, 'failure_reason'),
        agent_variables: a.agent_variables || null,
        started_at: pick(a, 'start_datetime', 'started_at'), ended_at: pick(a, 'end_datetime', 'ended_at'),
        language: pick(a, 'language_name', 'language'), ended_by: pick(a, 'ended_by'),
        num_messages: pick(a, 'num_messages'), audio_url: pick(a, 'audio_url'), raw: a
    };
}

async function upsert(row) {
    await db.query(`INSERT INTO call_history (attempt_id, interaction_id, app_id, agent_id, phone, status, duration, failure_reason, agent_variables,
            started_at, ended_at, language, ended_by, num_messages, audio_url, raw, source, synced_at, broadcast_id, target_id, occurrence_id)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'sync',now(), t.broadcast_id, t.id, t.occurrence_id
        FROM (SELECT 1) one LEFT JOIN call_targets t ON t.attempt_id=$1
        ON CONFLICT (attempt_id) DO UPDATE SET interaction_id=COALESCE(EXCLUDED.interaction_id, call_history.interaction_id),
            app_id=COALESCE(call_history.app_id, EXCLUDED.app_id), agent_id=COALESCE(call_history.agent_id, EXCLUDED.agent_id),
            phone=COALESCE(call_history.phone, EXCLUDED.phone), status=COALESCE(EXCLUDED.status, call_history.status),
            duration=COALESCE(EXCLUDED.duration, call_history.duration), failure_reason=COALESCE(EXCLUDED.failure_reason, call_history.failure_reason),
            agent_variables=COALESCE(EXCLUDED.agent_variables, call_history.agent_variables), started_at=COALESCE(EXCLUDED.started_at, call_history.started_at),
            ended_at=COALESCE(EXCLUDED.ended_at, call_history.ended_at), language=COALESCE(EXCLUDED.language, call_history.language),
            ended_by=COALESCE(EXCLUDED.ended_by, call_history.ended_by), num_messages=COALESCE(EXCLUDED.num_messages, call_history.num_messages),
            audio_url=COALESCE(EXCLUDED.audio_url, call_history.audio_url), raw=EXCLUDED.raw,
            source=CASE WHEN call_history.source='webhook' THEN 'webhook+sync' ELSE call_history.source END, synced_at=now()`,
        [row.attempt_id, row.interaction_id, row.app_id, row.agent_id, row.phone, row.status, row.duration, row.failure_reason,
         row.agent_variables ? JSON.stringify(row.agent_variables) : null, row.started_at, row.ended_at, row.language, row.ended_by,
         row.num_messages, row.audio_url, JSON.stringify(row.raw)]);
}

// Pulls attempts for every agent (app id) we know, since the last sync (with overlap).
async function syncNow({ days = null, auto = false } = {}) {
    if (running) return running;
    if (Date.now() < backoffUntil) return lastResult || { skipped: 'backing off' };
    if (auto && !days && lastResult && Date.now() - new Date(lastResult.at) < MIN_GAP_MS) return lastResult;
    running = (async () => {
        const creds = await config.getCredentials();
        if (!creds.sarvam_key || !creds.sarvam_org || !creds.sarvam_workspace) return { skipped: 'Sarvam API key/org/workspace not set' };
        const agents = await db.many('SELECT id, app_id, is_default FROM agents ORDER BY is_default DESC, id');
        const apps = new Map();
        agents.forEach(a => { if (!apps.has(a.app_id)) apps.set(a.app_id, a.id); });
        const out = { apps: 0, fetched: 0, errors: [] };
        const end = new Date();
        for (const [appId, agentId] of apps) {
            const key = `sarvam_attempts:${appId}`;
            const st = await db.one('SELECT value FROM sync_state WHERE key=$1', [key]);
            let start = days ? new Date(end - days * 86400000)
                : st && st.value.last_end ? new Date(new Date(st.value.last_end) - 60 * 60000) : new Date(end - FIRST_WINDOW_DAYS * 86400000);
            try {
                for (let offset = 0; offset < 20000; offset += 500) {
                    const j = await sarvamGet(creds, `/${encodeURIComponent(appId)}/attempts`, {
                        start_datetime: fmt(start), end_datetime: fmt(end), limit: 500, offset, sort_by: 'start_datetime', sort_order: 'asc' });
                    const items = Array.isArray(j) ? j : (j && (j.items || j.data || j.attempts)) || [];
                    for (const a of items) if (pick(a, 'attempt_id', 'id')) { await upsert(mapAttempt(a, appId, agentId)); out.fetched++; }
                    if (items.length < 500) break;
                }
                await db.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ($1,$2,now())
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, JSON.stringify({ last_end: end.toISOString() })]);
                out.apps++;
            } catch (e) {
                if (e.backoff) { backoffUntil = Date.now() + 15 * 60000; break; } // rate limited: pause quietly
                out.errors.push(`${appId}: ${e.message}`);
            }
        }
        return out;
    })().then(r => { lastResult = { at: new Date().toISOString(), ...r }; return lastResult; })
        .catch(e => { lastResult = { at: new Date().toISOString(), error: e.message }; return lastResult; })
        .finally(() => { running = null; });
    return running;
}

function startBackground(isRunner) {
    if (String(process.env.VOXSEND_CALL_SYNC || 'on').toLowerCase() === 'off') return console.log('Call history sync is OFF.');
    timer = setInterval(() => { if (isRunner()) syncNow().catch(() => {}); }, syncMinutes() * 60000);
    setTimeout(() => { if (isRunner()) syncNow().catch(() => {}); }, 20000);
}
const stopBackground = () => clearInterval(timer);
const syncInfo = () => ({ everyMinutes: syncMinutes(), running: !!running, last: lastResult });

// ── reading ──
// One outcome per call, from status + duration + failure reason (placeholders count as no reason).
const OUTCOMES = ['answered', 'busy', 'no_answer', 'rejected', 'failed', 'no_reason'];
const OUTCOME_SQL = `CASE
    WHEN lower(coalesce(h.status,'')) IN ('rejected','declined') OR h.failure_reason ~* '(reject|declin)' THEN 'rejected'
    WHEN lower(coalesce(h.status,'')) = 'busy' OR h.failure_reason ~* 'busy' THEN 'busy'
    WHEN lower(coalesce(h.status,'')) IN ('no_answer','unanswered','not_connected') OR h.failure_reason ~* '(no_answer|no answer|noanswer|unanswered|timeout)' THEN 'no_answer'
    WHEN lower(coalesce(h.status,'')) IN ('connected','completed','answered') AND coalesce(h.duration,0) > 0 THEN 'answered'
    WHEN lower(coalesce(h.status,'')) IN ('connected','completed','answered') THEN 'no_answer'
    WHEN h.failure_reason IS NOT NULL AND h.failure_reason <> '' AND h.failure_reason !~ '^NO_[A-Z_]+$' THEN 'failed'
    ELSE 'no_reason' END`;
const PLACEHOLDER = v => !v || /^NO_[A-Z_]+$/.test(String(v));
const PHONE_SQL = `CASE WHEN h.phone ~ '^\\+?[0-9]{6,}$' THEN h.phone ELSE COALESCE(NULLIF(h.raw->>'user_contact',''), NULLIF(h.raw->>'user_contact_masked','')) END`;
async function list({ q, status, agentId, broadcastId, from, to, reason, outcome, limit = 50, offset = 0 } = {}) {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (q) {
        const digits = String(q).replace(/[^0-9]/g, '');
        args.push(`%${digits || String(q)}%`, String(q));
        where.push(`(h.phone ILIKE $${args.length - 1} OR h.raw->>'user_contact' ILIKE $${args.length - 1} OR h.attempt_id = $${args.length})`);
    }
    if (status) {
        if (status === 'answered') where.push(`h.status IN ('connected','completed','answered')`);
        else if (status === 'not_answered') where.push(`h.status IN ('no_answer','busy','not_connected','unanswered')`);
        else if (status === 'failed') where.push(`h.status NOT IN ('connected','completed','answered','no_answer','busy','not_connected','unanswered','queued')`);
        else add('h.status = ?', status);
    }
    if (agentId) add('h.agent_id = ?', Number(agentId));
    if (broadcastId) add('h.broadcast_id = ?', Number(broadcastId));
    if (from) add('COALESCE(h.started_at, h.synced_at) >= ?', new Date(from));
    if (to) add('COALESCE(h.started_at, h.synced_at) < ?', new Date(to));
    // Outcome counts follow every other filter, so the tabs always match what you'd see.
    const wBase = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const cnt = await db.many(`SELECT ${OUTCOME_SQL} AS o, COUNT(*)::int n FROM call_history h ${wBase} GROUP BY 1`, args);
    const counts = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
    cnt.forEach(x => { counts[x.o] = x.n; });
    counts.all = cnt.reduce((t, x) => t + x.n, 0);
    const oc = outcome || (reason === '__none' ? 'no_reason' : null);
    if (oc && OUTCOMES.includes(oc)) add(`(${OUTCOME_SQL}) = ?`, oc);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500), off = Math.max(parseInt(offset, 10) || 0, 0);
    const rows = await db.many(`SELECT h.attempt_id, h.interaction_id, ${PHONE_SQL} AS phone, h.status, h.duration, h.failure_reason, h.started_at, h.ended_at,
            h.language, h.ended_by, h.num_messages, h.agent_id, a.label AS agent_label, h.broadcast_id, h.occurrence_id, h.source,
            (h.transcript IS NOT NULL) AS has_transcript, (h.audio_url IS NOT NULL OR h.interaction_id IS NOT NULL) AS has_recording,
            COALESCE(h.started_at, h.synced_at) AS sort_at, ${OUTCOME_SQL} AS outcome,
            (SELECT c.name FROM contacts c WHERE c.name IS NOT NULL AND c.name <> ''
               AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = right(regexp_replace(${PHONE_SQL}, '\\D', '', 'g'), 10) LIMIT 1) AS contact_name, h.agent_variables
        FROM call_history h LEFT JOIN agents a ON a.id=h.agent_id ${w}
        ORDER BY COALESCE(h.started_at, h.synced_at) DESC, h.attempt_id DESC LIMIT ${lim} OFFSET ${off}`, args);
    const total = (await db.one(`SELECT COUNT(*)::int n FROM call_history h ${w}`, args)).n;
    rows.forEach(r => {
        if (PLACEHOLDER(r.failure_reason)) r.failure_reason = null;
        if (PLACEHOLDER(r.ended_by) || r.ended_by === 'NO_END_REASON') r.ended_by = null;
        if (r.phone && /^NO_/.test(r.phone)) r.phone = null;
        if (r.interaction_id && /^NO_/.test(r.interaction_id)) { r.interaction_id = null; if (!r.has_transcript) r.has_recording = false; }
    });
    return { total, limit: lim, offset: off, items: rows, counts,
        synced_at: lastResult ? lastResult.at : null };
}

async function get(attemptId) {
    const r = await db.one(`SELECT h.*, a.label AS agent_label FROM call_history h LEFT JOIN agents a ON a.id=h.agent_id WHERE h.attempt_id=$1`, [attemptId]);
    if (!r) throw httpError(404, 'Call not found.');
    delete r.audio_url; delete r.raw;
    return r;
}

// Normalises a transcript into [{ role, text, time? }].
function turns(t) {
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = null; } }
    const arr = Array.isArray(t) ? t : (t && (t.transcript || t.messages || t.items || t.turns || t.data)) || [];
    return (Array.isArray(arr) ? arr : []).map(x => {
        if (typeof x === 'string') return { role: 'agent', text: x, en: '' };
        const en = String(pick(x, 'en_text', 'english_text', 'translation') || '');
        const text = String(pick(x, 'indic_text', 'content', 'text', 'message', 'transcript', 'utterance') || en);
        return {
            role: String(pick(x, 'role', 'speaker', 'sender', 'author') || 'agent').toLowerCase(),
            text, en: en && en.trim() !== text.trim() ? en : '',
            time: pick(x, 'timestamp', 'time', 'start_time', 'created_at')
        };
    }).filter(x => x.text);
}

async function transcript(attemptId, { refresh = false } = {}) {
    // Accepts an attempt id or an interaction id; old transcripts may only be in sarvam_calls.
    const r = await db.one(`SELECT h.attempt_id, h.interaction_id, COALESCE(h.transcript, s.transcript) AS transcript, h.app_id,
            h.raw->'transcript' AS raw_transcript
        FROM call_history h LEFT JOIN sarvam_calls s USING (attempt_id)
        WHERE h.attempt_id=$1 OR h.interaction_id=$1 LIMIT 1`, [attemptId]);
    if (r) attemptId = r.attempt_id;
    if (!r) return { attempt_id: attemptId, turns: [], note: 'No conversation was recorded for this call.' };
    const stored = turns(r.transcript);
    if (stored.length && !refresh) return { attempt_id: attemptId, turns: stored, cached: true };
    const fromRaw = turns(r.raw_transcript);
    if (fromRaw.length && !refresh) {
        await db.query('UPDATE call_history SET transcript=$2, transcript_fetched_at=now() WHERE attempt_id=$1', [attemptId, JSON.stringify(r.raw_transcript)]).catch(() => {});
        return { attempt_id: attemptId, turns: fromRaw, cached: true };
    }
    if (!r.interaction_id || /^NO_/.test(r.interaction_id)) return { attempt_id: attemptId, turns: turns(r.transcript), cached: true, note: 'No conversation was recorded for this call.' };
    // Fall back to Sarvam; any upstream error returns what we have instead of failing the UI.
    try {
        const creds = await config.getCredentials();
        if (!creds.sarvam_key) throw new Error('Sarvam API key not set.');
        let j = null;
        for (const pth of [r.app_id ? `/${encodeURIComponent(r.app_id)}/transcripts/${encodeURIComponent(r.interaction_id)}` : null, `/transcripts/${encodeURIComponent(r.interaction_id)}`].filter(Boolean)) {
            try { j = await sarvamGet(creds, pth); if (turns(j).length) break; } catch (e) { if (e.backoff) throw e; }
        }
        const t = turns(j);
        if (t.length) await db.query('UPDATE call_history SET transcript=$2, transcript_fetched_at=now() WHERE attempt_id=$1', [attemptId, JSON.stringify(j)]);
        return { attempt_id: attemptId, turns: t.length ? t : stored.length ? stored : fromRaw, cached: false,
            note: t.length || stored.length || fromRaw.length ? undefined : 'No conversation was recorded for this call.' };
    } catch (e) {
        const have = stored.length ? stored : fromRaw;
        return { attempt_id: attemptId, turns: have, cached: true, note: have.length ? undefined : 'The conversation is not available right now.' };
    }
}

// Streams the recording to the response. Only https provider URLs are followed.
async function streamRecording(attemptId, req, res) {
    const r = await db.one(`SELECT h.interaction_id, h.audio_url, h.app_id, h.started_at, ${PHONE_SQL} AS phone,
            (SELECT c.name FROM contacts c WHERE c.name <> '' AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = right(regexp_replace(${PHONE_SQL}, '\\D', '', 'g'), 10) LIMIT 1) AS contact_name
        FROM call_history h WHERE h.attempt_id=$1`, [attemptId]);
    if (r && req.query && req.query.download) {
        const who = String(r.contact_name || r.phone || 'call').replace(/[^\w+.-]+/g, '_').replace(/^_+|_+$/g, '') || 'call';
        const d = r.started_at ? new Date(r.started_at) : new Date();
        res.__dlName = `${who}_${d.toISOString().slice(0, 10)}`;
    }
    if (!r) throw httpError(404, 'Call not found.');
    const creds = await config.getCredentials();
    let url = null;
    const headers = {};
    const blocked = guard.sarvamHttpBlockedReason();
    if (blocked) throw httpError(400, blocked);
    if (r.interaction_id && !/^NO_/.test(r.interaction_id) && creds.sarvam_key) {
        // The analytics API serves recordings per app: /{app_id}/recordings/{interaction_id}.
        const id = encodeURIComponent(r.interaction_id);
        const paths = [r.app_id ? `/${encodeURIComponent(r.app_id)}/recordings/${id}` : null, `/recordings/${id}`].filter(Boolean);
        for (const pth of paths) {
            const h = { 'X-API-Key': creds.sarvam_key };
            if (req.headers.range) h.Range = req.headers.range;
            const resp = await fetch(analyticsBase(creds) + pth, { headers: h, signal: AbortSignal.timeout(30000) }).catch(() => null);
            if (!resp) continue;
            const ct = resp.headers.get('content-type') || '';
            if ((resp.ok || resp.status === 206) && /^audio\/|octet-stream/.test(ct)) return pipe(resp, res);
            if (resp.ok) {
                const j = await resp.json().catch(() => ({}));
                url = pick(j, 'url', 'recording_url', 'audio_url', 'signed_url', 'download_url') || pick(j.data || {}, 'url', 'recording_url', 'audio_url', 'signed_url');
                if (url) break;
            }
        }
    }
    // The stored audio_url points at Sarvam's dashboard (browser login), so it is not used.
    if (!url) throw httpError(404, 'No recording for this call.');
    let u; try { u = new URL(url); } catch (e) { throw httpError(502, 'Recording URL is invalid.'); }
    const local = /^(127\.|localhost$)/.test(u.hostname) && process.env.SARVAM_BASE_URL && new URL(process.env.SARVAM_BASE_URL).hostname === u.hostname;
    if (u.protocol !== 'https:' && !local) throw httpError(502, 'Recording URL is not https.');
    if (req.headers.range) headers.Range = req.headers.range;
    const resp = await fetch(u, { headers, signal: AbortSignal.timeout(60000) });
    if (!resp.ok && resp.status !== 206) throw httpError(404, 'No recording for this call.');
    return pipe(resp, res);
}

async function pipe(resp, res) {
    res.status(resp.status === 206 ? 206 : 200);
    const ct = resp.headers.get('content-type') || 'audio/mpeg';
    res.set('Content-Type', ct);
    if (res.__dlName) res.set('Content-Disposition', `attachment; filename="${res.__dlName}.${/wav/.test(ct) ? 'wav' : 'mp3'}"`);
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => { const v = resp.headers.get(h); if (v) res.set(h, v); });
    res.set('Cache-Control', 'private, max-age=300');
    const { Readable } = require('stream');
    Readable.fromWeb(resp.body).pipe(res);
}

module.exports = { syncNow, startBackground, stopBackground, syncInfo, list, get, transcript, streamRecording, turns, mapAttempt };
