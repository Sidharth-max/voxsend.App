// Call runner + scheduler. Exactly one process may place calls: the one holding a
// session-level advisory lock on a dedicated connection. Others serve the UI/API only.
// Every tick reads the DB, so pending schedules survive restarts; due rows are claimed
// with FOR UPDATE SKIP LOCKED so a time can never start twice.
const { Client } = require('pg');
const db = require('./db');
const broadcaster = require('./broadcaster');

const graceMs = () => (parseInt(process.env.SCHEDULE_GRACE_MINUTES, 10) || 60) * 60 * 1000; // read when used
const TICK_MS = (parseInt(process.env.VOXSEND_TICK_SECONDS, 10) || 15) * 1000;
const WAITING_NOTE = 'Waiting: previous broadcast still running';
const LOCK_KEY = `voxsend:runner:${db.SCHEMA}`;
const STARTED_AT = Date.now();

let lockClient = null;
let hasLock = false;
let schedulesOn = true;
let timer = null;
let ticking = false;

async function acquireLock() {
    try {
        const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'voxsend-runner-lock' });
        c.on('error', e => { console.error('Runner lock connection lost:', e.message); hasLock = false; lockClient = null; });
        await c.connect();
        const r = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY]);
        if (r.rows[0].ok) { lockClient = c; hasLock = true; return true; }
        await c.end();
    } catch (e) { console.error('Runner lock error:', e.message); }
    return false;
}

// Confirms the lock connection still works; on failure drop it so the next tick re-acquires.
async function lockAlive() {
    try { await lockClient.query('SELECT 1'); return true; }
    catch (e) {
        console.error('Runner lock check failed:', e.message);
        hasLock = false;
        try { lockClient.end(); } catch (x) {}
        lockClient = null;
        return false;
    }
}

async function start({ scheduler = true } = {}) {
    schedulesOn = scheduler;
    broadcaster.setRunGate(() => hasLock, () => schedulesOn);
    if (!(await acquireLock())) {
        console.log('Another voxsend process is the call runner: this one will not place calls (retrying every minute).');
    } else {
        await bootRecovery();
    }
    timer = setInterval(() => tick().catch(e => console.error('Scheduler error:', e.message)), TICK_MS);
    setTimeout(() => tick().catch(e => console.error('Scheduler error:', e.message)), 3000);
    console.log(schedulesOn ? 'Scheduler is ON: scheduled broadcasts and automatic resume will run.'
        : 'Scheduler is OFF (enable: settings.scheduler_enabled in the prod app, or VOXSEND_SCHEDULER=on): no scheduled broadcast or automatic resume will start.');
}

async function bootRecovery() {
    // A time claimed but never turned into a broadcast goes back to pending.
    await db.query(`UPDATE scheduled_calls SET status='pending', updated_at=now() WHERE status='starting' AND broadcast_id IS NULL`);
    const recovered = await broadcaster.recoverAfterRestart({ allowAuto: schedulesOn });
    // Runs started by the old app (no call_targets) cannot be resumed precisely.
    await db.query(`UPDATE scheduled_calls SET status='interrupted', note='Server restarted while this broadcast was running', updated_at=now()
        WHERE status IN ('started','starting') AND broadcast_id IS NULL`);
    for (const r of recovered) console.log(`Recovered broadcast ${r.id}: ${r.pending} not dialled${r.pending ? (r.auto && schedulesOn ? ', resuming automatically' : ', Resume available') : ''}`);
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        if (!hasLock) {
            if (await acquireLock()) { console.log('This process is now the call runner.'); await bootRecovery(); } else return;
        } else if (!(await lockAlive())) {
            return;
        }
        // A claim whose follow-up write failed (DB hiccup) must not stay stuck in 'starting'.
        await db.query(`UPDATE scheduled_calls SET status='pending', note='Retrying after an error', updated_at=now()
            WHERE status='starting' AND broadcast_id IS NULL AND updated_at < now() - interval '2 minutes'`);
                if (broadcaster.isBusy()) {
            if (schedulesOn) await db.query(`UPDATE scheduled_calls SET note=$1, updated_at=now() WHERE status='pending' AND run_at <= now() AND note IS NULL`, [WAITING_NOTE]);
            return;
        }
        // Resumes first (manual requests always; automatic ones only with the scheduler on).
        if (await broadcaster.runRequestedResume()) return;
        if (schedulesOn) await startDue();
    } finally { ticking = false; }
}

async function startDue() {
    const due = await db.one(`WITH due AS (
            SELECT id, note FROM scheduled_calls WHERE status='pending' AND run_at <= now() ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE scheduled_calls s SET status='starting', updated_at=now() FROM due WHERE s.id=due.id RETURNING s.*, due.note AS prev_note`);
    if (!due) return;
    const setStatus = async (status, note) => {
        await db.tx(async c => {
            await c.query('UPDATE scheduled_calls SET status=$2, note=$3, updated_at=now() WHERE id=$1', [due.id, status, note || null]);
            await broadcaster.refreshGroup(c, due.group_id);
        });
    };
    const runAt = due.run_at.getTime();
    const lateMs = Date.now() - runAt;
    const waited = due.prev_note === WAITING_NOTE;
    if (lateMs > graceMs() && runAt < STARTED_AT && !waited) return setStatus('missed', 'Server was not running at the scheduled time.');
    const lateMin = Math.round(lateMs / 60000);
    const note = lateMin < 2 ? null : waited ? `Started ${lateMin} min late: previous broadcast was still running`
        : `Started ${lateMin} min late: server was not running at the scheduled time`;
    try {
        await broadcaster.start({ nums: due.recipients, msg: due.message, lang: due.language, voice: due.voice, provider: due.provider,
            sentBy: due.sent_by || 'Scheduled', agentId: due.agent_id, occurrenceId: due.id, occurrenceNote: note });
    } catch (e) {
        if (/already in progress/.test(e.message)) return setStatus('pending', WAITING_NOTE);
        // Not the runner (503), a DB/network hiccup, or settings still missing: retry on the
        // next ticks while within the grace period. Only then give up and mark it failed.
        if (Date.now() - runAt < graceMs()) {
            console.error(`Scheduled call ${due.id} not started yet (${e.message}); will retry.`);
            return setStatus('pending', `Retrying: ${String(e.message).slice(0, 200)}`).catch(() => {});
        }
        return setStatus('failed', e.message);
    }
}

const poke = () => setTimeout(() => tick().catch(() => {}), 200);
const info = () => ({ runner: hasLock, schedules: schedulesOn, tickSeconds: TICK_MS / 1000, resumeWindowMinutes: broadcaster.RESUME_WINDOW_MS / 60000 });
async function stop() { clearInterval(timer); if (lockClient) await lockClient.end().catch(() => {}); hasLock = false; }

module.exports = { start, stop, tick, poke, info, WAITING_NOTE };
