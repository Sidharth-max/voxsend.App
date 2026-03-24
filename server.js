require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const app = express();

const db = new Database('voxsend.db');

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
    parallel_calls INTEGER DEFAULT 10,
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
app.use(bodyParser.json());

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/contacts', (req, res) => {
    try {
        const contacts = db.prepare('SELECT * FROM contacts').all();
        res.json(contacts);
    } catch (e) { res.json([]); }
});

app.post('/api/contacts', (req, res) => {
    const contacts = Array.isArray(req.body) ? req.body : [req.body];
    const insert = db.prepare('INSERT OR REPLACE INTO contacts (name, phone, group_name) VALUES (?, ?, ?)');
    const insertMany = db.transaction((list) => {
        for (const contact of list) {
            insert.run(contact.name || '', contact.phone, contact.group_name || '');
        }
    });
    try {
        insertMany(contacts);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/contacts', (req, res) => {
    const { phone } = req.body;
    try {
        db.prepare('DELETE FROM contacts WHERE phone=?').run(phone);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

let activeBroadcast = null;

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

    if (activeBroadcast && activeBroadcast.active) {
        return res.status(400).json({ success: false, message: "A broadcast is already in progress." });
    }

    activeBroadcast = {
        active: true,
        total: nums.length,
        current: 0,
        successful: 0,
        failed: 0,
        logs: [],
        startTime: new Date().toISOString(),
        msg: msg,
        lang: lang,
        sentBy: sentBy,
        provider: provider || 'twilio',
        recipients: nums.join('\n')
    };

    res.json({ success: true, message: "Broadcast started in background." });

    const runBroadcast = async () => {
        const { sid, token, from, vobiz_id, vobiz_token, vobiz_from, public_url } = credentials;
        const currentProvider = provider || 'twilio';
        
        let ttsUrl;
        let auth;
        
        if (currentProvider === 'vobiz') {
             // For Vobiz, we need a public URL for the XML. 
             // If public_url is not provided, we might fail or try best guess, but for now assume it's passed.
             const baseUrl = public_url ? public_url.replace(/\/$/, '') : '';
             ttsUrl = `${baseUrl}/api/vobiz/xml?msg=${encodeURIComponent(msg)}`;
        } else {
             auth = Buffer.from(`${sid}:${token}`).toString('base64');
             ttsUrl = `http://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(msg)}`;
        }

        for (let i = 0; i < nums.length; i++) {
            if (!activeBroadcast || !activeBroadcast.active) break;

            let n = nums[i].trim();
            if (!n.startsWith('+')) n = '+' + n;

            try {
                let resOk = false;
                let resMsg = '';

                if (currentProvider === 'vobiz') {
                    const vobizRes = await fetch(`https://api.vobiz.ai/api/v1/Account/${vobiz_id}/Call/`, {
                        method: 'POST',
                        headers: {
                            'X-Auth-ID': vobiz_id,
                            'X-Auth-Token': vobiz_token,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            from: vobiz_from,
                            to: n,
                            answer_url: ttsUrl,
                            answer_method: 'GET' 
                        })
                    });
                    const rjson = await vobizRes.json();
                    resOk = vobizRes.ok;
                    resMsg = resOk ? `Call UUID: ${rjson.call_uuid}` : (rjson.message || JSON.stringify(rjson));

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
                }

                if (resOk) {
                    activeBroadcast.successful++;
                    activeBroadcast.logs.push({ type: 'ok', text: `[${currentProvider}] Queued to ${n}`, time: new Date().toLocaleTimeString() });
                } else {
                    activeBroadcast.failed++;
                    activeBroadcast.logs.push({ type: 'err', text: `[${currentProvider}] Failed ${n}: ${resMsg}`, time: new Date().toLocaleTimeString() });
                }
            } catch (err) {
                activeBroadcast.failed++;
                activeBroadcast.logs.push({ type: 'err', text: `Network error to ${n}`, time: new Date().toLocaleTimeString() });
            }

            activeBroadcast.current = i + 1;
            if (activeBroadcast.logs.length > 50) activeBroadcast.logs.shift();
            await new Promise(r => setTimeout(r, 600));
        }

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
            activeBroadcast.active = false;
        }
    };

    runBroadcast();
});

app.all('/api/vobiz/xml', (req, res) => {
    const msg = req.query.msg || req.body.msg;
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak>${msg || 'Start talking'}</Speak>
</Response>`);
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
