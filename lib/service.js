// Data operations shared by the web API, /api/v1 and the CLI (contacts, lists,
// broadcasts, history, messages, settings).
const db = require('./db');
const { httpError, sanitizePhoneNumber, validatePhone } = require('./util');

// ── contacts / lists ──
const listContacts = async ({ group } = {}) => (await db.many(
    `SELECT id, name, phone, group_name, created_at FROM contacts ${group !== undefined ? 'WHERE COALESCE(group_name, \'\') = $1' : ''} ORDER BY id`,
    group !== undefined ? [group] : [])).map(r => ({ id: r.id, name: r.name || '', phone: r.phone, group: r.group_name || '', group_name: r.group_name || '', created_at: r.created_at, ...(v => v.ok ? {} : { invalid: v.reason, invalid_hint: v.hint || '' })(validatePhone(r.phone)) }));

// Saves valid contacts only; returns { count, invalid: [{ index, phone, reason }] }.
async function upsertContacts(list) {
    const all = (Array.isArray(list) ? list : [list]);
    const invalid = [], items = [];
    all.forEach((c, index) => {
        if (!c || !c.phone) return;
        const v = validatePhone(sanitizePhoneNumber(c.phone));
        if (!v.ok) { invalid.push({ index, line: c.line || index + 1, phone: String(c.phone), reason: v.reason, hint: v.hint || '' }); return; }
        items.push({ ...c, phone: v.e164 });
    });
    if (!items.length) return { count: 0, invalid };
    await db.tx(async client => {
        for (let i = 0; i < items.length; i += 500) {
            const chunk = items.slice(i, i + 500), args = [];
            const tuples = chunk.map(c => {
                args.push(String(c.name || ''), String(c.phone).trim(), String(c.group ?? c.group_name ?? ''));
                return `($${args.length - 2}, $${args.length - 1}, $${args.length})`;
            });
            await client.query(`INSERT INTO contacts (name, phone, group_name) VALUES ${tuples.join(',')}
                ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, group_name=EXCLUDED.group_name`, args);
            // Keep the last known name per number (fallback once a contact is deleted).
            await client.query(`INSERT INTO contact_name_snapshots (phone_key, name, updated_at)
                SELECT DISTINCT ON (k) k, n, now() FROM (SELECT right(regexp_replace(x.p, '\\D', '', 'g'), 10) AS k, x.n
                  FROM unnest($1::text[], $2::text[]) AS x(p, n) WHERE COALESCE(x.n, '') <> '') q ORDER BY k
                ON CONFLICT (phone_key) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
                [chunk.map(c => String(c.phone).trim()), chunk.map(c => String(c.name || ''))]);
        }
    });
    return { count: items.length, invalid };
}

async function deleteContacts(phones) {
    const list = (Array.isArray(phones) ? phones : [phones]).filter(Boolean).map(String);
    if (!list.length) return 0;
    return (await db.query('DELETE FROM contacts WHERE phone = ANY($1)', [list])).rowCount;
}

// Contact groups ("lists"): the contact's group name.
const listGroups = () => db.many(`SELECT group_name AS name, COUNT(*)::int AS count FROM contacts
    WHERE COALESCE(group_name, '') <> '' GROUP BY group_name ORDER BY group_name`);
async function groupNumbers(names) {
    const want = (Array.isArray(names) ? names : [names]).map(s => String(s).trim().toLowerCase());
    if (want.includes('*')) return (await db.many('SELECT phone FROM contacts ORDER BY id')).map(r => r.phone);
    return (await db.many('SELECT phone FROM contacts WHERE lower(group_name) = ANY($1) ORDER BY id', [want])).map(r => r.phone);
}

// ── broadcasts ──
async function listBroadcasts({ limit = 30, status } = {}) {
    const args = [Math.min(parseInt(limit, 10) || 30, 200)];
    let w = '';
    if (status) { args.push(status); w = 'WHERE b.status = $2'; }
    return db.many(`SELECT b.id, b.status, b.provider, b.agent_id, a.label agent_label, b.message, b.language, b.sent_by, b.total, b.successful, b.failed,
            b.started_at, b.finished_at, b.interrupted_at, b.note, b.resume_requested, b.resumed_count, b.occurrence_id,
            (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=b.id AND t.status='pending') AS not_dialled,
            (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=b.id AND t.status IN ('unknown','dialling')) AS unknown
        FROM broadcasts b LEFT JOIN agents a ON a.id=b.agent_id ${w} ORDER BY b.id DESC LIMIT $1`, args);
}
async function getBroadcast(id) {
    const b = (await listBroadcasts({ limit: 200 })).find(x => x.id === Number(id))
        || await db.one(`SELECT b.*, (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=b.id AND t.status='pending') AS not_dialled FROM broadcasts b WHERE id=$1`, [id]);
    if (!b) throw httpError(404, 'Broadcast not found.');
    const targets = await db.many(`SELECT id, phone, status, attempts, attempt_id, error, duration, dialled_at, finished_at FROM call_targets
        WHERE broadcast_id=$1 ORDER BY id`, [id]);
    return { ...b, targets };
}

// ── history / messages / settings ──
const listHistory = () => db.many(`SELECT h.*, a.label agent_label, b.status AS broadcast_status,
        (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=h.broadcast_id AND t.status='pending') AS not_dialled
    FROM history h LEFT JOIN agents a ON a.id=h.agent_id LEFT JOIN broadcasts b ON b.id=h.broadcast_id ORDER BY h.created_at DESC`);
async function addHistory({ message, language, total, successful, results, created_at }) {
    await db.query('INSERT INTO history (message, language, total, successful, results, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [message, language, total, successful, JSON.stringify(results ?? null), created_at ? new Date(created_at) : new Date()]);
}
const deleteHistory = id => id ? db.query('DELETE FROM history WHERE id=$1', [id]) : db.query('DELETE FROM history');

const listMessages = () => db.many('SELECT * FROM messages ORDER BY created_at DESC');
const addMessage = ({ name, content, language }) => db.query('INSERT INTO messages (name, content, language) VALUES ($1,$2,$3)', [name || 'Saved Message', content, language]);
const deleteMessage = id => db.query('DELETE FROM messages WHERE id=$1', [id]);

const getSettings = async () => {
    const s = await db.one('SELECT parallel_calls, retry_failed, default_language, delay_ms, org_name FROM settings WHERE id=1');
    // UI theme lives in sync_state (no schema change needed).
    const t = await db.one(`SELECT value FROM sync_state WHERE key='ui_theme'`).catch(() => null);
    if (s && t && t.value && t.value.theme) s.theme = t.value.theme;
    return s;
};
async function saveTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    await db.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ('ui_theme', $1, now())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify({ theme })]);
}
async function saveSettings(b = {}) {
    if (b.theme) await saveTheme(b.theme);
    if (Object.keys(b).every(k => k === 'theme')) return;
    const n = (v, d, lo, hi) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d; };
    const cur = await getSettings();
    await db.query('UPDATE settings SET parallel_calls=$1, retry_failed=$2, default_language=$3, delay_ms=$4, org_name=$5, updated_at=now() WHERE id=1', [
        n(b.parallel_calls, cur.parallel_calls, 1, 100), b.retry_failed === undefined ? cur.retry_failed : !!(b.retry_failed && b.retry_failed !== '0'),
        b.default_language || cur.default_language, n(b.delay_ms, cur.delay_ms, 0, 60000), b.org_name ?? cur.org_name]);
}

// Legacy Sarvam results view (kept for the existing History > Sarvam tab).
const sarvamCalls = () => db.many('SELECT * FROM sarvam_calls ORDER BY created_at DESC LIMIT 100');

module.exports = {
    listContacts, upsertContacts, deleteContacts, listGroups, groupNumbers, listBroadcasts, getBroadcast,
    listHistory, addHistory, deleteHistory, listMessages, addMessage, deleteMessage, getSettings, saveSettings, sarvamCalls, sanitizePhoneNumber
};
