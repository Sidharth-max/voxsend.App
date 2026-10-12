// Broadcast History: one list of every broadcast run (manual broadcasts, scheduled runs,
// and legacy history rows imported from the SQLite app), newest first, keyset-paginated.
// Calls link to runs through existing ids: call_targets.broadcast_id and call_history.target_id /
// attempt_id / broadcast_id. Legacy rows without a broadcast fall back to a time window + numbers.
const db = require('./db');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Every run as (key, at, kind, ...). key is unique and sortable: b<id> | h<id> | s<id>.
const RUNS_SQL = `
  SELECT 'b' || b.id AS key, b.id AS broadcast_id, NULL::bigint AS history_id, b.occurrence_id,
         b.started_at AS at, b.finished_at, b.status AS run_status,
         CASE WHEN b.occurrence_id IS NOT NULL THEN 'scheduled' ELSE 'manual' END AS kind,
         b.message, b.language, b.sent_by, a.label AS agent_label, sc.group_id AS schedule_group,
         COALESCE(NULLIF(b.recipients_total, 0), b.total) AS total,
         COALESCE(t.sent, b.successful + b.failed) AS sent, COALESCE(t.answered, b.successful) AS answered,
         COALESCE(t.busy, 0) AS busy, COALESCE(t.failed, b.failed) AS failed, COALESCE(t.not_dialled, 0) AS not_dialled
    FROM broadcasts b
    LEFT JOIN agents a ON a.id = b.agent_id
    LEFT JOIN scheduled_calls sc ON sc.id = b.occurrence_id
    LEFT JOIN LATERAL (
        SELECT NULLIF(COUNT(*), 0)::int AS n,
               (COUNT(*) FILTER (WHERE status NOT IN ('pending','skipped')))::int AS sent,
               (COUNT(*) FILTER (WHERE status = 'connected'))::int AS answered,
               (COUNT(*) FILTER (WHERE status = 'busy'))::int AS busy,
               (COUNT(*) FILTER (WHERE status IN ('failed','no_answer','unknown')))::int AS failed,
               (COUNT(*) FILTER (WHERE status = 'pending'))::int AS not_dialled
          FROM call_targets ct WHERE ct.broadcast_id = b.id
        HAVING COUNT(*) > 0) t ON true
  UNION ALL
  SELECT 'h' || h.id, NULL, h.id, NULL, h.created_at, NULL, 'completed', 'manual',
         h.message, h.language, NULL, a.label, NULL,
         COALESCE(h.total, 0), COALESCE(h.total, 0), COALESCE(h.successful, 0), 0,
         GREATEST(COALESCE(h.total, 0) - COALESCE(h.successful, 0), 0), 0
    FROM history h LEFT JOIN agents a ON a.id = h.agent_id
   WHERE h.broadcast_id IS NULL
  UNION ALL
  SELECT 's' || s.id, NULL, NULL, s.id, s.run_at, s.updated_at, s.status, 'scheduled',
         s.message, s.language, s.sent_by, a.label, s.group_id,
         jsonb_array_length(s.recipients), 0, 0, 0, 0, 0
    FROM scheduled_calls s LEFT JOIN agents a ON a.id = s.agent_id
   WHERE s.broadcast_id IS NULL AND s.status IN ('completed','interrupted','failed','missed')
     AND NOT EXISTS (SELECT 1 FROM broadcasts b2 WHERE b2.occurrence_id = s.id)`;

function parseCursor(c) {
    if (!c) return null;
    const i = String(c).lastIndexOf('|');
    if (i < 1) throw httpError(400, 'Bad cursor.');
    const at = new Date(String(c).slice(0, i)), key = String(c).slice(i + 1);
    if (isNaN(at) || !/^[bhs]\d+$/.test(key)) throw httpError(400, 'Bad cursor.');
    return { at, key };
}
// Keys compare as (kind letter, zero-padded id) so ties on the same timestamp stay stable.
const SORT_KEY = `substr(key,1,1) || lpad(substr(key,2), 20, '0')`;

async function listRuns({ cursor, limit = 20 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const c = parseCursor(cursor);
    const args = [lim + 1];
    let w = '';
    if (c) {
        args.push(c.at, c.key.slice(0, 1) + c.key.slice(1).padStart(20, '0'));
        w = `WHERE (r.at, ${SORT_KEY}) < ($2, $3)`;
    }
    const hidden = await hiddenRuns();
    if (hidden.length) { args.push(hidden); w += (w ? ' AND ' : 'WHERE ') + `NOT (r.key = ANY($${args.length}::text[]))`; }
    const rows = await db.many(`SELECT * FROM (${RUNS_SQL}) r ${w} ORDER BY r.at DESC, ${SORT_KEY} DESC LIMIT $1`, args);
    const more = rows.length > lim;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    return { items: rows, next_cursor: more && last ? `${new Date(last.at).toISOString()}|${last.key}` : null };
}

const CALL_COLS = `h.interaction_id, h.duration, h.failure_reason, h.language, h.ended_by, h.num_messages,
    h.agent_id, ag.label AS agent_label, h.agent_variables,
    (h.transcript IS NOT NULL) AS has_transcript,
    (h.audio_url IS NOT NULL OR (h.interaction_id IS NOT NULL AND h.interaction_id !~ '^NO_')) AS has_recording`;
const NAME_SQL = phone => `(SELECT c.name FROM contacts c WHERE c.name IS NOT NULL AND c.name <> ''
    AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = right(regexp_replace(${phone}, '\\D', '', 'g'), 10) LIMIT 1)`;

async function runCalls(key) {
    const m = /^([bhs])(\d+)$/.exec(String(key || ''));
    if (!m) throw httpError(400, 'Bad run id.');
    const id = Number(m[2]);
    let rows;
    if (m[1] === 'b') {
        rows = await db.many(`SELECT COALESCE(h.attempt_id, t.attempt_id) AS attempt_id, t.phone, t.id AS target_id,
                COALESCE(h.status, t.status) AS status, t.error, COALESCE(h.started_at, t.dialled_at, t.created_at) AS sort_at,
                ${CALL_COLS}, ${NAME_SQL('t.phone')} AS contact_name
            FROM call_targets t
            LEFT JOIN LATERAL (SELECT * FROM call_history x
                 WHERE x.target_id = t.id OR (t.attempt_id IS NOT NULL AND x.attempt_id = t.attempt_id)
                 ORDER BY x.started_at DESC NULLS LAST LIMIT 1) h ON true
            LEFT JOIN agents ag ON ag.id = h.agent_id
            WHERE t.broadcast_id = $1 ORDER BY t.id`, [id]);
        if (!rows.length) {   // broadcast with no target rows: calls tagged with it in call_history
            rows = await db.many(`SELECT h.attempt_id, h.phone, h.status, COALESCE(h.started_at, h.synced_at) AS sort_at,
                    ${CALL_COLS}, ${NAME_SQL('h.phone')} AS contact_name
                FROM call_history h LEFT JOIN agents ag ON ag.id = h.agent_id
                WHERE h.broadcast_id = $1 ORDER BY sort_at`, [id]);
        }
    } else {
        // Legacy run: no shared id, so match its numbers inside a window after it started.
        const src = m[1] === 'h'
            ? await db.one(`SELECT created_at AS at, COALESCE(recipients, '') AS recips FROM history WHERE id=$1`, [id])
            : await db.one(`SELECT run_at AS at, recipients::text AS recips FROM scheduled_calls WHERE id=$1`, [id]);
        if (!src) throw httpError(404, 'Run not found.');
        const nums = [...new Set((String(src.recips).match(/\+?\d{10,15}/g) || []).map(p => p.replace(/\D/g, '').slice(-10)))];
        if (!nums.length) return { items: [] };
        rows = await db.many(`SELECT DISTINCT ON (right(regexp_replace(h.phone, '\\D', '', 'g'), 10))
                h.attempt_id, h.phone, h.status, COALESCE(h.started_at, h.synced_at) AS sort_at,
                ${CALL_COLS}, ${NAME_SQL('h.phone')} AS contact_name
            FROM call_history h LEFT JOIN agents ag ON ag.id = h.agent_id
            WHERE right(regexp_replace(h.phone, '\\D', '', 'g'), 10) = ANY($1)
              AND COALESCE(h.started_at, h.synced_at) >= $2::timestamptz - interval '2 minutes'
              AND COALESCE(h.started_at, h.synced_at) <  $2::timestamptz + interval '3 hours'
            ORDER BY right(regexp_replace(h.phone, '\\D', '', 'g'), 10), sort_at`, [nums, src.at]);
        rows.sort((a, b) => new Date(a.sort_at) - new Date(b.sort_at));
    }
    rows.forEach(r => { if (r.interaction_id && /^NO_/.test(r.interaction_id)) r.interaction_id = null; });
    return { items: rows };
}

// Delete from the list = hide the run (stored in sync_state, no schema change). Call records,
// transcripts and recordings stay in Call history.
async function hiddenRuns() {
    const r = await db.one(`SELECT value FROM sync_state WHERE key='hidden_runs'`).catch(() => null);
    try { const v = JSON.parse((r && r.value) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return []; }
}
const checkKey = key => { if (!/^[bhs]\d+$/.test(String(key || ''))) throw httpError(400, 'Bad run key.'); return String(key); };
async function hideRun(key) {
    key = checkKey(key);
    const list = await hiddenRuns();
    if (!list.includes(key)) list.push(key);
    await db.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ('hidden_runs', $1, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(list)]);
    return { success: true };
}

// Every number a run dialled (or was meant to), for "View numbers" / "Re-use".
async function runRecipients(key) {
    key = checkKey(key);
    const id = Number(key.slice(1));
    let phones = [];
    const split = t => String(t || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
    if (key[0] === 'b') {
        phones = (await db.many('SELECT phone FROM call_targets WHERE broadcast_id=$1 ORDER BY id', [id])).map(r => r.phone);
        if (!phones.length) {
            const h = await db.one('SELECT recipients FROM history WHERE broadcast_id=$1 ORDER BY id DESC LIMIT 1', [id]).catch(() => null);
            phones = split(h && h.recipients);
        }
    } else if (key[0] === 'h') {
        const h = await db.one('SELECT recipients FROM history WHERE id=$1', [id]).catch(() => null);
        phones = split(h && h.recipients);
    } else {
        const sc = await db.one('SELECT recipients FROM scheduled_calls WHERE id=$1', [id]).catch(() => null);
        const v = sc && sc.recipients;
        phones = (Array.isArray(v) ? v : []).map(x => typeof x === 'string' ? x : (x && (x.phone || x.number)) || '').filter(Boolean);
    }
    return { items: [...new Set(phones)] };
}

module.exports = { listRuns, runCalls, runRecipients, hideRun };
