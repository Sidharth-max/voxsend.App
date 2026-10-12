// Token API (/api/v1). Authenticate with "Authorization: Bearer vxs_..." (create one with
// `voxsend tokens create`), or a signed-in browser session. Scopes: read (GET), write
// (changes, starting calls), admin (secrets, tokens). See docs/API.md.
const express = require('express');
const auth = require('./auth');
const config = require('./config');
const secrets = require('./secrets');
const broadcaster = require('./broadcaster');
const schedules = require('./schedules');
const callsync = require('./callsync');
const service = require('./service');
const { expandRule, httpError } = require('./util');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).then(out => {
    if (out !== undefined && !res.headersSent) res.json({ ok: true, data: out });
}).catch(next);
const admin = auth.requireAuth({ scope: 'admin' });
router.use(auth.requireAuth());

// Recipients: explicit numbers and/or contact groups ("*" = every contact).
async function recipients(b) {
    let nums = Array.isArray(b.numbers) ? b.numbers : (typeof b.numbers === 'string' ? b.numbers.split(/[\s,;]+/) : []);
    if (b.groups && (Array.isArray(b.groups) ? b.groups.length : true)) nums = nums.concat(await service.groupNumbers(b.groups));
    return nums.filter(Boolean);
}
// Times: explicit ISO list (runAts) or a repeat rule {mode, dates, startDate, endDate, endAfter, weekdays, skipWeekends, times, timezone}.
function times(b) {
    if (Array.isArray(b.runAts) && b.runAts.length) return { runAts: b.runAts, rule: b.rule || null };
    if (b.runAt) return { runAts: [b.runAt], rule: b.rule || null };
    if (b.rule) { const x = expandRule(b.rule); return { runAts: x.times, rule: x.rule }; }
    throw httpError(400, 'Give runAts (ISO times) or a rule.');
}
const scheduleBody = async b => ({ nums: await recipients(b), msg: b.message, lang: b.language, voice: b.voice, provider: b.provider,
    agentId: b.agentId ?? b.agent_id, sentBy: b.sentBy || 'API', ...times(b) });

router.get('/status', wrap(async () => ({ broadcast: broadcaster.status(), resumable: await broadcaster.resumable(), config: await config.publicConfig() })));

// contacts & lists
router.get('/contacts', wrap(req => service.listContacts(req.query.group !== undefined ? { group: req.query.group } : {})));
router.post('/contacts', wrap(async req => (r => ({ upserted: r.count, invalid: r.invalid }))(await service.upsertContacts(req.body.contacts || req.body))));
router.delete('/contacts', wrap(async req => ({ deleted: await service.deleteContacts(req.body.phones || req.body.phone) })));
router.get('/lists', wrap(() => service.listGroups()));
router.get('/lists/:name', wrap(req => service.groupNumbers([req.params.name])));

// agents
router.get('/agents', wrap(() => config.listAgents(true)));
router.post('/agents', wrap(req => config.saveAgent(null, req.body)));
router.patch('/agents/:id', wrap(async req => {
    const cur = await config.getAgent(Number(req.params.id));
    if (!cur) throw httpError(404, 'Agent not found.');
    return config.saveAgent(cur.id, { ...cur, ...req.body });
}));
router.post('/agents/:id/default', wrap(req => config.setDefaultAgent(Number(req.params.id))));
router.delete('/agents/:id', wrap(async req => { await config.deleteAgent(Number(req.params.id)); return { deleted: true }; }));

// schedules
router.get('/schedules', wrap(() => schedules.list()));
router.get('/schedules/:groupId', wrap(req => schedules.getGroup(req.params.groupId)));
router.post('/schedules', wrap(async req => schedules.create(await scheduleBody(req.body))));
router.put('/schedules/:groupId', wrap(async req => schedules.editGroup(req.params.groupId, await scheduleBody(req.body))));
router.delete('/schedules/:groupId', wrap(req => schedules.cancel({ group: req.params.groupId })));
router.patch('/schedule-times/:id', wrap(req => schedules.moveTime(Number(req.params.id), req.body.runAt)));
router.delete('/schedule-times/:id', wrap(req => schedules.cancel({ id: Number(req.params.id) })));

// broadcasts
router.get('/broadcast-runs', wrap(req => require('./runs').listRuns(req.query)));
router.get('/broadcast-runs/:key/calls', wrap(req => require('./runs').runCalls(req.params.key)));
router.get('/broadcasts', wrap(req => service.listBroadcasts(req.query)));
router.get('/broadcasts/active', wrap(() => broadcaster.status()));
router.get('/broadcasts/resumable', wrap(() => broadcaster.resumable()));
router.get('/broadcasts/:id', wrap(req => service.getBroadcast(Number(req.params.id))));
router.post('/broadcasts', wrap(async req => {
    const b = req.body || {};
    if (b.confirm !== true) throw httpError(400, 'Starting a broadcast places real calls. Send "confirm": true to proceed.');
    return broadcaster.start({ nums: await recipients(b), msg: b.message, lang: b.language, voice: b.voice, provider: b.provider,
        agentId: b.agentId ?? b.agent_id, sentBy: b.sentBy || 'API' });
}));
router.post('/broadcasts/stop', wrap(async () => ({ stopped: await broadcaster.stop() })));
router.post('/broadcasts/:id/resume', wrap(async req => {
    const r = await broadcaster.requestResume(Number(req.params.id));
    require('./scheduler').poke();
    return r;
}));

// call history
router.get('/calls', wrap(req => callsync.list(req.query)));
router.post('/calls/sync', wrap(req => callsync.syncNow({ days: parseInt(req.body.days, 10) || null })));
router.get('/calls/:id', wrap(req => callsync.get(req.params.id)));
router.get('/calls/:id/transcript', wrap(req => callsync.transcript(req.params.id, { refresh: req.query.refresh === '1' })));
router.get('/calls/:id/recording', (req, res, next) => callsync.streamRecording(req.params.id, req, res).catch(next));

// history
router.get('/history', wrap(() => service.listHistory()));

// secrets (masked) & tokens: admin scope
router.get('/secrets', admin, wrap(() => secrets.listMasked()));
router.put('/secrets/:name', admin, wrap(async req => {
    if (!config.FIELDS.includes(req.params.name)) throw httpError(400, `Unknown credential. Use one of: ${config.FIELDS.join(', ')}`);
    await config.saveCredentials({ [req.params.name]: String(req.body.value || '') });
    return { saved: req.params.name };
}));
router.delete('/secrets/:name', admin, wrap(async req => {
    if (!config.FIELDS.includes(req.params.name)) throw httpError(400, 'Unknown credential.');
    await config.saveCredentials({ clear: [req.params.name] });
    return { cleared: req.params.name };
}));
router.get('/tokens', admin, wrap(() => auth.listTokens()));
router.post('/tokens', admin, wrap(req => auth.createToken(req.body.name, req.body.scopes || ['read'], req.body.days || null)));
router.delete('/tokens/:id', admin, wrap(async req => ({ revoked: await auth.revokeToken(Number(req.params.id)) })));

router.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
router.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('API v1 error:', req.method, req.path, err.message);
    res.status(status).json({ ok: false, error: err.message });
});

module.exports = { router, recipients, times };
