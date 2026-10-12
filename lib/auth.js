// Sessions (PIN login -> httpOnly cookie, stored hashed in Postgres) and API tokens
// (Bearer, stored as sha256, with scopes). Plus a small login rate limiter.
const crypto = require('crypto');
const db = require('./db');
const secrets = require('./secrets');

const COOKIE = 'vx_session';
const sessionDays = () => parseInt(process.env.SESSION_DAYS, 10) || 7; // read when used
const SCOPES = ['read', 'write', 'admin'];
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// ── rate limiting (per IP, in memory) ──────────────────
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, first, until }
function loginBlocked(ip) {
    const r = loginFails.get(ip);
    if (!r) return 0;
    if (r.until && r.until > Date.now()) return r.until - Date.now();
    if (Date.now() - r.first > LOGIN_WINDOW_MS) loginFails.delete(ip);
    return 0;
}
function loginFailed(ip) {
    const now = Date.now();
    let r = loginFails.get(ip);
    if (!r || now - r.first > LOGIN_WINDOW_MS || (r.until && r.until <= now)) r = { count: 0, first: now, until: 0 };
    r.count++;
    if (r.count >= LOGIN_MAX_FAILS) r.until = now + LOGIN_LOCK_MS;
    loginFails.set(ip, r);
    return LOGIN_MAX_FAILS - r.count;
}
const loginOk = ip => loginFails.delete(ip);

// ── cookies ────────────────────────────────────────────
function parseCookies(header = '') {
    const out = {};
    header.split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}
function cookieHeader(value, maxAgeSec) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

// ── sessions ───────────────────────────────────────────
async function createSession(req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO sessions (id, expires_at, ip, user_agent) VALUES ($1, now() + ($2 || ' days')::interval, $3, $4)`,
        [sha256(token), String(sessionDays()), req.ip || null, String(req.get('user-agent') || '').slice(0, 200)]);
    res.append('Set-Cookie', cookieHeader(token, sessionDays() * 86400));
}
async function sessionFromRequest(req) {
    const token = parseCookies(req.get('cookie') || '')[COOKIE];
    if (!token) return null;
    const row = await db.one(`UPDATE sessions SET last_seen_at = now() WHERE id=$1 AND expires_at > now()
        RETURNING id, expires_at`, [sha256(token)]);
    return row;
}
async function destroySession(req, res) {
    const token = parseCookies(req.get('cookie') || '')[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE id=$1', [sha256(token)]);
    res.append('Set-Cookie', cookieHeader('', 0));
}
const purgeExpiredSessions = () => db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});

// ── API tokens ─────────────────────────────────────────
async function createToken(name, scopes = ['read'], expiresDays = null) {
    const bad = scopes.filter(s => !SCOPES.includes(s));
    if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}. Use: ${SCOPES.join(', ')}`);
    const secret = crypto.randomBytes(24).toString('base64url');
    const token = `vxs_${secret}`;
    const row = await db.one(`INSERT INTO api_tokens (name, prefix, token_hash, scopes, expires_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5 || ' days')::interval END)
        RETURNING id, name, prefix, scopes, created_at, expires_at`,
        [String(name || 'token').slice(0, 80), token.slice(0, 10), sha256(token), scopes, expiresDays]);
    return { ...row, token }; // the full token is shown once, never stored
}
const listTokens = () => db.many(`SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
    FROM api_tokens ORDER BY id`);
async function revokeToken(id) {
    const r = await db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    return r.rowCount;
}
async function tokenFromRequest(req) {
    const m = String(req.get('authorization') || '').match(/^Bearer\s+(vxs_[A-Za-z0-9_-]{20,})$/);
    if (!m) return null;
    return db.one(`UPDATE api_tokens SET last_used_at=now()
        WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, name, scopes`, [sha256(m[1])]);
}

// ── middleware ─────────────────────────────────────────
// Resolves req.auth = { kind: 'session'|'token', scopes } or rejects with 401.
function requireAuth({ scope = null } = {}) {
    return async (req, res, next) => {
        try {
            if (!req.auth) {
                const tok = await tokenFromRequest(req);
                if (tok) req.auth = { kind: 'token', id: tok.id, name: tok.name, scopes: tok.scopes };
                else {
                    const s = await sessionFromRequest(req);
                    if (s) req.auth = { kind: 'session', scopes: SCOPES }; // the PIN holder can do everything
                }
            }
            if (!req.auth) return res.status(401).json({ success: false, error: 'Not signed in.' });
            const need = scope || (req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write');
            const has = req.auth.scopes.includes('admin') || req.auth.scopes.includes(need)
                || (need === 'read' && req.auth.scopes.includes('write'));
            if (!has) return res.status(403).json({ success: false, error: `This token lacks the "${need}" scope.` });
            next();
        } catch (e) { next(e); }
    };
}

module.exports = {
    COOKIE, SCOPES, sha256, loginBlocked, loginFailed, loginOk, createSession, sessionFromRequest, destroySession,
    purgeExpiredSessions, createToken, listTokens, revokeToken, tokenFromRequest, requireAuth, verifyPin: secrets.verifyPin
};
