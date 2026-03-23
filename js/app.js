cat > js / app.js << 'EOF'
const TABS = ['broadcast', 'contacts', 'history', 'api', 'settings', 'users'];
function go(name) {
    if (name === 'users' && (!window.currentUser || window.currentUser.role !== 'operator')) {
        return alert("Access denied");
    }
    TABS.forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) el.classList.toggle('active', t === name);
    });
    TABS.forEach(t => {
        const s = document.getElementById('snav-' + t);
        if (s) s.classList.toggle('active', t === name);
    });
    TABS.forEach(t => {
        const tb = document.getElementById('tnav-' + t);
        if (tb) tb.classList.toggle('active', t === name);
    });
    TABS.forEach(t => {
        const bn = document.getElementById('bnav-' + t);
        if (bn) bn.classList.toggle('active', t === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.getCfg = async function () {
    try {
        const res = await fetch('/api/credentials');
        return await res.json();
    } catch (e) {
        return {};
    }
}

window.saveCfg = function () {
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
        if (res.success) {
            const btn = document.getElementById('save-btn');
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.innerHTML = 'Save Credentials'; }, 2000);
        }
    });
};

window.loadCfg = function () {
    fetch('/api/credentials').then(res => res.json()).then(c => {
        if (c.sid) document.getElementById('sid').value = c.sid;
        if (c.token) document.getElementById('token').value = c.token;
        if (c.from) document.getElementById('from').value = c.from;
    }).catch(e => console.error('Error fetching credentials:', e));
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadCfg();
    if (window.initAuth) window.initAuth();
});
EOF