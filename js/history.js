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
    ['broadcast', 'vobiz', 'sarvam', 'scheduled'].forEach(t => {
        const btn = document.getElementById('sub-' + t);
        const cont = document.getElementById('hist-' + t + '-content');
        if (btn) btn.classList.toggle('active', t === tab);
        if (cont) cont.style.display = t === tab ? 'block' : 'none';
    });
    if (tab === 'vobiz') window.loadVobizLogs();
    if (tab === 'sarvam') { window.loadCallAgents(); window.loadCalls(); }
    if (tab === 'scheduled' && window.loadSchedules) window.loadSchedules();
};
window.histTabWasPicked = () => histTabPicked;

const SARVAM_STATUS = {
    queued: ['Waiting for result', ''], connected: ['Answered', 'badge-success'], completed: ['Answered', 'badge-success'],
    answered: ['Answered', 'badge-success'], no_answer: ['No answer', 'badge-danger'], busy: ['Busy', 'badge-danger'],
    not_connected: ['Not connected', 'badge-danger'], failed: ['Failed', 'badge-danger'], unknown: ['Unknown', '']
};

const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ── Call history (Sarvam analytics, stored on the server) ──
let callsOffset = 0;
let callsTimer = null;
window.queueCallsReload = function() {
    clearTimeout(callsTimer);
    callsTimer = setTimeout(() => window.loadCalls(), 300);
};

window.loadCallAgents = async function() {
    const el = document.getElementById('calls-agent');
    if (!el || el.dataset.loaded) return;
    try {
        const rows = await fetch('/api/agents').then(r => r.ok ? r.json() : []);
        rows.forEach(a => {
            const o = document.createElement('option');
            o.value = String(a.id);
            o.textContent = a.label + (a.active ? '' : ' (inactive)');
            el.appendChild(o);
        });
        el.dataset.loaded = '1';
    } catch (e) { /* the filter just stays at "All agents" */ }
};

const callQuery = () => {
    const p = new URLSearchParams();
    const q = document.getElementById('calls-search').value.trim();
    if (q) p.set('q', q);
    const st = document.getElementById('calls-status').value;
    if (st) p.set('status', st);
    const ag = document.getElementById('calls-agent').value;
    if (ag) p.set('agentId', ag);
    const days = document.getElementById('calls-range').value;
    if (days) p.set('from', new Date(Date.now() - Number(days) * 86400000).toISOString());
    return p;
};

window.loadCalls = async function(more) {
    const list = document.getElementById('sarvam-calls-list');
    const empty = document.getElementById('sarvam-calls-empty');
    const moreBtn = document.getElementById('calls-more');
    const summary = document.getElementById('calls-summary');
    if (!list) return;
    callsOffset = more === true ? callsOffset : 0;
    const p = callQuery();
    p.set('limit', '50');
    p.set('offset', String(callsOffset));
    let data;
    try {
        const res = await fetch('/api/calls?' + p.toString());
        if (!res.ok) return;
        data = await res.json();
    } catch (e) { return; }
    if (more !== true) list.innerHTML = '';
    const items = data.items || [];
    items.forEach(r => list.appendChild(callCard(r)));
    callsOffset += items.length;
    if (empty) empty.style.display = data.total ? 'none' : 'block';
    if (moreBtn) moreBtn.style.display = callsOffset < data.total ? '' : 'none';
    if (summary) summary.textContent = data.total ? `Showing ${callsOffset} of ${data.total} call${data.total === 1 ? '' : 's'}.` : 'Call results and conversations from Sarvam. New calls are synced in the background.';
};

window.syncCalls = async function() {
    const btn = document.getElementById('calls-sync-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    const days = document.getElementById('calls-range').value;
    const res = await fetch('/api/calls/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: days ? Number(days) : 30 })
    }).then(r => r.json()).catch(() => ({ success: false, message: 'Network error.' }));
    btn.disabled = false;
    btn.textContent = 'Sync from Sarvam';
    const r = res.result || {};
    if (res.success && !r.skipped && !r.error) {
        const n = r.fetched || 0;
        const errs = (r.errors || []).length;
        window.showToast(`Synced ${n} call${n === 1 ? '' : 's'}.` + (errs ? ` ${errs} agent${errs === 1 ? '' : 's'} could not be synced.` : ''), errs ? 'error' : 'success');
        window.loadCalls();
    } else if (res.success) {
        window.showToast(r.skipped || r.error, 'error');
    } else {
        window.showToast(res.message || 'Sync failed.', 'error');
    }
};

function callCard(r) {
    const item = document.createElement('div');
    item.className = 'block panel';
    item.style.marginBottom = '10px';
    const body = document.createElement('div');
    body.className = 'block-body';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;';
    const left = document.createElement('div');
    left.style.minWidth = '0';
    const num = document.createElement('div');
    num.className = 'mono';
    num.style.color = 'var(--text)';
    num.textContent = r.phone || 'Unknown number';
    const when = document.createElement('div');
    when.className = 'hint';
    const bits = [];
    if (r.sort_at) bits.push(new Date(r.sort_at).toLocaleString());
    if (r.duration) bits.push(`${Math.round(r.duration)}s`);
    if (r.agent_label) bits.push(r.agent_label);
    if (r.ended_by) bits.push(`ended by ${r.ended_by}`);
    when.textContent = bits.join(' · ');
    left.append(num, when);
    const [label, cls] = SARVAM_STATUS[r.status] || [r.status || 'Unknown', ''];
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

    const vars = r.agent_variables && typeof r.agent_variables === 'object' && Object.keys(r.agent_variables).length ? r.agent_variables : null;
    if (vars) {
        const v = document.createElement('div');
        v.className = 'hint mono';
        v.style.cssText = 'margin-top:8px; white-space:pre-wrap;';
        v.textContent = Object.entries(vars).map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`).join('\n');
        body.appendChild(v);
    }

    const acts = document.createElement('div');
    acts.style.cssText = 'display:flex; gap:4px 16px; flex-wrap:wrap; align-items:flex-start; margin-top:6px;';
    if (r.has_transcript || r.interaction_id) {
        acts.appendChild(window.VxDisclosure(r.num_messages ? `Conversation (${r.num_messages} messages)` : 'Conversation', async box => {
            box.innerHTML = '<div class="hint" style="margin-top:8px;">Loading…</div>';
            let t;
            try {
                const res = await fetch(`/api/calls/${encodeURIComponent(r.attempt_id)}/transcript`);
                t = await res.json();
                if (!res.ok) throw new Error(t.message || 'Could not load the conversation.');
            } catch (e) {
                box.innerHTML = '';
                const err = document.createElement('div');
                err.className = 'hint';
                err.style.cssText = 'margin-top:8px; color:var(--error);';
                err.textContent = e.message || 'Could not load the conversation.';
                box.appendChild(err);
                return;
            }
            box.innerHTML = '';
            const turns = t.turns || [];
            if (!turns.length) {
                const none = document.createElement('div');
                none.className = 'hint';
                none.style.marginTop = '8px';
                none.textContent = t.note || 'No conversation was recorded for this call.';
                box.appendChild(none);
            }
            turns.forEach(turn => {
                const caller = /user|caller|human|customer/.test(turn.role || '');
                const line = document.createElement('div');
                line.style.cssText = 'margin-top:8px; font-size:0.9rem; line-height:1.5;';
                const w = document.createElement('strong');
                w.style.color = caller ? 'var(--text)' : 'var(--text2)';
                w.textContent = (caller ? 'Caller' : 'Agent') + ': ';
                line.append(w, document.createTextNode(turn.text));
                box.appendChild(line);
            });
        }));
    }
    if (r.has_recording) {
        acts.appendChild(window.VxDisclosure('Recording', box => {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.preload = 'none';
            audio.style.cssText = 'width:100%; margin-top:8px;';
            audio.src = `/api/calls/${encodeURIComponent(r.attempt_id)}/recording`;
            audio.onerror = () => {
                const err = document.createElement('div');
                err.className = 'hint';
                err.style.marginTop = '6px';
                err.textContent = 'No recording is available for this call.';
                audio.replaceWith(err);
            };
            box.appendChild(audio);
        }));
    }
    if (acts.children.length) body.appendChild(acts);
    item.appendChild(body);
    return item;
}

window.loadVobizLogs = async function() {
    const c = await window.getCfg();
    if (c.provider !== 'vobiz' || !c.configured.vobiz) return;

    try {
        // The server uses its own stored Vobiz credentials.
        const res = await fetch('/api/vobiz/logs', { method: 'POST' });
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
    if (c.provider === 'vobiz' && c.configured.vobiz) {
        const walletWrap = document.getElementById('wallet-wrap');
        const walletBal = document.getElementById('wallet-balance');

        if (walletWrap) walletWrap.style.display = 'flex';
        
        try {
            const res = await fetch('/api/vobiz/balance', { method: 'POST' });
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

const resumableHist = h => h.broadcast_id && ['interrupted', 'stopped'].includes(h.broadcast_status) && h.not_dialled > 0;

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
                    <div class="hist-card-op">By ${escapeHtml(h.sentBy || h.sent_by || 'Operator')}</div>
                </div>
                <div class="hist-card-msg">${escapeHtml(h.message)}</div>
                ${h.agent_label ? `<div class="row-sub" style="margin-top:4px;">${escapeHtml(h.agent_label)}</div>` : ''}
                ${resumableHist(h) ? `<div class="row-sub" style="margin-top:6px; color:var(--error);">${h.broadcast_status === 'stopped' ? 'Stopped' : 'Interrupted'}: ${h.not_dialled} number${h.not_dialled === 1 ? '' : 's'} not dialled yet.</div>` : ''}
                
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
                        ${resumableHist(h) ? `
                        <button class="btn btn-sm" onclick="event.stopPropagation(); resumeBroadcast(${Number(h.broadcast_id)}, ${Number(h.not_dialled)})" style="width:auto; height:32px; font-size:11px; padding:0 12px;">
                            RESUME ${Number(h.not_dialled)} LEFT
                        </button>` : ''}
                        ${window.getFailedNumbers(h).length > 0 ? `
                        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); retryFailedCalls(${h._index})" style="width:auto; height:32px; font-size:11px; padding:0 12px;">
                            Retry ${window.getFailedNumbers(h).length} failed
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
            retryBtn.textContent = `Retry ${failedNums.length} failed`;
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
