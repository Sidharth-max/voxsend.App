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
    document.getElementById('prev-msg').textContent = msg || 'Message will appear here...';
    document.getElementById('prev-msg').className = 'hist-msg ' + lang;

    const nums = getNums();
    document.getElementById('count').textContent = nums.length;
    
    // Twilio Voice costs $0.013/min for outbound to India.
    const cost = (nums.length * 0.013).toFixed(2);
    document.getElementById('est-cost').textContent = '$' + cost;
    
    const maxChars = lang === 'en' ? 1200 : 800;
    const isOver = msg.length > maxChars;
    const btn = document.getElementById('send-btn');
    const overEl = document.getElementById('over-limit');
    
    if (isOver) {
        overEl.style.display = 'block';
        btn.disabled = true;
    } else {
        overEl.style.display = 'none';
        btn.disabled = !msg || nums.length === 0;
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
            sentBy: window.currentUser ? window.currentUser.username : 'Unknown'
        });
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const msgEl = document.getElementById('msg');
    const numsEl = document.getElementById('numbers');
    if(msgEl) msgEl.addEventListener('input', window.preview);
    if(numsEl) numsEl.addEventListener('input', window.preview);
});
