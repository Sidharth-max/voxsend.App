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
    
    // Admin tabs visibility
    const showAdmin = r === 'operator';
    ['snav-users', 'snav-users-lbl', 'tnav-users', 'bnav-users'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showAdmin ? '' : 'none';
    });

    // Sender features
    const canSend = r === 'operator' || r === 'sender';
    ['snav-broadcast', 'snav-contacts', 'snav-api', 'tnav-broadcast', 'tnav-contacts', 'tnav-api', 'bnav-broadcast', 'bnav-contacts', 'bnav-api'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = canSend ? '' : 'none';
    });

    if (r === 'viewer') {
        go('history');
    } else {
        go('broadcast');
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
        return alert("Username already exists!");
    }
    
    appUsers.push({ name, username, pass, role, date: new Date().toLocaleDateString() });
    saveUsersData();
    renderUsers();
    
    document.getElementById('add-u-name').value = '';
    document.getElementById('add-u-email').value = '';
    document.getElementById('add-u-pass').value = '';
    alert("User added!");
};

window.deleteUser = function(username) {
    if (confirm(`Delete user ${username}?`)) {
        appUsers = appUsers.filter(u => u.username !== username);
        saveUsersData();
        renderUsers();
    }
};

window.changePwd = function(username) {
    const user = appUsers.find(u => u.username === username);
    if (!user) return;
    
    if (user.role === 'operator') {
        const cur = prompt("Enter current operator password to authorize change:");
        if (cur !== user.pass) return alert("Incorrect current password.");
    }
    
    const next = prompt(`Enter new password for ${username}:`);
    if (next && next.trim()) {
        user.pass = next.trim();
        saveUsersData();
        alert("Password updated.");
    }
};

window.verifySessionPassword = function(pass) {
    if (!window.currentUser) return false;
    const user = appUsers.find(u => u.username === window.currentUser.username);
    return user && user.pass === pass;
};
