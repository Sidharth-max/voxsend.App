require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const fs = require('fs');
const sarvam = require('./sarvam');
const app = express();

const db = new Database(process.env.DB_PATH || 'voxsend.db');

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
        const parsed = require('dotenv').parse(fs.readFileSync('.env'));
        if (parsed.APP_PIN) return String(parsed.APP_PIN).trim();
    } catch (e) {}
    return (process.env.APP_PIN || '').trim();
};

app.post('/api/auth/pin', (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = pinFails.get(ip);
    if (rec && rec.until > now) {
        return res.status(429).json({ ok: false, message: `Too many attempts. Try again in ${Math.ceil((rec.until - now) / 60000)} min.` });
    }

    const expected = currentPin();
    if (!expected) return res.status(503).json({ ok: false, message: 'No PIN is set. Add APP_PIN to .env.' });

    const given = String((req.body && req.body.pin) || '');
    const a = Buffer.from(given), b = Buffer.from(expected);
    const match = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    if (match) {
        pinFails.delete(ip);
        return res.json({ ok: true });
    }

    const expiredLock = rec && rec.until && rec.until <= now;
    const count = (rec && !expiredLock ? rec.count : 0) + 1;
    pinFails.set(ip, { count, until: count >= PIN_MAX_FAILS ? now + PIN_LOCK_MS : 0 });
    const left = PIN_MAX_FAILS - count;
    res.status(401).json({ ok: false, message: left > 0 ? `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Try again in 5 min.' });
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
function startBroadcast({ nums, msg, credentials, lang, sentBy, provider, voice }) {
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
            activeBroadcast.active = false;
        }
    };

    runBroadcast();
    return { success: true, message: "Broadcast started in background.", duplicatesRemoved };
}

app.post('/api/broadcast', (req, res) => {
    const result = startBroadcast(req.body);
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

app.get('/api/sarvam/calls', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM sarvam_calls ORDER BY created_at DESC LIMIT 100').all();
        res.json(rows.map(r => ({
            ...r,
            transcript: r.transcript ? JSON.parse(r.transcript) : null,
            agent_variables: r.agent_variables ? JSON.parse(r.agent_variables) : null
        })));
    } catch (e) { res.json([]); }
});

// ── VOBIZ DASHBOARD APIS ─────────────────────

app.post('/api/vobiz/balance', async (req, res) => {
    const { sid, token } = req.body;
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
    const { sid, token } = req.body;
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

app.use(express.static(__dirname));

app.get('/api/credentials', (req, res) => {
    res.json(getEnvCredentials());
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

app.post('/api/credentials', (req, res) => {
    try {
        // Merge into the existing .env so settings this form doesn't manage (PORT, DB_PATH, ...) survive.
        const existing = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split('\n') : [];
        const values = new Map();
        const order = [];
        existing.forEach(line => {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m) { values.set(m[1], m[2]); order.push(m[1]); }
        });
        Object.entries(ENV_KEYS).forEach(([field, envKey]) => {
            if (!(field in req.body)) return; // not sent: leave as is
            const clean = String(req.body[field] ?? '').replace(/[\r\n]/g, '');
            if (!values.has(envKey)) order.push(envKey);
            values.set(envKey, field === 'provider' ? (clean || 'twilio') : clean);
        });
        fs.writeFileSync('.env', order.map(k => `${k}=${values.get(k)}`).join('\n') + '\n');
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

// Accepts one time (runAt) or many (runAts). Many times are stored as one group,
// e.g. every day in a date range at one or more times of day.
app.post('/api/schedule', (req, res) => {
    const { nums, msg, lang, voice, provider, runAt, runAts, sentBy } = req.body || {};
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

    const groupId = require('crypto').randomUUID();
    const insert = db.prepare(
        'INSERT INTO scheduled_calls (message, language, voice, provider, recipients, run_at, sent_by, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    try {
        const ids = db.transaction(() => times.map(t => insert.run(String(msg || '').trim(), lang || 'hi', voice || null, prov,
            JSON.stringify(recipients), new Date(t).toISOString(), sentBy || null, groupId).lastInsertRowid))();
        res.json({ success: true, id: ids[0], ids, groupId, occurrences: times.length, total: recipients.length,
            firstRunAt: new Date(times[0]).toISOString(), lastRunAt: new Date(times[times.length - 1]).toISOString() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Every pending entry, plus the most recent finished ones.
app.get('/api/schedule', (req, res) => {
    try {
        const rows = db.prepare(
            `SELECT * FROM scheduled_calls WHERE status = 'pending'
             UNION ALL
             SELECT * FROM (SELECT * FROM scheduled_calls WHERE status != 'pending' ORDER BY run_at DESC LIMIT 100)
             ORDER BY run_at ASC`
        ).all();
        res.json(rows.map(r => ({
            id: r.id, group_id: r.group_id || `single-${r.id}`, message: r.message, language: r.language,
            provider: r.provider, total: JSON.parse(r.recipients).length, run_at: r.run_at,
            status: r.status, note: r.note, sent_by: r.sent_by
        })));
    } catch (e) { res.json([]); }
});

// Cancels one entry ({ id }) or every pending entry in a group ({ group }).
app.delete('/api/schedule', (req, res) => {
    const { id, group } = req.body || {};
    try {
        let info;
        if (group && String(group).startsWith('single-')) {
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled' WHERE id=? AND status='pending'").run(String(group).slice(7));
        } else if (group) {
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled' WHERE group_id=? AND status='pending'").run(group);
        } else {
            info = db.prepare("UPDATE scheduled_calls SET status='cancelled' WHERE id=? AND status='pending'").run(id);
        }
        res.json(info.changes
            ? { success: true, cancelled: info.changes }
            : { success: false, message: 'Only pending schedules can be cancelled.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Starts at most one due schedule per tick, and only while no broadcast is running.
function runDueSchedules() {
    if (activeBroadcast && activeBroadcast.active) return;
    try {
        const due = db.prepare("SELECT * FROM scheduled_calls WHERE status='pending' AND run_at <= ? ORDER BY run_at LIMIT 1")
            .get(new Date().toISOString());
        if (!due) return;
        const setStatus = (status, note) =>
            db.prepare('UPDATE scheduled_calls SET status=?, note=? WHERE id=?').run(status, note || null, due.id);

        if (Date.now() - Date.parse(due.run_at) > SCHEDULE_GRACE_MS) {
            return setStatus('missed', 'Server was not running at the scheduled time.');
        }
        const credentials = getEnvCredentials();
        const missing = missingCredentials(due.provider, credentials);
        if (missing) return setStatus('failed', missing);

        const result = startBroadcast({
            nums: JSON.parse(due.recipients), msg: due.message, credentials,
            lang: due.language, sentBy: due.sent_by || 'Scheduled', provider: due.provider, voice: due.voice
        });
        if (result.success) setStatus('started');
        else if (result.message === 'A broadcast is already in progress.') return; // try again next tick
        else setStatus('failed', result.message);
    } catch (e) {
        console.error('Scheduler error:', e.message);
    }
}
setInterval(runDueSchedules, 30 * 1000);
setTimeout(runDueSchedules, 5000);



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
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
