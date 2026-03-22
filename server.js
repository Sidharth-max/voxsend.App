const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static files
app.use(express.static(__dirname));

const CREDENTIALS_FILE = 'credentials.json';

// Get credentials
app.get('/api/credentials', (req, res) => {
    try {
        if (fs.existsSync(CREDENTIALS_FILE)) {
            const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json({});
        }
    } catch (e) {
        res.status(500).json({ error: 'Failed to read credentials' });
    }
});

// Save credentials
app.post('/api/credentials', (req, res) => {
    try {
        const credentials = {
            sid: req.body.sid,
            token: req.body.token,
            from: req.body.from
        };
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save credentials' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
