// Call history from the Sarvam analytics API: background sync of call attempts into
// call_history, transcripts fetched on demand (and cached), recordings proxied so the
// browser never sees provider URLs or the API key.
const db = require('./db');
const config = require('./config');
const sarvam = require('../sarvam');
const guard = require('./guard');
const { httpError } = require('./util');

const syncMinutes = () => parseInt(process.env.VOXSEND_SYNC_MINUTES, 10) || 10; // read when used
const FIRST_WINDOW_DAYS = parseInt(process.env.VOXSEND_SYNC_FIRST_DAYS, 10) || 14;
let timer = null, running = null, lastResult = null;

const analyticsBase = c => `${sarvam.baseUrl()}/api/analytics/v1/${encodeURIComponent(c.sarvam_org)}/${encodeURIComponent(c.sarvam_workspace)}`;

async function sarvamGet(c, path, params) {
    const blocked = guard.sarvamHttpBlockedReason();
    if (blocked) throw httpError(400, blocked);
    const url = new URL(analyticsBase(c) + path);
    Object.entries(params || {}).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
    const r = await fetch(url, { headers: { 'X-API-Key': c.sarvam_key, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch (e) { j = null; }
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
        phone: pick(a, 'user_identifier', 'user_phone_number', 'phone'),
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
async function syncNow({ days = null } = {}) {
    if (running) return running;
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
            } catch (e) { out.errors.push(`${appId}: ${e.message}`); }
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
async function list({ q, status, agentId, broadcastId, from, to, limit = 50, offset = 0 } = {}) {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (q) {
        const digits = String(q).replace(/[^0-9]/g, '');
        args.push(`%${digits || String(q)}%`, String(q));
        where.push(`(h.phone ILIKE $${args.length - 1} OR h.attempt_id = $${args.length})`);
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
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500), off = Math.max(parseInt(offset, 10) || 0, 0);
    const rows = await db.many(`SELECT h.attempt_id, h.interaction_id, h.phone, h.status, h.duration, h.failure_reason, h.started_at, h.ended_at,
            h.language, h.ended_by, h.num_messages, h.agent_id, a.label AS agent_label, h.broadcast_id, h.occurrence_id, h.source,
            (h.transcript IS NOT NULL) AS has_transcript, (h.audio_url IS NOT NULL OR h.interaction_id IS NOT NULL) AS has_recording,
            COALESCE(h.started_at, h.synced_at) AS sort_at, h.agent_variables
        FROM call_history h LEFT JOIN agents a ON a.id=h.agent_id ${w}
        ORDER BY COALESCE(h.started_at, h.synced_at) DESC, h.attempt_id DESC LIMIT ${lim} OFFSET ${off}`, args);
    const total = (await db.one(`SELECT COUNT(*)::int n FROM call_history h ${w}`, args)).n;
    return { total, limit: lim, offset: off, items: rows };
}

async function get(attemptId) {
    const r = await db.one(`SELECT h.*, a.label AS agent_label FROM call_history h LEFT JOIN agents a ON a.id=h.agent_id WHERE h.attempt_id=$1`, [attemptId]);
    if (!r) throw httpError(404, 'Call not found.');
    delete r.audio_url; delete r.raw;
    return r;
}

// Normalises a transcript into [{ role, text, time? }].
function turns(t) {
    const arr = Array.isArray(t) ? t : (t && (t.transcript || t.messages || t.items || t.turns || t.data)) || [];
    return (Array.isArray(arr) ? arr : []).map(x => ({
        role: String(pick(x, 'role', 'speaker', 'sender', 'author') || 'agent').toLowerCase(),
        text: String(pick(x, 'content', 'text', 'message', 'transcript') || ''),
        time: pick(x, 'timestamp', 'time', 'start_time', 'created_at')
    })).filter(x => x.text);
}

async function transcript(attemptId, { refresh = false } = {}) {
    const r = await db.one('SELECT attempt_id, interaction_id, transcript, app_id FROM call_history WHERE attempt_id=$1', [attemptId]);
    if (!r) throw httpError(404, 'Call not found.');
    if (r.transcript && !refresh) return { attempt_id: attemptId, turns: turns(r.transcript), cached: true };
    if (!r.interaction_id) return { attempt_id: attemptId, turns: turns(r.transcript), cached: true, note: 'No conversation was recorded for this call.' };
    const creds = await config.getCredentials();
    if (!creds.sarvam_key) throw httpError(400, 'Sarvam API key not set.');
    const j = await sarvamGet(creds, `/transcripts/${encodeURIComponent(r.interaction_id)}`);
    await db.query('UPDATE call_history SET transcript=$2, transcript_fetched_at=now() WHERE attempt_id=$1', [attemptId, JSON.stringify(j)]);
    return { attempt_id: attemptId, turns: turns(j), cached: false };
}

// Streams the recording to the response. Only https provider URLs are followed.
async function streamRecording(attemptId, req, res) {
    const r = await db.one('SELECT interaction_id, audio_url FROM call_history WHERE attempt_id=$1', [attemptId]);
    if (!r) throw httpError(404, 'Call not found.');
    const creds = await config.getCredentials();
    let url = null;
    const headers = {};
    const blocked = guard.sarvamHttpBlockedReason();
    if (blocked) throw httpError(400, blocked);
    if (r.interaction_id && creds.sarvam_key) {
        const api = `${analyticsBase(creds)}/recordings/${encodeURIComponent(r.interaction_id)}`;
        const resp = await fetch(api, { headers: { 'X-API-Key': creds.sarvam_key }, signal: AbortSignal.timeout(30000) });
        const ct = resp.headers.get('content-type') || '';
        if (resp.ok && /^audio\/|octet-stream/.test(ct)) return pipe(resp, res);
        if (resp.ok) {
            const j = await resp.json().catch(() => ({}));
            url = pick(j, 'url', 'recording_url', 'audio_url', 'signed_url', 'download_url') || pick(j.data || {}, 'url', 'recording_url', 'audio_url', 'signed_url');
        }
    }
    url = url || r.audio_url;
    if (!url) throw httpError(404, 'No recording for this call.');
    let u; try { u = new URL(url); } catch (e) { throw httpError(502, 'Recording URL is invalid.'); }
    const local = /^(127\.|localhost$)/.test(u.hostname) && process.env.SARVAM_BASE_URL && new URL(process.env.SARVAM_BASE_URL).hostname === u.hostname;
    if (u.protocol !== 'https:' && !local) throw httpError(502, 'Recording URL is not https.');
    if (req.headers.range) headers.Range = req.headers.range;
    const resp = await fetch(u, { headers, signal: AbortSignal.timeout(60000) });
    if (!resp.ok && resp.status !== 206) throw httpError(502, `Recording download failed (HTTP ${resp.status}).`);
    return pipe(resp, res);
}

async function pipe(resp, res) {
    res.status(resp.status === 206 ? 206 : 200);
    res.set('Content-Type', resp.headers.get('content-type') || 'audio/mpeg');
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => { const v = resp.headers.get(h); if (v) res.set(h, v); });
    res.set('Cache-Control', 'private, max-age=300');
    const { Readable } = require('stream');
    Readable.fromWeb(resp.body).pipe(res);
}

module.exports = { syncNow, startBackground, stopBackground, syncInfo, list, get, transcript, streamRecording, turns, mapAttempt };
