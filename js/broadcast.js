let lang = 'hi';

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
    const raw = document.getElementById('numbers').value;
    return raw.split('\n')
        .map(n => n.trim().replace(/\s+/g, ''))
        .filter(n => n.length > 5);
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
    if (numCountEl) numCountEl.textContent = nums.length + ' numbers';
    
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

window.blast = async function() {
    window.addLog('info', 'Starting broadcast sequence...');
    const btn = document.getElementById('send-btn');
    btn.disabled = true;
    document.getElementById('prog-wrap').classList.add('show');
    
    const nums = getNums();
    const msg = document.getElementById('msg').value.trim();
    const c = await window.getCfg();

    if (!c.sid || !c.token || !c.from) {
        window.addLog('err', 'Missing Twilio credentials! Check Settings.');
        btn.disabled = false;
        return;
    }

    const ttsUrl = `http://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(msg)}`;

    let ok = 0, fail = 0;
    
    for (let i = 0; i < nums.length; i++) {
        let n = nums[i];
        if (!n.startsWith('+')) n = '+' + n;
        
        try {
            const fd = new URLSearchParams();
            fd.append('To', n);
            fd.append('From', c.from);
            fd.append('Url', ttsUrl);

            const auth = btoa(c.sid + ':' + c.token);

            const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Calls.json`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: fd
            });
            
            const rjson = await res.json();
            
            if (res.ok) {
                ok++;
                window.addLog('ok', `Call queued to ${n} (SID: ${rjson.sid.substr(0,8)}...)`);
            } else {
                fail++;
                window.addLog('err', `Failed ${n}: ${rjson.message}`);
                if (rjson.code === 21212 || rjson.code === 20003) {
                    window.addLog('err', 'CRITICAL ERROR: Twilio configuration invalid or unverified number.');
                    break;
                }
            }
        } catch (err) {
            fail++;
            window.addLog('err', `Network error to ${n}`);
        }

        const pct = Math.round(((i + 1) / nums.length) * 100);
        document.getElementById('prog-fill').style.width = pct + '%';
        document.getElementById('prog-lbl').textContent = `${i + 1} / ${nums.length}`;
        
        await new Promise(r => setTimeout(r, 600));
    }

    window.addLog('info', `Broadcast complete. Success: ${ok}, Failed: ${fail}`);
    btn.disabled = false;
    
    if (window.saveHistoryEntry) {
        window.saveHistoryEntry({
            date: new Date().toISOString(),
            message: msg,
            total: nums.length,
            successful: ok,
            failed: fail,
            recipients: nums.join('\n'),
            sentBy: window.currentUser ? window.currentUser.username : 'Unknown'
        });
    }
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
    const existingArr = numsEl ? (numsEl.value.trim() ? numsEl.value.trim().split('\n').map(n => n.trim()).filter(Boolean) : []) : [];
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty">No contacts found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map((c, i) => {
        const isChecked = existingArr.includes(c.phone);
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
    const existing = numsEl.value.trim();
    let existingArr = existing ? existing.split('\n').map(n => n.trim()).filter(Boolean) : [];
    
    if (isChecked) {
        if (!existingArr.includes(phone)) existingArr.push(phone);
    } else {
        existingArr = existingArr.filter(n => n !== phone);
    }
    numsEl.value = existingArr.join('\n');
    window.preview();
};

window.toggleBroadcastSelectAll = function(isChecked) {
    const numsEl = document.getElementById('numbers');
    if (!numsEl) return;
    const existing = numsEl.value.trim();
    let existingArr = existing ? existing.split('\n').map(n => n.trim()).filter(Boolean) : [];
    
    const filterGroup = document.getElementById('b-filter-group');
    const searchQ = document.getElementById('b-search-contacts');
    
    const fv = filterGroup ? filterGroup.value : '';
    const sq = searchQ ? searchQ.value.toLowerCase() : '';
    
    const filtered = (typeof contacts !== 'undefined' ? contacts : []).filter(c => {
        if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });

    filtered.forEach(c => {
        if (isChecked) {
            if (!existingArr.includes(c.phone)) existingArr.push(c.phone);
        } else {
            existingArr = existingArr.filter(n => n !== c.phone);
        }
    });

    numsEl.value = existingArr.join('\n');
    
    document.querySelectorAll('.b-checkbox').forEach(cb => {
        cb.checked = isChecked;
    });
    
    window.preview();
};

document.addEventListener('DOMContentLoaded', () => {
    const msgEl = document.getElementById('msg');
    const numsEl = document.getElementById('numbers');
    if(msgEl) msgEl.addEventListener('input', window.preview);
    if(numsEl) numsEl.addEventListener('input', () => { window.preview(); if(window.renderBroadcastContacts) window.renderBroadcastContacts(); });
});
