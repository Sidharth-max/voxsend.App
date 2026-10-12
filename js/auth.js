window.currentUser = null;

// Sign-in is a server session: the PIN is checked by the server and an httpOnly cookie is set.
// Nothing about the session is kept in the browser's storage.
async function checkPin(pin) {
    try {
        const res = await fetch('/api/auth/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        const data = await res.json().catch(() => ({}));
        return { ok: !!data.ok, message: data.message };
    } catch (e) {
        return { ok: false, message: 'Cannot reach the server.' };
    }
}
window.checkPin = checkPin;

const OPERATOR = { name: 'Operator', username: 'operator', role: 'operator' };
let signedIn = false;

function showApp() {
    signedIn = true;
    window.currentUser = OPERATOR;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('main-app').style.display = 'flex';
    openLastTab();
}

function showLogin(message) {
    signedIn = false;
    window.currentUser = null;
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
    const errEl = document.getElementById('login-err');
    if (errEl && message) { errEl.textContent = message; errEl.style.display = 'block'; }
    const pinEl = document.getElementById('login-pin');
    if (pinEl) pinEl.focus();
}

// Any API call that comes back 401 means the session ended (expired or signed out elsewhere).
(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
        const res = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
        if (res.status === 401 && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
            if (signedIn) showLogin('You were signed out. Enter your PIN again.');
            else if (document.getElementById('login-screen').style.display !== 'flex') showLogin();
        }
        return res;
    };
})();

window.initAuth = async function() {
    sessionStorage.removeItem('active_user'); // left over from the old browser-only sign-in
    let me = null;
    try { me = await fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()); } catch (e) { me = null; }
    if (me && me.signedIn) showApp();
    else showLogin(me ? '' : 'Cannot reach the server.');
};

window.handleLogin = async function(e) {
    e.preventDefault();
    const pinEl = document.getElementById('login-pin');
    const errEl = document.getElementById('login-err');
    const btn = document.getElementById('login-btn');
    const pin = pinEl.value.trim();
    if (!pin) return;

    btn.disabled = true;
    const result = await checkPin(pin);
    btn.disabled = false;

    if (result.ok) {
        errEl.style.display = 'none';
        pinEl.value = '';
        // Reload so every screen loads its data with the new session.
        window.location.reload();
    } else {
        errEl.textContent = result.message || 'Incorrect PIN';
        errEl.style.display = 'block';
        pinEl.value = '';
        pinEl.focus();
    }
};

window.logout = async function() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* signed out locally anyway */ }
    localStorage.removeItem('last_active_tab');
    window.location.reload();
};

function openLastTab() {
    const last = window.location.hash.substring(1) || localStorage.getItem('last_active_tab');
    const validTabs = ['broadcast', 'contacts', 'history', 'api', 'settings'];
    go(last && validTabs.includes(last) ? last : 'broadcast');
}
