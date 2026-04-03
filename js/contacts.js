let contacts = [];

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
    Array.from(groups).sort().forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        select.appendChild(opt);
    });
    if (groups.has(currentVal)) select.value = currentVal;
};

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

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= phoneIdx || !cols[phoneIdx]) continue;
            
            let p = cols[phoneIdx].replace(/\s+/g, '');
            const phone = p.startsWith('+') ? p : '+' + p;
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

window.renderContacts = function() {
    const filterGroup = document.getElementById('filter-group');
    const searchQ = document.getElementById('search-contacts');
    const tbody = document.getElementById('contacts-tbody');
    if (!filterGroup || !searchQ || !tbody) return;

    const fv = filterGroup.value;
    const sq = searchQ.value.toLowerCase();
    
    const filtered = contacts.filter(c => {
        if (fv && c.group !== fv) return false;
        if (sq && !c.name.toLowerCase().includes(sq) && !c.phone.includes(sq)) return false;
        return true;
    });
    
    document.getElementById('contacts-count').textContent = `${contacts.length} total`;
    document.getElementById('check-all').checked = filtered.length > 0 && filtered.every(c => c.selected);
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No contacts found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map((c, i) => `
        <tr>
            <td><input type="checkbox" class="checkbox" ${c.selected ? 'checked' : ''} onchange="toggleContact('${c.phone}', this.checked)" /></td>
            <td><div class="mono" style="color:var(--text3); font-size: 0.8rem;">${i + 1}</div></td>
            <td><div style="font-weight:500;color:var(--text)">${c.name || '—'}</div></td>
            <td><div class="mono" style="color:var(--text2)">${c.phone}</div></td>
            <td>${c.group ? `<span class="badge">${c.group}</span>` : '—'}</td>
            <td>
                <button class="btn btn-secondary btn-sm" onclick="editContact('${c.phone}')" style="width:auto; padding:4px 10px; font-size:10px;">EDIT</button>
            </td>
        </tr>
    `).join('');
};

window.editContact = function(phone) {
    const c = contacts.find(c => c.phone === phone);
    if (!c) return;

    editingPhone = phone;
    document.getElementById('man-name').value = c.name || '';
    document.getElementById('man-phone').value = c.phone || '';
    document.getElementById('man-group').value = c.group || '';

    const btn = document.querySelector('button[onclick="addManualContact()"]');
    if (btn) btn.textContent = 'Update';
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
        if (fv && c.group !== fv) return false;
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
    const phoneInput = document.getElementById('man-phone').value.trim();
    const group = document.getElementById('man-group').value.trim();
    
    if (!phoneInput) return window.showToast("Phone number is required.", "error");
    
    let p = phoneInput.replace(/\s+/g, '');
    const phone = p.startsWith('+') ? p : '+' + p;
    
    if (editingPhone) {
        const existing = contacts.find(c => c.phone === editingPhone);
        if (existing) {
            existing.name = name;
            existing.phone = phone;
            existing.group = group;
            // Only send this one contact
            try { await upsertContacts([existing]); } catch(e) { console.error(e); }
        }
        editingPhone = null;
        const btn = document.querySelector('button[onclick="addManualContact()"]');
        if (btn) btn.textContent = 'Add';
    } else {
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
    }
    
    document.getElementById('man-name').value = '';
    document.getElementById('man-phone').value = '';
    document.getElementById('man-group').value = '';
    
    window.updateGroups();
    window.renderContacts();
    if(window.renderBroadcastContacts) window.renderBroadcastContacts();
    window.showToast("Saved contact.", "success");
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadContacts();
});
