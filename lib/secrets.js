// Secrets at rest: AES-256-GCM with the master key from VOXSEND_MASTER_KEY_FILE
// (64 hex chars = 32 bytes). Every value gets its own random 12-byte IV; the row stores
// the key fingerprint (key_id) and a key_version so keys can be rotated.
// The PIN is never encrypted: it is stored as an scrypt hash.
const crypto = require('crypto');
const fs = require('fs');
const db = require('./db');

// Credential fields, keyed by the names the app has always used.
const SECRET_FIELDS = {
    sid: 'Twilio Account SID', token: 'Twilio Auth Token', from: 'Twilio From number',
    vobiz_id: 'Vobiz Auth ID', vobiz_token: 'Vobiz Auth Token', vobiz_from: 'Vobiz From number',
    sarvam_key: 'Sarvam API key', sarvam_org: 'Sarvam Org ID', sarvam_workspace: 'Sarvam Workspace ID',
    sarvam_app_id: 'Sarvam Agent (app) ID', sarvam_app_version: 'Sarvam Agent version',
    sarvam_connection_id: 'Sarvam Connection ID', sarvam_from: 'Sarvam From number',
    sarvam_base_url: 'Sarvam API base URL', webhook_secret: 'Webhook signing secret'
};
// Any other key that was in the old .env is kept as "env.<KEY>" (encrypted) so nothing is lost.
const ENV_SECRET = /^env\.[A-Za-z_][A-Za-z0-9_]*$/;
const knownSecret = name => name in SECRET_FIELDS || ENV_SECRET.test(name);
const PIN_NAME = 'app_pin';

// ── master key ─────────────────────────────────────────
// No default key file: prod sets VOXSEND_MASTER_KEY_FILE=/workspace/pg/master.key, tests their own key.
const PROD_KEY = '/workspace/pg/master.key';
const keyFile = () => {
    const f = process.env.VOXSEND_MASTER_KEY_FILE;
    if (!f) throw new Error('VOXSEND_MASTER_KEY_FILE is not set (no default).');
    const guard = require('./guard');
    let rf = f; try { rf = fs.realpathSync(f); } catch (e) {}
    if (rf === PROD_KEY && !guard.isProd()) throw new Error('Refusing to use the prod master key outside the prod app.');
    return f;
};
const fingerprint = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

function readKeyFile(file) {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file} must hold 64 hex characters`);
    return Buffer.from(hex, 'hex');
}

// The current key, plus a pending ".new" key left by an interrupted rotation.
function loadKeys() {
    // VOXSEND_MASTER_KEY (64 hex) wins, e.g. on Fly.io where there is no key file.
    const envKey = String(process.env.VOXSEND_MASTER_KEY || '').trim();
    if (envKey) {
        if (!/^[0-9a-fA-F]{64}$/.test(envKey)) throw new Error('VOXSEND_MASTER_KEY must hold 64 hex characters');
        const current = Buffer.from(envKey, 'hex');
        return { current, currentId: fingerprint(current), keys: new Map([[fingerprint(current), current]]) };
    }
    const file = keyFile();
    const keys = new Map();
    const current = readKeyFile(file);
    keys.set(fingerprint(current), current);
    try { const k = readKeyFile(file + '.new'); keys.set(fingerprint(k), k); } catch (e) {}
    return { current, currentId: fingerprint(current), keys };
}

function encryptWith(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return { value: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), key_id: fingerprint(key) };
}

function decryptRow(row, keys) {
    const key = keys.get(row.key_id);
    if (!key) throw new Error(`Secret "${row.name}" was encrypted with a key that is not available (key ${row.key_id}).`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.value, 'base64')), decipher.final()]).toString('utf8');
}

// ── PIN hashing (scrypt) ───────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPinHash(pin, stored) {
    const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ── store ──────────────────────────────────────────────
const mask = v => {
    if (v === undefined || v === null || v === '') return '';
    const s = String(v);
    return s.length <= 6 ? '•'.repeat(s.length) : '••••' + s.slice(-4);
};

async function getAll(client = db) {
    const rows = (await client.query("SELECT * FROM secrets WHERE kind='aes-256-gcm'")).rows;
    if (!rows.length) return {};
    const { keys } = loadKeys();
    const out = {};
    for (const row of rows) out[row.name] = decryptRow(row, keys);
    return out;
}

async function get(name) {
    const row = await db.one("SELECT * FROM secrets WHERE name=$1 AND kind='aes-256-gcm'", [name]);
    if (!row) return null;
    return decryptRow(row, loadKeys().keys);
}

// Sets (or, with an empty value, deletes) one encrypted secret.
async function set(name, value, client = db) {
    if (!knownSecret(name)) throw new Error(`Unknown secret "${name}"`);
    if (value === undefined || value === null || String(value) === '') {
        await client.query('DELETE FROM secrets WHERE name=$1', [name]);
        return;
    }
    const { current } = loadKeys();
    const e = encryptWith(current, value);
    const version = await currentKeyVersion(client);
    await client.query(`INSERT INTO secrets (name, kind, value, iv, tag, key_id, key_version, updated_at)
        VALUES ($1, 'aes-256-gcm', $2, $3, $4, $5, $6, now())
        ON CONFLICT (name) DO UPDATE SET kind=EXCLUDED.kind, value=EXCLUDED.value, iv=EXCLUDED.iv, tag=EXCLUDED.tag,
            key_id=EXCLUDED.key_id, key_version=EXCLUDED.key_version, updated_at=now()`,
        [name, e.value, e.iv, e.tag, e.key_id, version]);
}

async function currentKeyVersion(client = db) {
    const r = (await client.query("SELECT value FROM sync_state WHERE key='secrets_key_version'")).rows[0];
    return r ? Number(r.value) : 1;
}

// Masked view for the UI/CLI: never plaintext.
async function listMasked() {
    const all = await getAll();
    const meta = (await db.many('SELECT name, kind, key_version, updated_at FROM secrets ORDER BY name'));
    return meta.map(m => ({
        name: m.name,
        label: m.name === PIN_NAME ? 'App PIN' : (SECRET_FIELDS[m.name] || (ENV_SECRET.test(m.name) ? `From old .env: ${m.name.slice(4)}` : m.name)),
        kind: m.kind,
        masked: m.kind === 'scrypt' ? '(hashed)' : mask(all[m.name]),
        key_version: m.key_version,
        updated_at: m.updated_at
    }));
}

async function setPin(pin, client = db) {
    if (!/^\S{4,64}$/.test(String(pin || ''))) throw new Error('The PIN must be 4-64 characters with no spaces.');
    await client.query(`INSERT INTO secrets (name, kind, value, updated_at) VALUES ($1, 'scrypt', $2, now())
        ON CONFLICT (name) DO UPDATE SET kind='scrypt', value=EXCLUDED.value, iv=NULL, tag=NULL, key_id=NULL, updated_at=now()`,
        [PIN_NAME, hashPin(pin)]);
}
async function hasPin() { return !!(await db.one("SELECT 1 FROM secrets WHERE name=$1", [PIN_NAME])); }
async function verifyPin(pin) {
    const row = await db.one("SELECT value FROM secrets WHERE name=$1 AND kind='scrypt'", [PIN_NAME]);
    return row ? verifyPinHash(pin, row.value) : false;
}

// Generates a webhook secret once (used to sign Sarvam webhook metadata and the
// Vobiz hangup callback URL).
async function ensureWebhookSecret() {
    const cur = await get('webhook_secret').catch(() => null);
    if (cur) return cur;
    const v = crypto.randomBytes(32).toString('base64url');
    await set('webhook_secret', v);
    return v;
}

// Re-encrypts every secret with a brand-new master key, then swaps the key file.
// Steps: write <key>.new -> re-encrypt in one transaction -> rename files. If the
// process dies in between, loadKeys() still finds the .new key by fingerprint.
async function rotateMasterKey() {
    const file = keyFile();
    const { keys } = loadKeys();
    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(file + '.new', newKey.toString('hex'), { mode: 0o600 });
    const count = await db.tx(async client => {
        const rows = (await client.query("SELECT * FROM secrets WHERE kind='aes-256-gcm' FOR UPDATE")).rows;
        const version = (await currentKeyVersion(client)) + 1;
        for (const row of rows) {
            const e = encryptWith(newKey, decryptRow(row, keys));
            await client.query('UPDATE secrets SET value=$2, iv=$3, tag=$4, key_id=$5, key_version=$6, updated_at=now() WHERE name=$1',
                [row.name, e.value, e.iv, e.tag, e.key_id, version]);
        }
        await client.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ('secrets_key_version', $1, now())
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(version)]);
        return { rows: rows.length, version };
    });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const old = `${file}.old-${stamp}`;
    fs.copyFileSync(file, old); fs.chmodSync(old, 0o600);
    fs.renameSync(file + '.new', file); fs.chmodSync(file, 0o600);
    return { ...count, oldKeyBackup: old, keyId: fingerprint(newKey) };
}

module.exports = {
    SECRET_FIELDS, PIN_NAME, ENV_SECRET, knownSecret, mask, getAll, get, set, listMasked, setPin, hasPin, verifyPin, hashPin, verifyPinHash,
    ensureWebhookSecret, rotateMasterKey, loadKeys, encryptWith, decryptRow, fingerprint
};
