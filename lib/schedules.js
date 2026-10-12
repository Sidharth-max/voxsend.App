// Schedules (groups + one scheduled_calls row per time). Shared by the web API,
// the token API (/api/v1) and the CLI so every entry point applies the same rules.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const { dedupeRecipients, PROVIDERS, MAX_SCHEDULE_OCCURRENCES, cleanScheduleRule, localParts, httpError } = require('./util');
const { refreshGroup } = require('./broadcaster');

function parseTimes(list, { allowPast = false } = {}) {
    const times = [...new Set((Array.isArray(list) ? list : [list]).filter(Boolean).map(t => Date.parse(t)))].sort((a, b) => a - b);
    if (!times.length || times.some(Number.isNaN)) throw httpError(400, 'Invalid date/time.');
    if (times.length > MAX_SCHEDULE_OCCURRENCES) throw httpError(400, `Too many times (${times.length}); the limit is ${MAX_SCHEDULE_OCCURRENCES}.`);
    if (!allowPast && times[0] < Date.now() - 60 * 1000) throw httpError(400, 'Scheduled time is in the past.');
    return times;
}

async function validate({ nums, msg, provider, agentId }) {
    const prov = provider || (await config.getCredentials()).provider || 'twilio';
    if (!PROVIDERS.includes(prov)) throw httpError(400, 'Unknown provider.');
    if ((!msg || !String(msg).trim()) && prov !== 'sarvam') throw httpError(400, 'Message is empty.');
    const { unique } = dedupeRecipients(nums || []);
    if (!unique.length) throw httpError(400, 'No valid recipients provided.');
    const agent = prov === 'sarvam' ? await config.resolveAgent(agentId) : null;
    if (prov === 'sarvam' && !agent) throw httpError(400, 'Add a Sarvam agent in Settings first.');
    const creds = config.withAgent(await config.getCredentials(), agent);
    const missing = config.missingCredentials(prov, creds);
    if (missing) throw httpError(400, `${missing}. Save credentials in the API tab first.`);
    return { prov, recipients: unique, agent, message: prov === 'sarvam' ? '' : String(msg).trim() };
}

async function create(body = {}) {
    const { lang, voice, runAt, runAts, sentBy, rule } = body;
    const v = await validate({ ...body, agentId: body.agentId ?? body.agent_id });
    const times = parseTimes(Array.isArray(runAts) ? runAts : [runAt]);
    const r = cleanScheduleRule(rule, times);
    const groupId = crypto.randomUUID();
    const recipientsJson = JSON.stringify(v.recipients);
    const agentId = v.agent ? v.agent.id : null;
    const ids = await db.tx(async client => {
        await client.query(`INSERT INTO schedule_groups (id, message, language, voice, provider, recipients, sent_by, agent_id, repeat_mode, dates,
            start_date, end_date, end_after, weekdays, skip_weekends, times, timezone, settings, occurrences, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'active')`,
            [groupId, v.message, lang || 'hi', voice || null, v.prov, recipientsJson, sentBy || null, agentId, r.mode, JSON.stringify(r.dates),
             r.startDate, r.endDate, r.endAfter, JSON.stringify(r.weekdays), r.skipWeekends, JSON.stringify(r.times), r.timezone,
             JSON.stringify(r), times.length]);
        const out = [];
        for (const t of times) {
            out.push((await client.query(`INSERT INTO scheduled_calls (message, language, voice, provider, recipients, run_at, sent_by, group_id, agent_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                [v.message, lang || 'hi', voice || null, v.prov, recipientsJson, new Date(t), sentBy || null, groupId, agentId])).rows[0].id);
        }
        return out;
    });
    return { id: ids[0], ids, groupId, occurrences: times.length, total: v.recipients.length, agent_id: agentId,
        firstRunAt: new Date(times[0]).toISOString(), lastRunAt: new Date(times[times.length - 1]).toISOString() };
}

async function getGroup(id) {
    const g = await db.one('SELECT g.*, a.label AS agent_label FROM schedule_groups g LEFT JOIN agents a ON a.id=g.agent_id WHERE g.id=$1', [id]);
    if (!g) throw httpError(404, 'Schedule not found.');
    const rows = await db.many(`SELECT s.id, s.run_at, s.status, s.note, s.broadcast_id,
            (SELECT COUNT(*)::int FROM call_targets t WHERE t.broadcast_id=s.broadcast_id AND t.status='pending') AS not_dialled
        FROM scheduled_calls s WHERE s.group_id=$1 ORDER BY s.run_at`, [g.id]);
    return {
        group: {
            id: g.id, message: g.message, language: g.language, voice: g.voice, provider: g.provider, recipients: g.recipients,
            sent_by: g.sent_by, agent_id: g.agent_id, agent_label: g.agent_label, mode: g.repeat_mode, dates: g.dates,
            start_date: ymd(g.start_date), end_date: ymd(g.end_date), end_after: g.end_after, weekdays: g.weekdays, skip_weekends: g.skip_weekends,
            times: g.times, timezone: g.timezone, settings: g.settings, status: g.status, created_at: g.created_at, updated_at: g.updated_at
        },
        rows
    };
}
const ymd = d => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);

// Edits a whole schedule; only still-pending times change (same rules as the SQLite app).
async function editGroup(groupId, body = {}) {
    const g = await db.one('SELECT * FROM schedule_groups WHERE id=$1', [groupId]);
    if (!g) throw httpError(404, 'Schedule not found.');
    const { lang, voice, runAts, sentBy, rule } = body;
    const agentIn = body.agentId ?? body.agent_id ?? (body.provider === g.provider || !body.provider ? g.agent_id : null);
    const v = await validate({ ...body, provider: body.provider || g.provider, agentId: agentIn });
    const times = parseTimes(runAts);
    const r = cleanScheduleRule(rule, times);
    const recipientsJson = JSON.stringify(v.recipients);
    const agentId = v.agent ? v.agent.id : null;
    const wanted = new Map(times.map(t => [new Date(t).toISOString(), t]));
    const result = await db.tx(async client => {
        await client.query('SELECT id FROM schedule_groups WHERE id=$1 FOR UPDATE', [groupId]);
        const running = (await client.query(`SELECT COUNT(*)::int n FROM scheduled_calls WHERE group_id=$1 AND status IN ('starting','started')`, [groupId])).rows[0].n;
        if (running) throw httpError(409, 'A broadcast from this schedule is running right now. Try again when it finishes.');
        const rows = (await client.query('SELECT id, run_at, status FROM scheduled_calls WHERE group_id=$1 FOR UPDATE', [groupId])).rows;
        const byTime = new Map(rows.map(x => [x.run_at.toISOString(), x]));
        let removed = 0, kept = 0, added = 0, revived = 0;
        for (const x of rows) {
            if (x.status === 'pending' && !wanted.has(x.run_at.toISOString())) {
                await client.query('DELETE FROM scheduled_calls WHERE id=$1', [x.id]); removed++;
            }
        }
        const params = [v.message, lang || 'hi', voice || null, v.prov, recipientsJson, sentBy || g.sent_by, agentId];
        for (const iso of wanted.keys()) {
            const x = byTime.get(iso);
            if (x && (x.status === 'pending' || x.status === 'cancelled')) {
                await client.query(`UPDATE scheduled_calls SET message=$1, language=$2, voice=$3, provider=$4, recipients=$5, sent_by=$6, agent_id=$7,
                    status='pending', note=NULL, updated_at=now() WHERE id=$8`, [...params, x.id]);
                x.status === 'pending' ? kept++ : revived++;
            } else if (!x) {
                await client.query(`INSERT INTO scheduled_calls (message, language, voice, provider, recipients, sent_by, agent_id, run_at, group_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [...params, iso, groupId]);
                added++;
            }
        }
        await client.query(`UPDATE schedule_groups SET message=$1, language=$2, voice=$3, provider=$4, recipients=$5, agent_id=$6, repeat_mode=$7, dates=$8,
            start_date=$9, end_date=$10, end_after=$11, weekdays=$12, skip_weekends=$13, times=$14, timezone=$15, settings=$16,
            occurrences=(SELECT COUNT(*) FROM scheduled_calls WHERE group_id=$17), updated_at=now() WHERE id=$17`,
            [v.message, lang || 'hi', voice || null, v.prov, recipientsJson, agentId, r.mode, JSON.stringify(r.dates), r.startDate, r.endDate,
             r.endAfter, JSON.stringify(r.weekdays), r.skipWeekends, JSON.stringify(r.times), r.timezone || g.timezone,
             JSON.stringify({ ...r, edited: true }), groupId]);
        await refreshGroup(client, groupId);
        const pending = (await client.query(`SELECT COUNT(*)::int n FROM scheduled_calls WHERE group_id=$1 AND status='pending'`, [groupId])).rows[0].n;
        return { removed, kept, added, revived, pending };
    });
    return { groupId, ...result, total: v.recipients.length, agent_id: agentId };
}

async function recomputeGroupRule(client, groupId) {
    const g = (await client.query('SELECT * FROM schedule_groups WHERE id=$1', [groupId])).rows[0];
    if (!g) return;
    const rows = (await client.query(`SELECT run_at FROM scheduled_calls WHERE group_id=$1 AND status <> 'cancelled' ORDER BY run_at`, [groupId])).rows;
    if (!rows.length) return;
    const loc = rows.map(r => localParts(r.run_at.toISOString(), g.timezone));
    const dates = [...new Set(loc.map(l => l.date))].sort();
    const times = [...new Set(loc.map(l => l.time))].sort();
    const mode = dates.length * times.length === rows.length ? 'dates' : 'custom';
    const settings = { ...(g.settings || {}), mode, times, dates, edited: true };
    await client.query(`UPDATE schedule_groups SET repeat_mode=$1, times=$2, dates=$3, start_date=$4, end_date=$5, settings=$6,
        occurrences=(SELECT COUNT(*) FROM scheduled_calls WHERE group_id=$7), updated_at=now() WHERE id=$7`,
        [mode, JSON.stringify(times), JSON.stringify(dates), dates[0], dates[dates.length - 1], JSON.stringify(settings), groupId]);
}

// Moves one pending time.
async function moveTime(id, runAt) {
    const t = Date.parse(runAt);
    if (!id || Number.isNaN(t)) throw httpError(400, 'Pick a valid date and time.');
    if (t < Date.now() + 30 * 1000) throw httpError(400, 'That time is in the past.');
    const when = new Date(t);
    await db.tx(async client => {
        const row = (await client.query('SELECT * FROM scheduled_calls WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!row) throw httpError(404, 'Scheduled time not found.');
        if (row.status !== 'pending') throw httpError(409, 'Only a scheduled (pending) time can be changed.');
        const clash = (await client.query('SELECT id, status FROM scheduled_calls WHERE group_id=$1 AND run_at=$2 AND id<>$3', [row.group_id, when, id])).rows[0];
        if (clash && clash.status !== 'cancelled') throw httpError(409, 'This schedule already has a call at that time.');
        if (clash) await client.query('DELETE FROM scheduled_calls WHERE id=$1', [clash.id]);
        await client.query(`UPDATE scheduled_calls SET run_at=$1, note=NULL, updated_at=now() WHERE id=$2 AND status='pending'`, [when, id]);
        await recomputeGroupRule(client, row.group_id);
    });
    return { id, run_at: when.toISOString() };
}

// Every pending/active entry plus the 100 most recent finished ones, with group settings.
async function list() {
    const rows = await db.many(`
        SELECT * FROM (
            SELECT s.* FROM scheduled_calls s WHERE s.status IN ('pending','starting','started')
            UNION ALL
            SELECT * FROM (SELECT s.* FROM scheduled_calls s WHERE s.status NOT IN ('pending','starting','started') ORDER BY s.run_at DESC LIMIT 100) x
        ) s ORDER BY s.run_at ASC`);
    const groupIds = [...new Set(rows.map(r => r.group_id))];
    const groups = new Map((await db.many(`SELECT g.id, g.repeat_mode, g.times, g.weekdays, g.skip_weekends, g.end_after, g.timezone, g.status, g.agent_id, a.label agent_label
        FROM schedule_groups g LEFT JOIN agents a ON a.id=g.agent_id WHERE g.id = ANY($1)`, [groupIds])).map(g => [g.id, g]));
    const agents = new Map((await db.many('SELECT id, label FROM agents')).map(a => [a.id, a.label]));
    const bIds = rows.map(r => r.broadcast_id).filter(Boolean);
    const notDialled = new Map((await db.many(`SELECT broadcast_id, COUNT(*)::int n FROM call_targets WHERE broadcast_id = ANY($1) AND status='pending' GROUP BY broadcast_id`, [bIds]))
        .map(x => [Number(x.broadcast_id), x.n]));
    const bStatus = new Map((await db.many('SELECT id, status, resume_requested FROM broadcasts WHERE id = ANY($1)', [bIds])).map(b => [Number(b.id), b]));
    return rows.map(r => {
        const g = groups.get(r.group_id);
        const b = r.broadcast_id ? bStatus.get(Number(r.broadcast_id)) : null;
        const left = r.broadcast_id ? (notDialled.get(Number(r.broadcast_id)) || 0) : 0;
        return {
            id: r.id, group_id: r.group_id, message: r.message, language: r.language, provider: r.provider, total: (r.recipients || []).length,
            run_at: r.run_at.toISOString(), status: r.status, note: r.note, sent_by: r.sent_by,
            agent_id: r.agent_id, agent_label: r.agent_id ? (agents.get(r.agent_id) || null) : null,
            broadcast_id: r.broadcast_id, not_dialled: left,
            resumable: !!(b && ['interrupted', 'stopped'].includes(b.status) && left > 0), resume_requested: !!(b && b.resume_requested),
            group: g ? { mode: g.repeat_mode, times: g.times, weekdays: g.weekdays, skip_weekends: g.skip_weekends, end_after: g.end_after,
                timezone: g.timezone, status: g.status, agent_id: g.agent_id, agent_label: g.agent_label } : null
        };
    });
}

// Cancels one pending entry ({ id }) or every pending entry of a group ({ group }).
async function cancel({ id, group } = {}) {
    return db.tx(async client => {
        let r, groupId = group;
        if (group) r = await client.query(`UPDATE scheduled_calls SET status='cancelled', updated_at=now() WHERE group_id=$1 AND status='pending'`, [group]);
        else {
            const row = (await client.query('SELECT group_id FROM scheduled_calls WHERE id=$1', [id])).rows[0];
            groupId = row && row.group_id;
            r = await client.query(`UPDATE scheduled_calls SET status='cancelled', updated_at=now() WHERE id=$1 AND status='pending'`, [id]);
        }
        if (groupId) await refreshGroup(client, groupId);
        if (!r.rowCount) throw httpError(400, 'Only pending schedules can be cancelled.');
        return { cancelled: r.rowCount };
    });
}

module.exports = { create, getGroup, editGroup, moveTime, list, cancel, parseTimes };
