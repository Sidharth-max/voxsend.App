require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const app = express();

const db = new Database('voxsend.db');

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
    parallel_calls INTEGER DEFAULT 3,
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
`);

try {
  db.prepare('ALTER TABLE messages ADD COLUMN name TEXT').run();
} catch (e) {
  // Ignore if column already exists
}

try {
  db.prepare('ALTER TABLE history ADD COLUMN recipients TEXT').run();
} catch (e) {}

// Initialize settings if not exists
const settingsExists = db.prepare('SELECT id FROM settings WHERE id=1').get();
if (!settingsExists) {
    db.prepare('INSERT INTO settings (id) VALUES (1)').run();
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

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

app.post('/api/broadcast', async (req, res) => {
    const { nums, msg, credentials, lang, sentBy, provider } = req.body;
    const { unique: recipientList, duplicates: duplicatesRemoved } = dedupeRecipients(nums || []);

    if (activeBroadcast && activeBroadcast.active) {
        return res.status(400).json({ success: false, message: "A broadcast is already in progress." });
    }

    if (!recipientList.length) {
        return res.status(400).json({ success: false, message: "No valid recipients provided." });
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
        voice: req.body.voice || 'Polly.Aditi',
        recipients: recipientList.join('\n')
    };

    if (duplicatesRemoved) {
        activeBroadcast.logs.push({ type: 'info', text: `Removed ${duplicatesRemoved} duplicate ${duplicatesRemoved === 1 ? 'number' : 'numbers'} before dialing.`, time: new Date().toLocaleTimeString() });
    }

    res.json({ success: true, message: "Broadcast started in background.", duplicatesRemoved });

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

        // ── Semaphore: limit concurrent calls to respect Vobiz plan ──────
        // Vobiz free plan = 3 concurrent calls; use 2 to leave safety buffer
        const MAX_CONCURRENT = currentProvider === 'vobiz' ? 2 : 10;
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
        const callTimeoutMs = Math.max(estimatedCallSec * 1000, 120000); // at least 120s to avoid releasing slots too early

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
                let maxAttempts = currentProvider === 'vobiz' ? 6 : 1; // 6 attempts * 10s = 1 min waiting

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
                                activeBroadcast.logs.push({ type: 'info', text: `[Vobiz] Concurrency limit reached. Waiting 10s before retry (Attempt ${attempts})...`, time: new Date().toLocaleTimeString() });
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                continue; // Try again
                            }
                        }
    
                        // If call was initiated, prepare to wait for it to actually finish
                        // so we don't exceed the Vobiz concurrent call limit
                        if (resOk && rjson.call_uuid) {
                            const callUuid = rjson.call_uuid;
                            waitForCallEnd = Promise.race([
                                new Promise(resolve => callCompletionResolvers.set(callUuid, resolve)),
                                new Promise(resolve => setTimeout(resolve, callTimeoutMs))
                            ]).then(() => callCompletionResolvers.delete(callUuid));
                        }
                        break; // Action completed, stop retrying
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
                // Removed cap to ensure full history is visible until broadcast ends
                // For Vobiz: wait until the call actually finishes before releasing
                // the concurrency slot — prevents "Concurrent Call Limit Reached"
                if (waitForCallEnd) {
                    await waitForCallEnd;
                }
                release();
            }
        };

        // Kick off all calls; semaphore waits for each call to finish (Vobiz)
        const tasks = recipientList.map((raw, i) => {
            let n = raw.trim();
            if (!n.startsWith('+')) n = '+' + n;
            return callOne(n, i);
        });
        await Promise.all(tasks);

        if (activeBroadcast) {
            try {
                db.prepare('INSERT INTO history (message, language, total, successful, recipients, results, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                    msg,
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
    res.json({
        sid: process.env.TWILIO_ACCOUNT_SID,
        token: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_FROM,
        vobiz_id: process.env.VOBIZ_AUTH_ID,
        vobiz_token: process.env.VOBIZ_AUTH_TOKEN,
        vobiz_from: process.env.VOBIZ_FROM,
        provider: process.env.PROVIDER || 'twilio',
        public_url: process.env.PUBLIC_URL
    });
});

app.post('/api/credentials', (req, res) => {
    const { sid, token, from, vobiz_id, vobiz_token, vobiz_from, provider, public_url } = req.body;
    const fs = require('fs');
    let envContent = `TWILIO_ACCOUNT_SID=${sid || ''}\nTWILIO_AUTH_TOKEN=${token || ''}\nTWILIO_FROM=${from || ''}\n`;
    envContent += `VOBIZ_AUTH_ID=${vobiz_id || ''}\nVOBIZ_AUTH_TOKEN=${vobiz_token || ''}\nVOBIZ_FROM=${vobiz_from || ''}\n`;
    envContent += `PROVIDER=${provider || 'twilio'}\n`;
    envContent += `PUBLIC_URL=${public_url || ''}\n`;
    
    fs.writeFileSync('.env', envContent);
    require('dotenv').config({ override: true });
    res.json({ success: true });
});



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
