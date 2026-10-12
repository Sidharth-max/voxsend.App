// Full country-code list for the shared country-code dropdowns (Broadcast + Contacts).
// India (+91) is pinned first and stays the default. Option value = dial code (digits),
// data-search carries name / ISO / dial so the dropdown search can match 'ind', 'IN', '91'.
(function () {
    const RAW = window.VxPhone.RAW;
    let names;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { names = null; }
    const list = RAW.split(',').map(s => {
        const iso = s.slice(0, 2), dial = s.slice(2);
        let name = iso;
        try { if (names) name = names.of(iso) || iso; } catch (e) { /* keep ISO */ }
        return { iso, dial, name };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const india = list.find(c => c.iso === 'IN');
    const ordered = [india].concat(list.filter(c => c !== india));
    window.VX_COUNTRIES = ordered;
    function fill(sel) {
        if (!sel) return;
        const cur = sel.value || '91';
        sel.innerHTML = '';
        ordered.forEach(c => {
            const o = document.createElement('option');
            o.value = c.dial;
            o.textContent = `+${c.dial} ${c.name}`;
            o.dataset.search = `${c.name} ${c.iso} +${c.dial} ${c.dial}`.toLowerCase();
            sel.appendChild(o);
        });
        // Pick the first option with that dial code (India for 91).
        const hit = Array.from(sel.options).findIndex(o => o.value === cur);
        sel.selectedIndex = hit >= 0 ? hit : 0;
        sel.setAttribute('data-search', 'Search country or code');
    }
    ['numbers-cc', 'man-cc'].forEach(id => fill(document.getElementById(id)));
})();
