// ── Phone numbers (shared by Broadcast typed numbers and Contacts > Add manually) ──
// Bare 10 digits -> +<cc>; leading 0s stripped; numbers typed with '+' kept as is.
// Red 'Invalid' pill for any number shown in the UI (computed at render time, so numbers
// edited straight in the DB are flagged too). '' when the number is fine.
window.vxPhoneIssue = function(phone) {
    if (!window.VxPhone || !phone) return null;
    const v = window.VxPhone.check(phone);
    return v.ok ? null : v;
};
window.vxInvalidPill = function(phone) {
    const v = window.vxPhoneIssue(phone);
    if (!v) return '';
    const tip = String(v.reason + (v.hint ? ' – ' + v.hint : '')).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    return `<span class="badge badge-danger badge-invalid" title="${tip}" aria-label="Invalid number: ${tip}">Invalid</span>`;
};
window.vxCleanPhone = function(value = '') {
    if (!value) return '';
    return String(value).trim().replace(/\s+/g, '').replace(/(?!^)\+/g, '').replace(/[^0-9+]/g, '');
};
window.vxNormalizePhone = function(value = '', cc = '91') {
    const c = window.vxCleanPhone(value);
    if (!c) return '';
    if (c.startsWith('+')) return c;
    const d = c.replace(/^0+/, '');
    if (d.length === 10) return '+' + cc + d;
    return '+' + d;
};
// null when fine, else { reason, fix } for a number that looks wrong.
window.vxCheckPhone = function(normalized = '', cc = '91') {
    const d = String(normalized).replace(/\D/g, '');
    if (d.length === 10) return { reason: 'missing country code', fix: '+' + cc + d };
    const v = window.VxPhone ? window.VxPhone.check('+' + d, cc) : { ok: d.length >= 8 && d.length <= 15, reason: 'wrong length' };
    if (v.ok) return null;
    return { reason: v.reason + (v.hint ? ' (' + v.hint + ')' : ''), fix: v.fix || null };
};

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
    const finish = () => {
        overlay.style.display = 'none';
        overlay.classList.remove('is-leaving');
        if (done) done();
    };
    if (vxReduced() || overlay.style.display === 'none') return finish();
    overlay.classList.add('is-leaving');
    overlay._vxTimer = setTimeout(finish, 200);
};

// Fades a transient element (popover, menu) out, then removes it.
window.vxRemove = function(el) {
    if (!el || !el.isConnected) return;
    if (vxReduced()) return el.remove();
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    el.style.pointerEvents = 'none';
    // Same animation as opening, reversed; removed when it ends (timeout as a fallback).
    let done = false;
    const finish = () => { if (done) return; done = true; el.remove(); };
    el.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 260);
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
    // bottom nav (API has its own item)
    const bnActive = name;
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

// Public settings only: provider, public URL and which providers are fully configured.
// Secrets never reach the browser; the server uses its own stored credentials.
window.getCfg = async function() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return { configured: {} };
        const c = await res.json();
        c.configured = c.configured || {};
        return c;
    } catch (e) {
        return { configured: {} };
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

// Input id for each stored credential field.
const CRED_INPUTS = {
    sid: 'sid', token: 'token', from: 'from',
    vobiz_id: 'vobiz-id', vobiz_token: 'vobiz-token', vobiz_from: 'vobiz-from',
    sarvam_key: 'sarvam-key', sarvam_org: 'sarvam-org', sarvam_workspace: 'sarvam-workspace',
    sarvam_app_id: 'sarvam-app-id', sarvam_app_version: 'sarvam-app-version',
    sarvam_connection_id: 'sarvam-connection-id', sarvam_from: 'sarvam-from'
};

window.saveCfg = function() {
    // Extra safety check
    if (document.getElementById('api-lock-overlay').style.display !== 'none') {
        return window.showToast("Unlock required", "error");
    }

    // Saved values are shown masked as placeholders; only boxes you typed into are sent.
    const credentials = {
        public_url: document.getElementById('public-url').value.trim(),
        provider: document.getElementById('provider-select').value
    };
    Object.entries(CRED_INPUTS).forEach(([key, id]) => {
        const v = document.getElementById(id).value.trim();
        if (v) credentials[key] = v;
    });

    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
    }).then(res => res.json()).then(res => {
        if (res.success) {
            const btn = document.getElementById('save-btn');
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.innerHTML = 'Save Credentials'; }, 2000);
            window.loadCfg();
            if (window.loadAgentPicker) window.loadAgentPicker();
        } else {
            window.showToast(res.message || 'Could not save.', 'error');
        }
    }).catch(() => window.showToast('Network error while saving.', 'error'));
};

window.loadCfg = function() {
    fetch('/api/credentials').then(res => res.json()).then(c => {
        const masked = c.masked || {};
        Object.entries(CRED_INPUTS).forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (!el.dataset.emptyPlaceholder) el.dataset.emptyPlaceholder = el.getAttribute('placeholder') || '';
            el.value = '';
            el.setAttribute('placeholder', masked[key] ? `Saved: ${masked[key]} (type to replace)` : el.dataset.emptyPlaceholder);
        });
        document.getElementById('public-url').value = c.public_url || '';
        if (c.provider) document.getElementById('provider-select').value = c.provider;
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
    // initAuth opens the last tab once the session is confirmed.
    if (window.initAuth) window.initAuth();
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

// The bottom bar keeps one size; it no longer shrinks on scroll.


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


// Segmented tab rows: one highlight pill slides to the active tab; list content fades in on change.
(function segmentedTabs() {
    const SEL = '.lang-pills[role="tablist"], #msg-lang-pills, #sched-mode, #sched-end-mode';
    const reduced = () => vxReduced();
    function place(row, instant) {
        const ind = row.querySelector(':scope > .seg-ind');
        const act = row.querySelector(':scope > .lang-pill.active');
        if (!ind) return;
        if (!act || !act.offsetWidth) { ind.style.opacity = '0'; return; }
        if (instant || reduced()) ind.style.transition = 'none';
        ind.style.opacity = '1';
        ind.style.width = act.offsetWidth + 'px';
        ind.style.height = act.offsetHeight + 'px';
        ind.style.transform = `translate(${act.offsetLeft - row.scrollLeft * 0}px, ${act.offsetTop}px)`;
        if (instant || reduced()) { void ind.offsetWidth; ind.style.transition = ''; }
    }
    function setup(row) {
        if (row.__seg) return;
        row.__seg = true;
        row.classList.add('seg-row');
        const ind = document.createElement('span');
        ind.className = 'seg-ind';
        ind.setAttribute('aria-hidden', 'true');
        row.prepend(ind);
        place(row, true);
        new MutationObserver(() => {
            if (!row.querySelector(':scope > .seg-ind')) row.prepend(ind); // rows rebuilt by JS
            requestAnimationFrame(() => place(row));
        }).observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    }
    const scan = () => document.querySelectorAll(SEL).forEach(setup);
    document.addEventListener('DOMContentLoaded', scan);
    window.addEventListener('resize', () => document.querySelectorAll('.seg-row').forEach(r => place(r, true)));
    // Rows inside pages that were hidden get measured when they become visible.
    const go1 = window.go;
    if (typeof go1 === 'function') window.go = function() { const r = go1.apply(this, arguments); requestAnimationFrame(() => { scan(); document.querySelectorAll('.seg-row').forEach(x => place(x, true)); }); return r; };
    setTimeout(scan, 0);

    // Soft fade-in of a list when its content is replaced (filter / tab change).
    window.vxFadeIn = function(el) {
        if (!el || reduced()) return;
        el.classList.remove('seg-fade');
        void el.offsetWidth;
        el.classList.add('seg-fade');
    };
    document.addEventListener('click', e => {
        const pill = e.target.closest && e.target.closest('.seg-row > .lang-pill');
        if (!pill) return;
        const row = pill.parentElement;
        const target = row.id === 'hist-subtabs' ? document.querySelector('#tab-history .history-list:not([style*="none"]), #hist-sarvam-content, #hist-broadcast-content, #hist-scheduled-content')
            : null; // Call history fades its own list after the swap
        if (row.id === 'hist-subtabs') {
            requestAnimationFrame(() => ['hist-sarvam-content', 'hist-broadcast-content', 'hist-scheduled-content', 'hist-vobiz-content']
                .map(id => document.getElementById(id)).filter(x => x && x.style.display !== 'none').forEach(window.vxFadeIn));
        } else if (target) setTimeout(() => window.vxFadeIn(target), 120);
    });
})();

// ── Checkbox tick (shared): every input.checkbox gets an SVG tick drawn with stroke-dashoffset ──
// The real <input> stays (a11y, JS, :checked); a wrapper span holds the SVG overlay.
(function () {
    const SVG = '<svg class="vx-cb-mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">'
        + '<path class="vx-cb-tick" pathLength="1" d="M2.5 6.2l2.3 2.3L9.5 3.6"/>'
        + '<path class="vx-cb-dash" pathLength="1" d="M3 6h6"/></svg>';
    const enhance = (root) => {
        const list = root.matches && root.matches('input.checkbox') ? [root] : (root.querySelectorAll ? root.querySelectorAll('input.checkbox') : []);
        list.forEach(inp => {
            if (inp.parentNode && inp.parentNode.classList && inp.parentNode.classList.contains('vx-cb')) return;
            const wrap = document.createElement('span');
            wrap.className = 'vx-cb';
            inp.parentNode.insertBefore(wrap, inp);
            wrap.appendChild(inp);
            wrap.insertAdjacentHTML('beforeend', SVG);
            replay(inp);
        });
    };
    // Lists re-render on every tick (Contacts, Broadcast picker, select-all), which replaces the
    // input that was clicked, so its CSS transition never plays. Remember recent changes and
    // replay them on the fresh input: render the old state, then flip it on the next frame.
    let recent = [], allAt = 0, allState = null;
    const sig = inp => inp.id || inp.getAttribute('onchange') || inp.getAttribute('onclick') || '';
    document.addEventListener('change', e => {
        const t = e.target;
        if (!t || !t.matches || !t.matches('input.checkbox')) return;
        if (/check-all/.test(t.id)) { allAt = performance.now(); allState = t.checked; }
        else recent.push({ s: sig(t), state: t.checked, at: performance.now() });
    }, true);
    document.addEventListener('click', e => {
        const t = e.target;
        if (t && t.matches && t.matches('input.checkbox') && /check-all/.test(t.id)) { allAt = performance.now(); allState = t.checked; }
    }, true);
    function replay(inp) {
        if (vxReduced() || inp.indeterminate) return;
        const now = performance.now();
        recent = recent.filter(r => now - r.at < 500);
        const s = sig(inp);
        const hit = s && recent.find(r => r.s === s);
        let want = null;
        if (hit && inp.checked === hit.state) want = hit.state;
        else if (now - allAt < 500 && inp.checked === allState && !/check-all/.test(inp.id)) want = allState;
        if (want === null) return;
        inp.checked = !want;
        void inp.offsetWidth;
        requestAnimationFrame(() => requestAnimationFrame(() => { inp.checked = want; }));
    }
    const start = () => {
        enhance(document.body);
        new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) enhance(n); })))
            .observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

// ── Numbers list (schedule / broadcast cards) ─────────────
// Shows the first 6 numbers with contact names, then "View all (N)" opens a searchable modal.
(function () {
    const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const key = p => String(p || '').replace(/\D/g, '').slice(-10);
    // Live contacts first; numbers whose contact was deleted use the server's last known name.
    const known = new Map();
    function book() {
        const list = typeof contacts !== 'undefined' && Array.isArray(contacts) ? contacts : [];
        const m = new Map();
        known.forEach((name, k) => m.set(k, { name, group: '' }));
        list.forEach(c => m.set(key(c.phone), c));
        return m;
    }
    async function learnNames(phones) {
        const live = book();
        const missing = phones.filter(p => !live.has(key(p)));
        if (!missing.length) return;
        try {
            const res = await fetch('/api/contact-names', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phones: missing }) });
            const data = res.ok ? await res.json() : {};
            Object.entries(data.names || {}).forEach(([p, n]) => n && known.set(key(p), n));
        } catch (e) { /* names stay 'Not in contacts' */ }
    }
    function row(phone, c, expandable) {
        const line = document.createElement('div');
        line.className = 'row-item';
        line.innerHTML = `<div style="min-width:0"><div class="row-label">${esc(c && c.name ? c.name : 'Not in contacts')}</div>
            <div class="row-sub mono">${esc(phone)} ${window.vxInvalidPill(phone)}</div></div>
            ${c && c.group ? `<span class="badge badge-muted">${esc(c.group)}</span>` : ''}`;
        if (!expandable) return line;
        // Tap a row: that number's call history expands inline (no navigation).
        const wrap = document.createElement('div');
        wrap.className = 'nums-row';
        line.classList.add('nums-row-hd');
        line.setAttribute('role', 'button');
        line.tabIndex = 0;
        line.setAttribute('aria-expanded', 'false');
        const panel = window.vxInlineHistory(phone);
        const flip = () => line.setAttribute('aria-expanded', String(panel.toggle()));
        line.addEventListener('click', flip);
        line.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        wrap.append(line, panel);
        return wrap;
    }
    function openAll(phones, title) {
        const map = book();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay nums-modal';
        overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
            <div class="modal-hd"><div><div class="modal-title">${esc(title)}</div><div class="row-sub nums-count"></div></div>
                <button type="button" class="modal-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
            <div class="nums-search"><input type="text" placeholder="Search name or number" autocomplete="off" aria-label="Search numbers"></div>
            <div class="nums-list"></div></div>`;
        document.body.appendChild(overlay);
        const list = overlay.querySelector('.nums-list'), input = overlay.querySelector('input'), count = overlay.querySelector('.nums-count');
        const all = phones.map(p => ({ p, c: map.get(key(p)) }));
        const bad = all.filter(x => window.vxPhoneIssue(x.p)).length;
        function render() {
            const q = input.value.trim().toLowerCase(), qd = q.replace(/\D/g, '');
            const hits = all.filter(x => !q || (x.c && x.c.name && x.c.name.toLowerCase().includes(q)) || (qd && x.p.replace(/\D/g, '').includes(qd)));
            const frag = document.createDocumentFragment();
            hits.forEach(x => frag.appendChild(row(x.p, x.c, true)));
            list.replaceChildren(frag);
            if (!hits.length) list.innerHTML = '<div class="row-item"><div class="row-sub">No matches.</div></div>';
            count.textContent = (q ? `${hits.length} of ${all.length}` : `${all.length} number${all.length === 1 ? '' : 's'}`) + (bad ? ` · ${bad} invalid` : '');
        }
        input.addEventListener('input', render);
        render();
        const close = () => { document.removeEventListener('keydown', onKey, true); window.vxHideModal(overlay, () => overlay.remove()); };
        const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('.modal-close').onclick = close;
        window.vxShowModal(overlay);
        setTimeout(() => input.focus({ preventScroll: true }), 60);
    }
    window.vxNumbersBox = async function (box, phones, title) {
        phones = Array.from(new Set((phones || []).filter(Boolean)));
        await learnNames(phones);
        box.innerHTML = '';
        if (!phones.length) { box.innerHTML = '<div class="row-item"><div class="row-sub">No numbers stored.</div></div>'; return; }
        const map = book();
        phones.slice(0, 6).forEach(p => box.appendChild(row(p, map.get(key(p)))));
        if (phones.length > 6) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-secondary btn-sm nums-all-btn';
            b.textContent = `View all (${phones.length})`;
            b.onclick = e => { e.stopPropagation(); openAll(phones, title || 'Numbers'); };
            box.appendChild(b);
        }
    };
    window.vxOpenNumbers = openAll;
})();

// ── Inline call history (one component for the View-all modal and Contacts) ──────────
// vxInlineHistory(phone) returns a panel element; call .toggle() to expand/collapse it in
// place (vxCollapse animation). Lazy-loads /api/calls?q=<number> on first open and renders
// the existing call cards (conversation accordion + custom recording player).
(function () {
    window.vxInlineHistory = function (phone) {
        const panel = document.createElement('div');
        panel.className = 'vx-inline-hist';
        panel.hidden = true;
        let loaded = false, open = false;
        async function load() {
            loaded = true;
            panel.innerHTML = '<div class="hint vx-inline-hist-msg">Loading calls…</div>';
            const digits = String(phone || '').replace(/\D/g, '');
            const q = digits.length > 10 ? digits.slice(-10) : digits;
            let items = null;
            try {
                const res = await fetch('/api/calls?' + new URLSearchParams({ q, limit: '50' }));
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Could not load the calls.');
                items = data.items || [];
            } catch (e) {
                loaded = false;
                panel.innerHTML = `<div class="hint vx-inline-hist-msg" style="color:var(--error)">${String(e.message).replace(/[<>&]/g, '')}</div>`;
                return;
            }
            if (!items.length) { panel.innerHTML = '<div class="hint vx-inline-hist-msg">No calls yet.</div>'; return; }
            const frag = document.createDocumentFragment();
            items.forEach(c => frag.appendChild(window.vxCallCard(c)));   // newest first (API order)
            panel.replaceChildren(frag);
            if (open && panel.style.height) panel.style.height = '';
        }
        panel.toggle = function (force) {
            const next = typeof force === 'boolean' ? force : !open;
            if (next === open) return open;
            open = next;
            if (open && !loaded) load();
            window.vxCollapse(panel, open, () => { panel.hidden = false; }, () => { panel.hidden = true; });
            return open;
        };
        panel.isOpen = () => open;
        return panel;
    };
})();
