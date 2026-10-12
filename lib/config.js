// Provider credentials (decrypted from `secrets`), app settings and agents.
// Plaintext credentials stay inside the server process; the API only ever returns
// masked values or "is it configured" flags.
const db = require('./db');
const secrets = require('./secrets');
const sarvam = require('../sarvam');

let cache = null; // { at, creds }
const CACHE_MS = 15000;
const invalidate = () => { cache = null; };

async function getSettings(client = db) {
    return (await client.query('SELECT * FROM settings WHERE id=1')).rows[0] || {};
}

// Everything the call engine needs, as the old getEnvCredentials() shape.
async function getCredentials() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.creds;
    const [all, s] = await Promise.all([secrets.getAll(), getSettings()]);
    const creds = { ...all, provider: s.provider || 'twilio', public_url: s.public_url || '' };
    cache = { at: Date.now(), creds };
    return creds;
}

// Applies an agent's app id/version over the stored Sarvam credentials.
function withAgent(creds, agent) {
    if (!agent) return creds;
    return { ...creds, sarvam_app_id: agent.app_id, sarvam_app_version: agent.version ? String(agent.version) : '' };
}

function missingCredentials(provider, c = {}) {
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
}

// Non-secret view for the browser: provider, public URL and which providers are usable.
async function publicConfig() {
    const c = await getCredentials();
    const agent = await defaultAgent();
    const ready = p => !missingCredentials(p, p === 'sarvam' ? withAgent(c, agent) : c);
    return { provider: c.provider, public_url: c.public_url, configured: { twilio: ready('twilio'), vobiz: ready('vobiz'), sarvam: ready('sarvam') },
        agent: agent ? { id: agent.id, label: agent.label, version: agent.version } : null };
}

// Masked credentials for the API tab.
const FIELDS = ['sid', 'token', 'from', 'vobiz_id', 'vobiz_token', 'vobiz_from', 'sarvam_key', 'sarvam_org', 'sarvam_workspace',
    'sarvam_app_id', 'sarvam_app_version', 'sarvam_connection_id', 'sarvam_from', 'sarvam_base_url'];
async function maskedCredentials() {
    const c = await getCredentials();
    const out = { provider: c.provider, public_url: c.public_url, masked: {} };
    FIELDS.forEach(f => { out.masked[f] = c[f] ? secrets.mask(c[f]) : ''; });
    return out;
}

// Saves only the fields that were sent with a value; an explicit `clear: [field]` removes one.
async function saveCredentials(body = {}) {
    const changed = [];
    await db.tx(async client => {
        for (const f of FIELDS) {
            if (typeof body[f] !== 'string') continue;
            const v = body[f].replace(/[\r\n]/g, '').trim();
            if (!v || v.startsWith('••••')) continue;
            await secrets.set(f, v, client);
            changed.push(f);
        }
        for (const f of Array.isArray(body.clear) ? body.clear : []) {
            if (FIELDS.includes(f)) { await secrets.set(f, '', client); changed.push(f + ' (cleared)'); }
        }
        if (body.provider !== undefined) {
            const p = ['twilio', 'vobiz', 'sarvam'].includes(body.provider) ? body.provider : 'twilio';
            await client.query('UPDATE settings SET provider=$1, updated_at=now() WHERE id=1', [p]);
            changed.push('provider');
        }
        if (typeof body.public_url === 'string') {
            await client.query('UPDATE settings SET public_url=$1, updated_at=now() WHERE id=1', [body.public_url.trim() || null]);
            changed.push('public_url');
        }
    });
    invalidate();
    return changed;
}

// ── agents ──
const listAgents = (all = true) => db.many(`SELECT id, label, app_id, version, notes, active, is_default, created_at, updated_at
    FROM agents ${all ? '' : 'WHERE active'} ORDER BY is_default DESC, label`);
const getAgent = id => db.one('SELECT * FROM agents WHERE id=$1', [id]);
const defaultAgent = () => db.one('SELECT * FROM agents WHERE is_default AND active LIMIT 1');

function cleanAgent(b = {}) {
    const label = String(b.label || '').trim().slice(0, 80);
    const app_id = String(b.app_id || '').trim().slice(0, 200);
    const v = b.version === '' || b.version === null || b.version === undefined ? null : parseInt(b.version, 10);
    if (!label) throw Object.assign(new Error('Give the agent a name.'), { status: 400 });
    if (!app_id) throw Object.assign(new Error('The Sarvam agent (app) ID is required.'), { status: 400 });
    if (v !== null && !(v > 0)) throw Object.assign(new Error('Version must be a positive number, or empty for the latest committed version.'), { status: 400 });
    return { label, app_id, version: v, notes: b.notes ? String(b.notes).slice(0, 500) : null, active: b.active === undefined ? true : !!b.active };
}

async function saveAgent(id, body) {
    const a = cleanAgent(body);
    return db.tx(async client => {
        let row;
        if (id) {
            row = (await client.query(`UPDATE agents SET label=$2, app_id=$3, version=$4, notes=$5, active=$6, updated_at=now()
                WHERE id=$1 RETURNING *`, [id, a.label, a.app_id, a.version, a.notes, a.active])).rows[0];
            if (!row) throw Object.assign(new Error('Agent not found.'), { status: 404 });
        } else {
            row = (await client.query(`INSERT INTO agents (label, app_id, version, notes, active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [a.label, a.app_id, a.version, a.notes, a.active])).rows[0];
        }
        const hasDefault = (await client.query('SELECT 1 FROM agents WHERE is_default')).rowCount;
        if (body.is_default || (!hasDefault && row.active)) row = await setDefaultIn(client, row.id);
        if (row.is_default && !row.active) throw Object.assign(new Error('The default agent must be active.'), { status: 400 });
        return row;
    });
}

async function setDefaultIn(client, id) {
    await client.query('UPDATE agents SET is_default=false WHERE is_default AND id<>$1', [id]);
    const row = (await client.query('UPDATE agents SET is_default=true, active=true, updated_at=now() WHERE id=$1 RETURNING *', [id])).rows[0];
    if (!row) throw Object.assign(new Error('Agent not found.'), { status: 404 });
    return row;
}
const setDefaultAgent = id => db.tx(c => setDefaultIn(c, id));

async function deleteAgent(id) {
    const a = await getAgent(id);
    if (!a) throw Object.assign(new Error('Agent not found.'), { status: 404 });
    if (a.is_default) throw Object.assign(new Error('Make another agent the default first.'), { status: 400 });
    const used = await db.one("SELECT COUNT(*)::int n FROM scheduled_calls WHERE agent_id=$1 AND status IN ('pending','starting','started')", [id]);
    if (used.n) throw Object.assign(new Error(`${used.n} scheduled call(s) still use this agent. Edit or cancel them first.`), { status: 409 });
    await db.query('DELETE FROM agents WHERE id=$1', [id]);
}

// Agent for a broadcast/schedule: the one asked for (must be active) or the default.
async function resolveAgent(agentId) {
    if (agentId) {
        const a = await getAgent(agentId);
        if (!a) throw Object.assign(new Error('That agent no longer exists.'), { status: 400 });
        return a;
    }
    return defaultAgent();
}

// Optional tunables that used to live in .env. The importer keeps them as encrypted "env.<KEY>"
// secrets; at boot they are copied into process.env unless the environment already sets them.
// The Sarvam base URL comes from the sarvam_base_url secret, in the prod app only (dev/test must
// point SARVAM_BASE_URL at a local stub through their own environment).
const TUNABLES = ['SARVAM_MAX_CALL_MINUTES', 'SCHEDULE_GRACE_MINUTES', 'VOXSEND_RESUME_MINUTES', 'SESSION_DAYS', 'VOXSEND_SYNC_MINUTES', 'TZ'];
async function applyDbEnv({ prod }) {
    const all = await secrets.getAll();
    const applied = [];
    for (const k of TUNABLES) {
        if (process.env[k] === undefined && all['env.' + k]) { process.env[k] = all['env.' + k]; applied.push(k); }
    }
    if (prod && !process.env.SARVAM_BASE_URL && all.sarvam_base_url) { process.env.SARVAM_BASE_URL = all.sarvam_base_url; applied.push('SARVAM_BASE_URL'); }
    return applied;
}
// The scheduler switch (settings.scheduler_enabled). Only the prod app honours it.
async function schedulerEnabled() {
    const r = await db.one('SELECT scheduler_enabled FROM settings WHERE id=1');
    return !!(r && r.scheduler_enabled);
}

module.exports = {
    TUNABLES, applyDbEnv, schedulerEnabled,
    getSettings, getCredentials, withAgent, missingCredentials, publicConfig, maskedCredentials, saveCredentials, invalidate,
    listAgents, getAgent, defaultAgent, saveAgent, setDefaultAgent, deleteAgent, resolveAgent, FIELDS
};
