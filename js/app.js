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

window.toggleProviderFields = function() {
    const provider = document.getElementById('provider-select').value;
    const twilioFields = document.getElementById('twilio-fields');
    const vobizFields = document.getElementById('vobiz-fields');
    
    if (provider === 'vobiz') {
        twilioFields.style.display = 'none';
        vobizFields.style.display = 'block';
    } else {
        twilioFields.style.display = 'block';
        vobizFields.style.display = 'none';
    }

    // Also toggle the voice selector on the broadcast tab
    const vWrap = document.getElementById('vobiz-voice-wrap');
    if (vWrap) vWrap.style.display = (provider === 'vobiz') ? 'block' : 'none';

    if (window.updateMetrics) window.updateMetrics();
};

window.saveCfg = function() {
    // Extra safety check
    if (document.getElementById('api-lock-overlay').style.display !== 'none') {
        return window.showToast("Unlock required", "error");
    }

    const credentials = {
        sid: document.getElementById('sid').value,
        token: document.getElementById('token').value,
        from: document.getElementById('from').value,
        vobiz_id: document.getElementById('vobiz-id').value,
        vobiz_token: document.getElementById('vobiz-token').value,
        vobiz_from: document.getElementById('vobiz-from').value,
        public_url: document.getElementById('public-url').value,
        provider: document.getElementById('provider-select').value
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
        // Load Twilio values
        if (c.sid) document.getElementById('sid').value = c.sid;
        if (c.token) document.getElementById('token').value = c.token;
        if (c.from) document.getElementById('from').value = c.from;
        
        // Load Vobiz values
        if (c.vobiz_id) document.getElementById('vobiz-id').value = c.vobiz_id;
        if (c.vobiz_token) document.getElementById('vobiz-token').value = c.vobiz_token;
        if (c.vobiz_from) document.getElementById('vobiz-from').value = c.vobiz_from;
        if (c.public_url) document.getElementById('public-url').value = c.public_url;
        
        // Set provider
        if (c.provider) {
            document.getElementById('provider-select').value = c.provider;
        }
        
        // Update UI
        window.toggleProviderFields();
        
    }).catch(e => console.error('Error fetching credentials:', e));
};

window.copyPublicUrl = function() {
    const url = document.getElementById('public-url').value;
    if (!url) return window.showToast("Public URL is empty", "error");
    navigator.clipboard.writeText(url);
    window.showToast("Public URL copied!");
};

// ── CUSTOM DIALOGS ──────────────────────────────────
window.showToast = function(msg, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

window.showConfirm = function(message) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '99999';

        overlay.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-hd">
                    <div class="modal-title">Confirm</div>
                </div>
                <div class="modal-body" style="font-size: 1rem; color: var(--text); padding: 20px;">
                    ${message}
                </div>
                <div class="modal-ft">
                    <button class="btn btn-secondary" id="confirm-no">Cancel</button>
                    <button class="btn btn-danger" id="confirm-yes">Confirm</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const close = (val) => {
            overlay.remove();
            resolve(val);
        };

        overlay.querySelector('#confirm-no').onclick = () => close(false);
        overlay.querySelector('#confirm-yes').onclick = () => close(true);
    });
};

window.showPrompt = function(message, inputType = 'text', defaultVal = '') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '99999';

        overlay.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-hd">
                    <div class="modal-title">${message}</div>
                </div>
                <div class="modal-body" style="padding: 20px;">
                    <input type="${inputType}" id="prompt-input" value="${defaultVal}" style="width: 100%;" />
                </div>
                <div class="modal-ft">
                    <button class="btn btn-secondary" id="prompt-cancel">Cancel</button>
                    <button class="btn" id="prompt-ok">OK</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        const input = overlay.querySelector('#prompt-input');
        input.focus();

        const close = (val) => {
            overlay.remove();
            resolve(val);
        };

        overlay.querySelector('#prompt-cancel').onclick = () => close(null);
        overlay.querySelector('#prompt-ok').onclick = () => close(input.value);
        input.onkeydown = (e) => {
            if (e.key === 'Enter') close(input.value);
            if (e.key === 'Escape') close(null);
        };
    });
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (window.initAuth) window.initAuth();
    
    const lastTab = localStorage.getItem('last_active_tab') || 'broadcast';
    go(lastTab);
});
