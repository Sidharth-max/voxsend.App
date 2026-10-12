// voxsend server (PostgreSQL). The only settings outside the database (.env) are DATABASE_URL
// (with ?schema=…), VOXSEND_MASTER_KEY_FILE and PORT. Provider credentials, phone numbers, base URL,
// agent ids and the PIN live encrypted/hashed in the DB; the scheduler switch is settings.scheduler_enabled.
// Test instances may still pass PGSCHEMA, VOXSEND_SCHEDULER, SARVAM_BASE_URL etc. in their environment.
const path = require('path');
const guard = require('./lib/guard');
const ENV_FILE = process.env.VOXSEND_ENV_FILE || path.join(__dirname, '.env');
try { guard.assertEnvFileAllowed(ENV_FILE); } catch (e) { console.error(e.message); process.exit(1); }
require('dotenv').config({ path: ENV_FILE, quiet: true });
// Scheduler: VOXSEND_SCHEDULER=on|off in the environment wins; otherwise it runs only in the prod
// app and only when settings.scheduler_enabled is true (set by cutover.sh). Off everywhere else.
const SCHEDULER_ENV = String(process.env.VOXSEND_SCHEDULER || '').toLowerCase();
let SCHEDULER_ON = false;
let INSTANCE;
try { INSTANCE = guard.assertDbAllowed(); } catch (e) { console.error(e.message); process.exit(1); }

const express = require('express');
const db = require('./lib/db');
const migrate = require('./lib/migrate');
const secrets = require('./lib/secrets');
const auth = require('./lib/auth');
const config = require('./lib/config');
const broadcaster = require('./lib/broadcaster');
const scheduler = require('./lib/scheduler');
const schedules = require('./lib/schedules');
const callsync = require('./lib/callsync');
const service = require('./lib/service');
const runs = require('./lib/runs');
const v1 = require('./lib/v1');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback'); // behind cloudflared on localhost

// ── security headers + CORS (same origin only, plus VOXSEND_ALLOWED_ORIGINS) ──
const allowedOrigins = new Set(String(process.env.VOXSEND_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    const origin = req.get('origin');
    if (origin) {
        const host = req.get('host');
        const same = (() => { try { return new URL(origin).host === host; } catch (e) { return false; } })();
        if (allowedOrigins.has(origin)) {
            res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE' });
            if (req.method === 'OPTIONS') return res.sendStatus(204);
        } else if (!same && req.path.startsWith('/api/') && !isWebhook(req.path)) {
            return res.status(403).json({ success: false, error: 'Cross-origin request refused.' });
        }
    }
    next();
});
const isWebhook = p => p === '/api/sarvam/webhook' || p.startsWith('/api/vobiz/hangup-callback') || p === '/api/vobiz/xml';
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, extra = {}) => res.json({ success: true, ...extra });

// ── public: health, auth, provider webhooks ──
app.get('/api/health', wrap(async (req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
}));

app.post('/api/auth/pin', wrap(async (req, res) => {
    const ip = req.ip || 'unknown';
    const blocked = auth.loginBlocked(ip);
    if (blocked) return res.status(429).json({ ok: false, message: `Too many attempts. Try again in ${Math.ceil(blocked / 60000)} min.` });
    if (!(await secrets.hasPin())) return res.status(503).json({ ok: false, message: 'No PIN is set. Run: voxsend secrets set-pin' });
    if (await auth.verifyPin(String((req.body && req.body.pin) || ''))) {
        auth.loginOk(ip);
        await auth.createSession(req, res);
        return res.json({ ok: true });
    }
    const left = auth.loginFailed(ip);
    res.status(401).json({ ok: false, message: left > 0 ? `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Try again in 5 min.' });
}));
app.get('/api/auth/me', wrap(async (req, res) => {
    const s = await auth.sessionFromRequest(req);
    res.json({ ok: !!s, signedIn: !!s });
}));
app.post('/api/auth/logout', wrap(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));

app.post('/api/sarvam/webhook', wrap(async (req, res) => {
    const p = req.body || {};
    const meta = (p.webhook_config && p.webhook_config.metadata) || {};
    if (!p.attempt_id || !(await broadcaster.verifyWebhookMeta(meta))) return res.status(403).json({ ok: false });
    await broadcaster.sarvamResult(p);
    res.json({ ok: true });
}));

app.all('/api/vobiz/hangup-callback/:token', wrap(async (req, res) => {
    if (!(await broadcaster.checkToken(req.params.token, broadcaster.vobizHangupToken()))) return res.status(403).send('Forbidden');
    const params = { ...req.query, ...(req.body || {}) };
    const uuid = params.CallUUID || params.call_uuid;
    if (uuid) broadcaster.vobizHangup(uuid);
    res.send('OK');
}));

const escapeXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
app.all('/api/vobiz/xml', wrap(async (req, res) => {
    const q = { ...(req.body || {}), ...req.query };
    const msg = String(q.msg || ''), voice = String(q.voice || 'Polly.Aditi'), lang = String(q.lang || 'hi-IN'), p = String(q.p || 'vobiz');
    if (!(await broadcaster.checkToken(q.s, broadcaster.xmlSignature(msg, voice, lang, p)))) return res.status(403).send('Forbidden');
    res.set('Content-Type', 'application/xml');
    if (p === 'vobiz') {
        const v = voice.toLowerCase().includes('man') ? 'MAN' : 'WOMAN';
        return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Speak voice="${v}" language="${escapeXml(lang)}">${escapeXml(msg)}</Speak>\n</Response>`);
    }
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Say language="${escapeXml(lang)}" voice="${escapeXml(voice)}">${escapeXml(msg)}</Say>\n</Response>`);
}));

// ── everything else under /api needs a session (or an API token) ──
app.use('/api/v1', v1.router);
app.use('/api', auth.requireAuth());

app.get('/api/system', wrap(async (req, res) => res.json({ ...scheduler.info(), sync: callsync.syncInfo(), schema: db.SCHEMA, broadcastActive: broadcaster.isBusy() })));

// config & credentials (never plaintext)
app.get('/api/config', wrap(async (req, res) => res.json(await config.publicConfig())));
app.get('/api/credentials', wrap(async (req, res) => res.json(await config.maskedCredentials())));
app.post('/api/credentials', wrap(async (req, res) => ok(res, { changed: await config.saveCredentials(req.body || {}) })));
app.post('/api/auth/change-pin', auth.requireAuth({ scope: 'admin' }), wrap(async (req, res) => {
    const { current, pin } = req.body || {};
    if (!(await auth.verifyPin(String(current || '')))) return res.status(400).json({ success: false, error: 'Current PIN is wrong.' });
    await secrets.setPin(String(pin || ''));
    ok(res);
}));

// contacts
app.get('/api/contacts', wrap(async (req, res) => res.json(await service.listContacts())));
app.post('/api/contacts', wrap(async (req, res) => ok(res, await service.upsertContacts(req.body))));
app.post('/api/contacts/upsert', wrap(async (req, res) => ok(res, await service.upsertContacts(req.body))));
app.delete('/api/contacts', wrap(async (req, res) => {
    const { phone, phones } = req.body || {};
    ok(res, { deleted: await service.deleteContacts(Array.isArray(phones) && phones.length ? phones : phone) });
}));

// broadcasts
app.get('/api/broadcast/status', (req, res) => res.json(broadcaster.status()));
app.post('/api/broadcast/stop', wrap(async (req, res) => {
    (await broadcaster.stop()) ? ok(res, { message: 'Broadcast stopping...' }) : res.json({ success: false, message: 'No active broadcast.' });
}));
app.post('/api/broadcast', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await broadcaster.start({ nums: b.nums, msg: b.msg, lang: b.lang, sentBy: b.sentBy, provider: b.provider, voice: b.voice, agentId: b.agentId || b.agent_id });
    ok(res, { message: 'Broadcast started in background.', duplicatesRemoved: r.duplicates, id: r.id });
}));
app.get('/api/broadcast-runs', wrap(async (req, res) => res.json(await runs.listRuns(req.query))));
app.get('/api/broadcast-runs/:key/calls', wrap(async (req, res) => res.json(await runs.runCalls(req.params.key))));
app.get('/api/broadcast-runs/:key/recipients', wrap(async (req, res) => res.json(await runs.runRecipients(req.params.key))));
app.delete('/api/broadcast-runs/:key', wrap(async (req, res) => res.json(await runs.hideRun(req.params.key))));
app.post('/api/contact-names', wrap(async (req, res) => res.json({ names: await runs.namesFor((req.body || {}).phones) })));
app.get('/api/broadcasts', wrap(async (req, res) => res.json(await service.listBroadcasts(req.query))));
app.get('/api/broadcasts/resumable', wrap(async (req, res) => res.json(await broadcaster.resumable())));
app.get('/api/broadcasts/:id', wrap(async (req, res) => res.json(await service.getBroadcast(Number(req.params.id)))));
app.post('/api/broadcasts/:id/resume', wrap(async (req, res) => {
    const r = await broadcaster.requestResume(Number(req.params.id));
    scheduler.poke();
    ok(res, { ...r, message: `Resuming: ${r.pending} number${r.pending === 1 ? '' : 's'} not dialled yet. Numbers already attempted are skipped.` });
}));

// schedules
app.post('/api/schedule', wrap(async (req, res) => ok(res, await schedules.create(req.body || {}))));
app.get('/api/schedule/group/:id', wrap(async (req, res) => ok(res, await schedules.getGroup(req.params.id))));
app.put('/api/schedule/group/:id', wrap(async (req, res) => ok(res, await schedules.editGroup(req.params.id, req.body || {}))));
app.put('/api/schedule/:id', wrap(async (req, res) => ok(res, await schedules.moveTime(Number(req.params.id), (req.body || {}).runAt))));
app.get('/api/schedule', wrap(async (req, res) => res.json(await schedules.list())));
app.delete('/api/schedule', wrap(async (req, res) => {
    const { id, group } = req.body || {};
    try { ok(res, await schedules.cancel({ id: id ? Number(id) : null, group })); }
    catch (e) { if (e.status === 400) return res.json({ success: false, message: e.message }); throw e; }
}));

// history, messages, settings
app.get('/api/history', wrap(async (req, res) => res.json(await service.listHistory())));
app.post('/api/history', wrap(async (req, res) => { await service.addHistory(req.body || {}); ok(res); }));
app.delete('/api/history', wrap(async (req, res) => { await service.deleteHistory((req.body || {}).id); ok(res); }));
app.get('/api/messages', wrap(async (req, res) => res.json(await service.listMessages())));
app.post('/api/messages', wrap(async (req, res) => { await service.addMessage(req.body || {}); ok(res); }));
app.delete('/api/messages', wrap(async (req, res) => { await service.deleteMessage((req.body || {}).id); ok(res); }));
app.get('/api/settings', wrap(async (req, res) => res.json(await service.getSettings() || {})));
app.post('/api/settings', wrap(async (req, res) => { await service.saveSettings(req.body || {}); ok(res); }));

// agents
app.get('/api/agents', wrap(async (req, res) => res.json(await config.listAgents(req.query.all !== '0'))));
app.post('/api/agents', wrap(async (req, res) => ok(res, { agent: await config.saveAgent(null, req.body || {}) })));
app.put('/api/agents/:id', wrap(async (req, res) => ok(res, { agent: await config.saveAgent(Number(req.params.id), req.body || {}) })));
app.post('/api/agents/:id/default', wrap(async (req, res) => ok(res, { agent: await config.setDefaultAgent(Number(req.params.id)) })));
app.delete('/api/agents/:id', wrap(async (req, res) => { await config.deleteAgent(Number(req.params.id)); ok(res); }));

// call history (Sarvam analytics + webhooks)
app.get('/api/calls', wrap(async (req, res) => res.json(await callsync.list(req.query))));
app.post('/api/calls/sync', wrap(async (req, res) => ok(res, { result: await callsync.syncNow({ days: parseInt((req.body || {}).days, 10) || null, auto: !!(req.body || {}).auto }) })));
app.get('/api/calls/:id', wrap(async (req, res) => res.json(await callsync.get(req.params.id))));
app.get('/api/calls/:id/transcript', wrap(async (req, res) => res.json(await callsync.transcript(req.params.id, { refresh: req.query.refresh === '1' }))));
app.get('/api/calls/:id/recording', wrap(async (req, res) => callsync.streamRecording(req.params.id, req, res)));
app.get('/api/sarvam/calls', wrap(async (req, res) => res.json(await service.sarvamCalls())));

// API tokens (for the CLI / integrations)
app.get('/api/tokens', auth.requireAuth({ scope: 'admin' }), wrap(async (req, res) => res.json(await auth.listTokens())));
app.post('/api/tokens', auth.requireAuth({ scope: 'admin' }), wrap(async (req, res) => {
    const b = req.body || {};
    ok(res, { token: await auth.createToken(b.name, Array.isArray(b.scopes) && b.scopes.length ? b.scopes : ['read'], b.days ? parseInt(b.days, 10) : null) });
}));
app.delete('/api/tokens/:id', auth.requireAuth({ scope: 'admin' }), wrap(async (req, res) => ok(res, { revoked: await auth.revokeToken(Number(req.params.id)) })));

// Vobiz dashboard data, using the stored credentials
const vobizGet = async (url, res) => {
    const c = await config.getCredentials();
    if (!c.vobiz_id || !c.vobiz_token) return res.status(400).json({ error: 'Missing Vobiz credentials' });
    const r = await fetch(url(c), { headers: { Authorization: `Basic ${Buffer.from(`${c.vobiz_id}:${c.vobiz_token}`).toString('base64')}` }, signal: AbortSignal.timeout(20000) });
    res.status(r.ok ? 200 : 502).json(await r.json().catch(() => ({ error: `HTTP ${r.status}` })));
};
app.post('/api/vobiz/balance', wrap(async (req, res) => vobizGet(c => `https://api.vobiz.ai/api/v1/account/${c.vobiz_id}/balance/INR`, res)));
app.post('/api/vobiz/logs', wrap(async (req, res) => vobizGet(c => `https://api.vobiz.ai/api/v1/account/${c.vobiz_id}/cdr?per_page=100&page=1`, res)));

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found.' }));

// ── frontend files only (never the app folder: it holds .env, logs, backups, code) ──
const NO_CACHE = 'no-cache';
const sendAppFile = (name, noCache) => (req, res) => { if (noCache) res.set('Cache-Control', NO_CACHE); res.sendFile(path.join(__dirname, name)); };
app.get(['/', '/index.html'], sendAppFile('index.html', true));
['sw.js', 'manifest.webmanifest'].forEach(f => app.get('/' + f, sendAppFile(f, true)));
['favicon.png', 'favicon.svg'].forEach(f => app.get('/' + f, sendAppFile(f)));
['css', 'js'].forEach(dir => app.use('/' + dir, express.static(path.join(__dirname, dir), {
    index: false, dotfiles: 'deny', setHeaders: res => res.set('Cache-Control', NO_CACHE)
})));
app.use('/icons', express.static(path.join(__dirname, 'icons'), { index: false, dotfiles: 'deny' }));

app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Payload too large.' });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('SERVER ERROR:', req.method, req.path, err.message);
    res.status(status).json({ success: false, error: err.message, message: err.message });
});

// ── boot ──
(async () => {
    await db.waitForDb(60000);
    // Schema changes on boot only when explicitly enabled (prod/test env files set it).
    const mc = await db.getPool().connect();
    try {
        const have = await migrate.currentVersion(mc), want = migrate.latestVersion();
        if (have < want) {
            if (String(process.env.VOXSEND_AUTO_MIGRATE || '').toLowerCase() !== 'on') {
                throw new Error(`Database schema ${db.SCHEMA} is at v${have}, code needs v${want}. Run "voxsend db migrate" (or set VOXSEND_AUTO_MIGRATE=on).`);
            }
            await migrate.migrate(mc);
        }
    } finally { mc.release(); }
    console.log(`Instance: ${INSTANCE}${INSTANCE === 'prod' ? '' : ' (dev/test: Twilio/Vobiz disabled, Sarvam only via a local stub)'}`);
    secrets.loadKeys(); // fail fast if the master key is missing
    await secrets.ensureWebhookSecret();
    const fromDb = await config.applyDbEnv({ prod: INSTANCE === 'prod' });
    if (fromDb.length) console.log(`Settings from the database: ${fromDb.join(', ')}`);
    SCHEDULER_ON = SCHEDULER_ENV === 'on' ? true : SCHEDULER_ENV === 'off' ? false
        : INSTANCE === 'prod' && await config.schedulerEnabled();
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, async err => {
        // Exit instead of lingering as a second process with no port.
        if (err) { console.error(`Could not listen on port ${PORT}: ${err.message}`); process.exit(1); }
        console.log(`Server running at http://localhost:${PORT} (schema ${db.SCHEMA})`);
        await scheduler.start({ scheduler: SCHEDULER_ON });
        callsync.startBackground(() => scheduler.info().runner && SCHEDULER_ON);
        setInterval(auth.purgeExpiredSessions, 6 * 3600 * 1000);
    });
    const shutdown = sig => {
        console.log(`${sig}: shutting down`);
        server.close();
        Promise.race([scheduler.stop(), new Promise(r => setTimeout(r, 3000))]).finally(() => db.close().finally(() => process.exit(0)));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
