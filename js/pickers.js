// Themed date and time pickers (replace the browser-native ones).
// A picker is a <button class="vx-field"> whose value lives in data-value:
// dates as "YYYY-MM-DD", times as "HH:MM" (24h). Changes fire an "input" event.

(function () {
    let openPop = null;

    const pad = n => String(n).padStart(2, '0');
    const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const parseYmd = s => (s ? new Date(s + 'T00:00') : null);

    function close() {
        if (!openPop) return;
        window.vxRemove(openPop.pop);
        openPop.anchor.setAttribute('aria-expanded', 'false');
        openPop = null;
    }

    // Puts the popover under (or above) its field, kept inside the viewport.
    function place(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let left = Math.min(r.left, window.innerWidth - w - 12);
        left = Math.max(12, left);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 12 && r.top - h - 6 > 12) top = r.top - h - 6;
        // Short screens: keep the whole popover (and its buttons) on screen.
        if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
        top = Math.max(12, top);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    // Opens a popover under the anchor, kept inside the viewport (works at phone width).
    function open(anchor, build) {
        const same = openPop && openPop.anchor === anchor;
        close();
        if (same) return;
        const pop = document.createElement('div');
        pop.className = 'vx-pop';
        pop.setAttribute('role', 'dialog');
        build(pop);
        document.body.appendChild(pop);
        place(pop, anchor);
        anchor.setAttribute('aria-expanded', 'true');
        openPop = { pop, anchor };
        const focusEl = pop.querySelector('.is-selected') || pop.querySelector('button');
        if (focusEl) focusEl.focus({ preventScroll: true });
    }

    document.addEventListener('mousedown', e => {
        if (openPop && !openPop.pop.contains(e.target) && !openPop.anchor.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && openPop) { const a = openPop.anchor; close(); a.focus(); }
    });
    // A page scroll or resize must not close the picker: on phones the page scrolls on its
    // own (momentum, address bar, a drag that starts beside a column), and closing there
    // left a half-picked time (e.g. only ":30" tapped) in the box. Follow the field instead.
    const follow = e => { if (openPop && !(e && e.target && e.target.nodeType === 1 && openPop.pop.contains(e.target))) place(openPop.pop, openPop.anchor); };
    window.addEventListener('resize', follow);
    document.addEventListener('scroll', follow, true);

    function setValue(field, value) {
        field.dataset.value = value || '';
        render(field);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function render(field) {
        const v = field.dataset.value;
        const label = field.querySelector('.vx-field-label');
        field.classList.toggle('is-empty', !v);
        if (!v) { label.textContent = field.dataset.placeholder || ''; return; }
        if (field.dataset.kind === 'date') {
            label.textContent = parseYmd(v).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        } else {
            const [h, m] = v.split(':').map(Number);
            label.textContent = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
    }

    const ICONS = {
        date: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 7h12M5 1.5v3M11 1.5v3" stroke-linecap="round"/></svg>',
        time: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };

    function makeField(kind, { value = '', placeholder = '', clearable = false } = {}) {
        const field = document.createElement('button');
        field.type = 'button';
        field.className = 'vx-field';
        field.dataset.kind = kind;
        field.dataset.placeholder = placeholder;
        if (clearable) field.dataset.clearable = '1';
        field.setAttribute('aria-haspopup', 'dialog');
        field.setAttribute('aria-expanded', 'false');
        field.innerHTML = `<span class="vx-field-icon">${ICONS[kind]}</span><span class="vx-field-label"></span>`;
        field.dataset.value = value;
        render(field);
        field.addEventListener('click', () => open(field, pop => (kind === 'date' ? buildCalendar : buildTime)(pop, field)));
        return field;
    }

    // ── Calendar ─────────────────────────────────────────
    function buildCalendar(pop, field) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const min = field.dataset.min ? parseYmd(field.dataset.min) : today;
        const selected = parseYmd(field.dataset.value);
        let view = new Date((selected || (min > today ? min : today)).getTime());
        view.setDate(1);

        const draw = () => {
            pop.innerHTML = '';
            pop.classList.add('vx-cal');
            const head = document.createElement('div');
            head.className = 'vx-cal-head';
            const prev = navBtn('‹', 'Previous month', -1);
            const next = navBtn('›', 'Next month', 1);
            const title = document.createElement('div');
            title.className = 'vx-cal-title';
            title.textContent = view.toLocaleDateString([], { month: 'long', year: 'numeric' });
            head.append(prev, title, next);
            pop.appendChild(head);

            const grid = document.createElement('div');
            grid.className = 'vx-cal-grid';
            // Weekday headings, Monday first
            for (let i = 0; i < 7; i++) {
                const d = new Date(2024, 0, 1 + i); // 1 Jan 2024 was a Monday
                const wd = document.createElement('div');
                wd.className = 'vx-cal-wd';
                wd.textContent = d.toLocaleDateString([], { weekday: 'narrow' });
                grid.appendChild(wd);
            }
            const offset = (view.getDay() + 6) % 7;
            for (let i = 0; i < offset; i++) grid.appendChild(document.createElement('span'));
            const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
            for (let day = 1; day <= days; day++) {
                const date = new Date(view.getFullYear(), view.getMonth(), day);
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'vx-cal-day';
                b.textContent = day;
                if (date.getTime() === today.getTime()) b.classList.add('is-today');
                if (selected && date.getTime() === selected.getTime()) b.classList.add('is-selected');
                if (date < min) b.disabled = true;
                b.addEventListener('click', () => { setValue(field, ymd(date)); close(); field.focus(); });
                grid.appendChild(b);
            }
            pop.appendChild(grid);

            const foot = document.createElement('div');
            foot.className = 'vx-pop-foot';
            if (field.dataset.clearable && field.dataset.value) {
                foot.appendChild(footBtn('Clear', () => { setValue(field, ''); close(); field.focus(); }));
            }
            if (today >= min) foot.appendChild(footBtn('Today', () => { setValue(field, ymd(today)); close(); field.focus(); }));
            if (foot.children.length) pop.appendChild(foot);
        };

        const navBtn = (txt, label, step) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'vx-cal-nav';
            b.textContent = txt;
            b.setAttribute('aria-label', label);
            const first = new Date(min.getFullYear(), min.getMonth(), 1);
            if (step < 0 && view <= first) b.disabled = true;
            b.addEventListener('click', () => { view.setMonth(view.getMonth() + step); draw(); });
            return b;
        };
        draw();
    }

    // ── Time ─────────────────────────────────────────────
    // Each tap on an hour or minute is saved to the field straight away, so the choice is
    // kept however the popover closes (tap outside, page scroll, Escape). Cancel restores
    // the value the field had when it was opened.
    function buildTime(pop, field) {
        pop.classList.add('vx-time');
        const original = field.dataset.value || '';
        const [curH, curM] = (original || '10:00').split(':').map(Number);
        let h = curH, m = curM;
        // An empty box shows 10 AM as a suggestion only. Until an hour is tapped (or "Set
        // time" accepts the suggestion) a minute tap is held, not saved, so a box can never
        // quietly become a copy of another time such as 10:30.
        let hourChosen = !!original;
        const commit = () => setValue(field, `${pad(h)}:${pad(m)}`);

        const cols = document.createElement('div');
        cols.className = 'vx-time-cols';
        const col = (items, current, fmt, onPick) => {
            const c = document.createElement('div');
            c.className = 'vx-time-col';
            items.forEach(v => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'vx-time-opt';
                b.textContent = fmt(v);
                if (v === current) b.classList.add('is-selected');
                b.addEventListener('click', () => {
                    c.querySelectorAll('.is-selected').forEach(x => x.classList.remove('is-selected'));
                    b.classList.add('is-selected');
                    onPick(v);
                });
                c.appendChild(b);
            });
            return c;
        };
        const hourLabel = v => new Date(2000, 0, 1, v).toLocaleTimeString([], { hour: 'numeric' });
        const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
        if (!minutes.includes(m)) minutes.push(m), minutes.sort((a, b) => a - b);
        cols.append(
            col(Array.from({ length: 24 }, (_, i) => i), h, hourLabel, v => { h = v; hourChosen = true; commit(); }),
            col(minutes, m, v => ':' + pad(v), v => { m = v; if (hourChosen) commit(); })
        );
        pop.appendChild(cols);

        const foot = document.createElement('div');
        foot.className = 'vx-pop-foot';
        foot.appendChild(footBtn('Cancel', () => {
            if ((field.dataset.value || '') !== original) setValue(field, original);
            close(); field.focus();
        }));
        const ok = footBtn('Set time', () => { commit(); close(); field.focus(); });
        ok.classList.add('is-primary');
        foot.appendChild(ok);
        pop.appendChild(foot);

        // Bring the selected options into view inside their columns
        requestAnimationFrame(() => pop.querySelectorAll('.vx-time-col .is-selected').forEach(el => {
            el.parentElement.scrollTop = el.offsetTop - el.parentElement.clientHeight / 2 + el.offsetHeight / 2;
        }));
    }

    function footBtn(txt, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vx-pop-btn';
        b.textContent = txt;
        b.addEventListener('click', onClick);
        return b;
    }

    // Replaces each <div data-vx-picker="date|time"> placeholder with a themed field.
    function mount(root = document) {
        root.querySelectorAll('[data-vx-picker]').forEach(ph => {
            const field = makeField(ph.dataset.vxPicker, {
                placeholder: ph.dataset.placeholder,
                clearable: ph.hasAttribute('data-clearable')
            });
            field.id = ph.id;
            if (ph.getAttribute('oninput')) field.setAttribute('oninput', ph.getAttribute('oninput'));
            ph.replaceWith(field);
        });
    }

    // Themed expand/collapse section (replaces native <details>/<summary>).
    function makeDisclosure(label, buildBody) {
        const wrap = document.createElement('div');
        wrap.className = 'vx-disclosure';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vx-disclosure-btn';
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<svg class="vx-chev" width="10" height="10" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        btn.appendChild(document.createTextNode(label));
        const body = document.createElement('div');
        body.className = 'vx-disclosure-body';
        body.hidden = true;
        let built = false;
        btn.addEventListener('click', () => {
            const openNow = btn.getAttribute('aria-expanded') !== 'true';
            if (openNow && !built) { buildBody(body); built = true; }
            btn.setAttribute('aria-expanded', String(openNow));
            window.vxCollapse(body, openNow, () => { body.hidden = false; }, () => { body.hidden = true; });
        });
        wrap.append(btn, body);
        return wrap;
    }

    window.VxPicker = { makeField, mount, setValue, close };
    window.VxDisclosure = makeDisclosure;
    document.addEventListener('DOMContentLoaded', () => mount());
})();
