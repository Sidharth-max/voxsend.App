// History > Broadcast History: every broadcast run (manual + scheduled), newest first.
// Keyset-paginated from /api/broadcast-runs; pages are appended (never re-rendered), so
// cards that are open stay open while more load. Calls reuse the Call history card.
(function () {
    const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const IST = { timeZone: 'Asia/Kolkata' };
    const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { ...IST, day: 'numeric', month: 'short', year: 'numeric' });
    const fmtTime = d => new Date(d).toLocaleTimeString('en-IN', { ...IST, hour: '2-digit', minute: '2-digit' }) + ' IST';
    const FAILED = new Set(['failed', 'no_answer', 'busy', 'unknown', 'not_connected']);

    let cursor = null, loading = false, done = false, gen = 0, observer = null;
    const seen = new Set();

    function runTitle(r) {
        const msg = r.message === '(Sarvam agent greeting)' ? '' : (r.message || '');
        return r.agent_label || msg.slice(0, 80) || (r.kind === 'scheduled' ? 'Scheduled broadcast' : 'Broadcast');
    }

    function stat(dot, label, val) {
        return `<div class="hist-stat-item">${dot ? `<span style="color:${dot}">●</span>` : ''}<span style="opacity:0.5">${label}</span><span class="hist-stat-val">${Number(val) || 0}</span></div>`;
    }

    function runCard(r) {
        const card = document.createElement('div');
        card.className = 'hist-card';
        card.dataset.run = r.key;
        const total = Number(r.total) || 0;
        const ok = total ? Math.min(100, (r.answered / total) * 100) : 0;
        const bad = total ? Math.min(100 - ok, ((Number(r.failed) + Number(r.busy)) / total) * 100) : 0;
        const msg = r.message && r.message !== '(Sarvam agent greeting)' && r.agent_label ? r.message : '';
        const state = ['interrupted', 'stopped'].includes(r.run_status) && r.not_dialled > 0
            ? `<div class="row-sub" style="margin-top:6px; color:var(--error);">${r.run_status === 'stopped' ? 'Stopped' : 'Interrupted'}: ${r.not_dialled} not dialled yet.</div>` : '';
        card.innerHTML = `
            <div class="hist-card-hd">
                <div class="hist-card-time">${esc(fmtDate(r.at))} · ${esc(fmtTime(r.at))}</div>
                <span class="badge ${r.kind === 'scheduled' ? 'badge-muted' : 'badge-success'}">${r.kind === 'scheduled' ? 'Scheduled' : 'Manual'}</span>
            </div>
            <div class="hist-card-msg">${esc(runTitle(r))}</div>
            ${msg ? `<div class="row-sub" style="margin-top:4px;">${esc(msg.slice(0, 140))}</div>` : ''}
            ${r.sent_by ? `<div class="row-sub" style="margin-top:2px;">By ${esc(r.sent_by)}</div>` : ''}
            ${state}
            <div class="status-rail"><div class="status-bar-ok" style="width:${ok}%"></div><div class="status-bar-err" style="width:${bad}%"></div></div>
            <div class="hist-card-stats">
                ${stat('', 'Sent', r.sent)}${stat('#10b981', 'Answered', r.answered)}${stat('#f0ad4e', 'Busy', r.busy)}${stat('#ef4444', 'Failed', r.failed)}
            </div>`;
        const acts = document.createElement('div');
        acts.className = 'hist-card-actions';
        acts.style.cssText = 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;';
        let calls = null;
        const disc = window.VxDisclosure('Calls', async box => {
            box.innerHTML = '<div class="hint" style="margin-top:8px;">Loading…</div>';
            try {
                const res = await fetch('/api/broadcast-runs/' + encodeURIComponent(r.key) + '/calls');
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Could not load the calls.');
                calls = data.items || [];
            } catch (e) {
                box.innerHTML = `<div class="hint" style="margin-top:8px; color:var(--error);">${esc(e.message)}</div>`;
                return;
            }
            const frag = document.createDocumentFragment();
            calls.forEach(c => frag.appendChild(window.vxCallCard(c)));
            box.replaceChildren(frag);
            if (!calls.length) box.innerHTML = '<div class="hint" style="margin-top:8px;">No call records were found for this run.</div>';
            retry.style.display = failedNums().length ? '' : 'none';
            retry.textContent = `Retry ${failedNums().length} failed`;
        });
        // Retry failed only fills the Broadcast form (nothing is dialled until the user sends).
        const failedNums = () => [...new Set((calls || []).filter(c => FAILED.has(c.status)).map(c => c.phone).filter(Boolean))];
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-secondary btn-sm';
        retry.style.cssText = 'width:auto; height:32px; font-size:11px; padding:0 12px;';
        retry.textContent = `Retry ${(Number(r.failed) || 0) + (Number(r.busy) || 0)} failed`;
        retry.style.display = (Number(r.failed) + Number(r.busy)) > 0 ? '' : 'none';
        retry.onclick = async e => {
            e.stopPropagation();
            if (!calls) {
                try { const res = await fetch('/api/broadcast-runs/' + encodeURIComponent(r.key) + '/calls'); calls = (await res.json()).items || []; }
                catch (err) { calls = []; }
            }
            const nums = failedNums();
            if (!nums.length) { window.showToast('No failed numbers found.', 'info'); return; }
            const msgEl = document.getElementById('msg');
            if (msgEl) msgEl.value = r.message === '(Sarvam agent greeting)' ? '' : (r.message || '');
            if (window.preview) window.preview();
            if (typeof window.setRecipientNumbers === 'function') window.setRecipientNumbers(nums);
            window.showToast(`Loaded ${nums.length} failed number${nums.length > 1 ? 's' : ''} for retry.`, 'success');
            go('broadcast');
        };
        // Numbers this run dialled (first 6 + "View all").
        let recips = null;
        const getRecips = async () => {
            if (recips) return recips;
            const res = await fetch('/api/broadcast-runs/' + encodeURIComponent(r.key) + '/recipients');
            recips = res.ok ? ((await res.json()).items || []) : [];
            return recips;
        };
        const nums = window.VxDisclosure(`View numbers (${total})`, async box => {
            box.innerHTML = '<div class="row-item"><div class="row-sub">Loading…</div></div>';
            window.vxNumbersBox(box, await getRecips().catch(() => []), `Numbers · ${runTitle(r)}`);
        });
        const small = 'width:auto; height:32px; font-size:11px; padding:0 12px;';
        const mk = (label, cls, fn) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = cls; b.style.cssText = small; b.textContent = label;
            b.onclick = e => { e.stopPropagation(); fn(b); };
            return b;
        };
        // Re-use: fill the Broadcast form with this run's message and numbers (nothing is sent).
        const reuse = mk('Re-use', 'btn btn-secondary btn-sm', async () => {
            const list = await getRecips().catch(() => []);
            const msgEl = document.getElementById('msg');
            if (msgEl) msgEl.value = r.message === '(Sarvam agent greeting)' ? '' : (r.message || '');
            if (window.preview) window.preview();
            if (list.length && typeof window.setRecipientNumbers === 'function') window.setRecipientNumbers(list);
            window.showToast(`Loaded ${list.length} number${list.length === 1 ? '' : 's'} into Broadcast.`, 'success');
            go('broadcast');
        });
        // Two groups: the Calls / View numbers toggles, then the action pills (Delete last).
        const toggles = document.createElement('div');
        toggles.className = 'run-toggles';
        toggles.append(disc, nums);
        const actions = document.createElement('div');
        actions.className = 'run-actions';
        actions.appendChild(reuse);
        if (r.broadcast_id && ['interrupted', 'stopped'].includes(r.run_status) && Number(r.not_dialled) > 0) {
            actions.appendChild(mk(`Resume ${Number(r.not_dialled)} left`, 'btn btn-sm', () => window.resumeBroadcast(Number(r.broadcast_id), Number(r.not_dialled))));
        }
        actions.appendChild(retry);
        // Delete removes the run from this list only; its calls stay in Call history.
        const del = mk('Delete', 'btn btn-secondary btn-sm', async () => {
            if (!(await window.showConfirm('Delete this broadcast from history? Its call records stay in Call history.'))) return;
            const res = await fetch('/api/broadcast-runs/' + encodeURIComponent(r.key), { method: 'DELETE' }).catch(() => null);
            if (!res || !res.ok) { window.showToast('Could not delete.', 'error'); return; }
            seen.delete(r.key);
            window.vxRemove ? window.vxRemove(card) : card.remove();
            window.showToast('Deleted from history.', 'success');
        });
        del.style.color = 'var(--error)';
        del.classList.add('run-del');
        actions.appendChild(del);
        acts.className += ' run-acts';
        acts.style.cssText = '';
        acts.append(toggles, actions);
        card.appendChild(acts);
        // The calls / numbers lists open full-width under the card, like the Call history cards.
        [disc, nums].forEach(d => {
            const body = d.querySelector('.vx-disclosure-body');
            if (body) { body.style.width = '100%'; card.appendChild(body); }
        });
        // Accordion: Calls and View numbers share the space.
        const bc = disc.querySelector('.vx-disclosure-btn'), bn = nums.querySelector('.vx-disclosure-btn');
        if (bc && bn) {
            bc.addEventListener('click', () => { if (bc.getAttribute('aria-expanded') === 'true' && bn.getAttribute('aria-expanded') === 'true') bn.click(); });
            bn.addEventListener('click', () => { if (bn.getAttribute('aria-expanded') === 'true' && bc.getAttribute('aria-expanded') === 'true') bc.click(); });
        }
        return card;
    }

    async function load(more) {
        const list = document.getElementById('runs-list');
        const sentinel = document.getElementById('runs-sentinel');
        const empty = document.getElementById('runs-empty');
        if (!list || loading || (more && done)) return;
        const g = more ? gen : ++gen;
        loading = true;
        let data = null;
        try {
            const p = new URLSearchParams({ limit: '20' });
            if (more && cursor) p.set('cursor', cursor);
            const res = await fetch('/api/broadcast-runs?' + p);
            data = res.ok ? await res.json() : null;
        } catch (e) { data = null; }
        loading = false;
        if (g !== gen || !data) return;
        const items = data.items || [];
        if (!more) {
            // Refresh: keep existing cards (and their open state); add only new runs on top.
            const fresh = items.filter(r => !seen.has(r.key));
            if (list.children.length && fresh.length < items.length) {
                const frag = document.createDocumentFragment();
                fresh.forEach(r => { seen.add(r.key); frag.appendChild(runCard(r)); });
                list.prepend(frag);
                if (empty) empty.style.display = seen.size ? 'none' : 'block';
                return;
            }
            seen.clear(); list.replaceChildren();
            done = false;
        }
        const frag = document.createDocumentFragment();
        items.forEach(r => { if (!seen.has(r.key)) { seen.add(r.key); frag.appendChild(runCard(r)); } });
        list.appendChild(frag);
        cursor = data.next_cursor;
        done = !cursor;
        if (empty) empty.style.display = seen.size ? 'none' : 'block';
        if (sentinel) sentinel.style.display = done ? 'none' : 'block';
        if (sentinel && 'IntersectionObserver' in window && !observer) {
            observer = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) load(true); }, { rootMargin: '0px 0px 300px 0px' });
            observer.observe(sentinel);
        }
    }

    window.loadBroadcastRuns = () => load(false);
    window.loadMoreBroadcastRuns = () => load(true);
})();
