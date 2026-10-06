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

// Until the user picks a History sub-tab, Sarvam setups open on Sarvam Conversations.
let histTabPicked = false;

window.setHistTab = function(tab, picked) {
    if (picked) histTabPicked = true;
    ['broadcast', 'vobiz', 'sarvam'].forEach(t => {
        const btn = document.getElementById('sub-' + t);
        const cont = document.getElementById('hist-' + t + '-content');
        if (btn) btn.classList.toggle('active', t === tab);
        if (cont) cont.style.display = t === tab ? 'block' : 'none';
    });
    if (tab === 'vobiz') window.loadVobizLogs();
    if (tab === 'sarvam') window.loadSarvamCalls();
};
window.histTabWasPicked = () => histTabPicked;

const SARVAM_STATUS = {
    queued: ['Waiting for result', ''], connected: ['Answered', 'badge-success'],
    no_answer: ['No answer', 'badge-danger'], busy: ['Busy', 'badge-danger'], failed: ['Failed', 'badge-danger']
};

// Sarvam transcript turns vary in shape; pull out a speaker, the words as spoken, and an
// English translation when Sarvam sends one ({ role, indic_text, en_text }).
const transcriptTurn = (turn) => {
    if (typeof turn === 'string') return { who: '', text: turn, en: '' };
    if (!turn || typeof turn !== 'object') return { who: '', text: String(turn ?? ''), en: '' };
    const role = String(turn.role || turn.speaker || turn.sender || '').toLowerCase();
    const who = /user|caller|human|customer/.test(role) ? 'Caller' : (role ? 'Agent' : '');
    const pick = (...keys) => keys.map(k => turn[k]).find(v => typeof v === 'string' && v.trim()) || '';
    const en = pick('en_text', 'english_text', 'translation');
    const text = pick('indic_text', 'content', 'text', 'message', 'transcript', 'utterance') || en;
    return { who, text, en: en && en.trim() !== text.trim() ? en : '' };
};

// "call_summary" -> "Call summary"
const prettyKey = k => String(k).replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase());

// Contacts name lookup, matched on the last 10 digits so +91 / 0 prefixes still match.
const phoneKey = p => String(p || '').replace(/\D/g, '').slice(-10);
const loadContactNames = async () => {
    const names = new Map();
    try {
        const book = await fetch('/api/contacts').then(r => r.json());
        (Array.isArray(book) ? book : []).forEach(c => { if (c.name && phoneKey(c.phone)) names.set(phoneKey(c.phone), c.name); });
    } catch (e) {}
    return names;
};

// One Sarvam call as a card: caller, status, conversation, collected details.
function renderSarvamCard(r, names) {
    const item = document.createElement('div');
    item.className = 'block panel';
    item.style.marginBottom = '10px';
    const body = document.createElement('div');
    body.className = 'block-body';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;';
    const left = document.createElement('div');
    const num = document.createElement('div');
    num.className = 'convo-caller';
    const name = names.get(phoneKey(r.phone));
    if (name) {
        const n = document.createElement('span');
        n.className = 'convo-name';
        n.textContent = name;
        num.appendChild(n);
    }
    // Tapping the number calls it exactly as stored (+91...), never a locally rewritten 0...
    const dial = String(r.phone || '').replace(/[^\d+]/g, '');
    const ph = document.createElement(dial ? 'a' : 'span');
    ph.className = 'mono convo-phone';
    if (dial) {
        ph.href = 'tel:' + (dial.startsWith('+') ? dial : (dial.length === 10 ? '+91' + dial : '+' + dial));
        ph.title = 'Call ' + r.phone;
    }
    ph.textContent = r.phone || 'Unknown number';
    num.appendChild(ph);
    const when = document.createElement('div');
    when.className = 'hint';
    const secs = r.duration ? ` · ${Math.round(r.duration)}s` : '';
    when.textContent = new Date((r.created_at || '').replace(' ', 'T') + 'Z').toLocaleString() + secs;
    left.append(num, when);
    const [label, cls] = SARVAM_STATUS[r.status] || [r.status, ''];
    const badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = label;
    head.append(left, badge);
    body.appendChild(head);

    if (r.failure_reason) {
        const fr = document.createElement('div');
        fr.className = 'hint';
        fr.style.cssText = 'color:var(--error); margin-top:6px;';
        fr.textContent = r.failure_reason;
        body.appendChild(fr);
    }

    const turns = Array.isArray(r.transcript) ? r.transcript : [];
    if (turns.length) {
        const det = window.VxDisclosure(`Conversation (${turns.length} ${turns.length === 1 ? 'turn' : 'turns'})`, body => {
            // Own wrapper: a display rule on the disclosure body would override its hidden state
            const box = document.createElement('div');
            box.className = 'convo';
            body.appendChild(box);
            turns.forEach(t => {
                const { who, text, en } = transcriptTurn(t);
                if (!text) return;
                const msg = document.createElement('div');
                msg.className = 'convo-msg ' + (who === 'Caller' ? 'is-caller' : 'is-agent');
                const w = document.createElement('div');
                w.className = 'convo-who';
                w.textContent = who || 'Speaker';
                const said = document.createElement('div');
                said.className = 'convo-text';
                said.textContent = text;
                msg.append(w, said);
                if (en) {
                    const tr = document.createElement('div');
                    tr.className = 'convo-en';
                    tr.textContent = en;
                    msg.appendChild(tr);
                }
                box.appendChild(msg);
            });
        });
        body.appendChild(det);
    }

    // Details the agent collected (name, summary, ...). Empty values are left out.
    const vars = Object.entries(r.agent_variables || {}).filter(([, val]) =>
        val !== null && val !== undefined && String(typeof val === 'object' ? JSON.stringify(val) : val).trim() &&
        !(typeof val === 'object' && !Object.keys(val).length));
    if (vars.length) {
        const dl = document.createElement('dl');
        dl.className = 'convo-vars';
        vars.forEach(([k, val]) => {
            const dt = document.createElement('dt');
            dt.textContent = prettyKey(k);
            const dd = document.createElement('dd');
            dd.textContent = typeof val === 'object'
                ? (Array.isArray(val) ? val.join(', ') : Object.entries(val).map(([a, b]) => `${prettyKey(a)}: ${b}`).join(' · '))
                : String(val);
            dl.append(dt, dd);
        });
        body.appendChild(dl);
    }

    item.appendChild(body);
    return item;
}

// A list of Sarvam calls that loads page by page as it scrolls into view, until every
// call is shown. opts.phone limits it to one person. Returns { reload }.
function SarvamFeed(list, empty, opts = {}) {
    const PAGE = 30;
    let names = new Map(), next = null, done = false, busy = false, gen = 0, shown = 0;
    const status = document.createElement('div');
    status.className = 'feed-status';
    const io = 'IntersectionObserver' in window
        ? new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '600px 0px' })
        : null;

    const setStatus = (text, retry) => {
        status.textContent = text;
        if (retry) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-secondary btn-sm';
            b.textContent = 'Retry';
            b.onclick = () => loadMore();
            status.append(' ', b);
        }
    };

    async function loadMore() {
        if (busy || done) return;
        busy = true;
        const mine = gen;
        setStatus('Loading conversations…');
        const q = new URLSearchParams({ limit: PAGE });
        if (next) q.set('cursor', next);
        if (opts.phone) q.set('phone', opts.phone);
        let data;
        try {
            const res = await fetch('/api/sarvam/calls?' + q);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            data = await res.json();
        } catch (e) {
            if (mine === gen) { busy = false; setStatus('Could not load conversations.', true); }
            return;
        }
        if (mine !== gen) return; // a reload started meanwhile
        const frag = document.createDocumentFragment();
        (data.rows || []).forEach(r => frag.appendChild(renderSarvamCard(r, names)));
        list.insertBefore(frag, status);
        shown += (data.rows || []).length;
        next = data.next;
        done = !next;
        busy = false;
        if (empty) empty.style.display = shown ? 'none' : 'block';
        if (done) {
            if (io) io.disconnect();
            setStatus(shown ? `All ${shown} conversation${shown === 1 ? '' : 's'} loaded` : '');
        } else {
            setStatus(`Showing ${shown} of ${data.total}`);
            // Short pages may leave the marker on screen: keep going without waiting for a scroll
            if (io) { io.unobserve(status); io.observe(status); } else loadMore();
        }
    }

    async function reload(newOpts) {
        if (newOpts) opts = newOpts;
        gen++;
        busy = false; done = false; next = null; shown = 0;
        list.innerHTML = '';
        list.appendChild(status);
        if (empty) empty.style.display = 'none';
        setStatus('Loading conversations…');
        const mine = gen;
        const n = await loadContactNames();
        if (mine !== gen) return;
        names = n;
        if (io) io.observe(status);
        await loadMore();
    }

    return { reload };
}

let historyFeed = null;
window.loadSarvamCalls = function() {
    const list = document.getElementById('sarvam-calls-list');
    if (!list) return;
    if (!historyFeed) historyFeed = SarvamFeed(list, document.getElementById('sarvam-calls-empty'));
    return historyFeed.reload();
};

// All Sarvam conversations with one person (opened from Contacts).
let personFeed = null;
window.openPersonConversations = function(phone, name) {
    const modal = document.getElementById('convo-modal');
    if (!modal) return;
    document.getElementById('convo-modal-title').textContent = name || phone;
    const sub = document.getElementById('convo-modal-phone');
    sub.textContent = name ? phone : '';
    if (!personFeed) personFeed = SarvamFeed(document.getElementById('convo-modal-list'), document.getElementById('convo-modal-empty'));
    window.vxShowModal(modal);
    personFeed.reload({ phone });
};
window.closePersonConversations = function() {
    window.vxHideModal(document.getElementById('convo-modal'));
};

window.loadVobizLogs = async function() {
    const c = await window.getCfg();
    if (c.provider !== 'vobiz') return;

    try {
        const res = await fetch('/api/vobiz/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
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

        if (walletWrap) walletWrap.style.display = 'flex';
        
        try {
            const res = await fetch('/api/vobiz/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await res.json();
            if (data.balance !== undefined) {
                const formatted = `₹${Number(data.balance).toFixed(2)}`;
                if (walletBal) walletBal.textContent = formatted;
                const mini = document.getElementById('sidebar-balance-mini');
                if (mini) mini.textContent = formatted;
            }
        } catch (e) {
            console.error('Failed to fetch balance:', e);
        }
    } else {
        const walletWrap = document.getElementById('wallet-wrap');
        if (walletWrap) walletWrap.style.display = 'none';
    }
};

// Extract phone numbers from failed/missed log entries
window.getFailedNumbers = function(h) {
    let logs = [];
    try { logs = typeof h.results === 'string' ? JSON.parse(h.results) : (h.results || []); } catch(e) {}
    const failed = [];
    logs.forEach(log => {
        const unanswered = log.type === 'info' && /: (no answer|line busy)$/.test(log.text || '');
        if (log.type !== 'err' && !unanswered) return;
        // Log format: "[provider] Failed +91XXXXXXXXXX: <reason>"  or  "Network error: ... for +91XXXXXXXXXX"
        const matches = (log.text || '').match(/\+\d{7,15}/g);
        if (matches) failed.push(...matches);
    });
    // Deduplicate
    return [...new Set(failed)];
};

window.retryFailedCalls = function(index) {
    const h = historyData[index];
    if (!h) return;
    const failed = window.getFailedNumbers(h);
    if (!failed.length) { window.showToast("No failed numbers found.", "info"); return; }

    const msgEl = document.getElementById('msg');
    // Agent-greeting broadcasts are stored with a label, not a real message: retry with an empty box.
    if (msgEl) msgEl.value = h.message === '(Sarvam agent greeting)' ? '' : (h.message || '');
    if (window.preview) window.preview();

    if (typeof window.setRecipientNumbers === 'function') {
        window.setRecipientNumbers(failed);
    } else {
        const numsEl = document.getElementById('numbers');
        if (numsEl) numsEl.value = failed.join('\n');
    }

    window.showToast(`Loaded ${failed.length} failed number${failed.length > 1 ? 's' : ''} for retry.`, "success");
    go('broadcast');
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

                <div class="hist-card-actions" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); repeatBroadcast(${h._index})" style="width:auto; height:32px; font-size:11px; padding:0 12px;">
                            RE-USE BROADCAST
                        </button>
                        ${window.getFailedNumbers(h).length > 0 ? `
                        <button class="btn btn-sm" onclick="event.stopPropagation(); retryFailedCalls(${h._index})" style="width:auto; height:32px; font-size:11px; padding:0 12px; background:var(--warning, #f59e0b); color:#000; border:none; border-radius:6px; cursor:pointer; font-weight:600;">
                            ↺ RETRY ${window.getFailedNumbers(h).length} FAILED
                        </button>` : ''}
                    </div>
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

    // setup retry failed button — only show if there are failed numbers
    const retryBtn = document.getElementById('mdl-retry-failed');
    const failedNums = window.getFailedNumbers(h);
    if (retryBtn) {
        if (failedNums.length > 0) {
            retryBtn.style.display = 'inline-flex';
            retryBtn.textContent = `↺ Retry ${failedNums.length} Failed`;
            retryBtn.onclick = () => {
                closeHistoryDetails();
                retryFailedCalls(index);
            };
        } else {
            retryBtn.style.display = 'none';
        }
    }

    window.vxShowModal(document.getElementById('hist-modal'));
};

window.closeHistoryDetails = function() {
    window.vxHideModal(document.getElementById('hist-modal'));
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
