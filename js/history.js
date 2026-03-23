let historyData = [];

window.loadHistory = async function() {
    try {
        const res = await fetch('/api/history');
        if (res.ok) {
            historyData = await res.json();
            const badge = document.getElementById('hist-badge');
            if(badge) badge.style.display = 'none';
        } else {
            throw new Error('API error');
        }
    } catch(e) {
        historyData = JSON.parse(localStorage.getItem('cast_hist') || '[]');
        const badge = document.getElementById('hist-badge');
        if(badge) badge.style.display = 'inline-block';
    }
    window.renderHistory();
    window.updateMetrics();
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

window.updateMetrics = function() {
    const today = new Date().toDateString();
    
    let total = 0;
    let ok = 0;
    let cost = 0;

    historyData.forEach(h => {
        if (new Date(h.date).toDateString() === today) {
            total += h.total || 0;
            ok += h.successful || 0;
        }
    });
    
    cost = ok * 0.70;

    const totalEl = document.getElementById('m-total');
    const okEl = document.getElementById('m-ok');
    const costEl = document.getElementById('m-cost');

    if (totalEl) totalEl.textContent = total;
    if (okEl) okEl.textContent = ok;
    if (costEl) costEl.textContent = '₹' + cost.toFixed(2);
};

window.renderHistory = function() {
    const list = document.getElementById('hist-list');
    if(!list) return;
    
    if (!historyData.length) {
        list.innerHTML = '<div class="empty">No broadcasts found.</div>';
        return;
    }
    list.innerHTML = historyData.map((h, i) => {
        return `
        <div class="block" style="margin-bottom:12px;">
            <div class="block-body" style="padding:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                    <div class="hist-meta">${new Date(h.date).toLocaleString()} <span style="margin-left:8px;color:var(--text3)">by ${h.sentBy || 'Operator'}</span></div>
                    <button class="btn btn-secondary btn-sm" onclick="repeatBroadcast(${i})" style="width:auto; padding:4px 10px; font-size:10px;">RE-USE BROADCAST</button>
                </div>
                <div class="hist-msg">"${h.message}"</div>
                <div class="flex-between" style="margin-top:10px;">
                    <div class="badge" style="background:transparent;border-color:var(--border);">Total: ${h.total}</div>
                    <div class="badge">Sent: ${h.successful}</div>
                    <div class="badge" style="background:rgba(248,113,113,.1);color:var(--error);border-color:rgba(248,113,113,.2)">Fail: ${h.failed}</div>
                </div>
            </div>
        </div>
        `;
    }).join('');
};

window.repeatBroadcast = function(index) {
    const h = historyData[index];
    if(!h) return;

    const msgEl = document.getElementById('msg');
    const numsEl = document.getElementById('numbers');

    if(msgEl) {
        msgEl.value = h.message;
    }
    if(numsEl && h.recipients) {
        numsEl.value = h.recipients;
    }

    if(window.preview) window.preview();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
    
    go('broadcast');
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadHistory();
});
