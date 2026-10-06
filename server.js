// VOXSEND_ENV_FILE lets a test instance use its own env file (never the real .env).
const ENV_FILE = process.env.VOXSEND_ENV_FILE || require('path').join(__dirname, '.env');
require("dotenv").config({ path: ENV_FILE });
// VOXSEND_SCHEDULER=off: serve the app but never start scheduled broadcasts (test instances).
const SCHEDULER_ON = String(process.env.VOXSEND_SCHEDULER || 'on').toLowerCase() !== 'off';
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const fs = require('fs');
const sarvam = require('./sarvam');
const app = express();

const DB_PATH = process.env.DB_PATH || 'voxsend.db';
const db = new Database(DB_PATH);

// Performance pragmas — WAL mode gives much faster concurrent writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('temp_store = MEMORY');

const sanitizePhoneNumber = (value = '') => {
    if (!value) return '';
    let normalized = String(value).trim().replace(/\s+/g, '');
    normalized = normalized.replace(/(?!^)\+/g, '');
    normalized = normalized.replace(/[^0-9+]/g, '');
    if (!normalized) return '';
    if (!normalized.startsWith('+')) {
        normalized = '+' + normalized.replace(/^\++/, '');
    }
    return normalized;
};

const normalizePhoneKey = (value = '') => sanitizePhoneNumber(value).replace(/[^0-9]/g, '');

const dedupeRecipients = (numbers = []) => {
    const seen = new Set();
    const unique = [];
    let duplicates = 0;

    (Array.isArray(numbers) ? numbers : []).forEach(num => {
        const cleaned = sanitizePhoneNumber(num);
        if (!cleaned) return;
        const key = normalizePhoneKey(cleaned);
        if (!key) return;
        if (seen.has(key)) {
            duplicates++;
            return;
        }
        seen.add(key);
        unique.push(cleaned);
    });

    return { unique, duplicates };
};

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT UNIQUE NOT NULL,
    group_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    language TEXT,
    total INTEGER,
    successful INTEGER,
    recipients TEXT,
    results TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    parallel_calls INTEGER DEFAULT 12,
    retry_failed INTEGER DEFAULT 0,
    default_language TEXT DEFAULT 'hi-IN',
    delay_ms INTEGER DEFAULT 200,
    org_name TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    content TEXT,
    language TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS call_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    error TEXT,
    broadcast_started_at TEXT,
    failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sarvam_calls (
    attempt_id TEXT PRIMARY KEY,
    phone TEXT,
    status TEXT,
    duration REAL,
    failure_reason TEXT,
    transcript TEXT,
    agent_variables TEXT,
    message TEXT,
    broadcast_started_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS scheduled_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    language TEXT,
    voice TEXT,
    provider TEXT NOT NULL,
    recipients TEXT NOT NULL,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    sent_by TEXT,
    group_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try {
  db.prepare('ALTER TABLE messages ADD COLUMN name TEXT').run();
} catch (e) {
  // Ignore if column already exists
}

try {
  db.prepare('ALTER TABLE history ADD COLUMN recipients TEXT').run();
} catch (e) {}

try {
  db.prepare('ALTER TABLE scheduled_calls ADD COLUMN group_id TEXT').run();
} catch (e) {}

// ── Schedule storage (migration) ──────────────
// schedule_groups holds one row per "Schedule" press: every setting needed to
// understand or rebuild it. scheduled_calls holds one row per occurrence with its
// own status (pending / starting / started / missed / failed / cancelled).
// The scheduler reads only the DB, so schedules survive restarts.
(function migrateSchedules() {
  const hasGroups = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_groups'").get();
  if (!hasGroups) {
    // First run of this migration: keep a copy of the database first.
    try {
      if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        fs.copyFileSync(DB_PATH, `${DB_PATH}.bak-${stamp}`);
        console.log(`Schedule migration: backed up database to ${DB_PATH}.bak-${stamp}`);
      }
    } catch (e) { console.error('Schedule migration backup failed:', e.message); }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_groups (
      id TEXT PRIMARY KEY,
      message TEXT,
      language TEXT,
      voice TEXT,
      provider TEXT NOT NULL,
      recipients TEXT NOT NULL,
      sent_by TEXT,
      repeat_mode TEXT NOT NULL DEFAULT 'daily',
      dates TEXT,
      start_date TEXT,
      end_date TEXT,
      end_after INTEGER,
      weekdays TEXT,
      skip_weekends INTEGER NOT NULL DEFAULT 0,
      times TEXT NOT NULL DEFAULT '[]',
      timezone TEXT,
      settings TEXT,
      occurrences INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_calls_status_run ON scheduled_calls (status, run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_calls_group ON scheduled_calls (group_id);
  `);
  try { db.prepare('ALTER TABLE scheduled_calls ADD COLUMN updated_at DATETIME').run(); } catch (e) {}

  if (SCHEDULER_ON) {
    // A crash between claiming an occurrence and starting it leaves it 'starting'; retry it.
    db.prepare("UPDATE scheduled_calls SET status='pending' WHERE status='starting'").run();
    // A broadcast cut off by a restart cannot finish; say so instead of showing it running forever.
    db.prepare("UPDATE scheduled_calls SET status='interrupted', note='Server restarted while this broadcast was running', updated_at=CURRENT_TIMESTAMP WHERE status='started'").run();
  }

  // Older single schedules had no group; give each its own.
  db.prepare("UPDATE scheduled_calls SET group_id = 'single-' || id WHERE group_id IS NULL OR group_id = ''").run();

  // One row per time within a schedule. Only added when no existing rows clash.
  const clashes = db.prepare(`SELECT group_id, run_at, COUNT(*) n FROM scheduled_calls
      GROUP BY group_id, run_at HAVING COUNT(*) > 1`).all();
  if (clashes.length) {
    console.warn(`Schedule migration: ${clashes.length} duplicate (group, time) pair(s) found; unique index not added.`);
  } else {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_scheduled_calls_group_run ON scheduled_calls (group_id, run_at)');
  }

  // Backfill a group row for every existing schedule (times are read in the user's zone).
  const MIGRATE_TZ = process.env.SCHEDULE_DEFAULT_TZ || 'Asia/Kolkata';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: MIGRATE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = iso => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  const missing = db.prepare(`SELECT DISTINCT group_id FROM scheduled_calls
      WHERE group_id NOT IN (SELECT id FROM schedule_groups)`).all();
  const insertGroup = db.prepare(`INSERT OR IGNORE INTO schedule_groups
      (id, message, language, voice, provider, recipients, sent_by, repeat_mode, dates, start_date, end_date,
       weekdays, skip_weekends, times, timezone, settings, occurrences, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const { group_id } of missing) {
      const rows = db.prepare('SELECT * FROM scheduled_calls WHERE group_id=? ORDER BY run_at').all(group_id);
      if (!rows.length) continue;
      const loc = rows.map(r => local(r.run_at));
      const dates = [...new Set(loc.map(l => l.date))].sort();
      const times = [...new Set(loc.map(l => l.time))].sort();
      // Consecutive days with the same times every day reads as "daily".
      let daily = dates.length * times.length === rows.length;
      for (let i = 1; daily && i < dates.length; i++) {
        daily = (Date.parse(dates[i] + 'T00:00Z') - Date.parse(dates[i - 1] + 'T00:00Z')) === 86400000;
      }
      const mode = daily ? 'daily' : 'dates';
      const pending = rows.some(r => r.status === 'pending');
      const allCancelled = rows.every(r => r.status === 'cancelled');
      const first = rows[0];
      insertGroup.run(group_id, first.message, first.language, first.voice, first.provider, first.recipients, first.sent_by,
        mode, JSON.stringify(dates), dates[0], dates[dates.length - 1], JSON.stringify(times), MIGRATE_TZ,
        JSON.stringify({ migrated: true, mode, dates, times, timezone: MIGRATE_TZ }), rows.length,
        pending ? 'active' : (allCancelled ? 'cancelled' : 'completed'), first.created_at);
    }
  })();
  if (missing.length) console.log(`Schedule migration: created ${missing.length} schedule group record(s).`);
})();

// Keeps schedule_groups.status in step with its occurrences.
function refreshScheduleGroup(groupId) {
  if (!groupId) return;
  const c = db.prepare(`SELECT COUNT(*) n, SUM(status IN ('pending','starting','started')) p, SUM(status='cancelled') x
      FROM scheduled_calls WHERE group_id=?`).get(groupId);
  if (!c || !c.n) return;
  const status = c.p > 0 ? 'active' : (c.x === c.n ? 'cancelled' : 'completed');
  db.prepare('UPDATE schedule_groups SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, groupId);
}

// Local date/time parts of an ISO instant in a time zone ("2026-10-07", "10:30").
function localParts(iso, tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// After a single time is moved, rebuild the group's dates/times from its live rows so
// the card title stays true. A schedule that no longer fits its pattern becomes "dates".
function recomputeGroupRule(groupId) {
  const g = db.prepare('SELECT * FROM schedule_groups WHERE id=?').get(groupId);
  if (!g) return;
  const rows = db.prepare("SELECT run_at FROM scheduled_calls WHERE group_id=? AND status != 'cancelled' ORDER BY run_at").all(groupId);
  if (!rows.length) return;
  const loc = rows.map(r => localParts(r.run_at, g.timezone));
  const dates = [...new Set(loc.map(l => l.date))].sort();
  const times = [...new Set(loc.map(l => l.time))].sort();
  // Still a full grid (every date has every time) -> a plain date list. Otherwise the
  // times were changed one by one and no longer follow a pattern: "custom".
  const fits = dates.length * times.length === rows.length;
  const mode = fits ? 'dates' : 'custom';
  let settings = {};
  try { settings = JSON.parse(g.settings || '{}'); } catch (e) {}
  Object.assign(settings, { mode, times, dates, edited: true });
  db.prepare(`UPDATE schedule_groups SET repeat_mode=?, times=?, dates=?, start_date=?, end_date=?, settings=?,
      occurrences=(SELECT COUNT(*) FROM scheduled_calls WHERE group_id=?), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(mode, JSON.stringify(times), JSON.stringify(dates),
      dates[0], dates[dates.length - 1], JSON.stringify(settings), groupId, groupId);
}

// Initialize settings if not exists
const settingsExists = db.prepare('SELECT id FROM settings WHERE id=1').get();
if (!settingsExists) {
    db.prepare('INSERT INTO settings (id) VALUES (1)').run();
} else if (settingsExists) {
    // Migrate: upgrade parallel_calls if still at old defaults (3 or 10) → 12 (Vobiz plan = 13, using 12 as safe limit)
    const row = db.prepare('SELECT parallel_calls FROM settings WHERE id=1').get();
    if (row && row.parallel_calls <= 10) {
        db.prepare('UPDATE settings SET parallel_calls=12 WHERE id=1').run();
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

// ── PIN LOGIN ────────────────────────────────
// The PIN lives in .env as APP_PIN. It is re-read on each attempt so a change
// takes effect without restarting. Repeated wrong guesses lock that address out.
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;
const pinFails = new Map(); // ip -> { count, until }

const currentPin = () => {
    try {
        const parsed = require('dotenv').parse(fs.readFileSync(ENV_FILE));
        if (parsed.APP_PIN) return String(parsed.APP_PIN).trim();
    } catch (e) {}
    return (process.env.APP_PIN || '').trim();
};

// Checks a PIN against APP_PIN, counting failures per address.
// Returns { ok } or { ok: false, status, message }.
function verifyPin(req, pin) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = pinFails.get(ip);
    if (rec && rec.until > now) {
        return { ok: false, status: 429, message: `Too many attempts. Try again in ${Math.ceil((rec.until - now) / 60000)} min.` };
    }

    const expected = currentPin();
    if (!expected) return { ok: false, status: 503, message: 'No PIN is set. Add APP_PIN to .env.' };

    const a = Buffer.from(String(pin || '')), b = Buffer.from(expected);
    if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) {
        pinFails.delete(ip);
        return { ok: true };
    }

    const expiredLock = rec && rec.until && rec.until <= now;
    const count = (rec && !expiredLock ? rec.count : 0) + 1;
    pinFails.set(ip, { count, until: count >= PIN_MAX_FAILS ? now + PIN_LOCK_MS : 0 });
    const left = PIN_MAX_FAILS - count;
    return { ok: false, status: 401, message: left > 0 ? `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Try again in 5 min.' };
}

app.post('/api/auth/pin', (req, res) => {
    const r = verifyPin(req, req.body && req.body.pin);
    if (r.ok) return res.json({ ok: true });
    res.status(r.status).json({ ok: false, message: r.message });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/contacts', (req, res) => {
    try {
        const contacts = db.prepare('SELECT * FROM contacts').all().map(row => ({
            id: row.id,
            name: row.name || '',
            phone: row.phone,
            group: row.group_name || '',
            group_name: row.group_name || '',
            created_at: row.created_at
        }));
        res.json(contacts);
    } catch (e) { res.json([]); }
});

app.post('/api/contacts', (req, res) => {
    const contacts = Array.isArray(req.body) ? req.body : [req.body];
    const insert = db.prepare('INSERT OR REPLACE INTO contacts (name, phone, group_name) VALUES (?, ?, ?)');
    const insertMany = db.transaction((list) => {
        for (const contact of list) {
            if (!contact || !contact.phone) continue;
            const groupValue = contact.group ?? contact.group_name ?? '';
            insert.run(contact.name || '', contact.phone, groupValue);
        }
    });
    try {
        insertMany(contacts);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Lightweight upsert — only send what changed (new or edited contacts)
app.post('/api/contacts/upsert', (req, res) => {
    const contacts = Array.isArray(req.body) ? req.body : [req.body];
    const insert = db.prepare('INSERT OR REPLACE INTO contacts (name, phone, group_name) VALUES (?, ?, ?)');
    const upsertMany = db.transaction((list) => {
        for (const contact of list) {
            if (!contact || !contact.phone) continue;
            const groupValue = contact.group ?? contact.group_name ?? '';
            insert.run(contact.name || '', contact.phone, groupValue);
        }
    });
    try {
        upsertMany(contacts);
        res.json({ success: true, count: contacts.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/contacts', (req, res) => {
    const { phone, phones } = req.body;
    try {
        if (Array.isArray(phones) && phones.length) {
            // Bulk delete
            const del = db.prepare('DELETE FROM contacts WHERE phone=?');
            const delMany = db.transaction((list) => list.forEach(p => del.run(p)));
            delMany(phones);
        } else if (phone) {
            db.prepare('DELETE FROM contacts WHERE phone=?').run(phone);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

let activeBroadcast = null;
const callCompletionResolvers = new Map();
const sarvamPending = new Map(); // attempt_id -> { phone, done }

app.get('/api/broadcast/status', (req, res) => {
    res.json(activeBroadcast || { active: false });
});

app.post('/api/broadcast/stop', (req, res) => {
    if (activeBroadcast) {
        activeBroadcast.active = false;
        activeBroadcast.stopped = true;
        res.json({ success: true, message: "Broadcast stopping..." });
    } else {
        res.json({ success: false, message: "No active broadcast." });
    }
});

// Credentials as stored server-side in .env (used by the credentials API and the scheduler).
const getEnvCredentials = () => ({
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
    vobiz_id: process.env.VOBIZ_AUTH_ID,
    vobiz_token: process.env.VOBIZ_AUTH_TOKEN,
    vobiz_from: process.env.VOBIZ_FROM,
    sarvam_key: process.env.SARVAM_API_KEY,
    sarvam_org: process.env.SARVAM_ORG_ID,
    sarvam_workspace: process.env.SARVAM_WORKSPACE_ID,
    sarvam_app_id: process.env.SARVAM_APP_ID,
    sarvam_app_version: process.env.SARVAM_APP_VERSION,
    sarvam_connection_id: process.env.SARVAM_CONNECTION_ID,
    sarvam_from: process.env.SARVAM_FROM,
    provider: process.env.PROVIDER || 'twilio',
    public_url: process.env.PUBLIC_URL
});

const PROVIDERS = ['twilio', 'vobiz', 'sarvam'];
const AGENT_GREETING_LABEL = '(Sarvam agent greeting)';
// The Sarvam agent may hold a conversation, so a call can run far longer than the message.
const SARVAM_MAX_CALL_MS = (parseInt(process.env.SARVAM_MAX_CALL_MINUTES, 10) || 10) * 60 * 1000;

// Returns a message describing missing credentials for a provider, or null if usable.
const missingCredentials = (provider, c = {}) => {
    if (provider === 'sarvam') {
        const missing = sarvam.missingSarvamConfig(c);
        return missing ? `Missing Sarvam settings: ${missing}` : null;
    }
    if (provider === 'vobiz') {
        if (!c.vobiz_id || !c.vobiz_token || !c.vobiz_from) return 'Missing Vobiz credentials';
        if (!c.public_url) return 'Missing Public URL (required for Vobiz callbacks)';
        return null;
    }
    if (!c.sid || !c.token || !c.from) return 'Missing Twilio credentials';
    return null;
};

// Validates and starts a broadcast in the background.
// Returns { success, status?, message, duplicatesRemoved? }.
function startBroadcast({ nums, msg, credentials, lang, sentBy, provider, voice, scheduleId }) {
    const { unique: recipientList, duplicates: duplicatesRemoved } = dedupeRecipients(nums || []);
    credentials = credentials || {};

    if (activeBroadcast && activeBroadcast.active) {
        return { success: false, status: 400, message: "A broadcast is already in progress." };
    }

    if (!recipientList.length) {
        return { success: false, status: 400, message: "No valid recipients provided." };
    }

    msg = (msg || '').trim();
    if (!msg && provider !== 'sarvam') {
        return { success: false, status: 400, message: "Message is empty." };
    }

    activeBroadcast = {
        active: true,
        total: recipientList.length,
        current: 0,
        successful: 0,
        failed: 0,
        logs: [],
        startTime: new Date().toISOString(),
        msg: msg,
        lang: lang,
        sentBy: sentBy,
        provider: provider || 'twilio',
        voice: voice || 'Polly.Aditi',
        recipients: recipientList.join('\n')
    };

    if (duplicatesRemoved) {
        activeBroadcast.logs.push({ type: 'info', text: `Removed ${duplicatesRemoved} duplicate ${duplicatesRemoved === 1 ? 'number' : 'numbers'} before dialing.`, time: new Date().toLocaleTimeString() });
    }

    const runBroadcast = async () => {
        const { sid, token, from, vobiz_id, vobiz_token, vobiz_from, public_url } = credentials;
        const currentProvider = provider || 'twilio';
        const broadcastStartedAt = activeBroadcast.startTime;

        let ttsUrl;
        let auth;
        const baseUrl = public_url ? public_url.replace(/\/$/, '') : '';

        if (currentProvider === 'vobiz') {
            const voice = activeBroadcast.voice || 'Polly.Aditi';
            const language = voice.includes('Aditi') || voice.includes('Kajal') ? 'hi-IN' : (voice.includes('Joanna') ? 'en-US' : 'en-IN');
            ttsUrl = `${baseUrl}/api/vobiz/xml?msg=${encodeURIComponent(msg)}&voice=${voice}&lang=${language}&p=vobiz`;
        } else if (currentProvider === 'sarvam') {
            // Sarvam speaks the message itself (passed per call); no TwiML URL needed.
        } else {
            auth = Buffer.from(`${sid}:${token}`).toString('base64');
            if (public_url) {
                const voice = activeBroadcast.voice || 'Polly.Aditi';
                const language = voice.includes('Aditi') || voice.includes('Kajal') ? 'hi-IN' : (voice.includes('Joanna') ? 'en-US' : 'en-IN');
                ttsUrl = `${baseUrl}/api/vobiz/xml?msg=${encodeURIComponent(msg)}&voice=${voice}&lang=${language}&p=twilio`;
            } else {
                ttsUrl = `http://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(msg)}`;
            }
        }

        // ── Semaphore: limit concurrent calls ────────────────────────────
        // Vobiz plan limit = 13 concurrent calls; use 12 to keep 1 slot buffer
        const VOBIZ_PLAN_LIMIT = 12;
        const dbSettings = db.prepare('SELECT parallel_calls FROM settings WHERE id=1').get();
        const configuredConcurrent = (dbSettings && dbSettings.parallel_calls) ? parseInt(dbSettings.parallel_calls) : VOBIZ_PLAN_LIMIT;
        const MAX_CONCURRENT = currentProvider === 'vobiz' ? Math.min(configuredConcurrent, VOBIZ_PLAN_LIMIT) : configuredConcurrent;
        let activeSlots = 0;
        const waiting = [];

        const acquire = () => new Promise(resolve => {
            if (activeSlots < MAX_CONCURRENT) {
                activeSlots++;
                resolve();
            } else {
                waiting.push(resolve);
            }
        });

        const release = () => {
            if (waiting.length > 0) {
                waiting.shift()();   // hand slot directly to next waiter
            } else {
                activeSlots--;
            }
        };
        // ─────────────────────────────────────────────────────────────────

        const logFailure = (phone, errorMsg) => {
            try {
                db.prepare(
                    'INSERT INTO call_failures (phone, error, broadcast_started_at) VALUES (?, ?, ?)'
                ).run(phone, errorMsg, broadcastStartedAt);
            } catch (e) {
                console.error('Failed to log call failure to DB:', e.message);
            }
        };

        // Estimate how long a call takes based on message length
        // ~750 chars/min speaking rate + 30s for ringing/buffer
        const msgLen = (msg || '').length;
        const estimatedCallSec = Math.ceil((msgLen / 750) * 60) + 60; // Extra buffer
        const callTimeoutMs = Math.max(estimatedCallSec * 1000, 180000); // at least 180s

        // ── Poll Vobiz API for call status (fallback if hangup callback doesn't arrive) ──
        const pollCallComplete = async (callUuid) => {
            const POLL_INTERVAL = 5000; // 5 seconds
            const MAX_POLLS = Math.ceil(callTimeoutMs / POLL_INTERVAL);
            for (let i = 0; i < MAX_POLLS; i++) {
                // If hangup callback already resolved, stop polling
                if (!callCompletionResolvers.has(callUuid)) return;
                try {
                    const statusRes = await fetch(`https://api.vobiz.ai/api/v1/Account/${vobiz_id}/Call/${callUuid}/`, {
                        headers: {
                            'X-Auth-ID': vobiz_id,
                            'X-Auth-Token': vobiz_token
                        }
                    });
                    if (statusRes.ok) {
                        const statusData = await statusRes.json();
                        const callStatus = (statusData.call_status || statusData.status || '').toLowerCase();
                        // Terminal statuses: completed, failed, busy, no-answer, canceled
                        if (['completed', 'failed', 'busy', 'no-answer', 'canceled', 'hangup'].includes(callStatus)) {
                            console.log(`[Poll] Call ${callUuid} ended with status: ${callStatus}`);
                            if (callCompletionResolvers.has(callUuid)) {
                                callCompletionResolvers.get(callUuid)();
                                callCompletionResolvers.delete(callUuid);
                            }
                            return;
                        }
                    }
                } catch (e) {
                    console.error(`[Poll] Error checking call ${callUuid}:`, e.message);
                }
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
            }
            // Timeout — force resolve
            if (callCompletionResolvers.has(callUuid)) {
                console.log(`[Poll] Call ${callUuid} timed out, releasing slot`);
                callCompletionResolvers.get(callUuid)();
                callCompletionResolvers.delete(callUuid);
            }
        };

        const callOne = async (n, index) => {
            await acquire();

            if (!activeBroadcast || !activeBroadcast.active) {
                release();
                return;
            }

            let waitForCallEnd = null;
            try {
                let resOk = false;
                let resMsg = '';
                let attempts = 0;
                let maxAttempts = currentProvider === 'vobiz' ? 10 : 1; // 10 attempts * 15s = 2.5 min max wait

                while (attempts < maxAttempts) {
                    attempts++;
                    if (currentProvider === 'vobiz') {
                        // Build call body with hangup_url so we know when the call finishes
                        const callBody = {
                            from: vobiz_from,
                            to: n,
                            answer_url: ttsUrl,
                            answer_method: 'GET'
                        };
                        if (baseUrl) {
                            callBody.hangup_url = `${baseUrl}/api/vobiz/hangup-callback`;
                            callBody.hangup_method = 'POST';
                        }
    
                        const vobizRes = await fetch(`https://api.vobiz.ai/api/v1/Account/${vobiz_id}/Call/`, {
                            method: 'POST',
                            headers: {
                                'X-Auth-ID': vobiz_id,
                                'X-Auth-Token': vobiz_token,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(callBody)
                        });
                        const rjson = await vobizRes.json();
                        resOk = vobizRes.ok;
                        resMsg = resOk ? `Call UUID: ${rjson.call_uuid}` : (rjson.message || JSON.stringify(rjson));
                        
                        // Handle Vobiz Concurrency Limit (429 or specific error messages)
                        const errorText = resMsg.toLowerCase();
                        if (!resOk && (vobizRes.status === 429 || errorText.includes('concurren') || errorText.includes('limit') || errorText.includes('capacity'))) {
                            if (attempts < maxAttempts) {
                                const waitSec = 15;
                                activeBroadcast.logs.push({ type: 'info', text: `[Vobiz] Concurrency limit hit. Waiting ${waitSec}s before retry (${attempts}/${maxAttempts})...`, time: new Date().toLocaleTimeString() });
                                await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
                                continue; // Try again
                            }
                        }
    
                        // If call was initiated, wait for it to actually finish
                        // Uses BOTH hangup callback AND active polling as fallback
                        if (resOk && rjson.call_uuid) {
                            const callUuid = rjson.call_uuid;
                            const callbackPromise = new Promise(resolve => callCompletionResolvers.set(callUuid, resolve));
                            // Start polling in background (will auto-stop if callback resolves first)
                            pollCallComplete(callUuid);
                            waitForCallEnd = callbackPromise.then(() => callCompletionResolvers.delete(callUuid));
                        }
                        break; // Action completed, stop retrying
                    } else if (currentProvider === 'sarvam') {
                        const webhookUrl = baseUrl ? `${baseUrl}/api/sarvam/webhook` : null;
                        const result = await sarvam.placeCall(credentials, {
                            to: n,
                            message: msg,
                            lang,
                            webhookUrl,
                            metadata: {
                                broadcast: broadcastStartedAt,
                                to: n,
                                sig: sarvam.signMetadata(credentials.sarvam_key, broadcastStartedAt, n)
                            }
                        });
                        resOk = result.ok;
                        resMsg = result.ok ? `Call queued (attempt ${result.attemptId})` : result.message;
                        if (result.ok) {
                            try {
                                db.prepare('INSERT OR IGNORE INTO sarvam_calls (attempt_id, phone, status, message, broadcast_started_at) VALUES (?, ?, ?, ?, ?)')
                                    .run(result.attemptId, n, 'queued', msg || null, broadcastStartedAt);
                            } catch (e) { console.error('Failed to record Sarvam call:', e.message); }
                        }

                        // With a public URL, hold the concurrency slot until Sarvam reports the
                        // outcome by webhook (or the timeout passes). Without one, release now.
                        if (result.ok && webhookUrl) {
                            const attemptId = result.attemptId;
                            waitForCallEnd = new Promise(resolve => {
                                const timer = setTimeout(() => {
                                    sarvamPending.delete(attemptId);
                                    resolve();
                                }, SARVAM_MAX_CALL_MS);
                                sarvamPending.set(attemptId, { phone: n, done: () => { clearTimeout(timer); resolve(); } });
                            });
                        }
                        break;
                    } else {
                        const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Basic ${auth}`,
                                'Content-Type': 'application/x-www-form-urlencoded'
                            },
                            body: new URLSearchParams({ To: n, From: from, Url: ttsUrl })
                        });
                        const rjson = await twilioRes.json();
                        resOk = twilioRes.ok;
                        resMsg = resOk ? 'Call queued' : rjson.message;
                        break;
                    }
                }

                if (resOk) {
                    activeBroadcast.successful++;
                    activeBroadcast.logs.push({ type: 'ok', text: `[${currentProvider}] Queued to ${n}`, time: new Date().toLocaleTimeString() });
                } else {
                    activeBroadcast.failed++;
                    activeBroadcast.logs.push({ type: 'err', text: `[${currentProvider}] Failed ${n}: ${resMsg}`, time: new Date().toLocaleTimeString() });
                    logFailure(n, resMsg);
                }
            } catch (err) {
                activeBroadcast.failed++;
                const errMsg = `Network error: ${err.message}`;
                activeBroadcast.logs.push({ type: 'err', text: `${errMsg} for ${n}`, time: new Date().toLocaleTimeString() });
                logFailure(n, errMsg);
            } finally {
                activeBroadcast.current++;
                // For Vobiz: wait until the call actually finishes before releasing
                // the concurrency slot — prevents "Concurrent Call Limit Reached"
                if (currentProvider === 'vobiz') {
                    if (waitForCallEnd) {
                        // Wait for call to finish before releasing concurrency slot
                        await waitForCallEnd;
                    }
                    // Brief buffer after call confirmed done
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (waitForCallEnd) {
                    await waitForCallEnd;
                }
                release();
            }
        };

        // Kick off all calls; semaphore gates concurrency (10 at a time for Vobiz)
        const tasks = recipientList.map((raw, i) => {
            let n = raw.trim();
            if (!n.startsWith('+')) n = '+' + n;
            return callOne(n, i);
        });
        await Promise.all(tasks);

        if (activeBroadcast) {
            try {
                db.prepare('INSERT INTO history (message, language, total, successful, recipients, results, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                    msg || AGENT_GREETING_LABEL,
                    lang,
                    activeBroadcast.total,
                    activeBroadcast.successful,
                    activeBroadcast.recipients,
                    JSON.stringify(activeBroadcast.logs),
                    activeBroadcast.startTime
                );
            } catch (e) {
                console.error("Error saving history:", e);
            }
            console.log(`Broadcast complete — sent: ${activeBroadcast.successful}, failed: ${activeBroadcast.failed}`);
            if (scheduleId) {
                try {
                    const note = `Sent ${activeBroadcast.successful}, failed ${activeBroadcast.failed}${activeBroadcast.stopped ? ' (stopped early)' : ''}`;
                    db.prepare("UPDATE scheduled_calls SET status='completed', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='started'")
                        .run(note, scheduleId);
                    const row = db.prepare('SELECT group_id FROM scheduled_calls WHERE id=?').get(scheduleId);
                    if (row) refreshScheduleGroup(row.group_id);
                } catch (e) { console.error('Error updating schedule status:', e.message); }
            }
            activeBroadcast.active = false;
        }
    };

    runBroadcast();
    return { success: true, message: "Broadcast started in background.", duplicatesRemoved };
}

app.post('/api/broadcast', (req, res) => {
    const result = startBroadcast({ ...req.body, credentials: getEnvCredentials() });
    if (!result.success) {
        return res.status(result.status || 400).json({ success: false, message: result.message });
    }
    res.json({ success: true, message: result.message, duplicatesRemoved: result.duplicatesRemoved });
});

// ── SARVAM WEBHOOK ───────────────────────────
// Sarvam POSTs the outcome of each call attempt here, including the conversation transcript.
app.post('/api/sarvam/webhook', (req, res) => {
    const p = req.body || {};
    const attemptId = p.attempt_id;
    const meta = (p.webhook_config && p.webhook_config.metadata) || {};
    // Only accept results for calls this server placed (metadata is signed with the API key).
    if (!attemptId || !sarvam.verifyMetadata(process.env.SARVAM_API_KEY, meta)) {
        return res.status(403).json({ ok: false });
    }

    const status = p.status || 'unknown';
    const reason = p.failure_reason || null;
    try {
        db.prepare(`INSERT INTO sarvam_calls (attempt_id, phone, status, duration, failure_reason, transcript, agent_variables, broadcast_started_at, updated_at)
                    VALUES (@id, @phone, @status, @duration, @reason, @transcript, @vars, @broadcast, CURRENT_TIMESTAMP)
                    ON CONFLICT(attempt_id) DO UPDATE SET status=@status, duration=@duration, failure_reason=@reason,
                        transcript=@transcript, agent_variables=@vars, updated_at=CURRENT_TIMESTAMP`)
            .run({
                id: attemptId, phone: meta.to || null, status, duration: p.duration ?? null, reason,
                transcript: p.interaction_transcript ? JSON.stringify(p.interaction_transcript) : null,
                vars: p.final_agent_variables ? JSON.stringify(p.final_agent_variables) : null,
                broadcast: meta.broadcast || null
            });
    } catch (e) {
        console.error('Failed to save Sarvam call result:', e.message);
    }

    const pending = sarvamPending.get(attemptId);
    if (pending) {
        sarvamPending.delete(attemptId);
        if (activeBroadcast) {
            const time = new Date().toLocaleTimeString();
            const logFailure = detail => {
                try {
                    db.prepare('INSERT INTO call_failures (phone, error, broadcast_started_at) VALUES (?, ?, ?)')
                        .run(pending.phone, detail, activeBroadcast.startTime);
                } catch (e) {}
            };
            if (status === 'connected') {
                const secs = p.duration ? ` (${Math.round(p.duration)}s)` : '';
                activeBroadcast.logs.push({ type: 'ok', text: `[sarvam] Answered ${pending.phone}${secs}`, time });
            } else if (status === 'no_answer' || status === 'busy') {
                const text = `[sarvam] ${pending.phone}: ${status === 'busy' ? 'line busy' : 'no answer'}`;
                activeBroadcast.logs.push({ type: 'info', text, time });
                logFailure(status);
            } else {
                const detail = reason || status;
                activeBroadcast.successful = Math.max(0, activeBroadcast.successful - 1);
                activeBroadcast.failed++;
                activeBroadcast.logs.push({ type: 'err', text: `[sarvam] Failed ${pending.phone}: ${detail}`, time });
                logFailure(detail);
            }
        }
        pending.done();
    }
    res.status(200).json({ ok: true });
});

// Sarvam call results, newest first, one page at a time.
//   ?limit=30            page size (1-100)
//   ?cursor=<from next>  continue after the last row of the previous page
//   ?phone=<number>      only this person's calls (matched on the last 10 digits)
// Returns { rows, next, total }; next is null on the last page.
db.exec('CREATE INDEX IF NOT EXISTS idx_sarvam_calls_created ON sarvam_calls (created_at, attempt_id)');
const parseJson = v => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
app.get('/api/sarvam/calls', (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const where = [], args = [];
        const digits = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
        if (digits) { where.push("replace(replace(phone, ' ', ''), '-', '') LIKE ?"); args.push('%' + digits); }
        const total = db.prepare(`SELECT COUNT(*) n FROM sarvam_calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
        if (req.query.cursor) {
            let c = null;
            try { c = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString()); } catch (e) {}
            if (!c || typeof c.t !== 'string' || typeof c.id !== 'string') return res.status(400).json({ error: 'Bad cursor' });
            where.push('(created_at < ? OR (created_at = ? AND attempt_id < ?))');
            args.push(c.t, c.t, c.id);
        }
        const rows = db.prepare(`SELECT * FROM sarvam_calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC, attempt_id DESC LIMIT ?`).all(...args, limit + 1);
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        res.json({
            rows: page.map(r => ({ ...r, transcript: parseJson(r.transcript), agent_variables: parseJson(r.agent_variables) })),
            next: more && last ? Buffer.from(JSON.stringify({ t: last.created_at, id: last.attempt_id })).toString('base64url') : null,
            total
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOBIZ DASHBOARD APIS ─────────────────────

app.post('/api/vobiz/balance', async (req, res) => {
    const sid = process.env.VOBIZ_AUTH_ID, token = process.env.VOBIZ_AUTH_TOKEN;
    if (!sid || !token) return res.status(400).json({ error: 'Missing Vobiz credentials' });

    try {
        const url = `https://api.vobiz.ai/api/v1/account/${sid}/balance/INR`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vobiz/logs', async (req, res) => {
    const sid = process.env.VOBIZ_AUTH_ID, token = process.env.VOBIZ_AUTH_TOKEN;
    if (!sid || !token) return res.status(400).json({ error: 'Missing Vobiz credentials' });

    try {
        // Fetch more logs (per_page=100 instead of default 20 recent)
        const url = `https://api.vobiz.ai/api/v1/account/${sid}/cdr?per_page=100&page=1`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.all('/api/vobiz/xml', (req, res) => {
    const msg = req.query.msg || req.body.msg || 'Hello';
    const voice = req.query.voice || req.body.voice || 'Polly.Aditi';
    const lang = req.query.lang || req.body.lang || 'hi-IN';
    const provider = req.query.p || req.body.p || 'vobiz';

    // XML Escape helper
    const escapeXml = (unsafe) => unsafe.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
        }
        return c;
    });

    const safeMsg = escapeXml(msg);
    res.set('Content-Type', 'application/xml');

    if (provider === 'vobiz') {
        const vobizVoice = voice.toLowerCase().includes('man') ? 'MAN' : 'WOMAN';
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="${vobizVoice}" language="${lang}">${safeMsg}</Speak>
</Response>`);
    } else {
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="${lang}" voice="${voice}">${safeMsg}</Say>
</Response>`);
    }
});

// ── VOBIZ HANGUP CALLBACK ─────────────────────
// Called by Vobiz when a call ends — releases the concurrency slot
app.all('/api/vobiz/hangup-callback', (req, res) => {
    const params = { ...req.query, ...req.body };
    const callUuid = params.CallUUID || params.call_uuid;
    console.log(`[Hangup Callback] CallUUID: ${callUuid}, Status: ${params.CallStatus || 'unknown'}`);
    if (callUuid && callCompletionResolvers.has(callUuid)) {
        callCompletionResolvers.get(callUuid)();
        callCompletionResolvers.delete(callUuid);
    }
    res.status(200).send('OK');
});

// Serve only the frontend files. Never the app folder itself: it holds the database,
// its backups, .env, logs and server code.
const path = require('path');
// The app shell (index.html, sw.js, manifest) and the code (js/css) must always be
// revalidated so a deploy reaches installed PWAs straight away.
const NO_CACHE = 'no-cache';
const sendAppFile = (name, noCache) => (req, res) => {
    if (noCache) res.set('Cache-Control', NO_CACHE);
    res.sendFile(path.join(__dirname, name));
};
app.get(['/', '/index.html'], sendAppFile('index.html', true));
['sw.js', 'manifest.webmanifest'].forEach(f => app.get('/' + f, sendAppFile(f, true)));
['favicon.png', 'favicon.svg'].forEach(f => app.get('/' + f, sendAppFile(f)));
['css', 'js'].forEach(dir => app.use('/' + dir, express.static(path.join(__dirname, dir), {
    index: false, dotfiles: 'deny', setHeaders: res => res.set('Cache-Control', NO_CACHE)
})));
app.use('/icons', express.static(path.join(__dirname, 'icons'), { index: false, dotfiles: 'deny' }));

// Secret values never leave the server; the browser only learns whether each is set.
const SECRET_FIELDS = ['token', 'vobiz_token', 'sarvam_key'];

app.get('/api/config', (req, res) => {
    const c = getEnvCredentials();
    const out = { ...c, missing: missingCredentials(c.provider, c) };
    SECRET_FIELDS.forEach(f => { out['has_' + f] = !!c[f]; delete out[f]; });
    res.json(out);
});

// Maps credential fields (as sent by the API tab) to their .env variable names.
const ENV_KEYS = {
    sid: 'TWILIO_ACCOUNT_SID', token: 'TWILIO_AUTH_TOKEN', from: 'TWILIO_FROM',
    vobiz_id: 'VOBIZ_AUTH_ID', vobiz_token: 'VOBIZ_AUTH_TOKEN', vobiz_from: 'VOBIZ_FROM',
    sarvam_key: 'SARVAM_API_KEY', sarvam_org: 'SARVAM_ORG_ID', sarvam_workspace: 'SARVAM_WORKSPACE_ID',
    sarvam_app_id: 'SARVAM_APP_ID', sarvam_app_version: 'SARVAM_APP_VERSION',
    sarvam_connection_id: 'SARVAM_CONNECTION_ID', sarvam_from: 'SARVAM_FROM',
    provider: 'PROVIDER', public_url: 'PUBLIC_URL'
};

// Saving needs the PIN. A blank secret field keeps the saved value.
app.post('/api/config', (req, res) => {
    const auth = verifyPin(req, req.body && req.body.pin);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });
    try {
        // Merge into the existing .env so settings this form doesn't manage (PORT, DB_PATH, ...) survive.
        const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
        const values = new Map();
        const order = [];
        existing.forEach(line => {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m) { values.set(m[1], m[2]); order.push(m[1]); }
        });
        Object.entries(ENV_KEYS).forEach(([field, envKey]) => {
            if (!(field in req.body)) return; // not sent: leave as is
            if (SECRET_FIELDS.includes(field) && !req.body[field]) return;
            const clean = String(req.body[field] ?? '').replace(/[\r\n]/g, '');
            if (!values.has(envKey)) order.push(envKey);
            values.set(envKey, field === 'provider' ? (clean || 'twilio') : clean);
        });
        fs.writeFileSync(ENV_FILE, order.map(k => `${k}=${values.get(k)}`).join('\n') + '\n');
        // dotenv's override re-reads .env; blank values must also clear the in-memory copy.
        order.forEach(k => { process.env[k] = values.get(k); });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── SCHEDULED CALLS ──────────────────────────
const SCHEDULE_GRACE_MS = (parseInt(process.env.SCHEDULE_GRACE_MINUTES, 10) || 60) * 60 * 1000;

const MAX_SCHEDULE_OCCURRENCES = 200;

const SCHEDULE_MODES = ['once', 'dates', 'daily', 'weekly'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

// Keeps only well-formed rule fields from the browser (the browser builds the run times
// in the user's time zone; the rule is stored so the schedule can be read back later).
function cleanScheduleRule(rule, times) {
    const r = rule && typeof rule === 'object' ? rule : {};
    const mode = SCHEDULE_MODES.includes(r.mode) ? r.mode : (times.length > 1 ? 'dates' : 'once');
    const list = (v, re) => (Array.isArray(v) ? [...new Set(v.map(String).filter(x => re.test(x)))].sort() : []);
    const weekdays = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [];
    const endAfter = parseInt(r.endAfter, 10);
    return {
        mode,
        dates: list(r.dates, YMD),
        startDate: YMD.test(r.startDate || '') ? r.startDate : null,
        endDate: YMD.test(r.endDate || '') ? r.endDate : null,
        endAfter: endAfter > 0 ? Math.min(endAfter, MAX_SCHEDULE_OCCURRENCES) : null,
        weekdays,
        skipWeekends: !!r.skipWeekends,
        times: list(r.times, HM),
        timezone: typeof r.timezone === 'string' ? r.timezone.slice(0, 64) : null
    };
}

// Accepts one time (runAt) or many (runAts) plus the repeat rule that produced them.
// Every press of "Schedule" becomes one schedule_groups row and one scheduled_calls row per time.
app.post('/api/schedule', (req, res) => {
    const { nums, msg, lang, voice, provider, runAt, runAts, sentBy, rule } = req.body || {};
    const { unique: recipients } = dedupeRecipients(nums || []);
    const prov = provider || 'twilio';
    const rawTimes = Array.isArray(runAts) ? runAts : [runAt];

    if (!PROVIDERS.includes(prov)) return res.status(400).json({ success: false, message: 'Unknown provider.' });
    if ((!msg || !String(msg).trim()) && prov !== 'sarvam') return res.status(400).json({ success: false, message: 'Message is empty.' });
    if (!recipients.length) return res.status(400).json({ success: false, message: 'No valid recipients provided.' });

    const times = [...new Set(rawTimes.map(t => Date.parse(t)))].sort((x, y) => x - y);
    if (!times.length || times.some(Number.isNaN)) return res.status(400).json({ success: false, message: 'Invalid date/time.' });
    if (times.length > MAX_SCHEDULE_OCCURRENCES) {
        return res.status(400).json({ success: false, message: `Too many times (${times.length}); the limit is ${MAX_SCHEDULE_OCCURRENCES}.` });
    }
    if (times[0] < Date.now() - 60 * 1000) return res.status(400).json({ success: false, message: 'Scheduled time is in the past.' });

    const missing = missingCredentials(prov, getEnvCredentials());
    if (missing) return res.status(400).json({ success: false, message: `${missing}. Save credentials in the API tab first.` });

    const r = cleanScheduleRule(rule, times);
    const groupId = require('crypto').randomUUID();
    const message = String(msg || '').trim();
    const recipientsJson = JSON.stringify(recipients);
    const insertGroup = db.prepare(`INSERT INTO schedule_groups
        (id, message, language, voice, provider, recipients, sent_by, repeat_mode, dates, start_date, end_date, end_after,
         weekdays, skip_weekends, times, timezone, settings, occurrences, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
    const insert = db.prepare(
        'INSERT INTO scheduled_calls (message, language, voice, provider, recipients, run_at, sent_by, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    try {
        const ids = db.transaction(() => {
            insertGroup.run(groupId, message, lang || 'hi', voice || null, prov, recipientsJson, sentBy || null,
                r.mode, JSON.stringify(r.dates), r.startDate, r.endDate, r.endAfter, JSON.stringify(r.weekdays),
                r.skipWeekends ? 1 : 0, JSON.stringify(r.times), r.timezone, JSON.stringify(r), times.length);
            return times.map(t => insert.run(message, lang || 'hi', voice || null, prov,
                recipientsJson, new Date(t).toISOString(), sentBy || null, groupId).lastInsertRowid);
        })();
        res.json({ success: true, id: ids[0], ids, groupId, occurrences: times.length, total: recipients.length,
            firstRunAt: new Date(times[0]).toISOString(), lastRunAt: new Date(times[times.length - 1]).toISOString() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Full settings of one schedule (for the Edit form and "View numbers").
app.get('/api/schedule/group/:id', (req, res) => {
    try {
        const g = db.prepare('SELECT * FROM schedule_groups WHERE id=?').get(req.params.id);
        if (!g) return res.status(404).json({ success: false, message: 'Schedule not found.' });
        const parse = (v, d) => { try { return JSON.parse(v); } catch (e) { return d; } };
        const rows = db.prepare('SELECT id, run_at, status, note FROM scheduled_calls WHERE group_id=? ORDER BY run_at').all(g.id);
        res.json({ success: true, group: {
            id: g.id, message: g.message, language: g.language, voice: g.voice, provider: g.provider,
            recipients: parse(g.recipients, []), sent_by: g.sent_by, mode: g.repeat_mode, dates: parse(g.dates, []),
            start_date: g.start_date, end_date: g.end_date, end_after: g.end_after, weekdays: parse(g.weekdays, []),
            skip_weekends: !!g.skip_weekends, times: parse(g.times, []), timezone: g.timezone, settings: parse(g.settings, {}),
            status: g.status, created_at: g.created_at, updated_at: g.updated_at
        }, rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Edits a whole schedule. Only still-pending times change: pending times that are no
// longer in the rule are removed, new times are added, and kept pending times get the
// new message/recipients. Anything that already ran (or was cancelled) stays as history.
app.put('/api/schedule/group/:id', (req, res) => {
    const groupId = req.params.id;
    const { nums, msg, lang, voice, provider, runAts, sentBy, rule } = req.body || {};
    const g = db.prepare('SELECT * FROM schedule_groups WHERE id=?').get(groupId);
    if (!g) return res.status(404).json({ success: false, message: 'Schedule not found.' });
    const prov = provider || g.provider;
    const { unique: recipients } = dedupeRecipients(nums || []);
    if (!PROVIDERS.includes(prov)) return res.status(400).json({ success: false, message: 'Unknown provider.' });
    if ((!msg || !String(msg).trim()) && prov !== 'sarvam') return res.status(400).json({ success: false, message: 'Message is empty.' });
    if (!recipients.length) return res.status(400).json({ success: false, message: 'No valid recipients provided.' });
    const times = [...new Set((Array.isArray(runAts) ? runAts : []).map(t => Date.parse(t)))].sort((x, y) => x - y);
    if (!times.length || times.some(Number.isNaN)) return res.status(400).json({ success: false, message: 'Invalid date/time.' });
    if (times.length > MAX_SCHEDULE_OCCURRENCES) return res.status(400).json({ success: false, message: `Too many times; the limit is ${MAX_SCHEDULE_OCCURRENCES}.` });
    if (times[0] < Date.now() - 60 * 1000) return res.status(400).json({ success: false, message: 'Scheduled time is in the past.' });
    const missing = missingCredentials(prov, getEnvCredentials());
    if (missing) return res.status(400).json({ success: false, message: `${missing}. Save credentials in the API tab first.` });

    const r = cleanScheduleRule(rule, times);
    const message = prov === 'sarvam' ? '' : String(msg || '').trim();
    const recipientsJson = JSON.stringify(recipients);
    const wanted = new Map(times.map(t => [new Date(t).toISOString(), t]));
    try {
        const result = db.transaction(() => {
            const running = db.prepare("SELECT COUNT(*) n FROM scheduled_calls WHERE group_id=? AND status IN ('starting','started')").get(groupId).n;
            if (running) { const e = new Error('A broadcast from this schedule is running right now. Try again when it finishes.'); e.status = 409; throw e; }
            const rows = db.prepare('SELECT id, run_at, status FROM scheduled_calls WHERE group_id=?').all(groupId);
            const byTime = new Map(rows.map(x => [new Date(x.run_at).toISOString(), x]));
            let removed = 0, kept = 0, added = 0, revived = 0;
            // Pending times no longer wanted: they never ran, so remove them.
            for (const x of rows) {
                if (x.status === 'pending' && !wanted.has(new Date(x.run_at).toISOString())) {
                    db.prepare('DELETE FROM scheduled_calls WHERE id=?').run(x.id); removed++;
                }
            }
            const upd = db.prepare(`UPDATE scheduled_calls SET message=?, language=?, voice=?, provider=?, recipients=?, sent_by=?,
                status='pending', note=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
            const ins = db.prepare('INSERT INTO scheduled_calls (message, language, voice, provider, recipients, run_at, sent_by, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            for (const iso of wanted.keys()) {
                const x = byTime.get(iso);
                if (x && x.status === 'pending') { upd.run(message, lang || 'hi', voice || null, prov, recipientsJson, sentBy || g.sent_by, x.id); kept++; }
                else if (x && x.status === 'cancelled') { upd.run(message, lang || 'hi', voice || null, prov, recipientsJson, sentBy || g.sent_by, x.id); revived++; }
                else if (x) { /* already ran at exactly this time: keep it as history */ }
                else { ins.run(message, lang || 'hi', voice || null, prov, recipientsJson, iso, sentBy || g.sent_by, groupId); added++; }
            }
            db.prepare(`UPDATE schedule_groups SET message=?, language=?, voice=?, provider=?, recipients=?, repeat_mode=?, dates=?,
                start_date=?, end_date=?, end_after=?, weekdays=?, skip_weekends=?, times=?, timezone=?, settings=?,
                occurrences=(SELECT COUNT(*) FROM scheduled_calls WHERE group_id=?), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
                .run(message, lang || 'hi', voice || null, prov, recipientsJson, r.mode, JSON.stringify(r.dates), r.startDate, r.endDate,
                    r.endAfter, JSON.stringify(r.weekdays), r.skipWeekends ? 1 : 0, JSON.stringify(r.times), r.timezone || g.timezone,
                    JSON.stringify({ ...r, edited: true }), groupId, groupId);
            refreshScheduleGroup(groupId);
            return { removed, kept, added, revived };
        })();
        res.json({ success: true, groupId, ...result, total: recipients.length,
            pending: db.prepare("SELECT COUNT(*) n FROM scheduled_calls WHERE group_id=? AND status='pending'").get(groupId).n });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, message: e.message });
    }
});

// Moves one pending time to a new date/time.
app.put('/api/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = Date.parse((req.body || {}).runAt);
    if (!id || Number.isNaN(t)) return res.status(400).json({ success: false, message: 'Pick a valid date and time.' });
    if (t < Date.now() + 30 * 1000) return res.status(400).json({ success: false, message: 'That time is in the past.' });
    const iso = new Date(t).toISOString();
    try {
        db.transaction(() => {
            const row = db.prepare('SELECT * FROM scheduled_calls WHERE id=?').get(id);
            if (!row) { const e = new Error('Scheduled time not found.'); e.status = 404; throw e; }
            if (row.status !== 'pending') { const e = new Error('Only a scheduled (pending) time can be changed.'); e.status = 409; throw e; }
            const clash = db.prepare('SELECT id, status FROM scheduled_calls WHERE group_id=? AND run_at=? AND id != ?').get(row.group_id, iso, id);
            if (clash && clash.status !== 'cancelled') { const e = new Error('This schedule already has a call at that time.'); e.status = 409; throw e; }
            if (clash) db.prepare('DELETE FROM scheduled_calls WHERE id=?').run(clash.id); // a cancelled duplicate makes way
            db.prepare("UPDATE scheduled_calls SET run_at=?, note=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(iso, id);
            recomputeGroupRule(row.group_id);
        })();
        res.json({ success: true, id, run_at: iso });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, message: e.message });
    }
});

// Every pending entry, plus the most recent finished ones, each with its group's settings.
app.get('/api/schedule', (req, res) => {
    try {
        const rows = db.prepare(
            `SELECT * FROM scheduled_calls WHERE status IN ('pending','starting')
             UNION ALL
             SELECT * FROM (SELECT * FROM scheduled_calls WHERE status NOT IN ('pending','starting') ORDER BY run_at DESC LIMIT 100)
             ORDER BY run_at ASC`
        ).all();
        const groupStmt = db.prepare('SELECT repeat_mode, times, weekdays, skip_weekends, end_after, timezone, status FROM schedule_groups WHERE id=?');
        const groups = new Map();
        const groupOf = id => {
            if (!groups.has(id)) {
                const g = groupStmt.get(id);
                groups.set(id, g ? {
                    mode: g.repeat_mode, times: JSON.parse(g.times || '[]'), weekdays: JSON.parse(g.weekdays || '[]'),
                    skip_weekends: !!g.skip_weekends, end_after: g.end_after, timezone: g.timezone, status: g.status
                } : null);
            }
            return groups.get(id);
        };
        res.json(rows.map(r => {
            const group_id = r.group_id || `single-${r.id}`;
            return {
                id: r.id, group_id, message: r.message, language: r.language,
                provider: r.provider, total: JSON.parse(r.recipients).length, run_at: r.run_at,
                status: r.status, note: r.note, sent_by: r.sent_by, group: groupOf(group_id)
            };
        }));
    } catch (e) { res.json([]); }
});

// Cancels one entry ({ id }) or every pending entry in a group ({ group }).
app.delete('/api/schedule', (req, res) => {
    const { id, group } = req.body || {};
    try {
        let info, groupId = group;
        if (group && String(group).startsWith('single-') && !db.prepare('SELECT 1 FROM scheduled_calls WHERE group_id=?').get(group)) {
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(String(group).slice(7));
        } else if (group) {
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND status='pending'").run(group);
        } else {
            const row = db.prepare('SELECT group_id FROM scheduled_calls WHERE id=?').get(id);
            groupId = row && row.group_id;
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(id);
        }
        refreshScheduleGroup(groupId);
        res.json(info.changes
            ? { success: true, cancelled: info.changes }
            : { success: false, message: 'Only pending schedules can be cancelled.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Starts at most one due schedule per tick, and only while no broadcast is running.
// Everything is read from the DB each tick, so pending schedules survive a restart.
// A time that comes up while another broadcast is still running waits its turn and
// starts as soon as that broadcast ends. Only a time that passed while the server was
// down (and longer ago than the grace period) is marked missed.
const SERVER_STARTED_AT = Date.now();
const WAITING_NOTE = 'Waiting: previous broadcast still running';
function runDueSchedules() {
    try {
        const nowIso = new Date().toISOString();
        if (activeBroadcast && activeBroadcast.active) {
            db.prepare("UPDATE scheduled_calls SET note=?, updated_at=CURRENT_TIMESTAMP WHERE status='pending' AND run_at <= ? AND note IS NULL")
                .run(WAITING_NOTE, nowIso);
            return;
        }
        const due = db.prepare("SELECT * FROM scheduled_calls WHERE status='pending' AND run_at <= ? ORDER BY run_at LIMIT 1").get(nowIso);
        if (!due) return;
        const setStatus = (status, note) => {
            db.prepare('UPDATE scheduled_calls SET status=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, note || null, due.id);
            refreshScheduleGroup(due.group_id);
        };
        // Claim the row first so a second server process can never start the same call.
        const claimed = db.prepare("UPDATE scheduled_calls SET status='starting', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(due.id);
        if (claimed.changes !== 1) return;

        const runAt = Date.parse(due.run_at);
        const lateMs = Date.now() - runAt;
        const waitedForBroadcast = due.note === WAITING_NOTE;
        const serverWasDown = runAt < SERVER_STARTED_AT;
        if (lateMs > SCHEDULE_GRACE_MS && serverWasDown && !waitedForBroadcast) {
            return setStatus('missed', 'Server was not running at the scheduled time.');
        }
        const credentials = getEnvCredentials();
        const missing = missingCredentials(due.provider, credentials);
        if (missing) return setStatus('failed', missing);

        const result = startBroadcast({
            nums: JSON.parse(due.recipients), msg: due.message, credentials,
            lang: due.language, sentBy: due.sent_by || 'Scheduled', provider: due.provider, voice: due.voice,
            scheduleId: due.id
        });
        const lateMin = Math.round(lateMs / 60000);
        const lateNote = lateMin < 2 ? null
            : waitedForBroadcast ? `Started ${lateMin} min late: previous broadcast was still running`
            : `Started ${lateMin} min late: server was not running at the scheduled time`;
        if (result.success) setStatus('started', lateNote);
        else if (result.message === 'A broadcast is already in progress.') setStatus('pending', WAITING_NOTE); // next tick
        else setStatus('failed', result.message);
    } catch (e) {
        console.error('Scheduler error:', e.message);
    }
}
if (SCHEDULER_ON) {
    setInterval(runDueSchedules, 30 * 1000);
    setTimeout(runDueSchedules, 5000);
} else {
    console.log('Scheduler is OFF (VOXSEND_SCHEDULER=off): no scheduled broadcast will start.');
}



app.get('/api/history', (req, res) => {
    try {
        const history = db.prepare('SELECT * FROM history ORDER BY created_at DESC').all();
        res.json(history);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/history', (req, res) => {
    const { message, language, total, successful, results, created_at } = req.body;
    try {
        db.prepare('INSERT INTO history (message, language, total, successful, results, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            message, language, total, successful, JSON.stringify(results), created_at || new Date().toISOString()
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/history', (req, res) => {
    const { id } = req.body;
    try {
        if (id) {
            db.prepare('DELETE FROM history WHERE id=?').run(id);
        } else {
            db.prepare('DELETE FROM history').run(); // Clear all
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/messages', (req, res) => {
    try {
        const messages = db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
        res.json(messages);
    } catch (e) { res.json([]); }
});

app.post('/api/messages', (req, res) => {
    const { name, content, language } = req.body;
    try {
        db.prepare('INSERT INTO messages (name, content, language) VALUES (?, ?, ?)').run(name || 'Saved Message', content, language);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/messages', (req, res) => {
    const { id } = req.body;
    try {
        db.prepare('DELETE FROM messages WHERE id=?').run(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/settings', (req, res) => {
    try {
        const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
        res.json(settings || {});
    } catch (e) { res.json({}); }
});

app.post('/api/settings', (req, res) => {
    const { parallel_calls, retry_failed, default_language, delay_ms, org_name } = req.body;
    try {
        db.prepare('UPDATE settings SET parallel_calls=?, retry_failed=?, default_language=?, delay_ms=?, org_name=? WHERE id=1').run(
            parallel_calls, retry_failed, default_language, delay_ms, org_name
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.use((err, req, res, next) => {
    console.error('SERVER ERROR:', err.message);
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, error: 'Payload too large. Max limit is 100mb.' });
    }
    res.status(500).json({ success: false, error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, (err) => {
    // Express 5 hands listen errors to this callback. Exit instead of lingering as a
    // second process that has no port but still runs the scheduler.
    if (err) {
        console.error(`Could not listen on port ${PORT}: ${err.message}`);
        process.exit(1);
    }
    console.log(`Server running at http://localhost:${PORT}`);
});
