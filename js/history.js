let historyData = [];

window.loadHistory = async function() {
    try {
        const res = await fetch('/api/history');
        if (res.ok) {
            let data = await res.json();
            historyData = data.map(h => ({
                ...h,
                date: h.created_at || h.date,
                failed: typeof h.failed !== 'undefined' ? h.failed : (h.total - h.successful)
            }));
            const badge = document.getElementById('hist-badge');
            if(badge) badge.style.display = 'none';
        }
    } catch(e) {
        let localData = JSON.parse(localStorage.getItem('cast_hist') || '[]');
        historyData = localData.map(h => ({
            ...h,
            date: h.created_at || h.date,
            failed: typeof h.failed !== 'undefined' ? h.failed : (h.total - h.successful)
        }));
    }
    window.renderHistory();
    window.updateMetrics();
    window.loadVobizLogs();
};

window.setHistTab = function(tab) {
    const bBtn = document.getElementById('sub-broadcast');
    const vBtn = document.getElementById('sub-vobiz');
    const bCont = document.getElementById('hist-broadcast-content');
    const vCont = document.getElementById('hist-vobiz-content');

    if (tab === 'vobiz') {
        bBtn.classList.remove('active');
        vBtn.classList.add('active');
        bCont.style.display = 'none';
        vCont.style.display = 'block';
        window.loadVobizLogs();
    } else {
        bBtn.classList.add('active');
        vBtn.classList.remove('active');
        bCont.style.display = 'block';
        vCont.style.display = 'none';
    }
};

window.loadVobizLogs = async function() {
    const c = await window.getCfg();
    if (c.provider !== 'vobiz') return;

    try {
        const res = await fetch('/api/vobiz/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: c.vobiz_id, token: c.vobiz_token })
        });
        const data = await res.json();
        // Vobiz API returns logs in 'data' array
        const logs = data.data || data.cdrs || (Array.isArray(data) ? data : []);
        
        const list = document.getElementById('vobiz-logs-list');
        const empty = document.getElementById('vobiz-logs-empty');
        if (!list) return;

        list.innerHTML = '';
        if (logs.length === 0) {
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';

        logs.forEach(l => {
            const row = document.createElement('tr');
            // Mapping Vobiz fields: destination_number, start_time, duration, hangup_cause, total_cost
            const num = l.destination_number || l.to_number || 'Unknown';
            const time = l.start_time ? new Date(l.start_time).toLocaleString() : 'N/A';
            const dur = l.duration || 0;
            const status = l.hangup_cause || l.status || 'N/A';
            const cost = l.total_cost || l.cost || 0;
            
            row.innerHTML = `
                <td style="font-size:12px; color:var(--text2)">${time}</td>
                <td class="mono">${num}</td>
                <td>${dur}s</td>
                <td><span class="badge ${status === 'NORMAL_CLEARING' || status === 'completed' ? 'badge-success' : 'badge-danger'}">${status}</span></td>
                <td class="mono">₹${Number(cost).toFixed(2)}</td>
            `;
            list.appendChild(row);
        });
    } catch (e) {
        console.error('Failed to load Vobiz logs:', e);
    }
};

window.saveHistoryEntry = async function(entry) {
    historyData.unshift(entry);
    if(historyData.length > 50) historyData.pop();
    
    try {
        const res = await fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(historyData)
        });
        if(!res.ok) throw new Error('API failure');
    } catch(e) {
        localStorage.setItem('cast_hist', JSON.stringify(historyData));
    }
    window.renderHistory();
    window.updateMetrics();
};

window.deleteHistoryEntry = async function(index, id) {
    const confirmed = await window.showConfirm('Are you sure you want to delete this history record?');
    if(!confirmed) return;
    
    historyData.splice(index, 1);
    
    try {
        if(id) {
            await fetch('/api/history', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
        }
    } catch(e) {
        console.error('Failed to delete history on server:', e);
        localStorage.setItem('cast_hist', JSON.stringify(historyData));
    }
    
    window.renderHistory();
    window.updateMetrics();
};

window.deleteAllHistory = async function() {
    if(!historyData.length) {
        window.showToast("History is already empty.", "info");
        return;
    }
    const confirmed = await window.showConfirm("Are you sure you want to delete ALL history? This cannot be undone.");
    if(!confirmed) return;

    historyData = [];
    localStorage.removeItem('cast_hist');

    try {
        await fetch('/api/history', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}) // No id clears all
        });
    } catch(e) {
        console.error('Failed to clear history on server:', e);
    }
    
    window.renderHistory();
    window.updateMetrics();
};

window.updateMetrics = async function() {
    let total = 0;
    let ok = 0;
    let cost = 0;

    historyData.forEach(h => {
        total += h.total || 0;
        ok += h.successful || 0;
    });
    
    cost = ok * 0.70;

    const totalEl = document.getElementById('m-total');
    const okEl = document.getElementById('m-ok');
    const costEl = document.getElementById('m-cost');

    if (totalEl) totalEl.textContent = total;
    if (okEl) okEl.textContent = ok;
    if (costEl) costEl.textContent = '₹' + cost.toFixed(2);

    // Update wallet balance if Vobiz
    const c = await window.getCfg();
    if (c.provider === 'vobiz' && c.vobiz_id) {
        const walletWrap = document.getElementById('wallet-wrap');
        const walletBal = document.getElementById('wallet-balance');
        const mWalletWrap = document.getElementById('mobile-wallet-wrap');
        const mWalletBal = document.getElementById('mobile-wallet-balance');

        if (walletWrap) walletWrap.style.display = 'flex';
        if (mWalletWrap) mWalletWrap.style.display = 'flex';
        
        try {
            const res = await fetch('/api/vobiz/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sid: c.vobiz_id, token: c.vobiz_token })
            });
            const data = await res.json();
            if (data.balance !== undefined) {
                const formatted = `₹${Number(data.balance).toFixed(2)}`;
                if (walletBal) walletBal.textContent = formatted;
                if (mWalletBal) mWalletBal.textContent = formatted;
            }
        } catch (e) {
            console.error('Failed to fetch balance:', e);
        }
    } else {
        const walletWrap = document.getElementById('wallet-wrap');
        const mWalletWrap = document.getElementById('mobile-wallet-wrap');
        if (walletWrap) walletWrap.style.display = 'none';
        if (mWalletWrap) mWalletWrap.style.display = 'none';
    }
};

window.renderHistory = function() {
    const list = document.getElementById('hist-list');
    if(!list) return;
    
    if (!historyData.length) {
        list.innerHTML = '<div class="empty">No broadcasts found.</div>';
        return;
    }

    // Date grouping logic
    const groups = {
        'Today': [],
        'Yesterday': [],
        'Older': []
    };

    const now = new Date();
    const todayStr = now.toDateString();
    const yest = new Date();
    yest.setDate(now.getDate() - 1);
    const yestStr = yest.toDateString();

    historyData.forEach((h, i) => {
        h._index = i; // keep original index for callback
        const d = new Date(h.date);
        const dStr = d.toDateString();
        
        if (dStr === todayStr) groups['Today'].push(h);
        else if (dStr === yestStr) groups['Yesterday'].push(h);
        else groups['Older'].push(h);
    });

    let html = '';
    for (const [label, items] of Object.entries(groups)) {
        if (!items.length) continue;
        
        html += `<div class="hist-date-group">
            <div class="hist-date-label">${label}</div>`;
        
        items.forEach(h => {
            const okPerf = h.total > 0 ? (h.successful / h.total) * 100 : 0;
            const errPerf = h.total > 0 ? (h.failed / h.total) * 100 : 0;

            html += `
            <div class="hist-card" onclick="showHistoryDetails(${h._index})" style="cursor:pointer">
                <div class="hist-card-hd">
                    <div class="hist-card-time">${new Date(h.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                    <div class="hist-card-op">By ${h.sentBy || 'Operator'}</div>
                </div>
                <div class="hist-card-msg">${h.message}</div>
                
                <div class="status-rail">
                    <div class="status-bar-ok" style="width: ${okPerf}%"></div>
                    <div class="status-bar-err" style="width: ${errPerf}%"></div>
                </div>

                <div class="hist-card-stats">
                    <div class="hist-stat-item">
                        <span style="opacity:0.5">Total</span>
                        <span class="hist-stat-val">${h.total}</span>
                    </div>
                    <div class="hist-stat-item">
                        <span style="color:#10b981">●</span>
                        <span style="opacity:0.5">Sent</span>
                        <span class="hist-stat-val">${h.successful}</span>
                    </div>
                    <div class="hist-stat-item">
                        <span style="color:#ef4444">●</span>
                        <span style="opacity:0.5">Fail</span>
                        <span class="hist-stat-val">${h.failed}</span>
                    </div>
                </div>

                <div class="hist-card-actions" style="display:flex; justify-content:space-between; align-items:center;">
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); repeatBroadcast(${h._index})" style="width:auto; height:32px; font-size:11px; padding:0 12px;">
                        RE-USE BROADCAST
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); deleteHistoryEntry(${h._index}, ${h.id ? h.id : 'null'})" style="width:auto; height:32px; font-size:11px; padding:0 12px; color:var(--error);">
                        DELETE
                    </button>
                </div>
            </div>
            `;
        });
        html += `</div>`;
    }

    list.innerHTML = html;
};

window.showHistoryDetails = function(index) {
    const h = historyData[index];
    if(!h) return;

    document.getElementById('mdl-msg').textContent = h.message;
    document.getElementById('mdl-date').textContent = new Date(h.date).toLocaleString();
    document.getElementById('mdl-op').textContent = h.sentBy || 'Operator';
    
    // format recipients list
    const recs = h.recipients ? h.recipients.split('\n').join('<br>') : 'No recipients data';
    document.getElementById('mdl-recipients').innerHTML = recs;

    // setup repeat button
    const repeatBtn = document.getElementById('mdl-repeat');
    repeatBtn.onclick = () => {
        closeHistoryDetails();
        repeatBroadcast(index);
    };

    document.getElementById('hist-modal').style.display = 'flex';
};

window.closeHistoryDetails = function() {
    document.getElementById('hist-modal').style.display = 'none';
};

window.repeatBroadcast = function(index) {
    const h = historyData[index];
    if(!h) return;

    const msgEl = document.getElementById('msg');
    const numsEl = document.getElementById('numbers');

    if(msgEl) {
        msgEl.value = h.message;
    }
    let handledRecipients = false;
    if(numsEl && h.recipients) {
        if (typeof window.setRecipientNumbers === 'function') {
            window.setRecipientNumbers(h.recipients.split('\n'));
            handledRecipients = true;
        } else {
            numsEl.value = h.recipients;
        }
    }

    if(!handledRecipients) {
        if(window.preview) window.preview();
        if(window.renderBroadcastContacts) window.renderBroadcastContacts();
    }
    
    go('broadcast');
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadHistory();
});
