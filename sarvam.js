const crypto = require('crypto');

// Sarvam AI Voice Agents — instant outbound call client.
// Docs: https://docs.sarvam.ai/conversations/api/instant-outbound/create

const LANGUAGE_NAMES = { hi: 'Hindi', en: 'English', gu: 'Gujarati' };

const REQUIRED_FIELDS = [
    ['sarvam_key', 'API key'],
    ['sarvam_org', 'Org ID'],
    ['sarvam_workspace', 'Workspace ID'],
    ['sarvam_app_id', 'Agent ID'],
    ['sarvam_connection_id', 'Connection ID'],
    ['sarvam_from', 'From number']
];

// Returns a human-readable list of missing Sarvam settings, or null if complete.
function missingSarvamConfig(cfg = {}) {
    const missing = REQUIRED_FIELDS.filter(([key]) => !cfg[key]).map(([, label]) => label);
    return missing.length ? missing.join(', ') : null;
}

// No version set: use whatever was last committed in the Sarvam dashboard.
// (version_filter is accepted by the API but not in its docs: latest | specific | latest_committed.)
function agentVersion(value) {
    const v = parseInt(value, 10);
    return Number.isInteger(v) && v > 0
        ? { version_filter: 'specific', app_version: v }
        : { version_filter: 'latest_committed' };
}

function baseUrl() {
    return (process.env.SARVAM_BASE_URL || 'https://apps.sarvam.ai').replace(/\/$/, '');
}

// Places one announcement call. Resolves to { ok, attemptId } or { ok:false, message }.
async function placeCall(cfg, { to, message, lang, webhookUrl, metadata }) {
    const url = `${baseUrl()}/api/outbounds/v1/orgs/${encodeURIComponent(cfg.sarvam_org)}` +
        `/workspaces/${encodeURIComponent(cfg.sarvam_workspace)}/outbounds`;

    const body = {
        app_config: {
            app_id: cfg.sarvam_app_id,
            ...agentVersion(cfg.sarvam_app_version),
            connection_config: {
                connection_id: cfg.sarvam_connection_id,
                agent_phone_number: cfg.sarvam_from
            }
        },
        user_config: { user_phone_number: to }
    };
    // No message: the agent speaks its own configured greeting in its own language.
    if (message && String(message).trim()) {
        body.app_config.app_overrides = {
            initial_bot_message: message,
            initial_language_name: LANGUAGE_NAMES[lang] || 'English'
        };
    }
    if (webhookUrl) {
        body.webhook_config = { url: webhookUrl, metadata: metadata || null };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.sarvam_key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
    });
    const json = await res.json().catch(() => ({}));

    if (res.ok && json.attempt_id) {
        return { ok: true, attemptId: json.attempt_id };
    }
    const detail = json.error?.message
        || (Array.isArray(json.detail) ? json.detail.map(d => d.msg).join('; ') : json.detail)
        || json.message
        || `HTTP ${res.status}`;
    return { ok: false, message: String(detail) };
}

// Webhook metadata is echoed back by Sarvam; signing it lets us reject forged results.
function signMetadata(apiKey, broadcast, to) {
    return crypto.createHmac('sha256', String(apiKey || '')).update(`${broadcast}|${to}`).digest('hex');
}

function verifyMetadata(apiKey, meta = {}) {
    if (!apiKey || !meta.sig || !meta.to) return false;
    const expected = Buffer.from(signMetadata(apiKey, meta.broadcast, meta.to));
    const given = Buffer.from(String(meta.sig));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { placeCall, missingSarvamConfig, signMetadata, verifyMetadata, LANGUAGE_NAMES };
