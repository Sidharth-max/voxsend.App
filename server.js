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
    } catch(e) { res.json([]); }
});

app.post('/api/contacts', (req, res) => {
    fs.writeFileSync('contacts.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
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
    } catch(e) {
        res.json([]);
    }
});

app.post('/api/history', (req, res) => {
    fs.writeFileSync('history.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
