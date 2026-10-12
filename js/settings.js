// ── Theme (light/dark) ─────────────────────────────────
// Saved as localStorage 'theme' = 'light' | 'dark'; light sets <html data-theme="light">.
// The header toggle (#settings-fab) goes through applyTheme.
const THEME_ANIM_MS = 400;   // fade length (css/theme.css uses the same 400ms)
const THEME_ANIM_HOLD = 450; // fallback class lifetime: fade + the 350ms icon morph
const DEFAULT_FONT_PX = 14; // the old font-size slider's default; the slider is gone
let themeAnimTimer = null;

function setThemeAttr(isLight) {
    const root = document.documentElement;
    if (isLight) root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLight ? '#fafafa' : '#0a0a0a');
}

window.applyTheme = function (isLight, animate) {
    const root = document.documentElement;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const changing = (root.getAttribute('data-theme') === 'light') !== !!isLight;
    if (!animate || reduce || !changing) {
        // Page load, other-tab sync, reduced motion: switch instantly, nothing animates.
        // .theme-vt also freezes the elements' own transitions (inputs, pills) for this switch.
        if (changing) {
            root.classList.add('theme-vt');
            setThemeAttr(isLight);
            void root.offsetWidth; // commit the new colours while transitions are off
            root.classList.remove('theme-vt');
        } else {
            setThemeAttr(isLight);
        }
    } else if (typeof document.startViewTransition === 'function') {
        // View Transitions: the browser snapshots the old page and crossfades the whole page
        // (every element, pseudo-element, SVG, image, gradient, popover) into the new one in a
        // single 300ms fade. .theme-vt (css/theme.css) freezes per-element transitions so the
        // new snapshot is final at once, and lets the FAB icon morph live on its own layer.
        root.classList.remove('theme-anim');
        root.classList.add('theme-vt');
        clearTimeout(themeAnimTimer);
        let vt;
        try {
            vt = document.startViewTransition(() => setThemeAttr(isLight));
        } catch (e) {
            vt = null;
            setThemeAttr(isLight);
        }
        const done = () => { if (!root.classList.contains('theme-anim')) root.classList.remove('theme-vt'); };
        if (vt && vt.finished) vt.finished.then(done, done);
        themeAnimTimer = setTimeout(done, THEME_ANIM_HOLD + 600); // safety net
    } else {
        // Fallback: .theme-anim gives every element (and ::before/::after, SVG fill/stroke) the
        // same 300ms colour transition for this switch only, then is removed.
        root.classList.add('theme-anim');
        void root.offsetWidth; // commit the transition rules before the colours change
        setThemeAttr(isLight);
        clearTimeout(themeAnimTimer);
        themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), THEME_ANIM_HOLD);
    }
    const fab = document.getElementById('settings-fab');
    if (fab) {
        const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
        fab.setAttribute('aria-label', label);
        fab.title = label;
    }
};

window.setThemeMode = function (isLight) {
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    window.applyTheme(isLight, true);
};

window.toggleTheme = function () {
    window.setThemeMode(document.documentElement.getAttribute('data-theme') !== 'light');
};

// Another tab changed the theme: follow it.
window.addEventListener('storage', (e) => {
    if (e.key === 'theme') window.applyTheme(e.newValue === 'light', false);
});

window.saveTrustName = function () {
    const name = document.getElementById('trust-name-input').value.trim();
    if (!name) return window.showToast("Name cannot be empty", "error");
    window.applyTrustName(name);
    window.saveAppSettings();
};

window.applyTrustName = function (name) {
    const display = document.getElementById('display-trust-name');
    if (display) display.textContent = name;
};

window.saveAppSettings = function () {
    const settings = {
        org_name: document.getElementById('trust-name-input').value.trim(),
        parallel_calls: document.getElementById('parallel-calls').value,
        retry_failed: document.getElementById('retry-toggle').checked ? 1 : 0,
        default_language: document.getElementById('default-lang').value,
        delay_ms: document.getElementById('call-delay').value
    };

    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    }).then(res => res.json()).then(res => {
        if (res.success) {
            window.showToast("Settings saved successfully!", "success");
        }
    }).catch(e => console.error("Error saving settings:", e));
};

window.loadAppSettings = function () {
    fetch('/api/settings').then(res => res.json()).then(s => {
        if (s.org_name) {
            document.getElementById('trust-name-input').value = s.org_name;
            window.applyTrustName(s.org_name);
        }
        if (s.parallel_calls) document.getElementById('parallel-calls').value = s.parallel_calls;
        if (s.retry_failed !== undefined) document.getElementById('retry-toggle').checked = !!s.retry_failed;
        if (s.default_language) document.getElementById('default-lang').value = s.default_language;
        if (s.delay_ms) document.getElementById('call-delay').value = s.delay_ms;
    }).catch(e => console.error("Error loading settings:", e));
};

// Adapts Settings to the provider: rows marked data-sarvam-off are disabled for Sarvam,
// rows with data-sarvam-sub get a Sarvam-specific description.
window.applySettingsProviderUI = function (provider) {
    const sarvam = provider === 'sarvam';
    document.querySelectorAll('#tab-settings .row-item[data-sarvam-off], #tab-settings .row-item[data-sarvam-sub]').forEach(row => {
        const sub = row.querySelector('.row-sub');
        if (sub && sub.dataset.orig === undefined) sub.dataset.orig = sub.textContent;
        const off = row.hasAttribute('data-sarvam-off');
        row.classList.toggle('is-off', sarvam && off);
        row.querySelectorAll('select, input').forEach(el => { el.disabled = sarvam && off; });
        if (sub) sub.textContent = sarvam ? (row.dataset.sarvamOff || row.dataset.sarvamSub) : sub.dataset.orig;
    });
};

// ── Sarvam agents ───────────────────────────────────
let agentEditingId = null;

window.loadAgents = async function () {
    const list = document.getElementById('agents-list');
    if (!list) return;
    let rows = [];
    try {
        const res = await fetch('/api/agents');
        if (!res.ok) return;
        rows = await res.json();
    } catch (e) { return; }
    document.getElementById('agents-count').textContent = String(rows.length);
    list.innerHTML = '';
    if (!rows.length) {
        list.innerHTML = '<div class="row-item"><div class="row-sub">No agents yet. Add one below.</div></div>';
        return;
    }
    rows.forEach(a => {
        const line = document.createElement('div');
        line.className = 'row-item' + (a.active ? '' : ' is-off');
        const left = document.createElement('div');
        left.style.minWidth = '0';
        const name = document.createElement('div');
        name.className = 'row-label';
        name.textContent = a.label;
        const sub = document.createElement('div');
        sub.className = 'row-sub mono';
        sub.textContent = a.app_id + (a.version ? ` · v${a.version}` : ' · latest');
        left.append(name, sub);
        if (a.notes) {
            const n = document.createElement('div');
            n.className = 'row-sub';
            n.textContent = a.notes;
            left.appendChild(n);
        }
        const right = document.createElement('div');
        right.className = 'row-right';
        right.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;';
        const badge = document.createElement('span');
        badge.className = 'badge ' + (a.is_default ? 'badge-success' : 'badge-muted');
        badge.textContent = a.is_default ? 'Default' : (a.active ? 'Active' : 'Inactive');
        right.appendChild(badge);
        const btn = (label, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'vx-pop-btn';
            b.textContent = label;
            b.onclick = fn;
            right.appendChild(b);
        };
        btn('Edit', () => editAgent(a));
        if (!a.is_default) btn('Make default', () => agentAction(`/api/agents/${a.id}/default`, 'POST', null, `${a.label} is now the default agent.`));
        if (!a.is_default) btn(a.active ? 'Hide' : 'Show', () => agentAction(`/api/agents/${a.id}`, 'PUT', { ...a, active: !a.active }, a.active ? `${a.label} is hidden from the picker.` : `${a.label} is back in the picker.`));
        if (!a.is_default) btn('Delete', async () => {
            if (!(await window.showConfirm(`Delete the agent "${a.label}"? Past calls keep their history.`))) return;
            agentAction(`/api/agents/${a.id}`, 'DELETE', null, 'Agent deleted.');
        });
        line.append(left, right);
        list.appendChild(line);
    });
};

async function agentAction(url, method, body, okMsg) {
    const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    }).then(r => r.json()).catch(() => ({ success: false, message: 'Network error.' }));
    if (res.success) window.showToast(okMsg, 'success');
    else window.showToast(res.message || 'Could not save.', 'error');
    window.loadAgents();
    if (window.loadAgentPicker) window.loadAgentPicker();
    return res.success;
}

function editAgent(a) {
    agentEditingId = a.id;
    document.getElementById('agent-form-title').textContent = `Edit "${a.label}"`;
    document.getElementById('agent-label').value = a.label;
    document.getElementById('agent-app-id').value = a.app_id;
    document.getElementById('agent-version').value = a.version || '';
    document.getElementById('agent-notes').value = a.notes || '';
    document.getElementById('agent-save-btn').textContent = 'Save agent';
    document.getElementById('agent-cancel-btn').style.display = '';
    document.getElementById('agent-form').dataset.active = a.active ? '1' : '0';
    document.getElementById('agent-label').focus();
}

window.resetAgentForm = function () {
    agentEditingId = null;
    ['agent-label', 'agent-app-id', 'agent-version', 'agent-notes'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('agent-form-title').textContent = 'Add an agent';
    document.getElementById('agent-save-btn').textContent = 'Add agent';
    document.getElementById('agent-cancel-btn').style.display = 'none';
};

window.saveAgentForm = async function () {
    const body = {
        label: document.getElementById('agent-label').value.trim(),
        app_id: document.getElementById('agent-app-id').value.trim(),
        version: document.getElementById('agent-version').value.trim() || null,
        notes: document.getElementById('agent-notes').value.trim(),
        active: agentEditingId ? document.getElementById('agent-form').dataset.active === '1' : true
    };
    if (!body.label || !body.app_id) return window.showToast('Enter a name and the agent ID.', 'error');
    if (body.version && !/^\d+$/.test(body.version)) return window.showToast('Version must be a number, or leave it empty.', 'error');
    const ok = await agentAction(agentEditingId ? `/api/agents/${agentEditingId}` : '/api/agents', agentEditingId ? 'PUT' : 'POST', body,
        agentEditingId ? 'Agent saved.' : 'Agent added.');
    if (ok) window.resetAgentForm();
};

window.loadSettings = function () {
    window.loadAppSettings();
    window.loadAgents();
};

document.addEventListener('DOMContentLoaded', () => {
    // init server settings
    window.loadAppSettings();
    window.applyTheme(localStorage.getItem('theme') === 'light', false);

    // Font size is no longer adjustable: drop any saved choice and use the default.
    localStorage.removeItem('font-size');
    document.documentElement.style.fontSize = DEFAULT_FONT_PX + 'px';
});
