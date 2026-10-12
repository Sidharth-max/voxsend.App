// Moves every key of an old .env file into the database, and proves it arrived.
//   provider credentials, phone numbers, base URL, agent/app id -> encrypted secrets (AES-256-GCM)
//   APP_PIN                     -> scrypt hash (verified by checking the PIN against it)
//   PROVIDER, PUBLIC_URL        -> settings table
//   bootstrap keys              -> stay in .env (DATABASE_URL, VOXSEND_MASTER_KEY_FILE, PORT, PGSCHEMA)
//   runtime switches            -> not imported (VOXSEND_SCHEDULER is settings.scheduler_enabled now)
//   any other key               -> encrypted secret "env.<KEY>"
// verify() decrypts every imported value and compares SHA-256 hashes with the file. It never
// returns or prints a value or a hash: only key names and ok/mismatch.
const crypto = require('crypto');
const secrets = require('./secrets');
const { BOOTSTRAP_KEYS } = require('./bootenv');

const SECRET_MAP = {
    TWILIO_ACCOUNT_SID: 'sid', TWILIO_AUTH_TOKEN: 'token', TWILIO_FROM: 'from',
    VOBIZ_AUTH_ID: 'vobiz_id', VOBIZ_AUTH_TOKEN: 'vobiz_token', VOBIZ_FROM: 'vobiz_from',
    SARVAM_API_KEY: 'sarvam_key', SARVAM_ORG_ID: 'sarvam_org', SARVAM_WORKSPACE_ID: 'sarvam_workspace',
    SARVAM_APP_ID: 'sarvam_app_id', SARVAM_APP_VERSION: 'sarvam_app_version',
    SARVAM_CONNECTION_ID: 'sarvam_connection_id', SARVAM_FROM: 'sarvam_from', SARVAM_BASE_URL: 'sarvam_base_url'
};
const SETTINGS_MAP = { PROVIDER: 'provider', PUBLIC_URL: 'public_url' };
const RUNTIME_SWITCHES = ['VOXSEND_SCHEDULER', 'VOXSEND_AUTO_MIGRATE', 'VOXSEND_ENV_FILE'];
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// Where each key goes. Order follows the file.
function plan(env) {
    return Object.keys(env).map(key => {
        const value = env[key];
        if (BOOTSTRAP_KEYS.includes(key)) return { key, dest: 'bootstrap (.env)', kind: 'bootstrap' };
        if (RUNTIME_SWITCHES.includes(key)) return { key, dest: 'not imported (runtime switch)', kind: 'skip' };
        if (value === undefined || value === '') return { key, dest: 'empty (nothing to store)', kind: 'empty' };
        if (key === 'APP_PIN') return { key, dest: `secrets.${secrets.PIN_NAME} (scrypt)`, kind: 'pin', name: secrets.PIN_NAME };
        if (SETTINGS_MAP[key]) return { key, dest: `settings.${SETTINGS_MAP[key]}`, kind: 'setting', column: SETTINGS_MAP[key] };
        const name = SECRET_MAP[key] || `env.${key}`;
        return { key, dest: `secrets.${name} (aes-256-gcm)`, kind: 'secret', name };
    });
}

async function apply(client, env) {
    for (const p of plan(env)) {
        const v = env[p.key];
        if (p.kind === 'secret') await secrets.set(p.name, v, client);
        else if (p.kind === 'pin') await secrets.setPin(v, client);
        else if (p.kind === 'setting' && p.column === 'provider') {
            if (!['twilio', 'vobiz', 'sarvam'].includes(v)) throw new Error(`PROVIDER must be twilio, vobiz or sarvam.`);
            await client.query('UPDATE settings SET provider=$1, updated_at=now() WHERE id=1', [v]);
        } else if (p.kind === 'setting' && p.column === 'public_url') {
            await client.query('UPDATE settings SET public_url=$1, updated_at=now() WHERE id=1', [v]);
        }
    }
}

// [{ key, dest, ok, note }] — ok is true/false for imported keys, null for keys that are not stored.
async function verify(client, env) {
    const all = await secrets.getAll(client); // decrypts every row with the master key
    const pinRow = (await client.query("SELECT value FROM secrets WHERE name=$1 AND kind='scrypt'", [secrets.PIN_NAME])).rows[0];
    const st = (await client.query('SELECT provider, public_url FROM settings WHERE id=1')).rows[0] || {};
    return plan(env).map(p => {
        const v = env[p.key];
        let ok = null;
        if (p.kind === 'secret') ok = all[p.name] !== undefined && sha(all[p.name]) === sha(v);
        else if (p.kind === 'pin') ok = !!pinRow && secrets.verifyPinHash(v, pinRow.value);
        else if (p.kind === 'setting') ok = sha(st[p.column] || '') === sha(v);
        return { key: p.key, dest: p.dest, ok };
    });
}

module.exports = { plan, apply, verify, SECRET_MAP, SETTINGS_MAP, RUNTIME_SWITCHES };
