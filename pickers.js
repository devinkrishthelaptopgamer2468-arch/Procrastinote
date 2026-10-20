// --- Date and time pickers that match the site ---
// Browsers draw their own pop-up for <input type="date"> and <input type="time">, and a website
// can't restyle it, so it never matched the theme. Every date/time box stays a normal input (all
// the code still reads "2026-10-23" / "16:30" from .value), but it's made read-only, which stops
// the browser's pop-up, and clicking it opens this picker instead. Works for boxes added later too.
(function () {
    'use strict';

    const SELECTOR = 'input[type="date"], input[type="time"]';
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // weeks start on Sunday, like the Calendar page
    const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const ARROW_LEFT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>';
    const ARROW_RIGHT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

    const pop = document.createElement('div');
    pop.className = 'picker-pop';
    pop.setAttribute('role', 'dialog');
    pop.hidden = true;
    document.body.appendChild(pop);

    let input = null;        // the box the picker is open for
    let view = null;         // date: { year, month, focus: 'YYYY-MM-DD' }
    let time = null;         // time: { hour (1-12), minute, pm }

    const pad = n => String(n).padStart(2, '0');
    const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const todayIso = () => { const t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()); };
    const parseIso = v => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
        return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
    };
    const addDays = (value, days) => {
        const p = parseIso(value);
        const date = new Date(p.y, p.m, p.d + days);
        return iso(date.getFullYear(), date.getMonth(), date.getDate());
    };
    const allowed = value => (!input.min || value >= input.min) && (!input.max || value <= input.max);

    function enhance(el) {
        if (el.dataset.picker) return;
        el.dataset.picker = el.type;
        el.readOnly = true; // stops the browser's own pop-up (and typing) on computers and phones
        el.setAttribute('aria-haspopup', 'dialog');
    }

    function enhanceAll(root) {
        if (root.matches?.(SELECTOR)) enhance(root);
        root.querySelectorAll?.(SELECTOR).forEach(enhance);
    }

    function setValue(value) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---------- Date ----------
    function renderDate() {
        const { year, month, focus } = view;
        const selected = input.value;
        const today = todayIso();
        const first = new Date(year, month, 1).getDay();
        const start = new Date(year, month, 1 - first);
        let cells = '';
        for (let i = 0; i < 42; i++) {
            const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const value = iso(day.getFullYear(), day.getMonth(), day.getDate());
            const classes = ['picker-day'];
            if (day.getMonth() !== month) classes.push('outside');
            if (value === today) classes.push('today');
            if (value === selected) classes.push('selected');
            const label = `${WEEKDAY_NAMES[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]} ${day.getFullYear()}`;
            cells += `<button type="button" class="${classes.join(' ')}" data-date="${value}" tabindex="${value === focus ? 0 : -1}"
                aria-label="${label}"${value === selected ? ' aria-pressed="true"' : ''}${allowed(value) ? '' : ' disabled'}>${day.getDate()}</button>`;
        }
        pop.setAttribute('aria-label', 'Choose a date');
        pop.innerHTML = `
            <div class="picker-head">
                <button type="button" class="picker-nav" data-move="-1" aria-label="Previous month">${ARROW_LEFT}</button>
                <strong aria-live="polite">${MONTHS[month]} ${year}</strong>
                <button type="button" class="picker-nav" data-move="1" aria-label="Next month">${ARROW_RIGHT}</button>
            </div>
            <div class="picker-weekdays" aria-hidden="true">${WEEKDAYS.map(d => `<span>${d}</span>`).join('')}</div>
            <div class="picker-days">${cells}</div>
            <div class="picker-foot">
                <button type="button" class="picker-link" data-act="clear">Clear</button>
                <button type="button" class="picker-link strong" data-act="today" ${allowed(today) ? '' : 'disabled'}>Today</button>
            </div>`;
    }

    function moveFocus(value) {
        const p = parseIso(value);
        view = { year: p.y, month: p.m, focus: value };
        renderDate();
        pop.querySelector(`[data-date="${value}"]`)?.focus();
    }

    function openDate() {
        const start = parseIso(input.value) ? input.value : (input.min && todayIso() < input.min ? input.min : todayIso());
        const p = parseIso(start);
        view = { year: p.y, month: p.m, focus: start };
        renderDate();
    }

    // ---------- Time ----------
    function readTime() {
        const m = /^(\d{2}):(\d{2})/.exec(input.value || '');
        if (!m) return { hour: null, minute: null, pm: new Date().getHours() >= 12 };
        const h = +m[1];
        return { hour: h % 12 || 12, minute: +m[2], pm: h >= 12 };
    }

    function writeTime() {
        if (time.hour === null) return;
        if (time.minute === null) time.minute = 0;
        const h24 = (time.hour % 12) + (time.pm ? 12 : 0);
        setValue(`${pad(h24)}:${pad(time.minute)}`);
    }

    function renderTime() {
        const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
        if (time.minute !== null && !minutes.includes(time.minute)) minutes.push(time.minute), minutes.sort((a, b) => a - b);
        const option = (kind, value, label, on) =>
            `<button type="button" class="picker-option${on ? ' selected' : ''}" data-${kind}="${value}" aria-pressed="${on}">${label}</button>`;
        pop.setAttribute('aria-label', 'Choose a time');
        pop.innerHTML = `
            <div class="picker-time-preview">${time.hour === null ? '--' : time.hour}:${time.minute === null ? '--' : pad(time.minute)} <span>${time.pm ? 'PM' : 'AM'}</span></div>
            <div class="picker-time">
                <div class="picker-col" aria-label="Hour">${Array.from({ length: 12 }, (_, i) => i + 1).map(h => option('hour', h, h, time.hour === h)).join('')}</div>
                <div class="picker-col" aria-label="Minutes">${minutes.map(m => option('minute', m, pad(m), time.minute === m)).join('')}</div>
                <div class="picker-col picker-col-ampm" aria-label="AM or PM">${option('pm', 0, 'AM', !time.pm)}${option('pm', 1, 'PM', time.pm)}</div>
            </div>
            <div class="picker-foot">
                <button type="button" class="picker-link" data-act="clear">Clear</button>
                <button type="button" class="picker-link strong" data-act="done">Done</button>
            </div>`;
        // Show the chosen hour and minute in the middle of their columns
        pop.querySelectorAll('.picker-col').forEach(col => {
            const on = col.querySelector('.selected');
            if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.offsetHeight / 2;
        });
    }

    // ---------- Opening, placing, closing ----------
    function place() {
        if (!input || pop.hidden) return;
        const r = input.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        const gap = 8;
        let top = r.bottom + gap;
        if (top + h > window.innerHeight - gap && r.top - gap - h > gap) top = r.top - gap - h; // no room below: open above
        top = Math.max(gap, Math.min(top, window.innerHeight - h - gap));
        const left = Math.max(gap, Math.min(r.left, window.innerWidth - w - gap));
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
    }

    function open(el) {
        if (input === el && !pop.hidden) return;
        close(false);
        input = el;
        // Inside a pop-up dialog the picker has to live in that dialog to be clickable
        const host = el.closest('dialog') || document.body;
        if (pop.parentNode !== host) host.appendChild(pop);
        pop.classList.toggle('is-time', el.type === 'time');
        if (el.type === 'time') {
            time = readTime();
            renderTime();
        } else {
            openDate();
        }
        pop.hidden = false;
        el.setAttribute('aria-expanded', 'true');
        place();
        pop.classList.remove('opening');
        void pop.offsetWidth;
        pop.classList.add('opening');
        (pop.querySelector('.picker-day[tabindex="0"]') || pop.querySelector('.picker-option.selected') || pop.querySelector('button'))?.focus({ preventScroll: true });
    }

    function close(returnFocus = true) {
        if (!input) return;
        const el = input;
        pop.hidden = true;
        el.setAttribute('aria-expanded', 'false');
        input = null;
        if (returnFocus) el.focus({ preventScroll: true });
    }

    pop.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled || !input) return;
        if (btn.dataset.move) {
            view.month += Number(btn.dataset.move);
            if (view.month < 0) { view.month = 11; view.year--; }
            if (view.month > 11) { view.month = 0; view.year++; }
            view.focus = iso(view.year, view.month, 1);
            renderDate();
            pop.querySelector(`[data-move="${btn.dataset.move}"]`)?.focus();
        } else if (btn.dataset.date) {
            setValue(btn.dataset.date);
            close();
        } else if (btn.dataset.act === 'today') {
            setValue(todayIso());
            close();
        } else if (btn.dataset.act === 'clear') {
            setValue('');
            close();
        } else if (btn.dataset.act === 'done') {
            writeTime();
            close();
        } else if (btn.dataset.hour !== undefined || btn.dataset.minute !== undefined || btn.dataset.pm !== undefined) {
            if (btn.dataset.hour !== undefined) time.hour = Number(btn.dataset.hour);
            if (btn.dataset.minute !== undefined) time.minute = Number(btn.dataset.minute);
            if (btn.dataset.pm !== undefined) time.pm = btn.dataset.pm === '1';
            if (time.hour === null) time.hour = 12;
            writeTime();
            const keep = [...pop.querySelectorAll('.picker-col')].map(c => c.scrollTop);
            renderTime();
            pop.querySelectorAll('.picker-col').forEach((c, i) => { c.scrollTop = keep[i]; });
        }
    });

    pop.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // don't also close a dialog the picker is in
            close();
            return;
        }
        const day = e.target.closest?.('.picker-day');
        if (!day) return;
        const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (steps[e.key]) {
            e.preventDefault();
            moveFocus(addDays(day.dataset.date, steps[e.key]));
        } else if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault();
            const p = parseIso(day.dataset.date);
            const target = new Date(p.y, p.m + (e.key === 'PageUp' ? -1 : 1), 1);
            const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
            moveFocus(iso(target.getFullYear(), target.getMonth(), Math.min(p.d, last)));
        }
    });

    // Clicking (or tapping) a date/time box opens the picker
    document.addEventListener('click', e => {
        const el = e.target.closest?.(SELECTOR);
        if (!el || el.disabled) return;
        enhance(el);
        e.preventDefault();
        open(el);
    }, true);

    // Keyboard: Enter, Space or Down arrow on a focused box opens it
    document.addEventListener('keydown', e => {
        const el = e.target.closest?.(SELECTOR);
        if (!el || el.disabled || !['Enter', ' ', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        open(el);
    }, true);

    // Clicking anywhere else closes it
    document.addEventListener('pointerdown', e => {
        if (!input || pop.contains(e.target) || e.target === input) return;
        close(false);
    }, true);

    // Stay next to the box when the page scrolls or resizes (phones resize when the address bar hides)
    window.addEventListener('resize', () => requestAnimationFrame(place));
    document.addEventListener('scroll', () => requestAnimationFrame(place), true);

    // Boxes on the page now, and any added later (forms drawn by the Classes page, dialogs...)
    enhanceAll(document);
    new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(n => n.nodeType === 1 && enhanceAll(n))))
        .observe(document.body, { childList: true, subtree: true });
})();
