require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(bodyParser.json());

app.get('/api/contacts', (req, res) => {
    try {
        if (fs.existsSync('contacts.json')) {
            res.json(JSON.parse(fs.readFileSync('contacts.json', 'utf8')));
        } else {
            res.json([]);
        }
    } catch (e) { res.json([]); }
});

app.post('/api/contacts', (req, res) => {
    fs.writeFileSync('contacts.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
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
    const { nums, msg, credentials, lang, sentBy } = req.body;

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
        sentBy: sentBy
    };

    res.json({ success: true, message: "Broadcast started in background." });

    // Background Processing
    const runBroadcast = async () => {
        const { sid, token, from } = credentials;
        const auth = Buffer.from(`${sid}:${token}`).toString('base64');
        const ttsUrl = `http://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(msg)}`;

        for (let i = 0; i < nums.length; i++) {
            if (!activeBroadcast || !activeBroadcast.active) break;

            let n = nums[i].trim();
            if (!n.startsWith('+')) n = '+' + n;

            try {
                const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({ To: n, From: from, Url: ttsUrl })
                });

                const rjson = await twilioRes.json();

                if (twilioRes.ok) {
                    activeBroadcast.successful++;
                    activeBroadcast.logs.push({ type: 'ok', text: `Call queued to ${n}`, time: new Date().toLocaleTimeString() });
                } else {
                    activeBroadcast.failed++;
                    activeBroadcast.logs.push({ type: 'err', text: `Failed ${n}: ${rjson.message}`, time: new Date().toLocaleTimeString() });
                }
            } catch (err) {
                activeBroadcast.failed++;
                activeBroadcast.logs.push({ type: 'err', text: `Network error to ${n}`, time: new Date().toLocaleTimeString() });
            }

            activeBroadcast.current = i + 1;
            // Limit logs to last 50 for performance
            if (activeBroadcast.logs.length > 50) activeBroadcast.logs.shift();

            // Artificial delay to respect rate limits
            await new Promise(r => setTimeout(r, 600));
        }

        // Finalize
        if (activeBroadcast) {
            const entry = {
                date: activeBroadcast.startTime,
                message: msg,
                total: activeBroadcast.total,
                successful: activeBroadcast.successful,
                failed: activeBroadcast.failed,
                recipients: nums.join('\n'),
                sentBy: sentBy || 'System'
            };

            // Save to history.json
            try {
                let hist = [];
                if (fs.existsSync('history.json')) {
                    hist = JSON.parse(fs.readFileSync('history.json', 'utf8'));
                }
                hist.unshift(entry);
                fs.writeFileSync('history.json', JSON.stringify(hist, null, 2));
            } catch (e) { console.error("Error saving history:", e); }

            activeBroadcast.active = false;
        }
    };

    runBroadcast();
});

app.use(express.static(__dirname));

app.get('/api/credentials', (req, res) => {
    res.json({
        sid: process.env.TWILIO_ACCOUNT_SID,
        token: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_FROM
    });
});

app.post('/api/credentials', (req, res) => {
    const { sid, token, from } = req.body;
    const envContent = `TWILIO_ACCOUNT_SID=${sid}\nTWILIO_AUTH_TOKEN=${token}\nTWILIO_FROM=${from}\n`;
    fs.writeFileSync('.env', envContent);
    require('dotenv').config({ override: true });
    res.json({ success: true });
});

app.get('/api/history', (req, res) => {
    try {
        if (fs.existsSync('history.json')) {
            res.json(JSON.parse(fs.readFileSync('history.json', 'utf8')));
        } else {
            res.json([]);
        }
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/history', (req, res) => {
    fs.writeFileSync('history.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

app.get('/api/messages', (req, res) => {
    try {
        if (fs.existsSync('messages.json')) {
            res.json(JSON.parse(fs.readFileSync('messages.json', 'utf8')));
        } else {
            res.json([]);
        }
    } catch (e) { res.json([]); }
});

app.post('/api/messages', (req, res) => {
    fs.writeFileSync('messages.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
    try {
        if (fs.existsSync('settings.json')) {
            res.json(JSON.parse(fs.readFileSync('settings.json', 'utf8')));
        } else {
            res.json({});
        }
    } catch (e) { res.json({}); }
});

app.post('/api/settings', (req, res) => {
    fs.writeFileSync('settings.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
