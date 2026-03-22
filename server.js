cat > server.js << 'EOF'
require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Get credentials from .env (never expose token)
app.get('/api/credentials', (req, res) => {
    res.json({
        sid: process.env.TWILIO_ACCOUNT_SID,
        from: process.env.TWILIO_FROM
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
EOF