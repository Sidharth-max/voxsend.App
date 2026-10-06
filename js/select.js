// Themed dropdowns (replace the browser-native <select> picker everywhere).
// Progressive enhancement: each real <select> stays in the DOM, hidden, as the source of
// truth. A trigger button (same look as the input or pill it sits beside) opens a popover
// list built on the date/time picker surface (.vx-pop). Picking an option sets
// select.value and fires bubbling "input" + "change", so existing handlers keep working.
// Options repopulated from code (innerHTML, appendChild) and values set from code
// (select.value = x, select.selectedIndex = n) re-sync the trigger automatically.
// Opt out for a single select with <select data-native>.

(function () {
    const proto = HTMLSelectElement.prototype;
    const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value');
    const indexDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex');
    // option.selected = true from code (no attribute change, so no MutationObserver record).
    const optSelDesc = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected');
    if (optSelDesc && optSelDesc.set) {
        Object.defineProperty(HTMLOptionElement.prototype, 'selected', {
            configurable: true,
            enumerable: optSelDesc.enumerable,
            get() { return optSelDesc.get.call(this); },
            set(v) {
                optSelDesc.set.call(this, v);
                const sel = this.parentNode && (this.parentNode.tagName === 'SELECT' ? this.parentNode : this.parentNode.parentNode);
                if (sel && sel.__vxSelect) sync(sel);
            }
        });
    }
    const tracked = new Set();
    let openState = null;
    let uid = 0;

    const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    const CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3L9.5 3.6"/></svg>';

    // Same placement as the date/time pickers (js/pickers.js): under the trigger, or above
    // it when there is no room, always clamped inside the viewport with a 12px margin.
    function place(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        pop.style.minWidth = Math.min(r.width, window.innerWidth - 24) + 'px';
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let left = Math.min(r.left, window.innerWidth - w - 12);
        left = Math.max(12, left);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 12 && r.top - h - 6 > 12) top = r.top - h - 6;
        if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
        top = Math.max(12, top);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    // Accessible name for the trigger: aria-label, <label for>, or the row/field label.
    function labelFor(sel) {
        if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
        if (sel.id) {
            const l = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
            if (l) return l.textContent.trim();
        }
        const field = sel.closest('.field');
        const fl = field && field.querySelector('.field-label');
        if (fl) return fl.textContent.trim();
        const row = sel.closest('.row-item');
        const rl = row && row.querySelector('.row-label');
        if (rl) return rl.textContent.trim();
        return '';
    }

    function sync(sel) {
        const st = sel.__vxSelect;
        if (!st) return;
        const opt = sel.options[indexDesc.get.call(sel)];
        st.label.textContent = opt ? opt.label : '';
        st.btn.disabled = sel.disabled;
        st.btn.classList.toggle('is-disabled', sel.disabled);
        const name = labelFor(sel);
        st.btn.setAttribute('aria-label', name ? `${name}: ${st.label.textContent}` : st.label.textContent);
        if (sel.disabled && openState && openState.sel === sel) close(false);
    }

    function enhance(sel) {
        if (sel.__vxSelect || sel.multiple || sel.size > 1 || sel.hasAttribute('data-native')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        const pill = sel.classList.contains('select-pill');
        btn.className = sel.className + ' vx-select-btn ' + (pill ? 'vx-select-pill' : 'vx-select-field');
        if (sel.getAttribute('style')) btn.setAttribute('style', sel.getAttribute('style'));
        if (sel.id) btn.id = sel.id + '-vxbtn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = `<span class="vx-select-label"></span><span class="vx-select-chev">${CHEVRON}</span>`;
        const st = { btn, label: btn.querySelector('.vx-select-label'), id: 'vx-select-list-' + (++uid) };
        sel.__vxSelect = st;

        // Hidden source of truth: never focusable or tappable, so no native picker can open.
        sel.classList.add('vx-select-native');
        sel.setAttribute('tabindex', '-1');
        sel.setAttribute('aria-hidden', 'true');
        sel.parentNode.insertBefore(btn, sel);

        // Values set from code re-sync the trigger.
        Object.defineProperty(sel, 'value', {
            configurable: true,
            get() { return valueDesc.get.call(this); },
            set(v) { valueDesc.set.call(this, v); sync(this); }
        });
        Object.defineProperty(sel, 'selectedIndex', {
            configurable: true,
            get() { return indexDesc.get.call(this); },
            set(v) { indexDesc.set.call(this, v); sync(this); }
        });
        sel.focus = opts => btn.focus(opts);
        sel.showPicker = () => openList(sel);

        // Options repopulated, option text / disabled changed, select disabled from code.
        let queued = false;
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            queueMicrotask(() => {
                queued = false;
                sync(sel);
                if (openState && openState.sel === sel) renderList(sel);
            });
        }).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
        sel.addEventListener('change', () => sync(sel));

        btn.addEventListener('click', () => {
            if (openState && openState.sel === sel) close(false); else openList(sel);
        });
        btn.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.altKey && e.key === 'ArrowDown')) {
                e.preventDefault();
                if (!(openState && openState.sel === sel)) openList(sel);
            }
        });

        tracked.add(sel);
        sync(sel);
    }

    function items() {
        return openState ? Array.from(openState.pop.querySelectorAll('.vx-select-opt')) : [];
    }
    const enabled = list => list.filter(el => el.getAttribute('aria-disabled') !== 'true');

    function renderList(sel) {
        const pop = openState.pop;
        const prevActive = document.activeElement && pop.contains(document.activeElement) ? document.activeElement.dataset.index : null;
        pop.innerHTML = '';
        const cur = indexDesc.get.call(sel);
        const addOpt = (opt, parent, groupDisabled) => {
            if (opt.hidden) return;
            const el = document.createElement('div');
            el.className = 'vx-select-opt';
            el.setAttribute('role', 'option');
            el.tabIndex = -1;
            el.id = `${openState.id}-${opt.index}`;
            el.dataset.index = opt.index;
            const on = opt.index === cur;
            el.setAttribute('aria-selected', String(on));
            if (on) el.classList.add('is-selected');
            if (opt.disabled || groupDisabled) { el.setAttribute('aria-disabled', 'true'); el.classList.add('is-disabled'); }
            el.innerHTML = `<span class="vx-select-check">${CHECK}</span><span class="vx-select-text"></span>`;
            el.querySelector('.vx-select-text').textContent = opt.label;
            parent.appendChild(el);
        };
        Array.from(sel.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const g = document.createElement('div');
                g.className = 'vx-select-group';
                g.setAttribute('role', 'group');
                g.setAttribute('aria-label', child.label);
                const head = document.createElement('div');
                head.className = 'vx-select-group-label';
                head.setAttribute('aria-hidden', 'true');
                head.textContent = child.label;
                g.appendChild(head);
                Array.from(child.children).forEach(o => o.tagName === 'OPTION' && addOpt(o, g, child.disabled));
                pop.appendChild(g);
            } else if (child.tagName === 'OPTION') {
                addOpt(child, pop, false);
            }
        });
        if (prevActive !== null) {
            const again = pop.querySelector(`[data-index="${prevActive}"]`);
            if (again) again.focus({ preventScroll: true });
        }
    }

    function openList(sel) {
        if (sel.disabled) return;
        close(false);
        if (window.VxPicker && window.VxPicker.close) window.VxPicker.close();
        const st = sel.__vxSelect;
        const pop = document.createElement('div');
        pop.className = 'vx-pop vx-select-pop';
        pop.id = st.id;
        pop.setAttribute('role', 'listbox');
        if (st.btn.id) pop.setAttribute('aria-labelledby', st.btn.id);
        const r = st.btn.getBoundingClientRect();
        openState = { sel, btn: st.btn, pop, id: st.id, typed: '', typedAt: 0, at: { top: r.top, left: r.left, vw: window.innerWidth } };
        sync(sel);
        renderList(sel);
        document.body.appendChild(pop);
        place(pop, st.btn);
        st.btn.setAttribute('aria-expanded', 'true');
        st.btn.setAttribute('aria-controls', st.id);
        const target = pop.querySelector('.vx-select-opt.is-selected:not(.is-disabled)') || enabled(items())[0];
        if (target) focusItem(target);
        else pop.tabIndex = -1, pop.focus({ preventScroll: true });
    }

    function close(returnFocus) {
        if (!openState) return;
        const { btn, pop } = openState;
        openState = null;
        window.vxRemove(pop);
        btn.setAttribute('aria-expanded', 'false');
        btn.removeAttribute('aria-controls');
        if (returnFocus) btn.focus({ preventScroll: true });
    }

    function focusItem(el) {
        if (!el) return;
        el.focus({ preventScroll: true });
        // Keep it visible inside the list without moving the page.
        const pop = openState.pop;
        const top = el.offsetTop, bottom = top + el.offsetHeight;
        if (top < pop.scrollTop) pop.scrollTop = top - 4;
        else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight + 4;
    }

    function pick(el) {
        if (!openState || !el || el.getAttribute('aria-disabled') === 'true') return;
        const sel = openState.sel;
        const idx = Number(el.dataset.index);
        const changed = indexDesc.get.call(sel) !== idx;
        indexDesc.set.call(sel, idx);
        sync(sel);
        close(true);
        if (changed) {
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Pointer: pick on click inside the list; close on any press outside list + trigger.
    document.addEventListener('click', e => {
        if (!openState) return;
        const opt = e.target.closest && e.target.closest('.vx-select-opt');
        if (opt && openState.pop.contains(opt)) pick(opt);
    });
    document.addEventListener('pointerdown', e => {
        if (openState && !openState.pop.contains(e.target) && !openState.btn.contains(e.target)) close(false);
    }, true);

    // Keyboard inside the open list.
    document.addEventListener('keydown', e => {
        if (!openState) return;
        const inPop = openState.pop.contains(document.activeElement);
        if (!inPop && document.activeElement !== openState.btn) return;
        const list = enabled(items());
        const cur = list.indexOf(document.activeElement);
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); focusItem(list[cur < 0 ? 0 : Math.min(list.length - 1, cur + 1)]); break;
            case 'ArrowUp': e.preventDefault(); focusItem(list[cur < 0 ? list.length - 1 : Math.max(0, cur - 1)]); break;
            case 'Home': case 'PageUp': e.preventDefault(); focusItem(list[0]); break;
            case 'End': case 'PageDown': e.preventDefault(); focusItem(list[list.length - 1]); break;
            case 'Enter': case ' ':
                if (inPop) { e.preventDefault(); pick(cur >= 0 ? list[cur] : null); }
                break;
            case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
            case 'Tab': close(true); break; // focus goes back to the trigger, then Tab moves on
            default:
                // Type-ahead: jump to the next option starting with the typed text.
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const now = Date.now();
                    openState.typed = (now - openState.typedAt > 700 ? '' : openState.typed) + e.key.toLowerCase();
                    openState.typedAt = now;
                    const q = openState.typed;
                    const ordered = list.slice(cur + 1).concat(list.slice(0, cur + 1));
                    const hit = ordered.find(el => el.textContent.trim().toLowerCase().startsWith(q))
                        || (q.length > 1 && list[cur] && list[cur].textContent.trim().toLowerCase().startsWith(q) ? list[cur] : null);
                    if (hit) focusItem(hit);
                }
        }
    }, true);

    // A page scroll or resize that actually moves the trigger closes the list. Scrolling
    // inside the list, sub-pixel jitter and the tail of a smooth scroll that ended before
    // the tap do not, so a tap right after scrolling does not open-and-vanish on phones.
    const moved = () => {
        const r = openState.btn.getBoundingClientRect();
        return Math.abs(r.top - openState.at.top) > 4 || Math.abs(r.left - openState.at.left) > 4;
    };
    // A page scroll (also the tail of a smooth scroll, e.g. right after switching tabs) keeps
    // the list attached to its trigger, like the native picker; it closes only once the
    // trigger has scrolled out of view.
    document.addEventListener('scroll', e => {
        if (!openState || (e.target && e.target.nodeType === 1 && openState.pop.contains(e.target))) return;
        const r = openState.btn.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > window.innerHeight) { close(false); return; }
        if (moved()) {
            openState.at.top = r.top;
            openState.at.left = r.left;
            place(openState.pop, openState.btn);
        }
    }, true);
    window.addEventListener('resize', () => {
        if (!openState) return;
        if (window.innerWidth !== openState.at.vw || moved()) close(false);
        else place(openState.pop, openState.btn);
    });

    // <label for="id"> clicks focus the trigger instead of the hidden select.
    document.addEventListener('click', e => {
        const l = e.target.closest && e.target.closest('label[for]');
        if (!l) return;
        const sel = document.getElementById(l.htmlFor);
        if (sel && sel.__vxSelect) { e.preventDefault(); sel.__vxSelect.btn.focus(); }
    });

    function scan(root) {
        (root || document).querySelectorAll('select').forEach(enhance);
        // Tidy up triggers whose select was removed on its own.
        tracked.forEach(sel => {
            if (!sel.isConnected) {
                tracked.delete(sel);
                if (sel.__vxSelect && sel.__vxSelect.btn.isConnected) sel.__vxSelect.btn.remove();
                if (openState && openState.sel === sel) close(false);
            }
        });
    }

    function init() {
        scan();
        // Selects created later by JS are enhanced too (one batched scan per frame).
        let pending = false;
        new MutationObserver(muts => {
            if (pending) return;
            if (!muts.some(m => m.addedNodes.length || m.removedNodes.length)) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; scan(); });
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.VxSelect = { enhance, sync, close: () => close(false), refresh: () => tracked.forEach(sync) };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
