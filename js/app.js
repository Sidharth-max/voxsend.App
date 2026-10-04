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

window.unlockApi = async function() {
    const passEl = document.getElementById('api-unlock-pass');
    const errEl = document.getElementById('api-unlock-err');
    const result = await window.checkPin(passEl.value.trim());
    passEl.value = '';
    if (result.ok) {
        document.getElementById('api-lock-overlay').style.display = 'none';
        const wrap = document.getElementById('api-fields-wrap');
        wrap.style.opacity = '1';
        wrap.style.pointerEvents = 'auto';
        wrap.style.filter = 'none';
        document.getElementById('api-unlock-err').style.display = 'none';
        window.loadCfg(); // Load credentials only after unlock
    } else {
        errEl.textContent = result.message || 'Incorrect PIN';
        errEl.style.display = 'block';
    }
};

window.toggleProviderFields = function() {
    const provider = document.getElementById('provider-select').value;
    const twilioFields = document.getElementById('twilio-fields');
    const vobizFields = document.getElementById('vobiz-fields');
    const sarvamFields = document.getElementById('sarvam-fields');
    const publicUrlWrap = document.getElementById('public-url-wrap');

    twilioFields.style.display = provider === 'twilio' ? 'block' : 'none';
    vobizFields.style.display = provider === 'vobiz' ? 'block' : 'none';
    if (sarvamFields) sarvamFields.style.display = provider === 'sarvam' ? 'block' : 'none';
    if (publicUrlWrap) publicUrlWrap.style.display = provider === 'twilio' ? 'none' : 'block';

    // Keep the Broadcast tab in step with the selected provider
    if (window.applyProviderUI) window.applyProviderUI(provider);

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
        sarvam_key: document.getElementById('sarvam-key').value,
        sarvam_org: document.getElementById('sarvam-org').value.trim(),
        sarvam_workspace: document.getElementById('sarvam-workspace').value.trim(),
        sarvam_app_id: document.getElementById('sarvam-app-id').value.trim(),
        sarvam_app_version: document.getElementById('sarvam-app-version').value.trim(),
        sarvam_connection_id: document.getElementById('sarvam-connection-id').value.trim(),
        sarvam_from: document.getElementById('sarvam-from').value.trim(),
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

        // Load Sarvam values
        const sarvamFieldIds = {
            sarvam_key: 'sarvam-key', sarvam_org: 'sarvam-org', sarvam_workspace: 'sarvam-workspace',
            sarvam_app_id: 'sarvam-app-id', sarvam_app_version: 'sarvam-app-version',
            sarvam_connection_id: 'sarvam-connection-id', sarvam_from: 'sarvam-from'
        };
        Object.entries(sarvamFieldIds).forEach(([key, id]) => {
            if (c[key]) document.getElementById(id).value = c[key];
        });
        
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
