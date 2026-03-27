let lang = 'hi';
window.lastNumStats = { total: 0, unique: 0, duplicatesRemoved: 0 };

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

window.setLang = function(l) {
    lang = l;
    document.getElementById('pill-hi').classList.toggle('active', l === 'hi');
    document.getElementById('pill-en').classList.toggle('active', l === 'en');
    
    const msgEl = document.getElementById('msg');
    if (msgEl) {
        if (l === 'hi') {
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
        prevMsgEl.textContent = msg || 'Message will appear here...';
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

    const costStrip = document.getElementById('cost-strip');
    if (costStrip) {
        if (nums.length > 0) {
            costStrip.style.display = 'flex';
            const csN = document.getElementById('cs-n');
            const csCost = document.getElementById('cs-cost');
            if (csN) csN.textContent = nums.length;
            if (csCost) {
                const cost = (nums.length * 0.70).toFixed(2);
                csCost.textContent = '₹' + cost;
            }
        } else {
            costStrip.style.display = 'none';
        }
    }

    const maxChars = lang === 'en' ? 1200 : 800;
    const isOver = msg.length > maxChars;
    const btn = document.getElementById('send-btn');
    const overEl = document.getElementById('over-limit');
    
    if (isOver) {
        if (overEl) overEl.style.display = 'block';
        if (btn) btn.disabled = true;
    } else {
        if (overEl) overEl.style.display = 'none';
        if (btn) btn.disabled = !msg || nums.length === 0;
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
    const isVobiz = c.provider === 'vobiz';
    const vWrap = document.getElementById('vobiz-voice-wrap');
    if (vWrap) vWrap.style.display = isVobiz ? 'block' : 'none';

    fetch('/api/broadcast/status').then(res => res.json()).then(status => {
        if (status.active) {
            window.startPolling();
            document.getElementById('msg').value = status.msg;
            window.preview();
            window.addLog('info', `Reconnected to active background ${status.provider} broadcast.`);
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
                    const logId = log.time + '|' + log.text;
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
             window.addLog('info', `Broadcast initiated via ${provider === 'vobiz' ? 'Vobiz.ai' : 'Twilio'}. You can safely close this page.`);
            window.startPolling();
        } else {
            window.addLog('err', 'Error: ' + res.message);
        }
    }).catch(err => {
        window.addLog('err', 'Network error starting broadcast.');
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
    
    const numsEl = document.getElementById('numbers');
    const existingStats = numsEl ? buildUniqueNumberList(numsEl.value.split('\n')) : { unique: [] };
    const existingArr = existingStats.unique;
    const existingKeys = new Set(existingArr.map(normalizeNumberKey));
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty">No contacts found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map((c, i) => {
        const isChecked = existingKeys.has(normalizeNumberKey(c.phone));
        return `
        <tr>
            <td style="padding: 8px;"><input type="checkbox" class="checkbox b-checkbox" ${isChecked ? 'checked' : ''} onchange="toggleBroadcastContact('${c.phone}', this.checked)" /></td>
            <td style="padding: 8px;"><div class="mono" style="color:var(--text3); font-size: 0.7rem;">${i + 1}</div></td>
            <td style="padding: 8px;">
                <div style="font-weight:500;color:var(--text);font-size:0.85rem">${c.name || '—'}</div>
                <div class="mono" style="color:var(--text2);font-size:0.75rem">${c.phone}</div>
            </td>
        </tr>
    `}).join('');
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
    
    window.checkActiveBroadcast();
});
