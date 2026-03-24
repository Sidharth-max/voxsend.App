const TABS = ['broadcast', 'contacts', 'history', 'api', 'settings'];

function go(name) {
    localStorage.setItem('last_active_tab', name);
    window.location.hash = name;
    // content tabs
    TABS.forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) el.classList.toggle('active', t === name);
    });
    // sidebar nav
    TABS.forEach(t => {
        const s = document.getElementById('snav-' + t);
        if (s) s.classList.toggle('active', t === name);
    });
    // topbar tabs
    TABS.forEach(t => {
        const tb = document.getElementById('tnav-' + t);
        if (tb) tb.classList.toggle('active', t === name);
    });
    // bottom nav
    TABS.forEach(t => {
        const bn = document.getElementById('bnav-' + t);
        if (bn) bn.classList.toggle('active', t === name);
    });
    
    if (name === 'history' && window.loadHistory) {
        window.loadHistory();
    }
    if (name === 'contacts' && window.loadContacts) {
        window.loadContacts();
    }
    if (name === 'settings' && window.loadSettings) {
        window.loadSettings();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.getCfg = async function() {
    try {
        const res = await fetch('/api/credentials');
        return await res.json();
    } catch (e) {
        return {};
    }
}

window.unlockApi = function() {
    const pass = document.getElementById('api-unlock-pass').value;
    if (window.verifySessionPassword && window.verifySessionPassword(pass)) {
        document.getElementById('api-lock-overlay').style.display = 'none';
        const wrap = document.getElementById('api-fields-wrap');
        wrap.style.opacity = '1';
        wrap.style.pointerEvents = 'auto';
        wrap.style.filter = 'none';
        document.getElementById('api-unlock-err').style.display = 'none';
        window.loadCfg(); // Load credentials only after unlock
    } else {
        document.getElementById('api-unlock-err').style.display = 'block';
    }
};

window.saveCfg = function() {
    // Extra safety check
    if (document.getElementById('api-lock-overlay').style.display !== 'none') {
        return alert("Unlock required");
    }

    const credentials = {
        sid: document.getElementById('sid').value,
        token: document.getElementById('token').value,
        from: document.getElementById('from').value
    };

    fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
    }).then(res => res.json()).then(res => {
        if(res.success) {
            const btn = document.getElementById('save-btn');
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.innerHTML = 'Save Credentials'; }, 2000);
        }
    });
};

window.loadCfg = function() {
    fetch('/api/credentials').then(res => res.json()).then(c => {
        if (c.sid) document.getElementById('sid').value = c.sid;
        if (c.token) document.getElementById('token').value = c.token;
        if (c.from) document.getElementById('from').value = c.from;
    }).catch(e => console.error('Error fetching credentials:', e));
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (window.initAuth) window.initAuth();
});
