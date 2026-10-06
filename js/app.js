// ── Motion helpers ─────────────────────────────────────
// One timing for every open/close in the app; nothing animates under reduced motion.
const VX_EASE = 'cubic-bezier(.4, 0, .2, 1)';
const vxReduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// Expands/collapses `el` by animating its height and opacity. show()/hide() do the real
// visibility change (hidden attribute, display, ...), so callers keep their own state.
window.vxCollapse = function(el, open, show, hide) {
    if (!el) return;
    const from = el.getBoundingClientRect().height;
    if (el._vxAnim) { el._vxAnim.cancel(); el._vxAnim = null; }
    if (vxReduced() || typeof el.animate !== 'function') { open ? show() : hide(); return; }
    if (open) show();
    const to = open ? el.scrollHeight : 0;
    el.style.overflow = 'hidden';
    // Taller panels get a little longer (200-320ms) so every size moves at a similar pace
    const duration = Math.round(200 + Math.min(Math.abs(to - from), 960) / 8);
    const anim = el.animate(
        [{ height: from + 'px', opacity: open ? 0 : 1 }, { height: to + 'px', opacity: open ? 1 : 0 }],
        { duration, easing: open ? 'cubic-bezier(.2, .8, .2, 1)' : VX_EASE });
    el._vxAnim = anim;
    const end = () => { el.style.overflow = ''; };
    anim.onfinish = () => { el._vxAnim = null; end(); if (!open) hide(); };
    anim.oncancel = end;
};

// Modals: fade the backdrop and lift the panel in; reverse on close.
window.vxShowModal = function(overlay) {
    if (!overlay) return;
    clearTimeout(overlay._vxTimer);
    overlay.classList.remove('is-leaving');
    overlay.style.display = 'flex';
};
window.vxHideModal = function(overlay, done) {
    if (!overlay) return;
    clearTimeout(overlay._vxTimer);
    const finish = () => { overlay.style.display = 'none'; overlay.classList.remove('is-leaving'); if (done) done(); };
    if (vxReduced() || overlay.style.display === 'none') return finish();
    overlay.classList.add('is-leaving');
    overlay._vxTimer = setTimeout(finish, 180);
};

// Fades a transient element (popover, menu) out, then removes it.
window.vxRemove = function(el) {
    if (!el || !el.isConnected) return;
    if (vxReduced()) return el.remove();
    el.classList.add('is-leaving');
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 140);
};

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
    // bottom nav (API Config has no item there; it is reached from Settings)
    const bnActive = name === 'api' ? 'settings' : name;
    TABS.forEach(t => {
        const bn = document.getElementById('bnav-' + t);
        if (bn) bn.classList.toggle('active', t === bnActive);
    });
    if (window.placeNavIndicator) window.placeNavIndicator();
    if (window.syncTopFade) requestAnimationFrame(window.syncTopFade);
    // The theme toggle sits at the end of the open page's header
    const themeBtn = document.getElementById('settings-fab');
    const hdActions = document.querySelector('#tab-' + name + ' .page-hd-actions');
    if (themeBtn && hdActions && themeBtn.parentElement !== hdActions) hdActions.appendChild(themeBtn);
    
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

// Non-secret settings only; API keys stay on the server.
window.getCfg = async function() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return {};
        return await res.json();
    } catch (e) {
        return {};
    }
}

// The PIN typed to unlock the API tab; the server checks it again on save.
let apiPin = '';

window.unlockApi = async function() {
    const passEl = document.getElementById('api-unlock-pass');
    const errEl = document.getElementById('api-unlock-err');
    const pin = passEl.value.trim();
    const result = await window.checkPin(pin);
    passEl.value = '';
    if (result.ok) {
        apiPin = pin;
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
        provider: document.getElementById('provider-select').value,
        pin: apiPin
    };

    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
    }).then(res => res.json()).then(res => {
        if(res.success) {
            const btn = document.getElementById('save-btn');
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.innerHTML = 'Save Credentials'; }, 2000);
            window.loadCfg();
        } else {
            window.showToast(res.message || res.error || 'Could not save', 'error');
        }
    }).catch(() => window.showToast('Cannot reach the server', 'error'));
};

window.loadCfg = function() {
    window.getCfg().then(c => {
        // Secret keys are never sent back; a blank field keeps the saved key.
        const secretFields = { token: 'token', vobiz_token: 'vobiz-token', sarvam_key: 'sarvam-key' };
        Object.entries(secretFields).forEach(([key, id]) => {
            const el = document.getElementById(id);
            el.value = '';
            el.placeholder = c['has_' + key] ? 'Saved (leave blank to keep)' : 'Not set';
        });

        // Load Twilio values
        if (c.sid) document.getElementById('sid').value = c.sid;
        if (c.from) document.getElementById('from').value = c.from;
        
        // Load Vobiz values
        if (c.vobiz_id) document.getElementById('vobiz-id').value = c.vobiz_id;
        if (c.vobiz_from) document.getElementById('vobiz-from').value = c.vobiz_from;
        if (c.public_url) document.getElementById('public-url').value = c.public_url;

        // Load Sarvam values
        const sarvamFieldIds = {
            sarvam_org: 'sarvam-org', sarvam_workspace: 'sarvam-workspace',
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
            window.vxHideModal(overlay, () => overlay.remove());
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
            window.vxHideModal(overlay, () => overlay.remove());
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


// ── Floating tab bar (phones) ──────────────────────────
// Slides the highlight under the active tab, and minimises the bar while the user scrolls
// down, restoring it on scroll up or near the top/bottom of the page.
window.placeNavIndicator = function() {
    const ind = document.querySelector('.bn-indicator');
    if (!ind) return;
    const items = [...document.querySelectorAll('.bn-item')];
    const i = items.findIndex(el => el.classList.contains('active'));
    ind.style.setProperty('--bn-count', items.length);
    ind.style.setProperty('--bn-index', Math.max(i, 0));
};

(function navMinimizeOnScroll() {
    let lastY = new WeakMap(), ticking = false, pending = null;
    const nav = () => document.querySelector('.bottomnav');
    const setMin = min => {
        const n = nav();
        if (n && n.classList.contains('is-min') !== min) n.classList.toggle('is-min', min);
    };
    // Tabs scroll inside their own container on some widths and the window on others: listen to both.
    document.addEventListener('scroll', e => {
        pending = e.target === document ? document.scrollingElement : e.target;
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            ticking = false;
            const el = pending;
            if (!el || !el.closest || (el !== document.scrollingElement && !el.closest('.tab-section'))) return;
            const y = el.scrollTop;
            const prev = lastY.has(el) ? lastY.get(el) : y;
            const nearTop = y < 40;
            const nearEnd = el.scrollHeight - el.clientHeight - y < 40;
            if (nearTop || nearEnd) setMin(false);
            else if (y - prev > 6) setMin(true);
            else if (prev - y > 6) setMin(false);
            lastY.set(el, y);
        });
    }, { capture: true, passive: true });
    // A new tab always starts with the full bar
    const go0 = window.go;
    if (typeof go0 === 'function') window.go = function(name) { setMin(false); return go0.apply(this, arguments); };
})();


// ── Sticky toolbars: mark them while stuck so they pick up the blurred pill look ──
(function stickyBars() {
    if (!('IntersectionObserver' in window)) return;
    const watch = bar => {
        if (bar._vxSentinel) return;
        const s = document.createElement('div');
        s.setAttribute('aria-hidden', 'true');
        s.style.cssText = 'height:1px;margin-bottom:-1px;pointer-events:none;';
        bar.before(s);
        bar._vxSentinel = s;
        // Stuck once the sentinel just above the bar has scrolled past the bar's top offset
        new IntersectionObserver(([e]) => {
            const stuck = !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds ? e.rootBounds.top + 40 : 40);
            bar.classList.toggle('is-stuck', stuck);
            syncTopFade();
        }, { rootMargin: '-14px 0px 0px 0px', threshold: [0, 1] }).observe(s);
    };
    // While a bar is pinned, the blurred top edge grows to sit behind it as well
    const syncTopFade = () => {
        const fade = document.querySelector('.top-fade');
        if (!fade) return;
        const bar = [...document.querySelectorAll('.tab-section.active .sticky-bar.is-stuck')][0];
        fade.classList.toggle('is-on', !!bar);
        if (!bar) return;
        const top = fade.getBoundingClientRect().top;
        fade.style.setProperty('--fade-h', Math.round(bar.getBoundingClientRect().bottom - top + 22) + 'px');
    };
    window.syncTopFade = syncTopFade;
    const init = () => document.querySelectorAll('.sticky-bar').forEach(watch);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
