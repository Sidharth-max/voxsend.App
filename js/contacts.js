let contacts = [];
let contactsVisibleLimit = 100;

window.loadContacts = async function() {
    try {
        const res = await fetch('/api/contacts');
        const data = await res.json();
        contacts = Array.isArray(data) ? data.map(c => ({
            name: (c && c.name) ? c.name : '',
            phone: c && c.phone ? c.phone : '',
            group: c ? (c.group ?? c.group_name ?? '') : '',
            selected: false
        })).filter(c => c.phone) : [];
    } catch (e) {
        contacts = [];
    }
    window.updateGroups();
    window.renderContacts();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
};

// ── Upsert a small batch of contacts (only what changed) ──────────────────────
// Sends in chunks of CHUNK_SIZE to avoid overloading the server.
const CHUNK_SIZE = 5000;

async function upsertContacts(list) {
    if (!list || !list.length) return;
    const chunks = [];
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
        chunks.push(list.slice(i, i + CHUNK_SIZE));
    }
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const res = await fetch('/api/contacts/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk.map(c => ({
                name: c.name || '',
                phone: c.phone,
                group: c.group || ''
            })))
        });
        if (!res.ok) throw new Error(await res.text());
        if (chunks.length > 1 && window.showToast) {
            window.showToast(`Saved chunk ${ci + 1}/${chunks.length}…`, 'info');
        }
    }
}

// Full sync — only used when contacts are deleted (sends entire list)
window.saveContacts = async function() {
    const payload = contacts.map(c => ({
        name: c.name || '',
        phone: c.phone,
        group: c.group || ''
    }));
    try {
        const res = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(await res.text());
    } catch (e) {
        console.error("Failed to save contacts", e);
        if (window.showToast) window.showToast(`Failed to save: ${e.message}`, "error");
    }
    window.updateGroups();
    window.renderContacts();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
};

window.updateGroups = function() {
    const select = document.getElementById('filter-group');
    if (!select) return;
    const currentVal = select.value;
    const groups = new Set(contacts.map(c => c.group).filter(Boolean));
    
    select.innerHTML = '<option value="">All Groups</option>';
    const badN = contacts.filter(c => window.vxPhoneIssue(c.phone)).length;
    if (badN) { const o = document.createElement('option'); o.value = '__invalid'; o.textContent = `Invalid (${badN})`; select.appendChild(o); }
    Array.from(groups).sort().forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        select.appendChild(opt);
    });
    if (groups.has(currentVal) || (currentVal === '__invalid' && badN)) select.value = currentVal;
    // Manual add form: existing groups + "New group…"
    const pick = document.getElementById('man-group-pick');
    if (pick) {
        const keep = pick.value;
        pick.innerHTML = '<option value="">No group</option>';
        Array.from(groups).sort().forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = g; pick.appendChild(o); });
        const nw = document.createElement('option'); nw.value = '__new'; nw.textContent = '+ New group…'; pick.appendChild(nw);
        if (keep && (groups.has(keep) || keep === '__new')) pick.value = keep;
    }
};

window.onManualGroupPick = function() {
    const pick = document.getElementById('man-group-pick');
    const inp = document.getElementById('man-group');
    if (!pick || !inp) return;
    const isNew = pick.value === '__new';
    inp.style.display = isNew ? '' : 'none';
    if (isNew) inp.focus();
};

// Same rules (and helper) as Broadcast's typed numbers: js/app.js vxNormalizePhone / vxCheckPhone.
const manualPhone = () => {
    const raw = document.getElementById('man-phone').value;
    const cc = (document.getElementById('man-cc') || {}).value || '91';
    const phone = window.vxNormalizePhone(raw, cc);
    if (!phone) return { phone: '', issue: null };
    const bad = window.vxCheckPhone(phone, cc);
    const issue = bad ? (bad.fix ? `Looks wrong (${bad.reason}). Use ${bad.fix}?` : `Looks wrong: ${bad.reason}`) : null;
    return { phone, issue };
};
window.checkManualPhone = function() {
    const h = document.getElementById('man-phone-hint');
    if (!h) return;
    const { phone, issue } = manualPhone();
    if (!phone) { h.style.display = 'none'; return; }
    h.style.display = 'block';
    h.style.color = issue ? 'var(--error)' : '';
    h.textContent = issue ? issue : `Will be saved as ${phone}`;
};
document.addEventListener('change', e => { if (e.target && e.target.id === 'man-cc') window.checkManualPhone(); });

window.handleCSV = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        if (lines.length < 2) return window.showToast("File appears empty or missing headers.", "error");
        
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        const nameIdx = headers.indexOf('name');
        const phoneIdx = headers.indexOf('phone');
        const groupIdx = headers.indexOf('group');
        
        if (phoneIdx === -1) return window.showToast("CSV must contain a 'phone' column.", "error");
        
        // Build a quick lookup for existing contacts by phone
        const existingMap = new Map(contacts.map(c => [c.phone, c]));

        let added = 0, updated = 0;
        const changedContacts = []; // only track what actually changed
        const bad = [];
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= phoneIdx || !cols[phoneIdx]) { bad.push({ line: i + 1, phone: '', reason: 'Empty number' }); continue; }
            const v = window.VxPhone.check(cols[phoneIdx]);
            if (!v.ok) { bad.push({ line: i + 1, phone: cols[phoneIdx], reason: v.reason + (v.hint ? ' – ' + v.hint : '') }); continue; }
            rows.push({ cols, phone: v.e164 });
        }
        if (bad.length) {
            const list = bad.slice(0, 12).map(b => `Line ${b.line}: ${b.phone || '(blank)'} – ${b.reason}`).join('\n');
            const more = bad.length > 12 ? `\n…and ${bad.length - 12} more.` : '';
            if (!rows.length) { event.target.value = ''; return window.showToast(`No valid numbers. ${bad.length} invalid row(s), e.g. line ${bad[0].line}: ${bad[0].reason}.`, 'error'); }
            const html = (`${bad.length} invalid row${bad.length > 1 ? 's' : ''} won't be imported:\n\n${list}${more}\n\nImport the ${rows.length} valid row${rows.length > 1 ? 's' : ''} only?`)
                .replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])).replace(/\n/g, '<br>');
            const go = await window.showConfirm(html);
            if (!go) { event.target.value = ''; return; }
        }

        for (const { cols, phone } of rows) {
            const name = nameIdx !== -1 && cols.length > nameIdx ? cols[nameIdx] : '';
            const group = groupIdx !== -1 && cols.length > groupIdx ? cols[groupIdx] : '';
            
            const existing = existingMap.get(phone);
            if (existing) {
                let changed = false;
                if (name && existing.name !== name) { existing.name = name; changed = true; }
                if (group && existing.group !== group) { existing.group = group; changed = true; }
                if (changed) { changedContacts.push(existing); updated++; }
            } else {
                const newContact = { name, phone, group, selected: false };
                contacts.push(newContact);
                existingMap.set(phone, newContact);
                changedContacts.push(newContact);
                added++;
            }
        }
        
        event.target.value = '';

        if (!changedContacts.length) {
            window.showToast("No new or updated contacts found.", "info");
            window.updateGroups();
            window.renderContacts();
            return;
        }

        try {
            if (changedContacts.length > CHUNK_SIZE) {
                window.showToast(`Uploading ${changedContacts.length} contacts in batches…`, "info");
            }
            await upsertContacts(changedContacts);
            window.showToast(`Done! Added: ${added}, Updated: ${updated}`, "success");
        } catch (err) {
            console.error("CSV upload failed", err);
            window.showToast(`Upload failed: ${err.message}`, "error");
        }

        window.updateGroups();
        window.renderContacts();
        if(window.renderBroadcastContacts) window.renderBroadcastContacts();
    };
    reader.readAsText(file);
};

let editingPhone = null;

const escAttr = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Clicking a number shows every Sarvam conversation with that person.
document.addEventListener('click', e => {
    const link = e.target.closest && e.target.closest('#contacts-tbody .c-phone-link');
    if (link && window.openPersonConversations) window.openPersonConversations(link.dataset.phone, link.dataset.name);
});

window.renderContacts = function() {
    const filterGroup = document.getElementById('filter-group');
    const searchQ = document.getElementById('search-contacts');
    const tbody = document.getElementById('contacts-tbody');
    if (!filterGroup || !searchQ || !tbody) return;

    const fv = filterGroup.value;
    const sq = searchQ.value.toLowerCase();
    
    const filtered = contacts.filter(c => {
        if (fv === '__invalid') { if (!window.vxPhoneIssue(c.phone)) return false; }
        else if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });

    // Reset visible limit if it's a new search/filter
    // We check if the search/filter changed from last time if we want to be more efficient,
    // but for now, we'll let the event listeners handle resetting it.
    
    document.getElementById('contacts-count').textContent = `${contacts.length} total`;
    const checkAll = document.getElementById('check-all');
    const selCount = filtered.filter(c => c.selected).length;
    checkAll.checked = filtered.length > 0 && selCount === filtered.length;
    checkAll.indeterminate = selCount > 0 && selCount < filtered.length;
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No contacts found.</td></tr>';
        return;
    }

    const visible = filtered.slice(0, contactsVisibleLimit);
    
    tbody.innerHTML = visible.map((c, i) => `
        <tr class="c-row">
            <td class="c-check"><input type="checkbox" class="checkbox" ${c.selected ? 'checked' : ''} onchange="toggleContact('${c.phone}', this.checked)" /></td>
            <td class="c-num"><div class="mono" style="color:var(--text3); font-size: 0.75rem;">${i + 1}</div></td>
            <td class="c-main">
                <div class="c-name-wrap">
                    <button type="button" class="c-name c-phone-link c-name-link" data-phone="${escAttr(c.phone)}" data-name="${escAttr(c.name)}" title="Show call history">${escAttr(c.name || '—')}</button>
                    <button class="btn btn-secondary btn-sm mobile-edit" onclick="editContact('${escAttr(c.phone)}')" aria-label="Edit contact">Edit</button>
                </div>
                <div class="c-details-wrap">
                    <button type="button" class="c-phone c-phone-link mono" data-phone="${escAttr(c.phone)}" data-name="${escAttr(c.name)}" title="Show call history">${escAttr(c.phone)}</button>${window.vxInvalidPill(c.phone)}
                    ${c.group ? `<span class="badge c-group" style="font-size: 0.65rem;">${c.group}</span>` : ''}
                </div>
            </td>
            <td class="c-phone-desktop"><button type="button" class="c-phone-link mono" data-phone="${escAttr(c.phone)}" data-name="${escAttr(c.name)}" title="Show call history">${escAttr(c.phone)}</button> ${window.vxInvalidPill(c.phone)}</td>
            <td class="c-group-desktop">${c.group ? `<span class="badge" style="font-size: 0.65rem;">${c.group}</span>` : '—'}</td>
            <td class="c-actions-desktop">
                <button class="btn btn-secondary btn-sm c-edit-btn" onclick="editContact('${escAttr(c.phone)}')" aria-label="Edit contact">Edit</button>
            </td>
        </tr>
    `).join('');

    if (filtered.length > contactsVisibleLimit) {
        const moreRow = document.createElement('tr');
        moreRow.innerHTML = `<td colspan="6" style="text-align:center; padding: 20px; color: var(--text3); font-size: 0.85rem;">
            Showing ${contactsVisibleLimit} of ${filtered.length}. Scroll to load more...
        </td>`;
        tbody.appendChild(moreRow);
    }
};

window.editContact = function(phone) {
    const c = contacts.find(c => c.phone === phone);
    if (!c) return;

    editingPhone = phone;
    document.getElementById('edit-name').value = c.name || '';
    document.getElementById('edit-phone').value = c.phone || '';
    document.getElementById('edit-group').value = c.group || '';

    const modal = document.getElementById('edit-contact-modal');
    window.vxShowModal(modal);
};

window.closeEditContact = function() {
    const modal = document.getElementById('edit-contact-modal');
    window.vxHideModal(modal);
    editingPhone = null;
};

window.saveEditedContact = async function() {
    if (!editingPhone) return;

    const name = document.getElementById('edit-name').value.trim();
    const phoneInput = document.getElementById('edit-phone').value.trim();
    const group = document.getElementById('edit-group').value.trim();

    if (!phoneInput) return window.showToast("Phone number is required.", "error");

    const chk = window.VxPhone.check(phoneInput);
    if (!chk.ok) return window.showToast(`Invalid number: ${chk.reason}${chk.hint ? ' – ' + chk.hint : ''}`, "error");
    const phone = chk.e164;

    const existingIndex = contacts.findIndex(c => c.phone === editingPhone);
    if (existingIndex !== -1) {
        const updatedContact = {
            ...contacts[existingIndex],
            name,
            phone,
            group
        };
        
        // Update local array
        contacts[existingIndex] = updatedContact;

        try {
            await upsertContacts([updatedContact]);
            window.showToast("Contact updated.", "success");
        } catch (e) {
            console.error(e);
            window.showToast("Failed to sync update.", "error");
        }
    }

    window.closeEditContact();
    window.updateGroups();
    window.renderContacts();
    if (window.renderBroadcastContacts) window.renderBroadcastContacts();
};

window.toggleContact = function(phone, isChecked) {
    const c = contacts.find(c => c.phone === phone);
    if (c) c.selected = isChecked;
    window.renderContacts();
};

window.toggleSelectAll = function(forceCheck) {
    const fv = document.getElementById('filter-group').value;
    const sq = document.getElementById('search-contacts').value.toLowerCase();
    
    const filtered = contacts.filter(c => {
        if (fv === '__invalid') { if (!window.vxPhoneIssue(c.phone)) return false; }
        else if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });
    
    const state = typeof forceCheck === 'boolean' ? forceCheck : !filtered.every(c => c.selected);
    filtered.forEach(c => c.selected = state);
    window.renderContacts();
};

window.deleteSelected = async function() {
    const toDelete = contacts.filter(c => c.selected);
    if (!toDelete.length) return window.showToast("No contacts selected.", "error");
    const confirmed = await window.showConfirm(`Delete ${toDelete.length} selected contact(s)?`);
    if (!confirmed) return;

    const phones = toDelete.map(c => c.phone);
    contacts = contacts.filter(c => !c.selected);

    try {
        await fetch('/api/contacts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phones })
        });
    } catch (e) {
        console.error("Delete failed", e);
        if (window.showToast) window.showToast("Delete failed.", "error");
    }

    window.updateGroups();
    window.renderContacts();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
};

window.exportCSV = function() {
    if (!contacts.length) return window.showToast("Nothing to export.", "info");
    const header = "name,phone,group\n";
    const rows = contacts.map(c => `"${c.name}","${c.phone}","${c.group}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts_export.csv';
    a.click();
    URL.revokeObjectURL(url);
};

window.useSelected = function() {
    const selected = contacts.filter(c => c.selected).map(c => c.phone);
    if (!selected.length) return window.showToast("Select at least one contact to use.", "warning");
    
    const numbersEl = document.getElementById('numbers');
    if (!numbersEl) return;
    
    const existing = numbersEl.value.trim();
    const existingArr = existing ? existing.split('\n').map(n => n.trim()).filter(Boolean) : [];
    
    const toAdd = selected.filter(phone => !existingArr.includes(phone));
    
    const updatedArr = [...existingArr, ...toAdd];
    let usedHelper = false;
    if (typeof window.setRecipientNumbers === 'function') {
        window.setRecipientNumbers(updatedArr);
        usedHelper = true;
    } else if (toAdd.length) {
        numbersEl.value = updatedArr.join('\n');
    }
    
    if (!usedHelper) {
        if (typeof window.preview === 'function') window.preview();
        if (typeof window.renderBroadcastContacts === 'function') window.renderBroadcastContacts();
    }
    
    if (typeof window.go === 'function') {
        window.go('broadcast');
    } else if (typeof go === 'function') {
        go('broadcast');
    }
};

window.downloadTemplate = function(e) {
    if(e) e.preventDefault();
    const csv = "name,phone,group\nJohn Doe,+919876543210,Committee\nJane Smith,+919123456789,Members\n";
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts_format.csv';
    a.click();
    URL.revokeObjectURL(url);
};

window.addManualContact = async function() {
    const name = document.getElementById('man-name').value.trim();
    const pick = document.getElementById('man-group-pick');
    const group = pick && pick.value !== '__new' ? pick.value : document.getElementById('man-group').value.trim();
    const { phone, issue } = manualPhone();
    if (!phone) return window.showToast("Phone number is required.", "error");
    if (issue) return window.showToast(issue, "error");
    
    const existing = contacts.find(c => c.phone === phone);
    if (existing) {
        if (name) existing.name = name;
        if (group) existing.group = group;
        try { await upsertContacts([existing]); } catch(e) { console.error(e); }
    } else {
        const newContact = { name, phone, group, selected: false };
        contacts.push(newContact);
        try { await upsertContacts([newContact]); } catch(e) { console.error(e); }
    }
    
    document.getElementById('man-name').value = '';
    document.getElementById('man-phone').value = '';
    document.getElementById('man-group').value = '';
    window.checkManualPhone();
    
    window.updateGroups();
    window.renderContacts();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
    window.showToast("Saved contact.", "success");
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadContacts();

    // Scroll to load more
    const container = document.querySelector('.contacts-list');
    if (container) {
        container.addEventListener('scroll', () => {
            if (container.scrollTop + container.clientHeight >= container.scrollHeight - 50) {
                const searchQ = document.getElementById('search-contacts');
                const filterGroup = document.getElementById('filter-group');
                const fv = filterGroup ? filterGroup.value : '';
                const sq = searchQ ? searchQ.value.toLowerCase() : '';
                
                const filtered = contacts.filter(c => {
                    if (fv === '__invalid') { if (!window.vxPhoneIssue(c.phone)) return false; }
        else if (fv && c.group !== fv) return false;
                    if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
                    return true;
                });

                if (contactsVisibleLimit < filtered.length) {
                    contactsVisibleLimit += 100;
                    window.renderContacts();
                }
            }
        });
    }

    // Reset limit on input
    const searchQ = document.getElementById('search-contacts');
    const filterGroup = document.getElementById('filter-group');
    if (searchQ) searchQ.addEventListener('input', () => { contactsVisibleLimit = 100; });
    if (filterGroup) filterGroup.addEventListener('change', () => { contactsVisibleLimit = 100; });
});
