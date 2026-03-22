let contacts = [];

window.loadContacts = function() {
    try {
        contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
        contacts.forEach(c => c.selected = false);
    } catch (e) {
        contacts = [];
    }
    window.updateGroups();
    window.renderContacts();
};

window.saveContacts = function() {
    localStorage.setItem('contacts', JSON.stringify(contacts));
    window.updateGroups();
    window.renderContacts();
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
    reader.onload = (e) => {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        if (lines.length < 2) return alert("File appears empty or missing headers.");
        
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        const nameIdx = headers.indexOf('name');
        const phoneIdx = headers.indexOf('phone');
        const groupIdx = headers.indexOf('group');
        
        if (phoneIdx === -1) return alert("CSV must contain a 'phone' column.");
        
        let added = 0, updated = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= phoneIdx || !cols[phoneIdx]) continue;
            
            let p = cols[phoneIdx].replace(/\s+/g, '');
            const phone = p.startsWith('+') ? p : '+' + p;
            const name = nameIdx !== -1 && cols.length > nameIdx ? cols[nameIdx] : '';
            const group = groupIdx !== -1 && cols.length > groupIdx ? cols[groupIdx] : '';
            
            const existing = contacts.find(c => c.phone === phone);
            if (existing) {
                if (name) existing.name = name;
                if (group) existing.group = group;
                updated++;
            } else {
                contacts.push({ name, phone, group, selected: false });
                added++;
            }
        }
        
        window.saveContacts();
        event.target.value = '';
        alert(`Imported successfully.\nAdded: ${added}\nUpdated: ${updated}`);
    };
    reader.readAsText(file);
};

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
        tbody.innerHTML = '<tr><td colspan="4" class="empty">No contacts found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map(c => `
        <tr>
            <td><input type="checkbox" class="checkbox" ${c.selected ? 'checked' : ''} onchange="toggleContact('${c.phone}', this.checked)" /></td>
            <td><div style="font-weight:500;color:var(--text)">${c.name || '—'}</div></td>
            <td><div class="mono" style="color:var(--text2)">${c.phone}</div></td>
            <td>${c.group ? `<span class="badge">${c.group}</span>` : '—'}</td>
        </tr>
    `).join('');
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

window.deleteSelected = function() {
    const toDelete = contacts.filter(c => c.selected);
    if (!toDelete.length) return alert("No contacts selected.");
    if (confirm(`Delete ${toDelete.length} selected contact(s)?`)) {
        contacts = contacts.filter(c => !c.selected);
        window.saveContacts();
    }
};

window.exportCSV = function() {
    if (!contacts.length) return alert("Nothing to export.");
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
    if (!selected.length) return alert("Select at least one contact to use.");
    
    const numbersEl = document.getElementById('numbers');
    const existing = numbersEl.value.trim();
    const existingArr = existing ? existing.split('\n').map(n => n.trim()).filter(Boolean) : [];
    
    const toAdd = selected.filter(phone => !existingArr.includes(phone));
    
    if (toAdd.length) {
        const updatedArr = [...existingArr, ...toAdd];
        numbersEl.value = updatedArr.join('\n');
    }
    
    if (window.preview) window.preview();
    go('broadcast');
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

window.addManualContact = function() {
    const name = document.getElementById('man-name').value.trim();
    const phoneInput = document.getElementById('man-phone').value.trim();
    const group = document.getElementById('man-group').value.trim();
    
    if (!phoneInput) return alert("Phone number is required.");
    
    let p = phoneInput.replace(/\s+/g, '');
    const phone = p.startsWith('+') ? p : '+' + p;
    
    const existing = contacts.find(c => c.phone === phone);
    let updated = false;
    if (existing) {
        if (name) existing.name = name;
        if (group) existing.group = group;
        updated = true;
    } else {
        contacts.push({ name, phone, group, selected: false });
    }
    
    document.getElementById('man-name').value = '';
    document.getElementById('man-phone').value = '';
    document.getElementById('man-group').value = '';
    
    window.saveContacts();
    alert(updated ? "Updated existing contact." : "Added manual contact.");
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadContacts();
});
