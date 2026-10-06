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

document.addEventListener('DOMContentLoaded', () => {
    // init server settings
    window.loadAppSettings();
    window.applyTheme(localStorage.getItem('theme') === 'light', false);

    // Font size is no longer adjustable: drop any saved choice and use the default.
    localStorage.removeItem('font-size');
    document.documentElement.style.fontSize = DEFAULT_FONT_PX + 'px';
});
