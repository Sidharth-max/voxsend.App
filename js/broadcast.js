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

const SARVAM_PLACEHOLDER = "Optional — leave empty to use the Sarvam agent's own greeting";

window.applyProviderUI = function(provider) {
    window.currentProvider = provider || 'twilio';
    const sarvam = isSarvam();
    const note = document.getElementById('sarvam-mode-note');
    if (note) note.style.display = sarvam ? 'block' : 'none';
    const label = document.getElementById('msg-label');
    if (label) label.textContent = sarvam ? 'Message override (optional)' : 'Voice message text';
    const vWrap = document.getElementById('vobiz-voice-wrap');
    if (vWrap) vWrap.style.display = window.currentProvider === 'vobiz' ? 'block' : 'none';

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
    const msg = msgEl.value.trim();
    
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
    const msg = document.getElementById('msg').value.trim();
    const c = await window.getCfg();

    // Clear previous logs
    const logEl = document.getElementById('log');
    if (logEl) logEl.innerHTML = '';
    
    const provider = c.provider || 'twilio';
    
    if (provider === 'vobiz') {
        if (!c.vobiz_id || !c.vobiz_token || !c.vobiz_from) {
            window.addLog('err', 'Missing Vobiz credentials! Check API tab.');
            return;
        }
        if (!c.public_url) {
            window.addLog('err', 'Missing Public URL! Required for Vobiz callbacks.');
            return;
        }
    } else if (provider === 'sarvam') {
        if (!c.sarvam_key || !c.sarvam_org || !c.sarvam_workspace || !c.sarvam_app_id ||
            !c.sarvam_app_version || !c.sarvam_connection_id || !c.sarvam_from) {
            window.addLog('err', 'Missing Sarvam settings! Check API tab.');
            return;
        }
    } else {
        if (!c.sid || !c.token || !c.from) {
            window.addLog('err', 'Missing Twilio credentials! Check API tab.');
            return;
        }
    }

    const voiceEl = document.getElementById('vobiz-voice');
    const selectedVoice = voiceEl ? voiceEl.value : (lang === 'hi' ? 'Polly.Aditi' : 'Polly.Joanna');

    const payload = {
        nums,
        msg,
        credentials: c,
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
// Builds every run time from the date range × the times of day, in the browser's time zone.
const buildScheduleTimes = () => {
    const from = document.getElementById('sched-from').dataset.value;
    const to = document.getElementById('sched-to').dataset.value || from;
    const times = [...document.querySelectorAll('#sched-times .vx-field')].map(f => f.dataset.value).filter(Boolean);
    if (!from || !times.length) return { runs: [], error: 'Pick a date and at least one time.' };
    if (to < from) return { runs: [], error: '"To" date is before "From" date.' };

    const runs = [];
    const day = new Date(from + 'T00:00');
    const last = new Date(to + 'T00:00');
    while (day <= last && runs.length <= MAX_SCHEDULE) {
        const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        [...new Set(times)].sort().forEach(t => runs.push(new Date(`${ymd}T${t}`)));
        day.setDate(day.getDate() + 1);
    }
    if (runs.length > MAX_SCHEDULE) return { runs: [], error: `That is more than ${MAX_SCHEDULE} broadcasts. Shorten the range or remove a time.` };
    const past = runs.filter(r => r.getTime() < Date.now()).length;
    if (past === runs.length) return { runs: [], error: 'All of those times are in the past.' };
    return { runs: runs.filter(r => r.getTime() >= Date.now()), skippedPast: past };
};
const MAX_SCHEDULE = 200;

window.addScheduleTime = function(value = '') {
    const wrap = document.getElementById('sched-times');
    const row = document.createElement('div');
    row.className = 'vx-time-row';
    const field = window.VxPicker.makeField('time', { value, placeholder: 'Pick a time' });
    field.addEventListener('input', window.updateSchedulePreview);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'vx-icon-btn';
    remove.setAttribute('aria-label', 'Remove this time');
    remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    remove.onclick = () => { row.remove(); window.updateSchedulePreview(); };
    row.append(field, remove);
    wrap.appendChild(row);
    window.updateSchedulePreview();
};

window.updateSchedulePreview = function() {
    const fromF = document.getElementById('sched-from');
    const toF = document.getElementById('sched-to');
    if (fromF && toF) toF.dataset.min = fromF.dataset.value || '';
    const el = document.getElementById('sched-preview');
    const btn = document.getElementById('schedule-btn');
    if (!el) return;
    const { runs, error, skippedPast } = buildScheduleTimes();
    if (error) { el.textContent = error; btn.disabled = true; return; }
    const fmt = d => d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    let text = `${runs.length} broadcast${runs.length === 1 ? '' : 's'}`;
    text += runs.length === 1 ? ` on ${fmt(runs[0])}.` : `, from ${fmt(runs[0])} to ${fmt(runs[runs.length - 1])}.`;
    if (skippedPast) text += ` ${skippedPast} time${skippedPast === 1 ? ' is' : 's are'} already past and will be skipped.`;
    el.textContent = text;
    btn.disabled = false;
};

window.scheduleBlast = async function() {
    const nums = getNums();
    const msg = document.getElementById('msg').value.trim();
    if (!msg && !isSarvam()) return window.showToast('Write a message first.', 'error');
    if (nums.length === 0) return window.showToast('Add at least one recipient.', 'error');
    const { runs, error } = buildScheduleTimes();
    if (error) return window.showToast(error, 'error');

    const c = await window.getCfg();
    const voiceEl = document.getElementById('vobiz-voice');
    const btn = document.getElementById('schedule-btn');
    btn.disabled = true;
    try {
        const res = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nums, msg, lang,
                voice: voiceEl ? voiceEl.value : null,
                provider: c.provider || 'twilio',
                runAts: runs.map(r => r.toISOString()),
                sentBy: window.currentUser ? window.currentUser.username : 'Unknown'
            })
        }).then(r => r.json());
        if (res.success) {
            window.showToast(`Scheduled ${res.occurrences} broadcast${res.occurrences === 1 ? '' : 's'} to ${res.total} number${res.total === 1 ? '' : 's'}.`, 'success');
            window.resetScheduleForm();
            window.loadSchedules();
        } else {
            window.showToast(res.message || 'Could not schedule.', 'error');
        }
    } catch (e) {
        window.showToast('Network error while scheduling.', 'error');
    } finally {
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
    window.addScheduleTime();
};

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

window.loadSchedules = async function() {
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

    const labels = { pending: 'Scheduled', started: 'Sent', missed: 'Missed', failed: 'Failed', cancelled: 'Cancelled' };
    const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    wrap.style.display = 'block';
    list.innerHTML = '';

    ordered.forEach(([groupId, entries]) => {
        const first = entries[0];
        const pending = entries.filter(r => r.status === 'pending');
        const card = document.createElement('div');
        card.className = 'row-item';
        card.style.cssText = 'display:block;';

        const top = document.createElement('div');
        top.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;';
        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'row-label';
        const span = entries.length === 1 ? fmt(first.run_at)
            : `${entries.length} broadcasts · ${fmt(first.run_at)} → ${fmt(entries[entries.length - 1].run_at)}`;
        title.textContent = `${span} · ${first.total} number${first.total === 1 ? '' : 's'} · ${PROVIDER_LABELS[first.provider] || first.provider}`;
        const sub = document.createElement('div');
        sub.className = 'hint';
        const text = first.message || "Sarvam agent's own greeting";
        const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
        const state = entries.length === 1
            ? `${labels[first.status] || first.status}${first.note ? ' — ' + first.note : ''}`
            : (pending.length ? `${pending.length} left · next ${fmt(pending[0].run_at)}` : 'Finished');
        sub.textContent = `${state} · ${preview}`;
        info.append(title, sub);
        top.appendChild(info);

        if (pending.length) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-danger btn-sm';
            btn.style.cssText = 'width:auto; padding:4px 10px;';
            btn.textContent = entries.length === 1 ? 'Cancel' : 'Cancel all';
            btn.onclick = () => window.cancelSchedule({ group: groupId },
                pending.length === 1 ? 'Cancel this scheduled call?' : `Cancel all ${pending.length} remaining broadcasts in this schedule?`);
            top.appendChild(btn);
        }
        card.appendChild(top);

        if (entries.length > 1) {
            const det = window.VxDisclosure('Show each time', box => {
            entries.forEach(r => {
                const line = document.createElement('div');
                line.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:6px;';
                const t = document.createElement('span');
                t.className = 'hint';
                t.textContent = `${fmt(r.run_at)} — ${labels[r.status] || r.status}${r.note ? ' (' + r.note + ')' : ''}`;
                line.appendChild(t);
                if (r.status === 'pending') {
                    const x = document.createElement('button');
                    x.className = 'btn btn-secondary btn-sm';
                    x.style.cssText = 'width:auto; margin:0; padding:2px 8px;';
                    x.textContent = 'Cancel';
                    x.onclick = () => window.cancelSchedule({ id: r.id }, `Cancel the ${fmt(r.run_at)} broadcast?`);
                    line.appendChild(x);
                }
                box.appendChild(line);
            });
            });
            card.appendChild(det);
        }
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
    
    document.getElementById('b-check-all').checked = filtered.length > 0 && filtered.every(c => {
        return new Set(getNums().map(normalizeNumberKey)).has(normalizeNumberKey(c.phone));
    });
    
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
