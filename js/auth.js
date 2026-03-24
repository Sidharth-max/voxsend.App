window.currentUser = null;

let appUsers = [
    { name: 'Sidharth Falodia', username: 'Sidharth.falodia@pjpt.org', pass: 'Sidharth@12', role: 'operator', date: new Date().toLocaleDateString() }
];

function loadUsersData() {
    try {
        const saved = JSON.parse(localStorage.getItem('app_users'));
        if (saved && saved.length) {
            appUsers = saved;
        }
    } catch(e) {}
    // Ensure operator always exists if wiped
    if (!appUsers.find(u => u.role === 'operator')) {
        appUsers.push({ name: 'Operator', username: 'Sidharth.falodia@pjpt.org', pass: 'Sidharth@12', role: 'operator', date: new Date().toLocaleDateString() });
    }
}

function saveUsersData() {
    localStorage.setItem('app_users', JSON.stringify(appUsers));
}

window.initAuth = function() {
    loadUsersData();
    const session = sessionStorage.getItem('active_user');
    if (session) {
        window.currentUser = JSON.parse(session);
        applyRoleRestrictions();
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';
        renderUsers();
    } else {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('main-app').style.display = 'none';
    }
};

window.handleLogin = function(e) {
    e.preventDefault();
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value.trim();
    
    const user = appUsers.find(x => x.username.toLowerCase() === u.toLowerCase() && x.pass === p);
    if (user) {
        window.currentUser = { name: user.name, username: user.username, role: user.role };
        sessionStorage.setItem('active_user', JSON.stringify(window.currentUser));
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('login-err').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';
        applyRoleRestrictions();
        renderUsers();
    } else {
        document.getElementById('login-err').style.display = 'block';
    }
};

window.logout = function() {
    sessionStorage.removeItem('active_user');
    localStorage.removeItem('last_active_tab');
    window.location.reload();
};

window.togglePass = function(id) {
    const el = document.getElementById(id);
    if (el.type === 'password') {
        el.type = 'text';
    } else {
        el.type = 'password';
    }
};

function applyRoleRestrictions() {
    const r = window.currentUser.role;
    
    // Admin features in Settings
    const showAdmin = r === 'operator';
    const adminSec = document.getElementById('admin-section');
    if (adminSec) adminSec.style.display = showAdmin ? 'block' : 'none';

    // Sender features
    const canSend = r === 'operator' || r === 'sender';
    ['snav-broadcast', 'snav-contacts', 'snav-api', 'tnav-broadcast', 'tnav-contacts', 'tnav-api', 'bnav-broadcast', 'bnav-contacts', 'bnav-api'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = canSend ? '' : 'none';
    });

    if (r === 'viewer') {
        const last = window.location.hash.substring(1) || localStorage.getItem('last_active_tab');
        if (last === 'settings' || last === 'history') {
            go(last);
        } else {
            go('history');
        }
    } else {
        const last = window.location.hash.substring(1) || localStorage.getItem('last_active_tab');
        const validTabs = ['broadcast', 'contacts', 'history', 'api', 'settings'];
        if (last && validTabs.includes(last)) {
            go(last);
        } else {
            go('broadcast');
        }
    }
}

// User Management Methods
window.renderUsers = function() {
    if (!window.currentUser || window.currentUser.role !== 'operator') return;
    const tb = document.getElementById('users-tbody');
    if (!tb) return;
    
    tb.innerHTML = appUsers.map(u => `
        <tr>
            <td><div style="font-weight:500;color:var(--text)">${u.name}</div></td>
            <td><div class="mono" style="color:var(--text2)">${u.username}</div></td>
            <td><span class="badge ${u.role === 'operator' ? 'op' : ''}">${u.role}</span></td>
            <td>
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-secondary btn-sm" onclick="changePwd('${u.username}')" style="padding:4px 8px;">Pwd</button>
                    ${u.role !== 'operator' ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${u.username}')" style="padding:4px 8px;">Del</button>` : ''}
                </div>
            </td>
        </tr>
    `).join('');
};

window.addUser = function(e) {
    e.preventDefault();
    const name = document.getElementById('add-u-name').value.trim();
    const username = document.getElementById('add-u-email').value.trim();
    const pass = document.getElementById('add-u-pass').value.trim();
    const role = document.getElementById('add-u-role').value;
    
    if (appUsers.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return window.showToast("Username already exists!", "error");
    }
    
    appUsers.push({ name, username, pass, role, date: new Date().toLocaleDateString() });
    saveUsersData();
    renderUsers();
    
    document.getElementById('add-u-name').value = '';
    document.getElementById('add-u-email').value = '';
    document.getElementById('add-u-pass').value = '';
    window.showToast("User added!", "success");
};

window.deleteUser = async function(username) {
    const confirmed = await window.showConfirm(`Delete user ${username}?`);
    if (confirmed) {
        appUsers = appUsers.filter(u => u.username !== username);
        saveUsersData();
        renderUsers();
    }
};

window.changePwd = async function(username) {
    const user = appUsers.find(u => u.username === username);
    if (!user) return;
    
    if (user.role === 'operator') {
        const cur = await window.showPrompt("Enter current operator password to authorize change:", "password");
        if (cur !== user.pass) return window.showToast("Incorrect current password.", "error");
    }
    
    const next = await window.showPrompt(`Enter new password for ${username}:`, "password");
    if (next && next.trim()) {
        user.pass = next.trim();
        saveUsersData();
        window.showToast("Password updated.", "success");
    }
};

window.verifySessionPassword = function(pass) {
    if (!window.currentUser) return false;
    const user = appUsers.find(u => u.username === window.currentUser.username);
    return user && user.pass === pass;
};
