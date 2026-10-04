window.currentUser = null;

// The PIN is checked by the server against APP_PIN in .env; it never ships to the browser.
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

function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('main-app').style.display = 'flex';
    openLastTab();
}

window.initAuth = function() {
    const session = sessionStorage.getItem('active_user');
    if (session) {
        window.currentUser = JSON.parse(session);
        showApp();
    } else {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('main-app').style.display = 'none';
        const pinEl = document.getElementById('login-pin');
        if (pinEl) pinEl.focus();
    }
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
        window.currentUser = { name: 'Operator', username: 'operator', role: 'operator' };
        sessionStorage.setItem('active_user', JSON.stringify(window.currentUser));
        errEl.style.display = 'none';
        pinEl.value = '';
        showApp();
    } else {
        errEl.textContent = result.message || 'Incorrect PIN';
        errEl.style.display = 'block';
        pinEl.value = '';
        pinEl.focus();
    }
};

window.logout = function() {
    sessionStorage.removeItem('active_user');
    localStorage.removeItem('last_active_tab');
    window.location.reload();
};

function openLastTab() {
    const last = window.location.hash.substring(1) || localStorage.getItem('last_active_tab');
    const validTabs = ['broadcast', 'contacts', 'history', 'api', 'settings'];
    go(last && validTabs.includes(last) ? last : 'broadcast');
}
