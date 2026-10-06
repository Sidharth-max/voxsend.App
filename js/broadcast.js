let lang = 'hi';
window.lastNumStats = { total: 0, unique: 0, duplicatesRemoved: 0 };
let broadcastVisibleLimit = 100;

const cleanNumberEntry = (value = '') => {
    if (!value) return '';
    let cleaned = value.trim();
    cleaned = cleaned.replace(/\s+/g, '');
    cleaned = cleaned.replace(/(?!^)\+/g, '');
    cleaned = cleaned.replace(/[^0-9+]/g, '');
    return cleaned;
};

const normalizeNumberKey = (value = '') => cleanNumberEntry(value).replace(/[^0-9]/g, '');

const buildUniqueNumberList = (entries = []) => {
    const seen = new Set();
    const unique = [];
    let duplicates = 0;
    let total = 0;

    entries.forEach(entry => {
        const cleaned = cleanNumberEntry(entry);
        if (!cleaned) return;
        total++;
        const key = normalizeNumberKey(cleaned);
        if (!key) return;
        if (seen.has(key)) {
            duplicates++;
            return;
        }
        seen.add(key);
        const formatted = cleaned.startsWith('+') ? cleaned : '+' + cleaned.replace(/^\++/, '');
        unique.push(formatted);
    });

    return { unique, duplicates, total };
};

const reflectNumberStats = (stats = {}) => {
    const uniqueCount = Array.isArray(stats.unique) ? stats.unique.length : 0;
    const total = stats.total || uniqueCount;
    const duplicates = stats.duplicates || 0;
    window.lastNumStats = { total, unique: uniqueCount, duplicatesRemoved: duplicates };

    const dupHint = document.getElementById('dup-hint');
    if (dupHint) {
        if (duplicates > 0) {
            dupHint.style.display = 'block';
            dupHint.textContent = `Removed ${duplicates} duplicate ${duplicates === 1 ? 'number' : 'numbers'} automatically.`;
        } else {
            dupHint.style.display = 'none';
        }
    }
};

const updateRecipientsField = (list, options = {}) => {
    const numsEl = document.getElementById('numbers');
    if (!numsEl) return { unique: [], duplicates: 0, total: 0, changed: false };

    const stats = buildUniqueNumberList(Array.isArray(list) ? list : []);
    reflectNumberStats(stats);

    const shouldKeepTrailing = typeof options.preserveTrailingNewline === 'boolean'
        ? options.preserveTrailingNewline
        : /\n$/.test(numsEl.value);

    let newValue = stats.unique.join('\n');
    if (shouldKeepTrailing && stats.unique.length) {
        newValue += '\n';
    }

    const changed = numsEl.value !== newValue;
    if (changed) numsEl.value = newValue;

    if (!options.skipPreview) {
        if (typeof window.preview === 'function') window.preview();
        if (typeof window.renderBroadcastContacts === 'function') window.renderBroadcastContacts();
    }

    return { ...stats, changed };
};

window.setRecipientNumbers = (list, options) => updateRecipientsField(list, options);

// Provider currently saved in the API tab; drives Sarvam-specific UI.
window.currentProvider = 'twilio';
const isSarvam = () => window.currentProvider === 'sarvam';
// Sarvam agents speak their own greeting and script, so no message is sent for them.
const currentMessage = () => {
    if (isSarvam()) return '';
    const el = document.getElementById('msg');
    return el ? el.value.trim() : '';
};

const SARVAM_PLACEHOLDER = "Optional — leave empty to use the Sarvam agent's own greeting";

// Sidebar / top bar title = the active calling service, styled in its own brand colours.
const PROVIDER_BRAND = { sarvam: 'Sarvam AI', twilio: 'Twilio', vobiz: 'Vobiz' };
let providerAgentVersion = null; // Sarvam app version from saved settings ('' = latest committed)
const renderProviderBrand = provider => {
    const name = PROVIDER_BRAND[provider] || PROVIDER_BRAND.twilio;
    document.querySelectorAll('[data-provider-title]').forEach(el => {
        el.dataset.provider = provider in PROVIDER_BRAND ? provider : 'twilio';
        el.textContent = '';
        if (provider === 'sarvam') {
            const g = document.createElement('span');
            g.className = 'sarvam-gradient';
            g.textContent = name;
            el.appendChild(g);
        } else el.textContent = name;
        el.setAttribute('aria-label', `Calling via ${name}`);
    });
    // Agent version under the subtitle (Sarvam only)
    const ver = providerAgentVersion;
    let meta = '';
    if (provider === 'sarvam' && ver !== null) meta = ver ? `Agent ${/^\d+$/.test(ver) ? 'v' + ver : ver}` : 'Agent · latest version';
    document.querySelectorAll('[data-provider-meta]').forEach(el => { el.textContent = meta; });
};
// Typing a version in the API tab updates the title straight away.
document.addEventListener('input', e => {
    if (e.target && e.target.id === 'sarvam-app-version') {
        providerAgentVersion = e.target.value.trim();
        renderProviderBrand(window.currentProvider);
    }
});

window.applyProviderUI = function(provider) {
    window.currentProvider = provider || 'twilio';
    const sarvam = isSarvam();
    const note = document.getElementById('sarvam-mode-note');
    if (note) note.style.display = sarvam ? 'block' : 'none';
    const msgField = document.getElementById('msg-field');
    if (msgField) msgField.style.display = sarvam ? 'none' : '';
    const label = document.getElementById('msg-label');
    if (label) label.textContent = sarvam ? 'Message override (optional)' : 'Voice message text';
    const vWrap = document.getElementById('vobiz-voice-wrap');
    if (vWrap) vWrap.style.display = window.currentProvider === 'vobiz' ? 'block' : 'none';

    // Sarvam bills in its own credits, so the ₹/min estimate does not apply.
    const costTile = document.getElementById('m-cost-tile');
    if (costTile) costTile.style.display = sarvam ? 'none' : '';

    // History sub-tabs only for the provider that has them
    const vTab = document.getElementById('sub-vobiz');
    const sTab = document.getElementById('sub-sarvam');
    if (vTab) vTab.style.display = window.currentProvider === 'vobiz' ? '' : 'none';
    if (sTab) sTab.style.display = sarvam ? '' : 'none';
    const activeSub = document.querySelector('#sub-vobiz.active, #sub-sarvam.active');
    if (activeSub && activeSub.style.display === 'none' && window.setHistTab) window.setHistTab('broadcast');
    else if (sarvam && window.setHistTab && !(window.histTabWasPicked && window.histTabWasPicked())
        && !document.querySelector('#sub-sarvam.active')) window.setHistTab('sarvam');

    if (window.applySettingsProviderUI) window.applySettingsProviderUI(window.currentProvider);
    renderProviderBrand(window.currentProvider);

    // Sarvam's agent speaks in its own configured language, so there is nothing to pick here.
    const langPills = document.getElementById('msg-lang-pills');
    if (langPills) langPills.classList.toggle('is-hidden', sarvam);

    // Gujarati is only spoken by Sarvam; Polly voices cannot.
    const gu = document.getElementById('pill-gu');
    if (gu) gu.style.display = sarvam ? '' : 'none';
    if (!sarvam && lang === 'gu') { window.setLang('hi'); return; }
    window.setLang(lang);
};

window.setLang = function(l) {
    lang = l;
    ['hi', 'en', 'gu'].forEach(code => {
        const pill = document.getElementById('pill-' + code);
        if (pill) pill.classList.toggle('active', l === code);
    });
    
    const msgEl = document.getElementById('msg');
    if (msgEl && isSarvam()) {
        msgEl.placeholder = SARVAM_PLACEHOLDER;
        msgEl.classList.toggle('hindi', l !== 'en');
    } else if (msgEl) {
        if (l === 'hi' || l === 'gu') {
            msgEl.placeholder = 'नमस्ते! हमारा कार्यक्रम कल 11 बजे है। कृपया समय पर पधारें। धन्यवाद।';
            msgEl.classList.add('hindi');
        } else {
            msgEl.placeholder = 'Hello! Our event is tomorrow at 11 AM. Please join us on time. Thank you.';
            msgEl.classList.remove('hindi');
        }
    }
    
    window.preview();
};

window.getNums = function() {
    const numsEl = document.getElementById('numbers');
    if (!numsEl) return [];
    const stats = buildUniqueNumberList(numsEl.value.split('\n'));
    reflectNumberStats(stats);
    return stats.unique;
};

window.preview = function() {
    const msgEl = document.getElementById('msg');
    if (!msgEl) return;
    const msg = currentMessage();
    
    const prevMsgEl = document.getElementById('prev-msg');
    if (prevMsgEl) {
        prevMsgEl.textContent = msg || (isSarvam() ? "Sarvam agent's own greeting" : 'Message will appear here...');
        prevMsgEl.className = 'hist-msg ' + lang;
    }

    const nums = getNums();
    
    const numCountEl = document.getElementById('num-count');
    if (numCountEl) {
        const dupRemoved = window.lastNumStats?.duplicatesRemoved || 0;
        numCountEl.textContent = dupRemoved > 0
            ? `${nums.length} numbers (removed ${dupRemoved} duplicates)`
            : nums.length + ' numbers';
    }
    
    const charCountEl = document.getElementById('char-count');
    if (charCountEl) charCountEl.textContent = msg.length + ' chars';

    const maxChars = lang === 'en' ? 1200 : 800;
    const isOver = msg.length > maxChars;
    const btn = document.getElementById('send-btn');
    const overEl = document.getElementById('over-limit');
    
    if (isOver) {
        if (overEl) overEl.style.display = 'block';
        if (btn) btn.disabled = true;
    } else {
        if (overEl) overEl.style.display = 'none';
        if (btn) btn.disabled = (!msg && !isSarvam()) || nums.length === 0;
    }
    if (typeof window.renderScheduleRecipients === 'function') window.renderScheduleRecipients();
};

window.addLog = function(type, text) {
    const log = document.getElementById('log');
    if (!log.classList.contains('show')) log.classList.add('show');
    const el = document.createElement('div');
    el.className = 'log-line ' + type;
    el.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    log.prepend(el);
};

let pollInterval = null;

window.checkActiveBroadcast = async function() {
    const c = await window.getCfg();
    providerAgentVersion = c.sarvam_app_version || '';
    window.applyProviderUI(c.provider);

    fetch('/api/broadcast/status').then(res => res.json()).then(status => {
        if (status.active) {
            // Restore context
            document.getElementById('msg').value = status.msg || '';
            if (window.preview) window.preview();
            
            // Open the log area and clear it for the fresh session info
            const logList = document.getElementById('log-list');
            if (logList) logList.innerHTML = '';
            document.getElementById('prog-wrap').classList.add('show');
            
            window.startPolling();
            window.addLog('info', `Reconnected to active ${status.provider} broadcast.`);
        }
    });
};

window.startPolling = function() {
    if (pollInterval) clearInterval(pollInterval);
    document.getElementById('send-btn').disabled = true;
    document.getElementById('prog-wrap').classList.add('show');
    window.seenLogs = new Set();
    
    pollInterval = setInterval(() => {
        fetch('/api/broadcast/status').then(res => res.json()).then(status => {
            if (!status.active) {
                clearInterval(pollInterval);
                pollInterval = null;
                document.getElementById('send-btn').disabled = false;
                document.getElementById('prog-wrap').classList.remove('show');
                window.addLog('info', `Broadcast finished. Success: ${status.successful || 0}, Failed: ${status.failed || 0}`);
                if (window.loadHistory) window.loadHistory();
                return;
            }

            const pct = Math.round((status.current / status.total) * 100);
            document.getElementById('prog-fill').style.width = pct + '%';
            document.getElementById('prog-lbl').textContent = `${status.current} / ${status.total}`;
            
            // Sync logs
            if (status.logs && status.logs.length > 0) {
                status.logs.forEach(log => {
                    // Use a more unique ID including index or full content
                    const logId = `${log.time}-${log.type}-${log.text}`;
                    if (!window.seenLogs.has(logId)) {
                        window.seenLogs.add(logId);
                        window.addLog(log.type, log.text);
                    }
                });
            }
        });
    }, 2000);
};

window.stopBroadcast = async function() {
    const confirmed = await window.showConfirm("Stop the current background broadcast?");
    if (confirmed) {
        fetch('/api/broadcast/stop', { method: 'POST' }).then(res => res.json()).then(res => {
            window.addLog('info', 'Stop request sent.');
        });
    }
};

window.blast = async function() {
    const nums = getNums();
    const msg = currentMessage();
    const c = await window.getCfg();

    // Clear previous logs
    const logEl = document.getElementById('log');
    if (logEl) logEl.innerHTML = '';
    
    const provider = c.provider || 'twilio';

    if (c.missing) {
        window.addLog('err', `${c.missing}. Check API tab.`);
        return;
    }

    const voiceEl = document.getElementById('vobiz-voice');
    const selectedVoice = voiceEl ? voiceEl.value : (lang === 'hi' ? 'Polly.Aditi' : 'Polly.Joanna');

    const payload = {
        nums,
        msg,
        lang: lang,
        sentBy: window.currentUser ? window.currentUser.username : 'Unknown',
        provider: provider,
        voice: selectedVoice
    };

    fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(res => res.json()).then(res => {
        if (res.success) {
            if (res.duplicatesRemoved) {
                window.addLog('info', `Skipped ${res.duplicatesRemoved} duplicate ${res.duplicatesRemoved === 1 ? 'number' : 'numbers'} before sending.`);
            }
             window.addLog('info', `Broadcast initiated via ${PROVIDER_LABELS[provider] || provider}. You can safely close this page.`);
            window.startPolling();
        } else {
            window.addLog('err', 'Error: ' + res.message);
        }
    }).catch(err => {
        window.addLog('err', 'Network error starting broadcast.');
    });
};

const PROVIDER_LABELS = { twilio: 'Twilio', vobiz: 'Vobiz.ai', sarvam: 'Sarvam AI' };

// ── Scheduled calls ──────────────────────────────────
// Repeat modes: specific dates, daily over a range (optionally skipping weekends), or
// weekly on chosen weekdays. A range ends on a date or after N run days. Every run day
// gets every time of day. All run times are built in the browser's time zone.
const MAX_SCHEDULE = 200;
const SCHED_MAX_SCAN_DAYS = 3660; // never look more than ~10 years ahead
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first, like the calendar
let scheduleMode = 'daily';
let scheduleEnd = 'date';
let scheduleInFlight = false; // blocks double-submits while a Schedule request is pending
const scheduleWeekdays = new Set();

const pad2 = n => String(n).padStart(2, '0');
const toYmd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtTimeHM = t => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const weekdayName = (d, style = 'short') => new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: style }); // 7 Jan 2024 was a Sunday

const fieldValues = sel => {
    const all = [...document.querySelectorAll(sel)].map(f => f.dataset.value || '');
    return { values: all.filter(Boolean), empty: all.filter(v => !v).length };
};

const buildScheduleTimes = () => {
    if (!getNums().length) return { runs: [], error: 'Choose who to call: tap Change to pick contacts.' };
    const t = fieldValues('#sched-times .vx-field');
    if (!t.values.length) return { runs: [], error: 'Pick at least one time.' };
    if (t.empty) return { runs: [], error: `${t.empty} time box${t.empty === 1 ? ' is' : 'es are'} empty. Pick a time or remove it with ×.` };
    // Never merge repeated times silently: a second box left on the first box's time
    // used to vanish from the schedule without a word.
    const dupT = t.values.find((v, i) => t.values.indexOf(v) !== i);
    if (dupT) return { runs: [], error: `Two time boxes are both ${fmtTimeHM(dupT)}. Change one or remove it with ×.` };
    const times = [...t.values].sort();

    let days = [];
    const rule = { mode: scheduleMode, times, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (scheduleMode === 'dates') {
        const d = fieldValues('#sched-dates .vx-field');
        if (!d.values.length) return { runs: [], error: 'Pick at least one date.' };
        if (d.empty) return { runs: [], error: `${d.empty} date box${d.empty === 1 ? ' is' : 'es are'} empty. Pick a date or remove it with ×.` };
        const dupD = d.values.find((v, i) => d.values.indexOf(v) !== i);
        if (dupD) return { runs: [], error: `Two date boxes are both ${new Date(dupD + 'T00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })}. Change one or remove it with ×.` };
        days = [...d.values].sort();
        rule.dates = days;
    } else {
        const from = document.getElementById('sched-from').dataset.value;
        if (!from) return { runs: [], error: 'Pick a start date.' };
        let allowed;
        if (scheduleMode === 'weekly') {
            if (!scheduleWeekdays.size) return { runs: [], error: 'Pick at least one weekday.' };
            allowed = d => scheduleWeekdays.has(d.getDay());
            rule.weekdays = [...scheduleWeekdays].sort();
        } else {
            const skip = document.getElementById('sched-skip-weekends').checked;
            allowed = d => !skip || (d.getDay() !== 0 && d.getDay() !== 6);
            rule.skipWeekends = skip;
            rule.weekdays = skip ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
        }
        rule.startDate = from;
        const day = new Date(from + 'T00:00');
        if (scheduleEnd === 'count') {
            const n = parseInt(document.getElementById('sched-count').value, 10);
            if (!(n >= 1)) return { runs: [], error: 'Enter how many days to run (1 or more).' };
            rule.endAfter = n;
            for (let i = 0; i < SCHED_MAX_SCAN_DAYS && days.length < n && days.length * times.length <= MAX_SCHEDULE; i++) {
                if (allowed(day)) days.push(toYmd(day));
                day.setDate(day.getDate() + 1);
            }
        } else {
            let to = document.getElementById('sched-to').dataset.value;
            if (!to && scheduleMode === 'weekly') return { runs: [], error: 'Pick an end date, or choose "For N days".' };
            to = to || from;
            if (to < from) return { runs: [], error: '"Ends" date is before the start date.' };
            rule.endDate = to;
            const last = new Date(to + 'T00:00');
            for (let i = 0; day <= last && i < SCHED_MAX_SCAN_DAYS && days.length * times.length <= MAX_SCHEDULE; i++) {
                if (allowed(day)) days.push(toYmd(day));
                day.setDate(day.getDate() + 1);
            }
        }
        if (!days.length) return { runs: [], error: 'No days match. Check the weekdays or "Skip weekends".' };
        if (scheduleEnd === 'count') rule.endDate = days[days.length - 1];
    }

    const runs = [];
    days.forEach(ymd => times.forEach(tm => runs.push(new Date(`${ymd}T${tm}`))));
    if (runs.length > MAX_SCHEDULE) return { runs: [], error: `That is more than ${MAX_SCHEDULE} broadcasts. Shorten the range or remove a time.` };
    const past = runs.filter(r => r.getTime() < Date.now()).length;
    if (past === runs.length) return { runs: [], error: 'All of those times are in the past.' };
    return { runs: runs.filter(r => r.getTime() >= Date.now()), skippedPast: past, days, times, rule };
};

const makeRemovableRow = (field, onRemove, label) => {
    const row = document.createElement('div');
    row.className = 'vx-time-row';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'vx-icon-btn';
    remove.setAttribute('aria-label', label);
    remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    remove.onclick = () => { row.remove(); onRemove(); };
    row.append(field, remove);
    return row;
};

window.addScheduleTime = function(value = '') {
    const field = window.VxPicker.makeField('time', { value, placeholder: 'Pick a time' });
    field.addEventListener('input', window.updateSchedulePreview);
    document.getElementById('sched-times').appendChild(makeRemovableRow(field, window.updateSchedulePreview, 'Remove this time'));
    window.updateSchedulePreview();
};

window.addScheduleDate = function(value = '') {
    const field = window.VxPicker.makeField('date', { value, placeholder: 'Pick a date' });
    field.addEventListener('input', window.updateSchedulePreview);
    document.getElementById('sched-dates').appendChild(makeRemovableRow(field, window.updateSchedulePreview, 'Remove this date'));
    window.updateSchedulePreview();
};

const renderWeekdayPills = () => {
    const wrap = document.getElementById('sched-weekdays');
    if (!wrap) return;
    wrap.innerHTML = '';
    WEEKDAY_ORDER.forEach(d => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lang-pill' + (scheduleWeekdays.has(d) ? ' active' : '');
        b.textContent = weekdayName(d);
        b.setAttribute('aria-pressed', String(scheduleWeekdays.has(d)));
        b.onclick = () => {
            if (scheduleWeekdays.has(d)) scheduleWeekdays.delete(d); else scheduleWeekdays.add(d);
            renderWeekdayPills();
            window.updateSchedulePreview();
        };
        wrap.appendChild(b);
    });
};

const setActivePill = (groupId, attr, value) => {
    document.querySelectorAll(`#${groupId} .lang-pill`).forEach(b => {
        const on = b.dataset[attr] === value;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    });
};

window.setScheduleMode = function(mode) {
    scheduleMode = mode;
    setActivePill('sched-mode', 'mode', mode);
    document.getElementById('sched-dates-wrap').style.display = mode === 'dates' ? 'block' : 'none';
    document.getElementById('sched-range-wrap').style.display = mode === 'dates' ? 'none' : 'block';
    document.getElementById('sched-weekdays-wrap').style.display = mode === 'weekly' ? 'block' : 'none';
    document.getElementById('sched-skipwe-wrap').style.display = mode === 'daily' ? '' : 'none';
    if (mode === 'dates' && !document.querySelector('#sched-dates .vx-field')) window.addScheduleDate();
    if (mode === 'weekly' && !scheduleWeekdays.size) {
        const from = document.getElementById('sched-from').dataset.value;
        scheduleWeekdays.add(from ? new Date(from + 'T00:00').getDay() : 1);
    }
    const to = document.getElementById('sched-to');
    if (to) to.dataset.placeholder = mode === 'weekly' ? 'Pick a date' : 'Same day';
    if (to && !to.dataset.value) to.querySelector('.vx-field-label').textContent = to.dataset.placeholder;
    renderWeekdayPills();
    window.updateSchedulePreview();
};

window.setScheduleEnd = function(end) {
    scheduleEnd = end;
    setActivePill('sched-end-mode', 'end', end);
    document.getElementById('sched-end-date-wrap').style.display = end === 'date' ? '' : 'none';
    document.getElementById('sched-end-count-wrap').style.display = end === 'count' ? '' : 'none';
    window.updateSchedulePreview();
};

// The preview lives in a .cost-strip: one .ci item per fact, values in <strong>.
const renderSchedulePreview = (el, items) => {
    el.innerHTML = '';
    items.forEach(([label, value]) => {
        const ci = document.createElement('span');
        ci.className = 'ci';
        if (value === undefined) { ci.textContent = label; }
        else {
            ci.append(label + ' ');
            const strong = document.createElement('strong');
            strong.textContent = value;
            ci.appendChild(strong);
        }
        el.appendChild(ci);
    });
};

window.updateSchedulePreview = function() {
    const fromF = document.getElementById('sched-from');
    const toF = document.getElementById('sched-to');
    if (fromF && toF) toF.dataset.min = fromF.dataset.value || '';
    const el = document.getElementById('sched-preview');
    const btn = document.getElementById('schedule-btn');
    if (!el || !btn) return;
    const { runs, error, skippedPast, days, times } = buildScheduleTimes();
    if (error) { renderSchedulePreview(el, [[error]]); btn.disabled = true; return; }
    btn.disabled = scheduleInFlight;
    const fmt = d => d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const items = [
        ['Broadcasts', String(runs.length)],
        ['Days', String(days.length)],
        [times.length === 1 ? 'Time' : 'Times', times.map(fmtTimeHM).join(', ')]
    ];
    if (runs.length === 1) items.push(['On', fmt(runs[0])]);
    else items.push(['First', fmt(runs[0])], ['Last', fmt(runs[runs.length - 1])]);
    if (skippedPast) items.push([`${skippedPast} past time${skippedPast === 1 ? '' : 's'} skipped`]);
    renderSchedulePreview(el, items);
};

window.scheduleBlast = async function() {
    if (scheduleInFlight) return;
    const nums = getNums();
    const msg = currentMessage();
    if (!msg && !isSarvam()) return window.showToast('Write a message first.', 'error');
    if (nums.length === 0) return window.showToast('Choose who to call first.', 'error');
    const { runs, error, rule } = buildScheduleTimes();
    const editing = scheduleEditing;
    if (error) return window.showToast(error, 'error');

    const btn = document.getElementById('schedule-btn');
    scheduleInFlight = true;
    btn.disabled = true;
    btn.textContent = editing ? 'Saving…' : 'Scheduling…';
    try {
        const c = await window.getCfg();
        const voiceEl = document.getElementById('vobiz-voice');
        const res = await fetch(editing ? `/api/schedule/group/${encodeURIComponent(editing.id)}` : '/api/schedule', {
            method: editing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nums, msg, lang,
                voice: voiceEl ? voiceEl.value : null,
                provider: editing ? editing.provider : (c.provider || 'twilio'),
                runAts: runs.map(r => r.toISOString()),
                rule,
                sentBy: window.currentUser ? window.currentUser.username : 'Unknown'
            })
        }).then(r => r.json());
        if (res.success && editing) {
            window.showToast(`Saved. ${res.pending} scheduled time${res.pending === 1 ? '' : 's'} for ${res.total} number${res.total === 1 ? '' : 's'}.`, 'success');
            exitScheduleEdit(true);
            window.loadSchedules(true);
        } else if (res.success) {
            window.showToast(`Scheduled ${res.occurrences} broadcast${res.occurrences === 1 ? '' : 's'} to ${res.total} number${res.total === 1 ? '' : 's'}.`, 'success');
            window.resetScheduleForm();
            window.loadSchedules(true);
        } else {
            window.showToast(res.message || 'Could not schedule.', 'error');
        }
    } catch (e) {
        window.showToast('Network error while scheduling.', 'error');
    } finally {
        scheduleInFlight = false;
        btn.textContent = scheduleEditing ? 'Save changes' : 'Schedule';
        window.updateSchedulePreview();
    }
};

window.resetScheduleForm = function() {
    ['sched-from', 'sched-to'].forEach(id => {
        const f = document.getElementById(id);
        f.dataset.value = '';
        f.classList.add('is-empty');
        f.querySelector('.vx-field-label').textContent = f.dataset.placeholder;
    });
    document.getElementById('sched-times').innerHTML = '';
    document.getElementById('sched-dates').innerHTML = '';
    document.getElementById('sched-skip-weekends').checked = false;
    document.getElementById('sched-count').value = 5;
    scheduleWeekdays.clear();
    window.setScheduleEnd('date');
    window.setScheduleMode('daily');
    window.addScheduleTime();
};

// ── Recipients inside the schedule form ─────────────
// #numbers stays the single source of truth; this section only reads and edits it,
// so it is always in step with the side panel.
const allContacts = () => (typeof contacts !== 'undefined' && Array.isArray(contacts) ? contacts : []);
const contactGroups = () => [...new Set(allContacts().map(c => c.group).filter(Boolean))].sort();

// "All contacts", "Shop owners, Staff", or "Custom selection" for the current numbers.
const describeSelection = keys => {
    const list = allContacts();
    if (!keys.size) return { label: 'Nobody selected yet', pick: '' };
    const inContacts = list.filter(c => keys.has(normalizeNumberKey(c.phone)));
    const outside = keys.size - new Set(inContacts.map(c => normalizeNumberKey(c.phone))).size;
    const extra = outside > 0 ? ` + ${outside} typed number${outside === 1 ? '' : 's'}` : '';
    if (list.length && inContacts.length === list.length && !outside) return { label: 'All contacts', pick: '__all' };
    const full = contactGroups().filter(g => {
        const members = list.filter(c => c.group === g);
        return members.length && members.every(c => keys.has(normalizeNumberKey(c.phone)));
    });
    const covered = new Set(list.filter(c => full.includes(c.group)).map(c => normalizeNumberKey(c.phone)));
    if (full.length && inContacts.every(c => covered.has(normalizeNumberKey(c.phone)))) {
        return { label: full.join(', ') + extra, pick: full.length === 1 && !outside ? full[0] : '' };
    }
    if (!inContacts.length) return { label: 'Typed numbers', pick: '' };
    return { label: 'Custom selection' + extra, pick: '' };
};

// Raw numbers textarea: collapsed once numbers are picked from contacts, open when the
// list is empty. A manual toggle is respected until the list is emptied again.
let numbersEditorChoice = null;
const setNumbersEditor = open => {
    const ed = document.getElementById('numbers-editor');
    const btn = document.getElementById('numbers-toggle');
    if (!ed || !btn) return;
    if ((btn.getAttribute('aria-expanded') === 'true') !== open) {
        window.vxCollapse(ed, open, () => { ed.style.display = ''; }, () => { ed.style.display = 'none'; });
    } else {
        ed.style.display = open ? '' : 'none';
    }
    btn.setAttribute('aria-expanded', String(open));
};
window.toggleNumbersEditor = function() {
    const btn = document.getElementById('numbers-toggle');
    numbersEditorChoice = btn.getAttribute('aria-expanded') !== 'true';
    setNumbersEditor(numbersEditorChoice);
    if (numbersEditorChoice) document.getElementById('numbers').focus();
};

// Keeps the RECIPIENTS header (count + group pick), its summary and the schedule
// form's "Calls N numbers" line in step with #numbers.
window.renderScheduleRecipients = function() {
    const nums = getNums();
    const keys = new Set(nums.map(normalizeNumberKey));
    const { label, pick } = describeSelection(keys);
    const countText = `${nums.length} number${nums.length === 1 ? '' : 's'}`;

    const sel = document.getElementById('rcpt-group-pick');
    if (sel) {
        const groups = contactGroups();
        const sig = groups.join('\u0001') + '|' + allContacts().length;
        if (sel.dataset.sig !== sig) {
            sel.innerHTML = '';
            [['', 'Pick a group…'], ['__all', `All contacts (${allContacts().length})`]]
                .concat(groups.map(g => [g, `${g} (${allContacts().filter(c => c.group === g).length})`]))
                .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
            sel.dataset.sig = sig;
        }
        sel.value = pick;
    }
    const summary = document.getElementById('rcpt-summary');
    if (summary) summary.textContent = nums.length ? `${countText} · ${label}` : 'Pick a group, choose contacts, or type numbers';
    const ta = document.getElementById('numbers');
    if (!nums.length) numbersEditorChoice = null;
    const typing = ta && document.activeElement === ta;
    if (!typing) setNumbersEditor(numbersEditorChoice !== null ? numbersEditorChoice : nums.length === 0);

    const countEl = document.getElementById('sched-rcpt-count');
    if (countEl) {
        countEl.textContent = countText;
        document.getElementById('sched-rcpt-sub').textContent = nums.length ? label : 'Nobody selected yet. Tap Change to pick contacts.';
    }
    if (typeof window.updateSchedulePreview === 'function') window.updateSchedulePreview();
};

// Picking a group replaces the selection with that group (or everyone).
window.pickRecipientGroup = function(value) {
    if (!value) return window.renderScheduleRecipients();
    const list = value === '__all' ? allContacts() : allContacts().filter(c => c.group === value);
    updateRecipientsField(list.map(c => c.phone));
};

// "Change" in the schedule form: jump to the recipients picker and flash it.
window.goToRecipients = function() {
    const phone = window.matchMedia('(max-width: 767px)').matches;
    const block = document.getElementById('recipients-block');
    const side = document.querySelector('.broadcast-side .dir-block');
    const target = phone && side ? side : block;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    [block, side].filter(Boolean).forEach(el => {
        el.classList.add('rcpt-flash');
        setTimeout(() => el.classList.remove('rcpt-flash'), 1600);
    });
    if (!phone && side) {
        const search = document.getElementById('b-search-contacts');
        if (search) setTimeout(() => search.focus({ preventScroll: true }), 400);
    }
};

// ── Edit a schedule in the form above ───────────────
let scheduleEditing = null;      // { id, provider, savedNumbers }
let scheduleInlineEditing = false; // a single time is being edited in the list

const setPickerValue = (field, v) => {
    field.dataset.value = v || '';
    field.classList.toggle('is-empty', !v);
    if (!v) field.querySelector('.vx-field-label').textContent = field.dataset.placeholder || '';
    else window.VxPicker.setValue(field, v);
};

window.startEditSchedule = async function(groupId) {
    let data;
    try { data = await fetch(`/api/schedule/group/${encodeURIComponent(groupId)}`).then(r => r.json()); } catch (e) { data = null; }
    if (!data || !data.success) return window.showToast((data && data.message) || 'Could not load that schedule.', 'error');
    const g = data.group;
    if (!scheduleEditing) scheduleEditing = { savedNumbers: getNums() };
    scheduleEditing.id = g.id;
    scheduleEditing.provider = g.provider;

    // Message, language, voice
    const msgEl = document.getElementById('msg');
    if (msgEl && g.provider !== 'sarvam') { msgEl.value = g.message || ''; }
    if (['hi', 'en', 'gu'].includes(g.language)) window.setLang(g.language);
    const voiceEl = document.getElementById('vobiz-voice');
    if (voiceEl && g.voice) voiceEl.value = g.voice;
    // Recipients
    updateRecipientsField(g.recipients || []);

    // Rule: fall back to the stored times/dates if older groups lack a field
    const pendingRows = data.rows.filter(r => r.status === 'pending');
    const localYmd = iso => toYmd(new Date(iso));
    const localHm = iso => { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
    const times = (g.times && g.times.length ? g.times : [...new Set(pendingRows.map(r => localHm(r.run_at)))]).slice().sort();
    let mode = ['dates', 'daily', 'weekly'].includes(g.mode) ? g.mode : 'dates';
    document.getElementById('sched-dates').innerHTML = '';
    document.getElementById('sched-times').innerHTML = '';
    scheduleWeekdays.clear();
    (g.weekdays || []).forEach(d => scheduleWeekdays.add(Number(d)));
    document.getElementById('sched-skip-weekends').checked = !!g.skip_weekends;
    setPickerValue(document.getElementById('sched-from'), g.start_date || (pendingRows[0] ? localYmd(pendingRows[0].run_at) : ''));
    setPickerValue(document.getElementById('sched-to'), g.end_after ? '' : (g.end_date || ''));
    if (g.end_after) document.getElementById('sched-count').value = g.end_after;
    window.setScheduleEnd(g.end_after ? 'count' : 'date');
    if (mode === 'dates') {
        const dates = g.dates && g.dates.length ? g.dates : [...new Set(pendingRows.map(r => localYmd(r.run_at)))];
        dates.forEach(d => window.addScheduleDate(d));
    }
    window.setScheduleMode(mode);
    times.forEach(t => window.addScheduleTime(t));
    if (!times.length) window.addScheduleTime();

    // Form chrome
    document.getElementById('sched-title').textContent = 'Edit schedule';
    const banner = document.getElementById('sched-edit-banner');
    banner.style.display = '';
    document.getElementById('sched-edit-text').textContent =
        `Editing "${describeScheduleGroup(g, data.rows)}". Saving changes only the times that have not run yet; past and cancelled times stay as history.` +
        (g.mode === 'custom' ? ' Some times were changed one by one; saving here sets every date below to every time below.' : '');
    document.getElementById('schedule-btn').textContent = 'Save changes';
    document.getElementById('sched-discard-btn').style.display = '';
    window.updateSchedulePreview();
    document.getElementById('sched-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Leaves edit mode; puts back the numbers that were selected before editing.
const exitScheduleEdit = () => {
    const saved = scheduleEditing ? scheduleEditing.savedNumbers : null;
    scheduleEditing = null;
    document.getElementById('sched-title').textContent = 'Or schedule for later';
    document.getElementById('sched-edit-banner').style.display = 'none';
    document.getElementById('sched-discard-btn').style.display = 'none';
    document.getElementById('schedule-btn').textContent = 'Schedule';
    window.resetScheduleForm();
    if (saved) updateRecipientsField(saved);
};
window.discardScheduleEdit = () => exitScheduleEdit();

// Inline editor for one pending time inside a card.
const editOneTime = (row, r, lineEl, leftEl, rightEl) => {
    scheduleInlineEditing = true;
    const d = new Date(r.run_at);
    const dateF = window.VxPicker.makeField('date', { value: toYmd(d), placeholder: 'Date' });
    const timeF = window.VxPicker.makeField('time', { value: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, placeholder: 'Time' });
    const cols = document.createElement('div');
    cols.className = 'sched-cols';
    [dateF, timeF].forEach(f => { const c = document.createElement('div'); c.className = 'sched-col'; c.appendChild(f); cols.appendChild(c); });
    leftEl.innerHTML = '';
    leftEl.style.flex = '1';
    leftEl.appendChild(cols);
    rightEl.innerHTML = '';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'vx-pop-btn is-primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'vx-pop-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { scheduleInlineEditing = false; window.loadSchedules(true); };
    save.onclick = async () => {
        if (!dateF.dataset.value || !timeF.dataset.value) return window.showToast('Pick a date and a time.', 'error');
        save.disabled = true;
        const runAt = new Date(`${dateF.dataset.value}T${timeF.dataset.value}`).toISOString();
        const res = await fetch(`/api/schedule/${r.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runAt })
        }).then(x => x.json()).catch(() => ({ success: false }));
        save.disabled = false;
        if (!res.success) return window.showToast(res.message || 'Could not change that time.', 'error');
        window.showToast('Time changed.', 'success');
        scheduleInlineEditing = false;
        window.loadSchedules(true);
    };
    rightEl.append(save, cancel);
};

// "Daily · 10:30 AM, 5:30 PM" style title from a stored schedule's settings.
const describeScheduleGroup = (g, entries) => {
    const times = g && g.times && g.times.length
        ? g.times.map(fmtTimeHM)
        : [...new Set(entries.map(r => new Date(r.run_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })))];
    let label = entries.length === 1 ? 'One-time' : 'Scheduled';
    if (g && g.mode === 'daily') label = g.skip_weekends ? 'Weekdays' : 'Daily';
    else if (g && g.mode === 'weekly') label = 'Weekly · ' + WEEKDAY_ORDER.filter(d => (g.weekdays || []).includes(d)).map(d => weekdayName(d)).join(', ');
    else if (g && g.mode === 'dates') label = 'Specific dates';
    else if (g && g.mode === 'custom') label = 'Custom times';
    const shown = times.length > 3 ? times.slice(0, 3).concat(`+${times.length - 3} more`) : times;
    return `${label} · ${shown.join(', ')}`;
};

// "Oct 7 – Oct 10, 2026" (or a single date) for the first and last run.
const scheduleDateRange = entries => {
    const a = new Date(entries[0].run_at), b = new Date(entries[entries.length - 1].run_at);
    const full = { month: 'short', day: 'numeric', year: 'numeric' };
    if (a.toDateString() === b.toDateString()) return a.toLocaleDateString([], { weekday: 'short', ...full });
    const sameYear = a.getFullYear() === b.getFullYear();
    return `${a.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : full)} – ${b.toLocaleDateString([], full)}`;
};

const SCHED_STATUS = {
    pending: ['Scheduled', 'badge-muted'], starting: ['Starting', 'badge-success'], started: ['Running', 'badge-success'],
    completed: ['Completed', 'badge-success'], cancelled: ['Cancelled', 'badge-muted'], missed: ['Missed', 'badge-danger'],
    failed: ['Failed', 'badge-danger'], interrupted: ['Interrupted', 'badge-danger']
};
const makeBadge = (label, cls) => {
    const b = document.createElement('span');
    b.className = 'badge ' + (cls || '');
    b.textContent = label;
    return b;
};
const groupStatus = (entries, pending) => {
    if (entries.some(r => r.status === 'started' || r.status === 'starting')) return ['Running', 'badge-success'];
    if (pending.length) return ['Active', 'badge-success'];
    if (entries.every(r => r.status === 'cancelled')) return ['Cancelled', 'badge-muted'];
    if (entries.some(r => ['failed', 'missed', 'interrupted'].includes(r.status))) return ['Finished with issues', 'badge-danger'];
    return ['Finished', 'badge-muted'];
};
const expandedSchedules = new Set(); // keeps "Show each time" open across the 30 s refresh
const expandedNumbers = new Set();   // same for "View numbers"

window.cancelSchedule = async function(target, label) {
    const confirmed = await window.showConfirm(label || 'Cancel this scheduled call?');
    if (!confirmed) return;
    const res = await fetch('/api/schedule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target)
    }).then(r => r.json()).catch(() => ({ success: false }));
    if (!res.success) window.showToast(res.message || 'Could not cancel.', 'error');
    window.loadSchedules();
};

window.loadSchedules = async function(force) {
    if (scheduleInlineEditing && force !== true) return; // don't wipe a time that is being edited
    if (force === true) scheduleInlineEditing = false;
    const wrap = document.getElementById('sched-wrap');
    const list = document.getElementById('sched-list');
    if (!wrap || !list) return;
    let rows = [];
    try { rows = await fetch('/api/schedule').then(r => r.json()); } catch (e) { return; }
    if (!Array.isArray(rows) || rows.length === 0) { wrap.style.display = 'none'; return; }

    // Group entries that were scheduled together; groups with pending runs come first.
    const groups = new Map();
    rows.forEach(r => {
        if (!groups.has(r.group_id)) groups.set(r.group_id, []);
        groups.get(r.group_id).push(r);
    });
    const ordered = [...groups.entries()].sort(([, a], [, b]) => {
        const nextA = a.find(r => r.status === 'pending'), nextB = b.find(r => r.status === 'pending');
        if (!!nextA !== !!nextB) return nextA ? -1 : 1;
        if (nextA) return nextA.run_at.localeCompare(nextB.run_at);
        return b[b.length - 1].run_at.localeCompare(a[a.length - 1].run_at);
    }).slice(0, 30);

    const fmtShort = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    // The card header already shows the year; rows only add it when a schedule spans two years.
    const fmtRow = (iso, withYear) => {
        const d = new Date(iso);
        const opts = { weekday: 'short', month: 'short', day: 'numeric' };
        if (withYear) opts.year = 'numeric';
        return `${d.toLocaleDateString([], opts)} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    };
    const fmtFull = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const activeCount = ordered.filter(([, e]) => e.some(r => r.status === 'pending')).length;
    const countBadge = document.getElementById('sched-count-badge');
    if (countBadge) countBadge.textContent = `${activeCount} active`;
    wrap.style.display = 'block';
    list.innerHTML = '';

    ordered.forEach(([groupId, entries]) => {
        const first = entries[0];
        const pending = entries.filter(r => r.status === 'pending');
        const card = document.createElement('div');
        card.className = 'hist-card sched-card';

        // Header: rule title + date range, overall status on the right
        const hd = document.createElement('div');
        hd.className = 'hist-card-hd';
        const titleBox = document.createElement('div');
        titleBox.style.minWidth = '0';
        const title = document.createElement('div');
        title.className = 'sched-card-title';
        title.textContent = describeScheduleGroup(first.group, entries);
        const range = document.createElement('div');
        range.className = 'hist-card-time';
        range.textContent = scheduleDateRange(entries);
        titleBox.append(title, range);
        hd.append(titleBox, makeBadge(...groupStatus(entries, pending)));
        card.appendChild(hd);

        // Meta: numbers · provider · left · next
        const stats = document.createElement('div');
        stats.className = 'hist-card-stats';
        const stat = (value, label) => {
            const it = document.createElement('span');
            it.className = 'hist-stat-item';
            if (value !== null) {
                const v = document.createElement('span');
                v.className = 'hist-stat-val';
                v.textContent = value;
                it.appendChild(v);
            }
            if (label) it.append(label);
            return it;
        };
        stats.append(
            stat(String(first.total), first.total === 1 ? 'number' : 'numbers'),
            stat(null, PROVIDER_LABELS[first.provider] || first.provider)
        );
        if (entries.length > 1) stats.append(stat(`${pending.length}/${entries.length}`, 'left'));
        if (pending.length) {
            const next = stat(null, 'Next ');
            const v = document.createElement('span');
            v.className = 'hist-stat-val';
            v.textContent = fmtShort(pending[0].run_at);
            next.appendChild(v);
            stats.append(next);
        }
        card.appendChild(stats);

        const text = first.provider !== 'sarvam' && first.message && first.message !== '(Sarvam agent greeting)' ? first.message : "Agent's own greeting";
        const msg = document.createElement('div');
        msg.className = 'row-sub';
        msg.style.cssText = 'margin-top:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        msg.textContent = text;
        msg.title = text;
        card.appendChild(msg);

        // Actions: "Show each time" on the left, "Cancel all" on the right
        const actions = document.createElement('div');
        actions.className = 'hist-card-actions';
        const spansYears = new Date(first.run_at).getFullYear() !== new Date(entries[entries.length - 1].run_at).getFullYear();
        const det = window.VxDisclosure(`Show each time (${entries.length})`, box => {
            box.className += ' sched-times-list';
            entries.forEach(r => {
                const line = document.createElement('div');
                line.className = 'row-item';
                const left = document.createElement('div');
                const when = document.createElement('div');
                when.className = 'row-label';
                when.textContent = fmtRow(r.run_at, spansYears);
                left.appendChild(when);
                const [smLabel, smCls] = SCHED_STATUS[r.status] || [r.status, 'badge-muted'];
                const sm = makeBadge(smLabel, smCls);
                sm.classList.add('sched-time-badge-sm');
                left.appendChild(sm);
                if (r.note) {
                    const note = document.createElement('div');
                    note.className = 'row-sub';
                    note.textContent = r.note;
                    left.appendChild(note);
                }
                const right = document.createElement('div');
                right.className = 'sched-time-right';
                const [label, cls] = SCHED_STATUS[r.status] || [r.status, 'badge-muted'];
                right.appendChild(makeBadge(label, cls));
                if (r.status === 'pending') {
                    const ed = document.createElement('button');
                    ed.type = 'button';
                    ed.className = 'vx-pop-btn';
                    ed.textContent = 'Edit';
                    ed.setAttribute('aria-label', `Change the ${fmtFull(r.run_at)} time`);
                    ed.onclick = () => editOneTime(groupId, r, line, left, right);
                    right.appendChild(ed);
                    const x = document.createElement('button');
                    x.type = 'button';
                    x.className = 'vx-pop-btn';
                    x.textContent = 'Cancel';
                    x.setAttribute('aria-label', `Cancel the ${fmtFull(r.run_at)} broadcast`);
                    x.onclick = () => window.cancelSchedule({ id: r.id }, `Cancel the ${fmtFull(r.run_at)} broadcast?`);
                    right.appendChild(x);
                } else if (pending.length) {
                    // Invisible stand-ins keep the status badges in one column.
                    ['Edit', 'Cancel'].forEach(t => {
                        const ghost = document.createElement('span');
                        ghost.className = 'vx-pop-btn';
                        ghost.textContent = t;
                        ghost.style.visibility = 'hidden';
                        ghost.setAttribute('aria-hidden', 'true');
                        right.appendChild(ghost);
                    });
                }
                line.append(left, right);
                box.appendChild(line);
            });
        });
        const detBtn = det.querySelector('.vx-disclosure-btn');
        const detBody = det.querySelector('.vx-disclosure-body');
        detBtn.addEventListener('click', () => {
            if (detBtn.getAttribute('aria-expanded') === 'true') expandedSchedules.add(groupId);
            else expandedSchedules.delete(groupId);
        });
        // "View numbers": who this schedule calls (loaded on first open)
        const nums = window.VxDisclosure(`View numbers (${first.total})`, async box => {
            box.className += ' sched-times-list';
            box.style.cssText = 'max-height:320px; overflow-y:auto; overscroll-behavior:contain;';
            box.innerHTML = '<div class="row-item"><div class="row-sub">Loading…</div></div>';
            const data = await fetch(`/api/schedule/group/${encodeURIComponent(groupId)}`).then(x => x.json()).catch(() => null);
            box.innerHTML = '';
            const byKey = new Map(allContacts().map(c => [normalizeNumberKey(c.phone), c]));
            ((data && data.group && data.group.recipients) || []).forEach(phone => {
                const c = byKey.get(normalizeNumberKey(phone));
                const line = document.createElement('div');
                line.className = 'row-item';
                const left = document.createElement('div');
                left.style.minWidth = '0';
                const name = document.createElement('div');
                name.className = 'row-label';
                name.textContent = c && c.name ? c.name : 'Not in contacts';
                const ph = document.createElement('div');
                ph.className = 'row-sub mono';
                ph.textContent = phone;
                left.append(name, ph);
                line.appendChild(left);
                if (c && c.group) line.appendChild(makeBadge(c.group, 'badge-muted'));
                box.appendChild(line);
            });
            if (!box.children.length) box.innerHTML = '<div class="row-item"><div class="row-sub">No numbers stored.</div></div>';
        });
        const numsBtn = nums.querySelector('.vx-disclosure-btn');
        const numsBody = nums.querySelector('.vx-disclosure-body');
        numsBtn.addEventListener('click', () => {
            if (numsBtn.getAttribute('aria-expanded') === 'true') expandedNumbers.add(groupId);
            else expandedNumbers.delete(groupId);
        });
        const leftActs = document.createElement('div');
        leftActs.style.cssText = 'display:flex; gap:4px 16px; flex-wrap:wrap; align-items:center;';
        leftActs.append(det, nums);
        actions.appendChild(leftActs);
        const rightActs = document.createElement('div');
        rightActs.style.cssText = 'display:flex; gap:8px; align-items:center; margin-left:auto;';
        if (pending.length) {
            const eb = document.createElement('button');
            eb.type = 'button';
            eb.className = 'vx-pop-btn';
            eb.textContent = 'Edit';
            eb.setAttribute('aria-label', 'Edit this schedule');
            eb.onclick = () => window.startEditSchedule(groupId);
            rightActs.appendChild(eb);
        }
        actions.appendChild(rightActs);
        if (pending.length) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'vx-pop-btn sched-cancel-all';
            btn.textContent = pending.length === 1 ? 'Cancel' : 'Cancel all';
            btn.onclick = () => window.cancelSchedule({ group: groupId },
                pending.length === 1 ? 'Cancel this scheduled call?' : `Cancel all ${pending.length} remaining broadcasts in this schedule?`);
            rightActs.appendChild(btn);
        }
        card.appendChild(actions);
        // The per-time and numbers lists span the whole card width, below the actions row.
        card.appendChild(detBody);
        card.appendChild(numsBody);
        if (expandedSchedules.has(groupId)) detBtn.click();
        if (expandedNumbers.has(groupId)) numsBtn.click();
        list.appendChild(card);
    });
};

window.renderBroadcastContacts = function() {
    const filterGroup = document.getElementById('b-filter-group');
    const searchQ = document.getElementById('b-search-contacts');
    const tbody = document.getElementById('b-contacts-tbody');
    if (!filterGroup || !searchQ || !tbody || typeof contacts === 'undefined') return;

    const groups = new Set(contacts.map(c => c.group).filter(Boolean));
    const currentVal = filterGroup.value;
    filterGroup.innerHTML = '<option value="">All Groups</option>';
    Array.from(groups).sort().forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        filterGroup.appendChild(opt);
    });
    if (groups.has(currentVal)) filterGroup.value = currentVal;

    const fv = filterGroup.value;
    const sq = searchQ.value.toLowerCase();
    
    const filtered = contacts.filter(c => {
        if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });
    
    const countEl = document.getElementById('b-contacts-count');
    if (countEl) countEl.textContent = `${contacts.length} total`;
    
    const bCheckAll = document.getElementById('b-check-all');
    const pickedKeys = new Set(getNums().map(normalizeNumberKey));
    const pickedCount = filtered.filter(c => pickedKeys.has(normalizeNumberKey(c.phone))).length;
    bCheckAll.checked = filtered.length > 0 && pickedCount === filtered.length;
    bCheckAll.indeterminate = pickedCount > 0 && pickedCount < filtered.length;
    
    const numsEl = document.getElementById('numbers');
    const existingStats = numsEl ? buildUniqueNumberList(numsEl.value.split('\n')) : { unique: [] };
    const existingArr = existingStats.unique;
    const existingKeys = new Set(existingArr.map(normalizeNumberKey));
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty">No contacts found.</td></tr>';
        return;
    }
    
    const visible = filtered.slice(0, broadcastVisibleLimit);
    
    tbody.innerHTML = visible.map((c, i) => {
        const isChecked = existingKeys.has(normalizeNumberKey(c.phone));
        return `
        <tr class="b-row">
            <td style="padding: 8px;" class="b-check"><input type="checkbox" class="checkbox b-checkbox" ${isChecked ? 'checked' : ''} onchange="toggleBroadcastContact('${c.phone}', this.checked)" /></td>
            <td style="padding: 8px;" class="b-num"><div class="mono" style="color:var(--text3); font-size: 0.65rem;">${i + 1}</div></td>
            <td style="padding: 8px;" class="b-main">
                <div style="font-weight:500;color:var(--text);font-size:0.8rem;">${c.name || '—'}</div>
                <div class="mono" style="color:var(--text2);font-size:0.7rem;margin-top:2px;">${c.phone}</div>
            </td>
        </tr>
    `}).join('');

    if (filtered.length > broadcastVisibleLimit) {
        const moreRow = document.createElement('tr');
        moreRow.innerHTML = `<td colspan="3" style="text-align:center; padding: 15px; color: var(--text3); font-size: 0.7rem;">
            Showing ${broadcastVisibleLimit} of ${filtered.length}. Scroll to see more.
        </td>`;
        tbody.appendChild(moreRow);
    }
};

window.toggleBroadcastContact = function(phone, isChecked) {
    const numsEl = document.getElementById('numbers');
    if (!numsEl) return;
    let lines = numsEl.value ? numsEl.value.split('\n') : [];

    if (isChecked) {
        lines.push(phone);
    } else {
        const targetKey = normalizeNumberKey(phone);
        lines = lines.filter(n => normalizeNumberKey(n) !== targetKey);
    }

    updateRecipientsField(lines);
};

window.clearNumbers = function() {
    const numsEl = document.getElementById('numbers');
    if (numsEl) {
        updateRecipientsField([]);
    }
};

window.toggleBroadcastSelectAll = function(isChecked) {
    const numsEl = document.getElementById('numbers');
    if (!numsEl) return;
    let updatedArr = numsEl.value ? numsEl.value.split('\n') : [];
    
    const filterGroup = document.getElementById('b-filter-group');
    const searchQ = document.getElementById('b-search-contacts');
    
    const fv = filterGroup ? filterGroup.value : '';
    const sq = searchQ ? searchQ.value.toLowerCase() : '';
    
    const filtered = (typeof contacts !== 'undefined' ? contacts : []).filter(c => {
        if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });

    if (isChecked) {
        updatedArr = updatedArr.concat(filtered.map(c => c.phone));
    } else {
        const removalKeys = new Set(filtered.map(c => normalizeNumberKey(c.phone)));
        updatedArr = updatedArr.filter(n => !removalKeys.has(normalizeNumberKey(n)));
    }

    updateRecipientsField(updatedArr);
    
    document.querySelectorAll('.b-checkbox').forEach(cb => {
        cb.checked = isChecked;
    });
};

document.addEventListener('DOMContentLoaded', () => {
    const msgEl = document.getElementById('msg');
    const numsEl = document.getElementById('numbers');
    
    if(msgEl) msgEl.addEventListener('input', window.preview);
    if(numsEl) {
        numsEl.addEventListener('input', function(e) {
            // Remove any character that is not a digit, plus sign, space, tab, or newline
            const cleanVal = this.value.replace(/[^0-9+\s\n\r]/g, '');
            if (this.value !== cleanVal) {
                this.value = cleanVal;
            }
            updateRecipientsField(this.value.split('\n'), { preserveTrailingNewline: /\n$/.test(cleanVal) });
        });
    }

    // Scroll to load more in sidebar
    const broadcastSidebarWrap = document.querySelector('.broadcast-side .table-wrap');
    if (broadcastSidebarWrap) {
        broadcastSidebarWrap.addEventListener('scroll', () => {
            if (broadcastSidebarWrap.scrollTop + broadcastSidebarWrap.clientHeight >= broadcastSidebarWrap.scrollHeight - 50) {
                const searchQ = document.getElementById('b-search-contacts');
                const filterGroup = document.getElementById('b-filter-group');
                const fv = filterGroup ? filterGroup.value : '';
                const sq = searchQ ? searchQ.value.toLowerCase() : '';
                
                const filtered = (typeof contacts !== 'undefined' ? contacts : []).filter(c => {
                    if (fv && c.group !== fv) return false;
                    if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
                    return true;
                });

                if (broadcastVisibleLimit < filtered.length) {
                    broadcastVisibleLimit += 100;
                    window.renderBroadcastContacts();
                }
            }
        });
    }

    // Reset limit on input
    const bSearch = document.getElementById('b-search-contacts');
    const bFilter = document.getElementById('b-filter-group');
    if (bSearch) bSearch.addEventListener('input', () => { broadcastVisibleLimit = 100; });
    if (bFilter) bFilter.addEventListener('change', () => { broadcastVisibleLimit = 100; });
    
    window.checkActiveBroadcast();
    window.resetScheduleForm();
    window.loadSchedules();
    setInterval(window.loadSchedules, 30000);
});

// Contacts loading or changing also refreshes the schedule form's recipients row.
(() => {
    const renderSidePanel = window.renderBroadcastContacts;
    window.renderBroadcastContacts = function() {
        renderSidePanel.apply(this, arguments);
        if (typeof window.renderScheduleRecipients === 'function') window.renderScheduleRecipients();
    };
})();

// Typing numbers by hand keeps the editor open.
document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('numbers');
    if (ta) ta.addEventListener('input', () => { numbersEditorChoice = true; });
});

// Tapping anywhere on a contact row in the picker ticks its box (a bigger target on phones).
document.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('#b-contacts-tbody .b-row');
    if (!row || e.target.closest('input, button, a, label')) return;
    const cb = row.querySelector('.b-checkbox');
    if (!cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
});
