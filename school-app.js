// --- State & Local Storage Management ---
const USERS_KEY = 'school_planner_users';
const SESSION_KEY = 'school_planner_current_session';
const SUBJECT_LIST = [
    "Mathematics", "Physics", "Biology", "Chemistry", "English", 
    "Tamil", "Hindi", "Sanskrit", "French", "Social Science", "Sixth Subject", "PT", "VBSE",
    "LSA", "VBSE/LSA", "Library", "MADD", "ATL"
];

// Escape user-supplied text before inserting it into innerHTML templates
function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- In-page notes instead of pop-up alerts ---
// Some browsers (and in-app browsers) block alert() pop-ups, which hid sign-up messages.
// Every alert() in the app now shows as a small note at the top of the page.
function showToast(message) {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = String(message ?? '');
    const dismiss = () => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 350);
    };
    toast.addEventListener('click', dismiss);
    stack.appendChild(toast);
    setTimeout(dismiss, Math.min(9000, 3500 + toast.textContent.length * 45));
}
window.alert = showToast;

// --- Online backend (Supabase) for accounts, planner sync & friends chat ---
// Accounts, friend messages and each account's planner live online; localStorage keeps a copy
// so the app still opens offline. If supabase-config.js is empty, `cloud` is null and the app
// works local-only like before.
function isSecretSupabaseKey(key) {
    if (key.startsWith('sb_secret_')) return true;
    try {
        const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.role === 'service_role';
    } catch (e) {
        return false;
    }
}

const cloud = (function createCloudClient() {
    const cfg = window.PROCRASTINOTE_SUPABASE || {};
    const url = (cfg.url || '').trim();
    const key = (cfg.publishableKey || '').trim();
    if (!url || !key || !window.supabase) return null;
    if (isSecretSupabaseKey(key)) {
        console.error('supabase-config.js contains a SECRET key. Replace it with the publishable (anon) key. Online chat is disabled.');
        return null;
    }
    return window.supabase.createClient(url, key);
})();

// Planner sync state (see "Planner sync" near the friends chat code)
const PLANNER_SYNC_FIELDS = ['settings', 'notebooks', 'activeNotebookId', 'uniforms', 'timetable', 'homeTimetable',
    'homeSchedule', 'homework', 'friendsList', 'holidays', 'halfdayDates',
    'classFollow', 'classTimetableImported', 'classHomeworkAdded'];
let plannerReady = false;     // false until this device has loaded the online copy after logging in
let plannerDirty = false;     // local changes not saved online yet
let plannerSyncTimer = null;
let plannerLastSynced = null; // updated_at of the online copy this device last saved or loaded
let plannerBase = {};         // field -> JSON of the online copy as of plannerLastSynced
let applyingRemotePlanner = false;

let defaultState = {
    settings: {
        totalDays: 6,
        currentDayOrder: 1, // Represents 'Today'
        lastUpdatedDate: new Date().toDateString(),
        theme: 'system' // follow the device until the person picks light or dark
    },
    user: null, // Holds profile info
    notebooks: [], // e.g. [{id, title, content, images: []}]
    activeNotebookId: null, // To remember the last opened note
    uniforms: {}, // e.g., { "1": "Regular", "2": "PE" }
    timetable: {}, // e.g., { "1": ["Math", "English"], "2": ["Science"] }
    homeTimetable: { weekdays: '', weekends: '', halfdays: '', everyday: '' },
    homeSchedule: [], // e.g. [{id, daycat, acttype, subject, start, end}]
    homework: [], // e.g., { id, task, subject, date }
    emailVerified: false,
    friendsList: [], // Holds list of added friend emails
    holidays: {}, // e.g. { "2026-11-09": "Diwali" } (no Day Order on these dates)
    halfdayDates: {}, // e.g. { "2026-10-19": true }: use the half-day study plan that day
    // Classes (classes.js)
    classFollow: {}, // { classId: true }: class homework is added to your homework automatically
    classTimetableImported: {}, // { classId: timetable_updated_at of the class timetable you imported }
    classHomeworkAdded: {}, // { classHomeworkId: classId }: already added once, so finished homework doesn't return
    groqKeyEnc: null, // encrypted Groq key (see "Groq key protection")
    groqKeyHint: '', // last 4 characters, to recognise which key is saved
    emailjs: {
        publicKey: '',
        serviceId: '',
        templateId: ''
    }
};

let allUsers = JSON.parse(localStorage.getItem(USERS_KEY)) || {};
let currentEmail = localStorage.getItem(SESSION_KEY);
let appState = (currentEmail && allUsers[currentEmail]) ? 
    { ...JSON.parse(JSON.stringify(defaultState)), user: allUsers[currentEmail].profile, ...allUsers[currentEmail].data } : 
    JSON.parse(JSON.stringify(defaultState));
    
// Auto-update if using the old broken default key
if (appState.geminiKey) {
    delete appState.geminiKey;
}

// Simple state management script
function saveState() {
    if (appState.user && appState.user.email) {
        const email = appState.user.email.toLowerCase();
        allUsers[email] = {
            profile: appState.user,
            data: {
                settings: appState.settings,
                notebooks: appState.notebooks,
                activeNotebookId: appState.activeNotebookId,
                uniforms: appState.uniforms,
                timetable: appState.timetable,
                homeTimetable: appState.homeTimetable,
                homeSchedule: appState.homeSchedule,
                homework: appState.homework,
                emailVerified: appState.emailVerified,
                friendsList: appState.friendsList || [],
                holidays: appState.holidays || {},
                halfdayDates: appState.halfdayDates || {},
                classFollow: appState.classFollow || {},
                classTimetableImported: appState.classTimetableImported || {},
                classHomeworkAdded: appState.classHomeworkAdded || {},
                groqKeyEnc: appState.groqKeyEnc || null,
                groqKeyHint: appState.groqKeyHint || '',
                groqKey: appState.groqKey || undefined, // old readable key, kept only until it's encrypted
                emailjs: appState.emailjs
            }
        };
        try {
            localStorage.setItem(USERS_KEY, JSON.stringify(allUsers));
            localStorage.setItem(SESSION_KEY, email);
        } catch (e) {
            // The browser's storage for this site is full (usually from pictures in notes)
            if (!saveState._warned) {
                alert('Your browser storage is full, so changes on this device may not be saved. Remove some pictures from your notes to free up space.');
                saveState._warned = true;
                setTimeout(() => { saveState._warned = false; }, 60000);
            }
        }
        schedulePlannerSync();
    }
    renderAllViews();
}

function flashFeedback(buttonElement) {
    const card = buttonElement.closest('.card');
    if (card) {
        card.classList.remove('flash-success');
        void card.offsetWidth; // Trigger reflow
        card.classList.add('flash-success');
        setTimeout(() => {
            card.classList.remove('flash-success');
        }, 500);
    }
}

// Global custom dropdown helper
function setupCustomDropdown(displayId, optionsId, inputId, options, onSelect) {
    const display = document.getElementById(displayId);
    const optionsEl = document.getElementById(optionsId);
    const hiddenInput = document.getElementById(inputId);
    
    if (!display || !optionsEl) return;

    // Clear and build options
    optionsEl.innerHTML = '';
    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'custom-option';
        div.innerText = opt.label;
        div.setAttribute('data-value', opt.value);
        div.addEventListener('click', (e) => {
            const val = e.target.getAttribute('data-value');
            if (hiddenInput) hiddenInput.value = val;
            display.innerText = opt.label;
            display.classList.add('has-value');
            optionsEl.classList.remove('open');
            display.classList.remove('active');
            if (onSelect) onSelect(val);
        });
        optionsEl.appendChild(div);
    });

    display.onclick = (e) => {
        e.stopPropagation();
        // Close other open ones
        document.querySelectorAll('.custom-select-options').forEach(o => {
            if (o !== optionsEl) o.classList.remove('open');
        });
        document.querySelectorAll('.custom-select-display').forEach(d => {
            if (d !== display) d.classList.remove('active');
        });
        optionsEl.classList.toggle('open');
        display.classList.toggle('active');
    };
}

// Close custom select dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select-display') && !e.target.closest('.custom-select-options')) {
        document.querySelectorAll('.custom-select-options').forEach(o => o.classList.remove('open'));
        document.querySelectorAll('.custom-select-display').forEach(d => d.classList.remove('active'));
    }
});

// --- Navigation Logic ---
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const phoneNav = window.matchMedia('(max-width: 820px)');

document.querySelectorAll('.nav-links li').forEach(link => {
    link.addEventListener('click', (e) => {
        const li = e.currentTarget;
        document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));

        li.classList.add('active');
        const tabId = li.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active-view');
        closePhoneNav();
        window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
});

// When any view becomes visible (dock, back buttons, mini player...), its cards float in one after another
function playViewEntrance(view) {
    if (!view || reducedMotion.matches) return;
    const items = view.querySelectorAll(':scope > .view-header, .card, .timetable-switch');
    items.forEach((el, i) => el.style.setProperty('--i', Math.min(i, 10)));
    view.classList.remove('entering');
    void view.offsetWidth; // restart the animation
    view.classList.add('entering');
    clearTimeout(view._enterTimer);
    view._enterTimer = setTimeout(() => view.classList.remove('entering'), 1500);
}

const viewObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
        const view = m.target;
        const wasActive = (m.oldValue || '').split(' ').includes('active-view');
        if (view.classList.contains('active-view') && !wasActive) playViewEntrance(view);
    });
});
document.querySelectorAll('.view').forEach(view => {
    viewObserver.observe(view, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
});

// Phone menu: the dock slides in from the left
function closePhoneNav() {
    document.body.classList.remove('nav-open');
    document.getElementById('nav-toggle')?.setAttribute('aria-expanded', 'false');
}

document.getElementById('nav-toggle')?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    document.getElementById('nav-toggle').setAttribute('aria-expanded', String(open));
});
document.getElementById('nav-scrim')?.addEventListener('click', closePhoneNav);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePhoneNav();
});
phoneNav.addEventListener('change', closePhoneNav);

// Dock magnify: icons near the mouse grow, like a Mac dock
(function setupDockMagnify() {
    const dock = document.getElementById('app-dock');
    if (!dock) return;
    const items = Array.from(dock.querySelectorAll('.dock-item'));
    let centers = [];

    const reset = () => items.forEach(item => item.style.setProperty('--mag', '1'));
    dock.addEventListener('mouseenter', () => {
        // Measure while everything is at normal size, so growing icons don't shift the targets
        centers = items.map(item => {
            const r = item.getBoundingClientRect();
            return r.left + r.width / 2;
        });
    });
    dock.addEventListener('mousemove', (e) => {
        if (phoneNav.matches || reducedMotion.matches || !centers.length) return;
        items.forEach((item, i) => {
            const distance = Math.abs(e.clientX - centers[i]);
            const mag = 1 + 0.4 * Math.max(0, 1 - distance / 120);
            item.style.setProperty('--mag', mag.toFixed(3));
        });
    });
    dock.addEventListener('mouseleave', reset);
    phoneNav.addEventListener('change', reset);
})();

// Top bar turns frosted once the page scrolls
window.addEventListener('scroll', () => {
    document.querySelector('.app-topbar')?.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

// --- Date & Day Order Math ---
// currentDayOrder belongs to the last school day on or before lastUpdatedDate.
// Weekends and holidays have no Day Order and are skipped when counting.
function getHoliday(date) {
    return (appState.holidays || {})[formatDateString(date)];
}

function isSchoolDay(date) {
    const dow = date.getDay(); // 0 is Sunday, 6 is Saturday
    return dow !== 0 && dow !== 6 && getHoliday(date) === undefined;
}

function updateDayOrderIfNeeded() {
    if (!appState.settings.lastUpdatedDate) {
        appState.settings.lastUpdatedDate = new Date().toDateString();
        return true;
    }
    
    let lastDate = new Date(appState.settings.lastUpdatedDate);
    let today = new Date();
    
    // Normalize to midnight
    lastDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    
    // Only start tracking from June 1st, 2026
    let startTrackingDate = new Date('2026-06-01');
    startTrackingDate.setHours(0, 0, 0, 0);
    
    let upgraded = false;
    if (lastDate < startTrackingDate) {
        lastDate = startTrackingDate;
        upgraded = true;
    }
    
    if (today > lastDate) {
        let temp = new Date(lastDate);
        let weekdays = 0;
        while (temp < today) {
            temp.setDate(temp.getDate() + 1);
            if (isSchoolDay(temp)) {
                weekdays++;
            }
        }
        
        if (weekdays > 0) {
            let current = parseInt(appState.settings.currentDayOrder) || 1;
            let total = parseInt(appState.settings.totalDays) || 6;
            let newDay = ((current - 1 + weekdays) % total) + 1;
            appState.settings.currentDayOrder = newDay;
        }
        
        appState.settings.lastUpdatedDate = today.toDateString();
        return true;
    } else if (today < lastDate) {
        // Clock was moved back or timezone change, just sync date to today without changing day order
        appState.settings.lastUpdatedDate = today.toDateString();
        return true;
    } else if (upgraded) {
        appState.settings.lastUpdatedDate = today.toDateString();
        return true;
    }
    return false;
}

// The next school day after today (skips weekends and holidays)
function getNextSchoolDay() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    for (let i = 0; i < 366; i++) {
        date.setDate(date.getDate() + 1);
        if (isSchoolDay(date)) return date;
    }
    return date;
}

// Add (name = string) or remove (name = null) a holiday. Every school day after it shifts by one.
// Future dates shift automatically; for today or a past date, the stored Day Order is shifted too.
function setHoliday(date, name) {
    if (!appState.holidays) appState.holidays = {};
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const key = formatDateString(day);
    const wasSchoolDay = isSchoolDay(day);
    if (name === null) {
        delete appState.holidays[key];
    } else {
        appState.holidays[key] = name;
    }

    const lastDate = new Date(appState.settings.lastUpdatedDate);
    lastDate.setHours(0, 0, 0, 0);
    if (day <= lastDate && wasSchoolDay !== isSchoolDay(day)) {
        const total = parseInt(appState.settings.totalDays) || 6;
        const current = parseInt(appState.settings.currentDayOrder) || 1;
        const step = isSchoolDay(day) ? 1 : -1;
        appState.settings.currentDayOrder = ((current - 1 + step + total) % total) + 1;
    }
    saveState();
}

// --- Calendar Logic ---
let currentCalendarDate = new Date();
let selectedCalendarDate = new Date();
selectedCalendarDate.setHours(0,0,0,0);

function getDayOrderForDate(targetDate) {
    const targetCopy = new Date(targetDate);
    targetCopy.setHours(0,0,0,0);
    
    if (!isSchoolDay(targetCopy)) return null; // Weekends and holidays have no Day Order

    let lastDate = new Date(appState.settings.lastUpdatedDate);
    lastDate.setHours(0,0,0,0);
    
    let currentDayOrder = parseInt(appState.settings.currentDayOrder) || 1;
    let totalDays = parseInt(appState.settings.totalDays) || 6;
    
    if (targetCopy.getTime() === lastDate.getTime()) {
        return currentDayOrder;
    }
    
    let weekdays = 0;
    let temp = new Date(lastDate);
    
    if (targetCopy > lastDate) {
        while (temp.getTime() < targetCopy.getTime()) {
            temp.setDate(temp.getDate() + 1);
            if (isSchoolDay(temp)) {
                weekdays++;
            }
        }
        return ((currentDayOrder - 1 + weekdays) % totalDays) + 1;
    } else {
        // Mirror of the forward case: count school days in (target, lastDate]
        while (temp.getTime() > targetCopy.getTime()) {
            if (isSchoolDay(temp)) {
                weekdays++;
            }
            temp.setDate(temp.getDate() - 1);
        }

        let newDay = (currentDayOrder - 1 - weekdays) % totalDays;
        if (newDay < 0) newDay += totalDays;
        return newDay + 1;
    }
}

// "2026-10-20" means that day where you live. new Date("2026-10-20") would read it as midnight
// in London, which shows the day before for anyone west of the UK.
function parseDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}

function formatDateString(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function showCalendarDayDetails(date) {
    const detailsDate = document.getElementById('cal-details-date');
    const detailsContent = document.getElementById('cal-details-content');
    if (!detailsDate || !detailsContent) return;
    
    detailsDate.innerText = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    
    const dayOrder = getDayOrderForDate(date);
    const formattedDate = formatDateString(date);
    
    let html = '';
    
    if (dayOrder !== null) {
        html += `
            <div class="calendar-detail-section">
                <h4>Day Order</h4>
                <p>Day Order ${dayOrder}</p>
            </div>
        `;
        
        const uniform = appState.uniforms[dayOrder] || 'Not configured in settings';
        html += `
            <div class="calendar-detail-section">
                <h4>Required Uniform</h4>
                <p>${escapeHTML(uniform)}</p>
            </div>
        `;
        
        const daySubjects = appState.timetable[dayOrder] || [];
        let subjectsHtml = '';
        daySubjects.forEach((sub, idx) => {
            if (sub.trim() !== '') {
                subjectsHtml += `<li><strong>Period ${idx + 1}:</strong> ${escapeHTML(sub)}</li>`;
            }
        });
        if (subjectsHtml === '') {
            subjectsHtml = '<li>No subjects scheduled.</li>';
        }
        
        html += `
            <div class="calendar-detail-section">
                <h4>Timetable Subjects</h4>
                <ul style="list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.25rem;">
                    ${subjectsHtml}
                </ul>
            </div>
        `;
    } else if (getHoliday(date) !== undefined) {
        const holidayName = getHoliday(date);
        html += `
            <div class="calendar-detail-section holiday-section">
                <h4>Holiday</h4>
                <p>${holidayName ? escapeHTML(holidayName) : 'School holiday'}</p>
                <p style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.25rem;">No Day Order. The schedule continues on the next school day.</p>
            </div>
        `;
    } else {
        html += `
            <div class="calendar-detail-section" style="background: rgba(148, 163, 184, 0.05);">
                <h4>Day Category</h4>
                <p style="color: var(--text-secondary);">Weekend (No Day Order / Classes)</p>
            </div>
        `;
    }

    // Holiday controls (weekdays only; weekends already have no Day Order)
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) {
        if (getHoliday(date) !== undefined) {
            html += `
                <div class="calendar-detail-section">
                    <button type="button" id="cal-remove-holiday" class="btn secondary-btn holiday-btn">Remove Holiday</button>
                </div>
            `;
        } else {
            html += `
                <div class="calendar-detail-section">
                    <h4>Holiday?</h4>
                    <input type="text" id="cal-holiday-name" class="holiday-name-input" maxlength="60" placeholder="Name (optional), e.g. Diwali">
                    <button type="button" id="cal-mark-holiday" class="btn primary-btn holiday-btn">Mark as Holiday</button>
                </div>
            `;
        }
    }

    const matchingHw = appState.homework.filter(hw => formatDateString(parseDay(hw.date)) === formattedDate);
    let hwHtml = '';
    if (matchingHw.length > 0) {
        matchingHw.forEach(hw => {
            hwHtml += `
                <li class="calendar-detail-hw-item">
                    <strong style="color: var(--danger); font-size: 0.95rem;">${escapeHTML(hw.task)}</strong>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.15rem;">Subject: ${escapeHTML(hw.subject)}</div>
                </li>
            `;
        });
    } else {
        hwHtml = '<li style="color: var(--text-secondary); font-style: italic;">No homework assignments due.</li>';
    }
    
    html += `
        <div class="calendar-detail-section">
            <h4>Homework Due</h4>
            <ul class="calendar-detail-hw-list">
                ${hwHtml}
            </ul>
        </div>
    `;
    
    detailsContent.innerHTML = html;

    document.getElementById('cal-mark-holiday')?.addEventListener('click', () => {
        setHoliday(date, document.getElementById('cal-holiday-name').value.trim());
    });
    document.getElementById('cal-remove-holiday')?.addEventListener('click', () => {
        setHoliday(date, null);
    });
    document.getElementById('cal-holiday-name')?.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') document.getElementById('cal-mark-holiday')?.click();
    });
}

function createDayCell(date, isCurrentMonth) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell';
    if (!isCurrentMonth) {
        cell.classList.add('other-month');
    }
    
    const today = new Date();
    if (date.getDate() === today.getDate() && date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear()) {
        cell.classList.add('today');
    }
    
    if (selectedCalendarDate && date.getDate() === selectedCalendarDate.getDate() && date.getMonth() === selectedCalendarDate.getMonth() && date.getFullYear() === selectedCalendarDate.getFullYear()) {
        cell.classList.add('selected');
    }
    
    const numDiv = document.createElement('div');
    numDiv.className = 'calendar-day-num';
    numDiv.innerText = date.getDate();
    cell.appendChild(numDiv);
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'calendar-day-info';
    
    const dayOrder = getDayOrderForDate(date);
    if (dayOrder !== null) {
        const doBadge = document.createElement('span');
        doBadge.className = 'calendar-mini-badge day-order';
        doBadge.innerText = `DO ${dayOrder}`;
        infoDiv.appendChild(doBadge);
        
        const uniform = appState.uniforms[dayOrder];
        if (uniform) {
            const uniBadge = document.createElement('span');
            uniBadge.className = 'calendar-mini-badge';
            const isSports = uniform.toLowerCase().includes('pe') || uniform.toLowerCase().includes('sports') || uniform.toLowerCase().includes('pt') || uniform.toLowerCase().includes('uniform rules');
            if (isSports) {
                uniBadge.classList.add('sports-uniform');
            } else {
                uniBadge.classList.add('regular-uniform');
            }
            uniBadge.innerText = uniform;
            uniBadge.title = `Uniform: ${uniform}`;
            infoDiv.appendChild(uniBadge);
        }
    } else if (getHoliday(date) !== undefined) {
        cell.classList.add('holiday');
        const holidayBadge = document.createElement('span');
        holidayBadge.className = 'calendar-mini-badge holiday-badge';
        holidayBadge.innerText = 'Holiday';
        holidayBadge.title = getHoliday(date) || 'Holiday';
        infoDiv.appendChild(holidayBadge);
    }
    
    const formattedDate = formatDateString(date);
    const hasHw = appState.homework.some(hw => formatDateString(parseDay(hw.date)) === formattedDate);
    if (hasHw) {
        const hwBadge = document.createElement('span');
        hwBadge.className = 'calendar-mini-badge hw-due';
        hwBadge.innerText = `HW Due`;
        infoDiv.appendChild(hwBadge);
    }
    
    cell.appendChild(infoDiv);
    
    cell.addEventListener('click', () => {
        selectedCalendarDate = new Date(date);
        document.querySelectorAll('.calendar-day-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        showCalendarDayDetails(date);
    });
    
    return cell;
}

function renderCalendar() {
    const grid = document.getElementById('calendar-days-grid');
    const monthYearLabel = document.getElementById('calendar-month-year');
    if (!grid || !monthYearLabel) return;
    
    grid.innerHTML = '';
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    monthYearLabel.innerText = `${monthNames[month]} ${year}`;
    
    const firstDay = new Date(year, month, 1);
    const startDayOfWeek = firstDay.getDay(); 
    
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
        const dayNum = prevMonthDays - i;
        const cellDate = new Date(year, month - 1, dayNum);
        grid.appendChild(createDayCell(cellDate, false));
    }
    
    for (let i = 1; i <= totalDaysInMonth; i++) {
        const cellDate = new Date(year, month, i);
        grid.appendChild(createDayCell(cellDate, true));
    }
    
    const currentCells = startDayOfWeek + totalDaysInMonth;
    const remainingCells = 42 - currentCells;
    for (let i = 1; i <= remainingCells; i++) {
        const cellDate = new Date(year, month + 1, i);
        grid.appendChild(createDayCell(cellDate, false));
    }
    
    if (selectedCalendarDate) {
        showCalendarDayDetails(selectedCalendarDate);
    }
}

// Bind calendar navigation controls
(function initCalendarControls() {
    document.getElementById('btn-prev-month')?.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
        renderCalendar();
    });

    document.getElementById('btn-next-month')?.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
        renderCalendar();
    });
})();

// --- Render Logic ---

function renderAllViews() {
    renderSettings();
    renderTimetable();
    renderHomework();
    renderDashboard();
    renderProfile();
    renderNotebooks();
    updateRobotExpression();
    renderCalendar();
    renderEmailJSSettings();
    if (typeof renderFriends === 'function') {
        renderFriends();
    }
    if (typeof renderNotifications === 'function') {
        renderNotifications();
    }
    if (typeof renderHomeSchedule === 'function') {
        const activeFilter = document.querySelector('.hs-pill.active')?.getAttribute('data-filter') || 'all';
        renderHomeSchedule(activeFilter);
    }
}

function updateRobotExpression() {
    const mouths = document.querySelectorAll('.robot-mouth');
    if (!mouths.length) return;
    
    let isOverdue = false;
    const now = new Date();
    // Normalize today to start of day
    now.setHours(0, 0, 0, 0); 
    
    for (let hw of appState.homework) {
        const hwDate = parseDay(hw.date);
        hwDate.setHours(0, 0, 0, 0);
        if (hwDate < now) {
            isOverdue = true;
            break;
        }
    }
    
    const frownPath = "M 40 65 Q 50 55 60 65";
    const smilePath = "M 40 60 Q 50 68 60 60";
    
    mouths.forEach(mouth => {
        mouth.setAttribute('d', isOverdue ? frownPath : smilePath);
    });
}

function renderSettings() {
    // Setup Custom Dropdowns for School Setup
    setupCustomDropdown('total-days-display', 'total-days-options', 'total-days', 
        Array.from({length: 10}, (_, i) => ({label: (i+1).toString(), value: (i+1).toString()})),
        (val) => {
            appState.settings.totalDays = parseInt(val);
            renderSettings(); // Re-render to update the range of Today's Day Order
        }
    );

    const total = parseInt(appState.settings.totalDays);
    setupCustomDropdown('current-day-display', 'current-day-options', 'current-day-order', 
        Array.from({length: total}, (_, i) => ({label: (i+1).toString(), value: (i+1).toString()})),
        (val) => {
            appState.settings.currentDayOrder = parseInt(val);
        }
    );

    // Set initial display values
    const totalDisplay = document.getElementById('total-days-display');
    if (totalDisplay) {
        totalDisplay.innerText = appState.settings.totalDays;
        totalDisplay.classList.add('has-value');
    }

    const currentDisplay = document.getElementById('current-day-display');
    if (currentDisplay) {
        if (parseInt(appState.settings.currentDayOrder) > total) {
            appState.settings.currentDayOrder = total;
        }
        currentDisplay.innerText = appState.settings.currentDayOrder;
        currentDisplay.classList.add('has-value');
    }

    // Uniforms
    const container = document.getElementById('uniform-setup-container');
    container.innerHTML = '';
    
    const uniformOptions = [
        {label: 'Regular Uniform', value: 'Regular Uniform'},
        {label: 'Sports Uniform', value: 'Sports Uniform'}
    ];

    for (let i = 1; i <= appState.settings.totalDays; i++) {
        const val = appState.uniforms[i] || 'Regular Uniform';
        container.innerHTML += `
            <div class="form-group" style="position: relative; margin-bottom: 2rem;">
                <label>Day ${i} Uniform</label>
                <div id="uniform-day-${i}-display" class="custom-select-display">${val}</div>
                <div id="uniform-day-${i}-options" class="custom-select-options"></div>
                <input type="hidden" id="uniform-day-${i}" value="${val}">
            </div>
        `;
    }

    // Initialize dropdowns after HTML is added
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        setupCustomDropdown(`uniform-day-${i}-display`, `uniform-day-${i}-options`, `uniform-day-${i}`, uniformOptions);
        const display = document.getElementById(`uniform-day-${i}-display`);
        if (display && appState.uniforms[i]) {
            display.classList.add('has-value');
        }
    }
}

function renderTimetable() {
    const container = document.getElementById('timetable-container');
    container.innerHTML = '';
    
    const subOptions = SUBJECT_LIST.map(s => ({label: s, value: s}));

    for (let i = 1; i <= appState.settings.totalDays; i++) {
        const daySubjects = appState.timetable[i] || ['', '', '', '', '', '', '', ''];
        let subjectsHtml = '';
        
        for (let j = 0; j < 8; j++) {
            let val = daySubjects[j] || '';
            let displayVal = val || `Subject ${j+1}`;
            subjectsHtml += `
                <div class="form-group" style="position: relative; margin-bottom: 1.5rem;">
                    <div id="day-${i}-sub-${j}-display" class="custom-select-display ${val ? 'has-value' : ''}" style="font-size: 0.9rem; padding: 0.5rem 0;">${displayVal}</div>
                    <div id="day-${i}-sub-${j}-options" class="custom-select-options"></div>
                    <input type="hidden" class="subject-input day-${i}-sub" id="day-${i}-sub-${j}" value="${val}">
                </div>
            `;
        }

        container.innerHTML += `
            <div class="day-column">
                <h4>Day ${i}</h4>
                ${subjectsHtml}
            </div>
        `;
    }

    // Initialize all timetable dropdowns
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        for (let j = 0; j < 8; j++) {
            setupCustomDropdown(`day-${i}-sub-${j}-display`, `day-${i}-sub-${j}-options`, `day-${i}-sub-${j}`, subOptions, (val) => {
                // Optional: handle immediate save or feedback
            });
        }
    }

    // Populate home timetable
    const ht = appState.homeTimetable;
    if (ht) {
        const wk = document.getElementById('home-study-weekdays');
        if (wk) wk.value = ht.weekdays || '';
        const we = document.getElementById('home-study-weekends');
        if (we) we.value = ht.weekends || '';
        const hd = document.getElementById('home-study-halfdays');
        if (hd) hd.value = ht.halfdays || '';
        const ed = document.getElementById('home-study-everyday');
        if (ed) ed.value = ht.everyday || '';
    }
}

function renderHomework() {
    // Setup Subject Dropdown for Form
    const subOptions = SUBJECT_LIST.map(s => ({label: s, value: s}));
    setupCustomDropdown('hw-subject-display', 'hw-subject-options', 'hw-subject', subOptions);

    const list = document.getElementById('active-homework-list');
    list.innerHTML = '';

    // Sort by date mostly
    appState.homework.sort((a, b) => parseDay(a.date) - parseDay(b.date));

    if (appState.homework.length === 0) {
        list.innerHTML = '<li class="empty-state">No active homework!</li>';
        return;
    }

    appState.homework.forEach((hw, index) => {
        list.innerHTML += `
            <li style="animation-delay: ${Math.min(index, 8) * 40}ms">
                <div class="hw-info">
                    <strong>${escapeHTML(hw.task)}</strong>
                    <span>${escapeHTML(hw.subject)} · Due ${parseDay(hw.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                </div>
                <button class="done-btn" onclick="completeHomework(${index}, this)">
                    <span class="done-circle"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="done-check" d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>
                    Done
                </button>
            </li>
        `;
    });
}

function renderDashboard() {
    const dateLine = document.getElementById('dash-date');
    if (dateLine) dateLine.innerText = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

    // Plan for the next school day, skipping weekends and holidays
    const nextSchoolDay = getNextSchoolDay();
    const tmrwDay = getDayOrderForDate(nextSchoolDay);
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = nextSchoolDay.getTime() === tomorrow.getTime();
    const nextLabel = isTomorrow ? 'Tomorrow' : nextSchoolDay.toLocaleDateString(undefined, { weekday: 'long' });
    const tomorrowLabel = document.getElementById('dash-tomorrow-label');
    if (tomorrowLabel) tomorrowLabel.innerText = nextLabel;
    let dayOrderText = `Day Order ${tmrwDay}`;
    if (!isTomorrow) {
        const holidayName = getHoliday(tomorrow);
        const reason = holidayName !== undefined ? `Tomorrow is a holiday${holidayName ? ` (${holidayName})` : ''}` : 'No school tomorrow';
        dayOrderText = `${reason}. Next school day: ${nextSchoolDay.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}, Day Order ${tmrwDay}`;
    }
    document.getElementById('dash-day-order-display').innerText = dayOrderText;

    // Uniform
    const unif = appState.uniforms[tmrwDay];
    document.getElementById('dash-uniform').innerText = unif ? unif : "Not set yet";

    // Subjects & Books
    // Get ALL unique subjects to know our master list
    let allSubjects = new Set();
    const totalDays = parseInt(appState.settings.totalDays) || 6;
    Object.entries(appState.timetable).forEach(([day, dayList]) => {
        if (parseInt(day) > totalDays) return; // ignore day orders that were removed in setup
        dayList.forEach(sub => {
            if (sub.trim() !== '') allSubjects.add(sub.trim());
        });
    });

    // Get tomorrow's subjects
    let tmrwSubjects = new Set();
    const dayList = appState.timetable[tmrwDay] || [];
    dayList.forEach(sub => {
        if (sub.trim() !== '') tmrwSubjects.add(sub.trim());
    });

    // Pack list = tomorrow's subjects
    const packListEl = document.getElementById('dash-pack-list');
    packListEl.innerHTML = '';
    if (tmrwSubjects.size === 0) {
        packListEl.innerHTML = '<li class="empty-state">No subjects set for tomorrow.</li>';
    } else {
        tmrwSubjects.forEach(sub => {
            packListEl.innerHTML += `<li>${escapeHTML(sub)}</li>`;
        });
    }

    // Leave list = All subjects minus tomorrow's subjects
    const leaveListEl = document.getElementById('dash-leave-list');
    leaveListEl.innerHTML = '';
    let leftBehind = 0;
    allSubjects.forEach(sub => {
        if (!tmrwSubjects.has(sub)) {
            leaveListEl.innerHTML += `<li>${escapeHTML(sub)}</li>`;
            leftBehind++;
        }
    });
    
    if (leftBehind === 0) {
        leaveListEl.innerHTML = '<li class="empty-state">No other books.</li>';
    }

    // Homework Alert (due within 2 days)
    const hwList = document.getElementById('dash-homework-list');
    hwList.innerHTML = '';
    const now = new Date();
    let urgentHw = 0;

    appState.homework.forEach(hw => {
        const diffTime = parseDay(hw.date) - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        if (diffDays <= 3) { // Shows due soon
            const when = diffDays < 0 ? 'Overdue' : diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : `In ${diffDays} days`;
            hwList.innerHTML += `<li class="${diffDays < 0 ? 'overdue' : ''}"><span class="due-task">${escapeHTML(hw.task)}</span><span class="due-when">${when}</span></li>`;
            urgentHw++;
        }
    });

    if (urgentHw === 0) {
        hwList.innerHTML = '<li class="empty-state">Nothing due soon. Nice.</li>';
    }

    renderStudyPlan();
}

// --- Dashboard: today's home study blocks ---
// Which Home Study Plan category applies today: weekday, halfday, weekend or holiday (uses weekend blocks)
function getTodayStudyCategory() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!isSchoolDay(today)) return getHoliday(today) !== undefined ? 'holiday' : 'weekend';
    return (appState.halfdayDates || {})[formatDateString(today)] ? 'halfday' : 'weekday';
}

function renderStudyPlan() {
    const list = document.getElementById('dash-study-list');
    const badge = document.getElementById('dash-study-daytype');
    const halfdayBtn = document.getElementById('dash-halfday-toggle');
    if (!list) return;

    const category = getTodayStudyCategory();
    const labels = { weekday: 'Weekday plan', halfday: 'Half-day plan', weekend: 'Weekend plan', holiday: 'Holiday: weekend plan' };
    if (badge) badge.innerText = labels[category];
    if (halfdayBtn) {
        halfdayBtn.style.display = (category === 'weekday' || category === 'halfday') ? '' : 'none';
        halfdayBtn.innerText = category === 'halfday' ? 'Back to full day' : 'Half-day today?';
    }

    const daycat = category === 'holiday' ? 'weekend' : category;
    const blocks = (appState.homeSchedule || [])
        .filter(item => item.daycat === daycat)
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    if (blocks.length === 0) {
        list.innerHTML = `
            <li class="empty-state">No study blocks for this kind of day yet.</li>
            <li><button type="button" class="btn secondary-btn study-plan-link">Plan study time</button></li>
        `;
        list.querySelector('.study-plan-link').addEventListener('click', () => {
            document.querySelector('li[data-tab="timetable"]')?.click();
            showTimetableTab('home');
        });
        return;
    }

    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const actLabels = { study: 'Study', homework: 'Homework', revision: 'Revision', break: 'Break' };
    list.innerHTML = '';
    blocks.forEach(item => {
        let status = '';
        if (item.end && item.end <= nowTime) status = 'done';
        else if (item.start && item.start <= nowTime && (!item.end || nowTime < item.end)) status = 'now';
        const timeStr = item.start && item.end ? `${item.start} – ${item.end}` : (item.start || item.end || '');
        const li = document.createElement('li');
        li.className = `study-plan-item act-${escapeHTML(item.acttype)} ${status}`;
        li.innerHTML = `
            <span class="study-plan-time">${escapeHTML(timeStr)}</span>
            <span class="study-plan-subject">${escapeHTML(item.subject || actLabels[item.acttype] || 'Study')}</span>
            <span class="study-plan-tag">${status === 'now' ? 'Now' : escapeHTML(actLabels[item.acttype] || item.acttype)}</span>
        `;
        list.appendChild(li);
    });
}

document.getElementById('dash-halfday-toggle')?.addEventListener('click', () => {
    if (!appState.halfdayDates) appState.halfdayDates = {};
    const key = formatDateString(new Date());
    if (appState.halfdayDates[key]) delete appState.halfdayDates[key];
    else appState.halfdayDates[key] = true;
    saveState();
});

setInterval(renderStudyPlan, 60000); // keep the "Now" highlight current

function renderProfile() {
    if (appState.user) {
        const nameEl = document.getElementById('profile-name');
        const gradeEl = document.getElementById('profile-grade');
        const emailEl = document.getElementById('profile-email');
        
        if (nameEl) nameEl.innerText = appState.user.name || '--';
        if (gradeEl) gradeEl.innerText = appState.user.class || '--';
        if (emailEl) emailEl.innerText = appState.user.email || '--';
    }
}

// --- Action Bindings ---

// Settings setup
document.getElementById('save-school-setup').addEventListener('click', (e) => {
    appState.settings.totalDays = document.getElementById('total-days').value;
    appState.settings.currentDayOrder = document.getElementById('current-day-order').value;
    saveState();
    flashFeedback(e.target);
});

document.getElementById('save-uniforms-btn').addEventListener('click', (e) => {
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        const hiddenInput = document.getElementById(`uniform-day-${i}`);
        if(hiddenInput) {
            appState.uniforms[i] = hiddenInput.value;
        }
    }
    saveState();
    flashFeedback(e.target);
});

// Timetable setup
document.getElementById('save-timetable-btn').addEventListener('click', (e) => {
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        let subs = [];
        document.querySelectorAll(`.day-${i}-sub`).forEach(input => {
            subs.push(input.value);
        });
        appState.timetable[i] = subs;
    }
    saveState();
    flashFeedback(e.target);
});


// --- Home Schedule Logic ---
function renderHomeSchedule(filter = 'all') {
    if (!appState.homeSchedule) appState.homeSchedule = [];
    const listEl = document.getElementById('home-schedule-list');
    const emptyEl = document.getElementById('home-schedule-empty');
    if (!listEl) return;

    const filtered = filter === 'all' 
        ? appState.homeSchedule 
        : appState.homeSchedule.filter(item => item.daycat === filter);

    // Remove all items except empty state
    Array.from(listEl.children).forEach(ch => { if (ch.id !== 'home-schedule-empty') ch.remove(); });

    if (filtered.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Sort by start time
    const sorted = [...filtered].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    const daycatLabels = { weekday: 'Weekday', weekend: 'Weekend', halfday: 'Half-day' };
    const acttypeLabels = { study: 'Study Session', homework: 'Homework Time', revision: 'Revision', break: 'Break' };
    const acttypeColors = { study: '#3b82f6', homework: '#8b5cf6', revision: '#10b981', break: '#f59e0b' };

    sorted.forEach(item => {
        const div = document.createElement('div');
        div.className = 'schedule-item';
        const color = acttypeColors[item.acttype] || '#3b82f6';
        const timeStr = item.start && item.end ? `${item.start} – ${item.end}` : (item.start || item.end || '');
        div.innerHTML = `
            <div class="schedule-item-color-bar" style="background: ${color};"></div>
            <div class="schedule-item-body">
                <div class="schedule-item-time">${escapeHTML(timeStr)}</div>
                <div class="schedule-item-subject">${escapeHTML(item.subject || 'General')}</div>
                <div class="schedule-item-badges">
                    <span class="schedule-badge" style="background: ${color}22; color: ${color};">${escapeHTML(acttypeLabels[item.acttype] || item.acttype)}</span>
                    <span class="schedule-badge" style="background: rgba(100,116,139,0.1); color: var(--text-secondary);">${escapeHTML(daycatLabels[item.daycat] || item.daycat)}</span>
                </div>
            </div>
            <button class="schedule-delete-btn" onclick="deleteScheduleItem('${item.id}')" title="Remove">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        `;
        listEl.appendChild(div);
    });
}

window.deleteScheduleItem = function(id) {
    if (!appState.homeSchedule) return;
    appState.homeSchedule = appState.homeSchedule.filter(i => i.id !== id);
    saveState();
    const activeFilter = document.querySelector('.hs-pill.active')?.getAttribute('data-filter') || 'all';
    renderHomeSchedule(activeFilter);
};

// Setup home schedule form dropdowns & handlers
(function initHomeSchedule() {
    const daycatOptions = [
        { label: 'Weekday (Mon–Fri)', value: 'weekday' },
        { label: 'Weekend (Sat–Sun)', value: 'weekend' },
        { label: 'Half-day', value: 'halfday' }
    ];
    const acttypeOptions = [
        { label: 'Study Session', value: 'study' },
        { label: 'Homework Time', value: 'homework' },
        { label: 'Revision', value: 'revision' },
        { label: 'Break', value: 'break' }
    ];

    setupCustomDropdown('hs-daycat-display', 'hs-daycat-options', 'hs-daycat', daycatOptions, () => {});
    setupCustomDropdown('hs-acttype-display', 'hs-acttype-options', 'hs-acttype', acttypeOptions, () => {});

    document.getElementById('btn-add-schedule-block')?.addEventListener('click', () => {
        const daycat = document.getElementById('hs-daycat')?.value || 'weekday';
        const acttype = document.getElementById('hs-acttype')?.value || 'study';
        const subject = document.getElementById('hs-subject')?.value.trim() || '';
        const start = document.getElementById('hs-start')?.value || '';
        const end = document.getElementById('hs-end')?.value || '';

        if (!start && !end) {
            const btn = document.getElementById('btn-add-schedule-block');
            btn.classList.add('shake-error');
            setTimeout(() => btn.classList.remove('shake-error'), 600);
            return;
        }

        if (start && end && end <= start) {
            const endInput = document.getElementById('hs-end');
            endInput.classList.add('shake-error');
            setTimeout(() => endInput.classList.remove('shake-error'), 600);
            alert('The end time needs to be after the start time.');
            return;
        }

        if (!appState.homeSchedule) appState.homeSchedule = [];
        appState.homeSchedule.push({ id: 'hs_' + Date.now(), daycat, acttype, subject, start, end });
        saveState();

        // Reset form
        if (document.getElementById('hs-subject')) document.getElementById('hs-subject').value = '';
        if (document.getElementById('hs-start')) document.getElementById('hs-start').value = '';
        if (document.getElementById('hs-end')) document.getElementById('hs-end').value = '';

        const activeFilter = document.querySelector('.hs-pill.active')?.getAttribute('data-filter') || 'all';
        renderHomeSchedule(activeFilter);
    });

    // Filter pills
    document.getElementById('hs-filter-pills')?.addEventListener('click', (e) => {
        const pill = e.target.closest('.hs-pill');
        if (!pill) return;
        document.querySelectorAll('.hs-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        renderHomeSchedule(pill.getAttribute('data-filter') || 'all');
    });
})();

// Timetable tab switch ('school' or 'home')
function showTimetableTab(tab) {
    const isHome = tab === 'home';
    const schoolBtn = document.getElementById('tt-school-btn');
    const homeBtn = document.getElementById('tt-home-btn');
    schoolBtn?.classList.toggle('active', !isHome);
    homeBtn?.classList.toggle('active', isHome);
    schoolBtn?.setAttribute('aria-selected', String(!isHome));
    homeBtn?.setAttribute('aria-selected', String(isHome));
    document.getElementById('school-timetable-view').style.display = isHome ? 'none' : 'block';
    document.getElementById('home-timetable-view').style.display = isHome ? 'block' : 'none';
}

document.getElementById('tt-school-btn')?.addEventListener('click', () => showTimetableTab('school'));
document.getElementById('tt-home-btn')?.addEventListener('click', () => showTimetableTab('home'));


// Helper to calculate the next working day (excluding Saturday/Sunday)
function getNextWorkingDay() {
    const date = new Date();
    // Move to tomorrow
    date.setDate(date.getDate() + 1);
    // Move past Saturday and Sunday
    while (date.getDay() === 0 || date.getDay() === 6) {
        date.setDate(date.getDate() + 1);
    }
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Homework setup
document.getElementById('homework-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const taskInput = document.getElementById('hw-task');
    const task = taskInput.value.trim();
    const subject = document.getElementById('hw-subject').value;
    if (!task) {
        taskInput.classList.add('shake-error');
        setTimeout(() => taskInput.classList.remove('shake-error'), 600);
        return;
    }
    if (!subject) {
        const subjectDisplay = document.getElementById('hw-subject-display');
        subjectDisplay?.classList.add('shake-error');
        setTimeout(() => subjectDisplay?.classList.remove('shake-error'), 600);
        alert('Pick a subject for this homework.');
        return;
    }
    let deadlineDate = document.getElementById('hw-deadline').value;
    if (!deadlineDate) {
        deadlineDate = getNextWorkingDay();
    }
    const hw = {
        id: 'hw_' + Date.now(), // lets account sync merge changes from two devices
        task,
        subject,
        date: deadlineDate
    };
    appState.homework.push(hw);
    
    // Clear inputs
    document.getElementById('hw-task').value = '';
    const hiddenSub = document.getElementById('hw-subject');
    hiddenSub.value = '';
    const displaySub = document.getElementById('hw-subject-display');
    if (displaySub) {
        displaySub.innerText = 'Select Subject';
        displaySub.classList.remove('has-value');
    }
    document.getElementById('hw-deadline').value = '';
    
    saveState();
});

// Finishing homework: the check draws itself, then the item slides away
window.completeHomework = function(index, button) {
    const li = button?.closest('li');
    if (!li || reducedMotion.matches) {
        appState.homework.splice(index, 1);
        saveState();
        return;
    }
    if (li.classList.contains('completing')) return; // already on its way out
    const task = appState.homework[index];
    li.classList.add('completing');
    setTimeout(() => {
        li.style.height = `${li.offsetHeight}px`;
        void li.offsetHeight;
        li.classList.add('leaving');
    }, 420);
    setTimeout(() => {
        const current = appState.homework.indexOf(task);
        if (current !== -1) appState.homework.splice(current, 1);
        saveState();
    }, 1050);
}

// --- Notebook Logic ---
let selectedNotebookIds = new Set();

function updateBulkActionsBar() {
    const bulkBar = document.getElementById('notebook-bulk-bar');
    const selectedCountEl = document.getElementById('nb-selected-count');
    const selectAllCheckbox = document.getElementById('nb-select-all');
    const bulkButtonsContainer = document.querySelector('.bulk-buttons-container');

    if (!bulkBar) return;

    if (appState.notebooks && appState.notebooks.length > 0) {
        bulkBar.style.display = 'block';
        if (selectedCountEl) {
            selectedCountEl.innerText = `${selectedNotebookIds.size} selected`;
        }
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = (selectedNotebookIds.size === appState.notebooks.length && appState.notebooks.length > 0);
        }
        if (bulkButtonsContainer) {
            if (selectedNotebookIds.size > 0) {
                bulkButtonsContainer.classList.add('visible');
            } else {
                bulkButtonsContainer.classList.remove('visible');
            }
        }
    } else {
        bulkBar.style.display = 'none';
        selectedNotebookIds.clear();
        if (bulkButtonsContainer) {
            bulkButtonsContainer.classList.remove('visible');
        }
    }
}

function renderNotebooks() {
    const listEl = document.getElementById('notebook-list');
    const emptyState = document.getElementById('notebook-empty-state');
    const activeView = document.getElementById('notebook-active-view');
    const titleInput = document.getElementById('notebook-title');
    const contentInput = document.getElementById('notebook-content');
    const galleryEl = document.getElementById('notebook-image-gallery');

    if (!listEl) return;
    listEl.innerHTML = '';
    
    if (!appState.notebooks) appState.notebooks = [];

    // Filter out selection set for deleted notes
    const validIds = new Set(appState.notebooks.map(n => n.id));
    selectedNotebookIds.forEach(id => {
        if (!validIds.has(id)) selectedNotebookIds.delete(id);
    });

    appState.notebooks.forEach(nb => {
        const li = document.createElement('li');
        li.className = 'notebook-list-item' + (appState.activeNotebookId === nb.id ? ' active' : '');
        
        const isChecked = selectedNotebookIds.has(nb.id);
        
        li.innerHTML = `
            <input type="checkbox" class="nb-item-checkbox" data-id="${nb.id}" ${isChecked ? 'checked' : ''}>
            <div style="flex: 1; min-width: 0;" class="nb-item-click-target">
                <h4 style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0;">${escapeHTML(nb.title || 'Untitled Note')}</h4>
                <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${nb.content ? escapeHTML(nb.content.substring(0, 30)) + '...' : 'No content'}</p>
            </div>
        `;
        
        const checkbox = li.querySelector('.nb-item-checkbox');
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                selectedNotebookIds.add(nb.id);
            } else {
                selectedNotebookIds.delete(nb.id);
            }
            updateBulkActionsBar();
        });
        
        const clickTarget = li.querySelector('.nb-item-click-target');
        clickTarget.addEventListener('click', () => {
            appState.activeNotebookId = nb.id;
            saveState();
        });

        listEl.appendChild(li);
    });

    updateBulkActionsBar();

    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);

    if (activeNb) {
        emptyState.style.display = 'none';
        activeView.style.display = 'flex';
        
        if (document.activeElement !== titleInput) titleInput.value = activeNb.title;
        if (document.activeElement !== contentInput) contentInput.value = activeNb.content;

        galleryEl.innerHTML = '';
        if (activeNb.images && activeNb.images.length > 0) {
            activeNb.images.forEach((imgUrl, idx) => {
                const container = document.createElement('div');
                container.className = 'gallery-img-container';
                container.innerHTML = `
                    <img src="${escapeHTML(imgUrl)}" alt="Notebook Image">
                    <button class="gallery-img-delete" onclick="deleteNotebookImage(${idx})">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                `;
                galleryEl.appendChild(container);
            });
        }
    } else {
        emptyState.style.display = 'block';
        activeView.style.display = 'none';
    }
    if (typeof renderSharedNotes === 'function') renderSharedNotes();
}

document.getElementById('btn-new-notebook')?.addEventListener('click', () => {
    if (!appState.notebooks) appState.notebooks = [];
    const newId = 'nb_' + Date.now();
    appState.notebooks.unshift({
        id: newId,
        title: 'New Note',
        content: '',
        images: []
    });
    appState.activeNotebookId = newId;
    saveState();
});

// Fullscreen Notebook toggle
document.getElementById('btn-fullscreen-notebook')?.addEventListener('click', () => {
    const editor = document.getElementById('notebook-editor');
    if (!editor) return;
    
    const isFullscreen = editor.classList.toggle('fullscreen');
    
    const expandIcon = document.getElementById('fullscreen-expand-icon');
    const collapseIcon = document.getElementById('fullscreen-collapse-icon');
    
    if (isFullscreen) {
        if (expandIcon) expandIcon.style.display = 'none';
        if (collapseIcon) collapseIcon.style.display = 'inline-block';
    } else {
        if (expandIcon) expandIcon.style.display = 'inline-block';
        if (collapseIcon) collapseIcon.style.display = 'none';
    }
});

// Select All notes
document.getElementById('nb-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) {
        if (appState.notebooks) {
            appState.notebooks.forEach(nb => selectedNotebookIds.add(nb.id));
        }
    } else {
        selectedNotebookIds.clear();
    }
    renderNotebooks();
});

// Bulk Delete selected notes
document.getElementById('btn-bulk-delete')?.addEventListener('click', () => {
    if (selectedNotebookIds.size === 0) return;
    showConfirm(`Are you sure you want to delete the ${selectedNotebookIds.size} selected notes?`, () => {
        appState.notebooks = appState.notebooks.filter(nb => !selectedNotebookIds.has(nb.id));
        if (selectedNotebookIds.has(appState.activeNotebookId)) {
            appState.activeNotebookId = null;
        }
        selectedNotebookIds.clear();
        saveState();
        renderNotebooks();
    });
});

// Bulk Export/Download selected notes
document.getElementById('btn-bulk-download')?.addEventListener('click', () => {
    if (selectedNotebookIds.size === 0) return;
    
    let exportContent = '';
    selectedNotebookIds.forEach(id => {
        const nb = appState.notebooks.find(n => n.id === id);
        if (nb) {
            exportContent += `=========================================\n`;
            exportContent += `Title: ${nb.title || 'Untitled Note'}\n`;
            exportContent += `=========================================\n\n`;
            exportContent += `${nb.content || ''}\n\n\n`;
        }
    });

    const blob = new Blob([exportContent], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `procrastinote_export_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
});

// Press Enter to submit URL image
document.getElementById('notebook-image-url')?.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('btn-add-image')?.click();
    }
});

// options: { title, confirmLabel, danger } (default: a red "Delete" button)
window.showConfirm = function(message, onConfirm, options = {}) {
    const overlay = document.getElementById('custom-confirm-overlay');
    const msgEl = document.getElementById('custom-confirm-msg');
    const btnYes = document.getElementById('custom-confirm-yes');
    const btnNo = document.getElementById('custom-confirm-no');

    if (!overlay) {
        if (confirm(message)) onConfirm();
        return;
    }

    msgEl.innerText = message;
    document.getElementById('custom-confirm-title').innerText = options.title || 'Confirm action';
    btnYes.innerText = options.confirmLabel || 'Delete';
    btnYes.className = `btn ${options.danger === false ? 'primary-btn' : 'danger-solid-btn'}`;
    overlay.style.display = 'flex';
    
    const cleanup = () => {
        overlay.style.display = 'none';
        btnYes.removeEventListener('click', yesHandler);
        btnNo.removeEventListener('click', noHandler);
    };
    
    const yesHandler = () => {
        cleanup();
        onConfirm();
    };
    
    const noHandler = () => {
        cleanup();
    };
    
    btnYes.addEventListener('click', yesHandler);
    btnNo.addEventListener('click', noHandler);
};

document.getElementById('btn-delete-notebook')?.addEventListener('click', () => {
    showConfirm("Are you sure you want to delete this note?", () => {
        appState.notebooks = appState.notebooks.filter(n => n.id !== appState.activeNotebookId);
        appState.activeNotebookId = null;
        saveState();
        renderNotebooks();
    });
});

document.getElementById('notebook-title')?.addEventListener('input', (e) => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (activeNb) {
        activeNb.title = e.target.value;
        saveState();
    }
});

document.getElementById('notebook-content')?.addEventListener('input', (e) => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (activeNb) {
        activeNb.content = e.target.value;
        saveState();
    }
});

document.getElementById('btn-add-image')?.addEventListener('click', () => {
    const urlInput = document.getElementById('notebook-image-url');
    const url = urlInput.value.trim();
    if (url) {
        const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
        if (activeNb) {
            if (!activeNb.images) activeNb.images = [];
            activeNb.images.push(url);
            urlInput.value = '';
            saveState();
            renderNotebooks();
        }
    }
});

document.getElementById('notebook-image-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && isPdfFile(file)) {
        openPdfForOcr(file);
    } else if (file) {
        const reader = new FileReader();
        reader.onload = async (ev) => {
            // Phone photos are several MB; the browser only stores about 5 MB per site, so shrink them first
            const dataUrl = await shrinkImage(ev.target.result);
            const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
            if (activeNb) {
                if (!activeNb.images) activeNb.images = [];
                activeNb.images.push(dataUrl);
                saveState();
                renderNotebooks();
            }
        };
        reader.readAsDataURL(file);
    }
    e.target.value = '';
});

// Resize a picture to at most 1600px and re-save it as a JPEG (usually 150-400 KB)
function shrinkImage(dataUrl, maxSide = 1600, quality = 0.82) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            if (scale === 1 && dataUrl.length < 600000) return resolve(dataUrl);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background in JPEG
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

window.deleteNotebookImage = function(index) {
    showConfirm("Are you sure you want to delete this image?", () => {
        const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
        if (activeNb && activeNb.images) {
            activeNb.images.splice(index, 1);
            saveState();
            renderNotebooks();
        }
    });
}

// AI Assist Logic
document.getElementById('btn-ai-continue')?.addEventListener('click', async () => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!activeNb || !activeNb.content) {
        alert("Write something first so AI has context!");
        return;
    }
    const btn = document.getElementById('btn-ai-continue');
    const origText = btn.innerHTML;
    btn.innerHTML = 'Writing...';
    btn.disabled = true;

    const prompt = `Continue the following notes. Add new relevant information to extend the ideas organically. IMPORTANT: Do not include any conversational filler, greetings, or acknowledgements. Just output the continuation text directly:\n\n${activeNb.content}`;
    const response = await callGroq(prompt);
    
    activeNb.content += '\n\n' + response;
    const contentInput = document.getElementById('notebook-content');
    if (contentInput) contentInput.value = activeNb.content;
    saveState();

    btn.innerHTML = origText;
    btn.disabled = false;
});

document.getElementById('btn-ai-generate')?.addEventListener('click', async () => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!activeNb) return;
    
    const promptInput = document.getElementById('notebook-ai-prompt');
    const query = promptInput.value.trim();
    if (!query) {
        alert("Enter a prompt for the AI.");
        return;
    }

    const btn = document.getElementById('btn-ai-generate');
    const origText = btn.innerText;
    btn.innerText = '...';
    btn.disabled = true;

    const context = activeNb.content ? ` Context from notes: "${activeNb.content.substring(0, 500)}"` : '';
    const prompt = `The user is writing notes. They asked: "${query}". Generate a helpful response to insert into their notes.${context}`;
    const response = await callGroq(prompt);
    
    activeNb.content += `\n\n[AI: ${query}]\n${response}\n`;
    const contentInput = document.getElementById('notebook-content');
    if (contentInput) contentInput.value = activeNb.content;
    promptInput.value = '';
    saveState();

    btn.innerText = origText;
    btn.disabled = false;
});

document.getElementById('btn-translate-english')?.addEventListener('click', async () => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!activeNb || !activeNb.content) {
        alert("Write something first to translate!");
        return;
    }
    const btn = document.getElementById('btn-translate-english');
    const origText = btn.innerText;
    btn.innerText = 'Translating...';
    btn.disabled = true;

    const prompt = `Translate the following notes into English. IMPORTANT: Just output the translated text directly, without any conversational filler, greetings, or acknowledgements:\n\n${activeNb.content}`;
    const response = await callGroq(prompt);
    
    activeNb.content += `\n\n[Translation to English]\n${response}\n`;
    const contentInput = document.getElementById('notebook-content');
    if (contentInput) contentInput.value = activeNb.content;
    saveState();

    btn.innerText = origText;
    btn.disabled = false;
});

document.getElementById('btn-ocr-images')?.addEventListener('click', async () => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!activeNb || !activeNb.images || activeNb.images.length === 0) {
        alert("Add some images to extract text from!");
        return;
    }
    const btn = document.getElementById('btn-ocr-images');
    const origText = btn.innerText;
    btn.innerText = 'Extracting...';
    btn.disabled = true;

    try {
        let extractedText = '';
        for (let i = 0; i < activeNb.images.length; i++) {
            const imgUrl = activeNb.images[i];
            const { data: { text } } = await Tesseract.recognize(imgUrl, 'eng+tam');
            extractedText += `\n[Image ${i + 1} Extracted Text]:\n${cleanOcrText(text)}\n`;
        }
        
        activeNb.content += `\n\n[OCR Extraction]\n${extractedText}\n`;
        activeNb.images = [];
        const contentInput = document.getElementById('notebook-content');
        if (contentInput) contentInput.value = activeNb.content;
        saveState();
        renderNotebooks();
    } catch (e) {
        alert("Error during OCR: " + e.message);
    }

    btn.innerText = origText;
    btn.disabled = false;
});

// --- PDF text extraction ---
// A picked PDF is never stored: the chosen pages are drawn as pictures (pdf.js)
// and read with the same Tamil + English OCR as images, then added to the note.
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const PDF_MAX_PAGES_PER_RUN = 30;   // OCR takes a few seconds per page
const PDF_MAX_FILE_MB = 50;
let pdfjsLibPromise = null;
let pdfOcrDoc = null;               // { pdf, name, numPages }
let pdfOcrCancelled = false;

const isPdfFile = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function loadPdfJs() {
    if (!pdfjsLibPromise) {
        pdfjsLibPromise = import(PDFJS_BASE + 'build/pdf.min.mjs').then(lib => {
            lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.mjs';
            return lib;
        });
        pdfjsLibPromise.catch(() => { pdfjsLibPromise = null; }); // allow a retry after a network error
    }
    return pdfjsLibPromise;
}

function pdfOcrEls() {
    return {
        panel: document.getElementById('pdf-ocr-panel'),
        name: document.getElementById('pdf-ocr-name'),
        pages: document.getElementById('pdf-ocr-pages'),
        from: document.getElementById('pdf-ocr-from'),
        to: document.getElementById('pdf-ocr-to'),
        hint: document.getElementById('pdf-ocr-hint'),
        progress: document.getElementById('pdf-ocr-progress'),
        start: document.getElementById('btn-pdf-ocr-start'),
        cancel: document.getElementById('btn-pdf-ocr-cancel')
    };
}

function closePdfOcrPanel() {
    const els = pdfOcrEls();
    if (pdfOcrDoc) pdfOcrDoc.pdf.destroy();
    pdfOcrDoc = null;
    els.panel.hidden = true;
    els.progress.hidden = true;
}

// Returns { from, to } when the chosen range is valid, otherwise shows why and returns null
function readPdfOcrRange() {
    const els = pdfOcrEls();
    const total = pdfOcrDoc.numPages;
    const from = parseInt(els.from.value, 10);
    const to = parseInt(els.to.value, 10);
    let problem = '';
    if (!Number.isInteger(from) || !Number.isInteger(to)) problem = 'Type a page number in both boxes.';
    else if (from < 1 || to < 1 || from > total || to > total) problem = `Pages must be between 1 and ${total}.`;
    else if (from > to) problem = '"From" must be the same as or smaller than "to".';
    else if (to - from + 1 > PDF_MAX_PAGES_PER_RUN) problem = `You can read up to ${PDF_MAX_PAGES_PER_RUN} pages at a time. Pick a smaller range.`;
    const count = problem ? 0 : to - from + 1;
    els.hint.innerText = problem || `${count} page${count === 1 ? '' : 's'} will be read. This takes a few seconds per page.`;
    els.start.disabled = !!problem;
    return problem ? null : { from, to };
}

async function openPdfForOcr(file) {
    if (!appState.notebooks.find(n => n.id === appState.activeNotebookId)) return;
    if (file.size > PDF_MAX_FILE_MB * 1024 * 1024) {
        alert(`That PDF is too big. Pick one under ${PDF_MAX_FILE_MB} MB.`);
        return;
    }
    closePdfOcrPanel();
    const els = pdfOcrEls();
    els.panel.hidden = false;
    els.name.innerText = file.name;
    els.pages.innerText = '(opening...)';
    els.hint.innerText = '';
    els.start.disabled = true;
    try {
        const pdfjsLib = await loadPdfJs();
        const pdf = await pdfjsLib.getDocument({
            data: new Uint8Array(await file.arrayBuffer()),
            isEvalSupported: false, // never run code from inside a PDF
            cMapUrl: PDFJS_BASE + 'cmaps/',
            cMapPacked: true,
            standardFontDataUrl: PDFJS_BASE + 'standard_fonts/'
        }).promise;
        pdfOcrDoc = { pdf, name: file.name, numPages: pdf.numPages };
        els.pages.innerText = `(${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'})`;
        els.from.max = els.to.max = pdf.numPages;
        els.from.value = 1;
        els.to.value = Math.min(pdf.numPages, PDF_MAX_PAGES_PER_RUN);
        readPdfOcrRange();
    } catch (err) {
        closePdfOcrPanel();
        alert(/password/i.test(err.name + err.message)
            ? 'This PDF is password-protected, so it can\'t be read.'
            : `Couldn't open that PDF: ${err.message}`);
    }
}

// Draw one PDF page onto a canvas big enough for OCR to read small print
async function renderPdfPage(pdf, pageNumber) {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2000 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 'print' draws without waiting for animation frames, so reading keeps going
    // when the student switches to another tab or app
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    page.cleanup();
    return canvas;
}

// PDFs typed on a computer contain their words. When that saved text is right it beats OCR,
// which misreads some Tamil letters (கி as தி). But Microsoft Word and other apps often save
// Tamil with wrong or missing letters (தேவையான as ததவவயான) while the page still LOOKS right.
// So every page is also read with OCR, and the saved text is used only when the two agree.
const PDF_MIN_TAMIL_CHARS = 20;
const PDF_MIN_AGREEMENT = 0.7; // measured: correct saved text 80-100%, Word's broken text 58%

async function getPdfPageTamilText(pdf, pageNumber) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : '')).join('');
    const tamilChars = (text.match(/[஀-௿]/g) || []).length;
    return tamilChars >= PDF_MIN_TAMIL_CHARS ? fixTamilDisplayOrder(text).trim() : null;
}

const tamilWords = text => text.split(/[\s.,;:!?()"'\-]+/).filter(word => /[஀-௿]{2}/.test(word));

function choosePdfPageText(savedText, ocrText) {
    if (!savedText) return ocrText;
    const ocrWords = tamilWords(ocrText);
    if (ocrWords.length === 0) return savedText;
    const saved = tamilWords(savedText);
    const savedSet = new Set(saved);
    const agreement = ocrWords.filter(word => savedSet.has(word)).length / ocrWords.length;
    const pictureHasMore = ocrWords.length > saved.length * 1.3; // e.g. words inside a diagram
    return agreement >= PDF_MIN_AGREEMENT && !pictureHasMore ? savedText : ocrText;
}

// PDFs often store Tamil in display order: the sign ெ ே ை comes BEFORE its letter,
// and ொ ோ ௌ are split around it (ெ + க + ா). Put them back in reading order.
function fixTamilDisplayOrder(text) {
    // A sign at the start of a word is impossible in reading order, so it shows display order
    if (!/(^|[^஀-௿])[ெ-ை]/m.test(text)) return text;
    return text.replace(/([ெ-ை])([க-ஹ](?:்ஷ)?)([ாௗ]?)/g, (match, sign, letter, after) => {
        if (sign === 'ெ' && after === 'ா') return letter + 'ொ'; // ொ
        if (sign === 'ே' && after === 'ா') return letter + 'ோ'; // ோ
        if (sign === 'ெ' && after === 'ௗ') return letter + 'ௌ'; // ௌ
        return letter + sign + after;
    });
}

// OCR leaves invisible joiner characters after Tamil letters, reads specks as junk lines,
// and writes ௌ as the look-alike ெ + ள (பௌர்ணமி as பெளர்ணமி)
function cleanOcrText(text) {
    return text
        .replace(/[​-‍]/g, '')
        .replace(/([க-ஹ])ெள(?![ா-்ௗ])/g, '$1ௌ')
        .split('\n')
        .filter(line => !line.trim() || /[஀-௿A-Za-z]{2}|\d{2}/.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

['pdf-ocr-from', 'pdf-ocr-to'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => { if (pdfOcrDoc) readPdfOcrRange(); });
});

document.getElementById('btn-pdf-ocr-cancel')?.addEventListener('click', () => {
    if (pdfOcrDoc?.running) {
        pdfOcrCancelled = true; // stops after the page being read
        pdfOcrEls().progress.innerText = 'Stopping after this page...';
    } else {
        closePdfOcrPanel();
    }
});

document.getElementById('btn-pdf-ocr-start')?.addEventListener('click', async () => {
    const activeNb = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!activeNb || !pdfOcrDoc) return;
    const range = readPdfOcrRange();
    if (!range) return;

    const els = pdfOcrEls();
    const doc = pdfOcrDoc;
    doc.running = true;
    pdfOcrCancelled = false;
    els.start.disabled = els.from.disabled = els.to.disabled = true;
    els.cancel.innerText = 'Stop';
    els.progress.hidden = false;

    const total = range.to - range.from + 1;
    const pagesText = [];
    let worker = null;
    try {
        els.progress.innerText = 'Getting the text reader ready...';
        worker = await Tesseract.createWorker('eng+tam');
        for (let p = range.from; p <= range.to && !pdfOcrCancelled; p++) {
            els.progress.innerText = `Reading page ${p} (${p - range.from + 1} of ${total})...`;
            const savedText = await getPdfPageTamilText(doc.pdf, p);
            const canvas = await renderPdfPage(doc.pdf, p);
            const ocrText = cleanOcrText((await worker.recognize(canvas)).data.text);
            pagesText.push(`[Page ${p}]\n${choosePdfPageText(savedText, ocrText)}`);
        }
    } catch (err) {
        alert(`Error while reading the PDF: ${err.message}`);
    } finally {
        if (worker) await worker.terminate();
    }

    if (pagesText.length) {
        const lastPage = range.from + pagesText.length - 1;
        const label = lastPage === range.from ? `page ${range.from}` : `pages ${range.from}-${lastPage}`;
        activeNb.content += `\n\n[PDF text: ${doc.name}, ${label}]\n${pagesText.join('\n\n')}\n`;
        const contentInput = document.getElementById('notebook-content');
        if (contentInput) contentInput.value = activeNb.content;
        saveState();
    }

    doc.running = false;
    els.from.disabled = els.to.disabled = false;
    els.cancel.innerText = 'Cancel';
    if (pdfOcrCancelled || !pagesText.length) {
        els.progress.innerText = pagesText.length ? `Stopped. Added ${pagesText.length} page${pagesText.length === 1 ? '' : 's'} to your note.` : 'No text was added.';
        readPdfOcrRange();
    } else {
        closePdfOcrPanel();
    }
});
// --- Theme Toggle Logic ---
// 'system' (the default) follows the device's light or dark setting; the toggle picks one explicitly
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
    const theme = appState.settings?.theme || 'system';
    if (theme === 'system') return prefersDark.matches ? 'dark' : 'light';
    return theme;
}

function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#070A12' : '#EEF1F7');

    // Update switch visually
    const toggleSwitch = document.getElementById('theme-checkbox');
    if (toggleSwitch) toggleSwitch.checked = (theme === 'light');
}

prefersDark.addEventListener('change', () => {
    if ((appState.settings?.theme || 'system') === 'system') applyTheme();
});

// Switching theme reveals the new one in a circle growing from the toggle
function switchThemeWithReveal(nextTheme, originEl) {
    const change = () => {
        appState.settings.theme = nextTheme;
        applyTheme();
        saveState();
    };
    if (!document.startViewTransition || reducedMotion.matches) {
        document.documentElement.classList.add('theme-fade');
        change();
        setTimeout(() => document.documentElement.classList.remove('theme-fade'), 500);
        return;
    }
    const rect = originEl?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(change);
    transition.ready.then(() => {
        document.documentElement.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
            { duration: 650, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' }
        );
    }).catch(() => {});
}

document.getElementById('theme-checkbox')?.addEventListener('change', (e) => {
    switchThemeWithReveal(e.target.checked ? 'light' : 'dark', e.target.closest('.theme-toggle'));
});

// --- Auth / Login Logic ---
// --- Custom Dropdown Logic ---
const gradeDisplay = document.getElementById('grade-display');
const gradeOptions = document.getElementById('grade-options');
const hiddenClassInput = document.getElementById('login-class');

if (gradeDisplay) {
    gradeDisplay.addEventListener('click', (e) => {
        e.stopPropagation();
        gradeOptions.classList.toggle('open');
        gradeDisplay.classList.toggle('active');
    });

    document.querySelectorAll('.custom-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const val = e.target.getAttribute('data-value');
            if (hiddenClassInput) hiddenClassInput.value = val;
            gradeDisplay.innerText = val;
            gradeDisplay.classList.add('has-value');
            gradeOptions.classList.remove('open');
            gradeDisplay.classList.remove('active');
        });
    });

    // Show Password Toggle
    const passToggle = document.getElementById('show-password-cb');
    const passInput = document.getElementById('login-password');
    if (passToggle && passInput) {
        passToggle.addEventListener('change', (e) => {
            passInput.type = e.target.checked ? 'text' : 'password';
        });
    }
}

// Generate options for study timer (10 min to 1 h, step 5 min)
function getStudyTimeOptions() {
    const opts = [];
    for (let mins = 10; mins <= 60; mins += 5) {
        let label;
        if (mins < 60) {
            label = `${mins} Minutes`;
        } else if (mins === 60) {
            label = `1 Hour`;
        } else {
            label = `${mins / 60} Hours`;
        }
        opts.push({ label, value: mins.toString() });
    }
    return opts;
}

// Initialise the study time custom dropdown
setupCustomDropdown(
    'study-min-display',
    'study-min-options',
    'study-min',
    getStudyTimeOptions(),
    (val) => {
        // Trigger change event if needed
        const hiddenInput = document.getElementById('study-min');
        if (hiddenInput) {
            hiddenInput.dispatchEvent(new Event('change'));
        }
    }
);

// Generate options for break timer (5 min to 20 min, step 5 min)
function getBreakTimeOptions() {
    const opts = [];
    for (let mins = 5; mins <= 20; mins += 5) {
        opts.push({ label: `${mins} Minutes`, value: mins.toString() });
    }
    return opts;
}

// Initialise the break time custom dropdown
setupCustomDropdown(
    'break-min-display',
    'break-min-options',
    'break-min',
    getBreakTimeOptions(),
    (val) => {
        // Trigger change event if needed
        const hiddenInput = document.getElementById('break-min');
        if (hiddenInput) {
            hiddenInput.dispatchEvent(new Event('change'));
        }
    }
);

// --- Auth Toggle Logic ---
let currentAuthMode = 'signup'; // default

// Sign-up / log-in problems are shown inside the form. kind 'info' is for good news (email sent).
function showAuthMessage(text, kind = 'error') {
    const el = document.getElementById('auth-message');
    if (!el) return;
    el.innerText = text || '';
    el.hidden = !text;
    el.classList.toggle('info', kind === 'info');
}

document.getElementById('login-form')?.addEventListener('input', () => showAuthMessage(''));

document.getElementById('btn-login')?.addEventListener('click', () => {
    currentAuthMode = 'login';
    document.querySelector('.auth-slider').classList.add('login-mode');
    document.getElementById('btn-login').classList.add('active');
    document.getElementById('btn-signup').classList.remove('active');
    
    document.getElementById('auth-title').innerText = 'Welcome Back';
    document.getElementById('auth-submit-btn').innerText = 'Log In';
    
    document.querySelectorAll('.auth-hide-on-login').forEach(el => el.style.display = 'none');
    // Password resets need online accounts (offline passwords only live in this browser)
    document.querySelectorAll('.auth-show-on-login').forEach(el => el.style.display = cloud ? '' : 'none');
    document.getElementById('login-name').removeAttribute('required'); // Prevent form validation
    showAuthMessage('');
});

document.getElementById('btn-signup')?.addEventListener('click', () => {
    currentAuthMode = 'signup';
    document.querySelector('.auth-slider').classList.remove('login-mode');
    document.getElementById('btn-signup').classList.add('active');
    document.getElementById('btn-login').classList.remove('active');
    
    document.getElementById('auth-title').innerText = 'Create an Account';
    document.getElementById('auth-submit-btn').innerText = 'Sign Up';
    
    // Reset hiding to default flex/block state, assuming normal standard is block.
    document.querySelectorAll('.auth-hide-on-login').forEach(el => el.style.display = '');
    document.querySelectorAll('.auth-show-on-login').forEach(el => el.style.display = 'none');
    document.getElementById('login-name').setAttribute('required', 'true');
    showAuthMessage('');
});

// --- Forgot password ---
// Supabase emails a link back to this site. Opening it signs the person in for a moment
// (event PASSWORD_RECOVERY) so they can choose a new password.
document.getElementById('btn-forgot-password')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const emailInput = document.getElementById('login-email');
    const email = emailInput.value.trim().toLowerCase();
    if (!cloud) return;
    if (!email || !email.includes('@')) {
        showAuthMessage('Type your email above, then press "Forgot password?" again.');
        emailInput.focus();
        return;
    }
    button.disabled = true;
    try {
        const { error } = await cloud.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) {
            showAuthMessage(/rate limit|too many/i.test(error.message)
                ? 'Too many emails right now. The free plan only sends a few per hour. Check your inbox (and spam) for an earlier link, or try again in an hour.'
                : `Couldn't send the reset email: ${error.message}`);
        } else {
            // Same answer whether or not the email has an account, so nobody can find out who has one
            showAuthMessage(`If ${email} has a Procrastinote account, a link to choose a new password is on its way. Check your inbox (and spam).`, 'info');
        }
    } catch (err) {
        showAuthMessage(`Could not reach the server: ${err.message}`);
    }
    button.disabled = false;
});

function showResetMessage(text, kind = 'error') {
    const el = document.getElementById('reset-message');
    if (!el) return;
    el.innerText = text || '';
    el.hidden = !text;
    el.classList.toggle('info', kind === 'info');
}

function openResetPasswordScreen() {
    const overlay = document.getElementById('reset-password-overlay');
    if (!overlay) return;
    showResetMessage('');
    overlay.style.display = 'flex';
    document.getElementById('reset-password')?.focus();
}

cloud?.auth.onAuthStateChange(event => {
    if (event === 'PASSWORD_RECOVERY') openResetPasswordScreen();
});

document.getElementById('reset-password-form')?.addEventListener('input', () => showResetMessage(''));

document.getElementById('reset-password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = document.getElementById('reset-password').value;
    const again = document.getElementById('reset-password-confirm').value;
    if (pass.length < 6) return showResetMessage('Use at least 6 characters.');
    if (pass !== again) return showResetMessage('The two passwords are different. Type them again.');

    const button = document.getElementById('reset-password-btn');
    button.disabled = true;
    const { data, error } = await cloud.auth.updateUser({ password: pass });
    button.disabled = false;
    if (error) {
        showResetMessage(/same|different from the old/i.test(error.message)
            ? 'That is your old password. Choose a different one.'
            : `Couldn't save the new password: ${error.message}. If the link is old, ask for a new one.`);
        return;
    }
    document.getElementById('reset-password-form').reset();
    document.getElementById('reset-password-overlay').style.display = 'none';

    // Already logged in as this account on this device: just carry on
    if (appState.user?.cloudId && appState.user.cloudId === data.user?.id) {
        alert('Your password was changed.');
        return;
    }
    // Otherwise log in with the new password, so the planner loads the normal way
    await cloud.auth.signOut();
    checkAuth();
    openAuth('login');
    setTimeout(() => {
        document.getElementById('login-email').value = data.user?.email || '';
        document.getElementById('login-password')?.focus();
        showAuthMessage('Your password was changed. Log in with your new password.', 'info');
    }, 500);
});

function shakePasswordInput(id) {
    const passInput = document.getElementById(id);
    passInput.classList.add('shake-error');
    setTimeout(() => passInput.classList.remove('shake-error'), 750);
}

// Build appState from an online account, keeping this browser's planner data for that email
function loadUserFromCloud(user) {
    const email = user.email.toLowerCase();
    const meta = user.user_metadata || {};
    const local = allUsers[email];
    appState = { ...JSON.parse(JSON.stringify(defaultState)), ...(local ? local.data : {}) };
    appState.user = {
        name: local?.profile.name || meta.name || email.split('@')[0],
        class: local?.profile.class || meta.class || '',
        email,
        cloudId: user.id
    }; // no password stored locally anymore
}

// moving = true when an old offline account is being moved online during log in.
// Then the messages talk about logging in, not signing up.
async function cloudSignup(name, cls, email, pass, moving = false) {
    const { data, error } = await cloud.auth.signUp({
        email,
        password: pass,
        options: { data: { name, class: cls }, emailRedirectTo: window.location.origin }
    });
    if (error) {
        if (/rate limit/i.test(error.message)) {
            showAuthMessage('Too many sign-up emails right now. The free plan only sends a few per hour. Check your inbox (and spam) for an earlier link, or try again in an hour.');
        } else {
            showAuthMessage(`${moving ? 'Log in' : 'Sign up'} failed: ${error.message}`);
        }
        return false;
    }
    // Supabase answers "success" for an email that already has an account, but sends nothing
    // and returns a user with no identities. Say so instead of promising an email.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        if (moving) {
            // The online account exists and the password typed is not its password
            shakePasswordInput('login-password');
            showAuthMessage('Wrong email or password.');
            return false;
        }
        document.getElementById('btn-login')?.click();
        showAuthMessage('This email already has an account. Log in with it instead.');
        return false;
    }
    if (!data.session) {
        document.getElementById('btn-login')?.click();
        if (moving) {
            showAuthMessage(`Your account is moving online so it works on every device. We sent a confirmation link to ${email}. Click it, then log in again.`, 'info');
            return false;
        }
        showAuthMessage(`Almost done! We sent a confirmation link to ${email}. Click it, then come back and log in.`, 'info');
        return false;
    }
    loadUserFromCloud(data.user);
    return true;
}

async function cloudLogin(email, pass) {
    const { data, error } = await cloud.auth.signInWithPassword({ email, password: pass });
    if (error) {
        // One-time move: an old local-only account becomes an online account with the same password
        const local = allUsers[email];
        if (/invalid login/i.test(error.message) && local?.profile.pass && local.profile.pass === pass) {
            return cloudSignup(local.profile.name, local.profile.class, email, pass, true);
        }
        if (/not confirmed/i.test(error.message)) {
            showAuthMessage('Please click the confirmation link in your email first, then log in.');
        } else if (/invalid login/i.test(error.message)) {
            shakePasswordInput('login-password');
            showAuthMessage('Wrong email or password.');
        } else {
            showAuthMessage(`Log in failed: ${error.message}`);
        }
        return false;
    }
    loadUserFromCloud(data.user);
    return true;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('login-name').value;
    const cls = hiddenClassInput ? hiddenClassInput.value : '';
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const pass = document.getElementById('login-password').value;

    if (cloud) {
        if (currentAuthMode === 'signup' && !cls) {
            showAuthMessage('Please select your Class / Grade.');
            return;
        }
        const submitBtn = document.getElementById('auth-submit-btn');
        submitBtn.disabled = true;
        let ok = false;
        try {
            ok = currentAuthMode === 'login'
                ? await cloudLogin(email, pass)
                : await cloudSignup(name, cls, email, pass);
        } catch (err) {
            showAuthMessage(`Could not reach the server: ${err.message}`);
        } finally {
            submitBtn.disabled = false;
        }
        if (!ok) return;
        saveState();
        checkAuth();
        startCloudChat();
        startPlannerSync(); // loads this account's planner from other devices
        return;
    }

    if (currentAuthMode === 'login') {
        const userEntry = allUsers[email];
        if (!userEntry) {
            showAuthMessage('No account found with this email. Please sign up first.');
            return;
        }
        if (userEntry.profile.pass !== pass) {
            const passInput = document.getElementById('login-password');
            passInput.classList.add('shake-error');
            setTimeout(() => passInput.classList.remove('shake-error'), 750);
            showAuthMessage('Wrong email or password.');
            return;
        }
        // Load user data
        appState = {
            user: userEntry.profile,
            ...userEntry.data
        };
    } else {
        // Signup Mode
        if (!cls) {
            showAuthMessage('Please select your Class / Grade.');
            return;
        }
        if (allUsers[email]) {
            showAuthMessage('An account with this email already exists. Try logging in instead.');
            return;
        }
        // Create new user with default data
        appState = JSON.parse(JSON.stringify(defaultState));
        appState.user = { name, class: cls, email, pass };
    }
    
    saveState();
    checkAuth();
});

document.getElementById('logout-btn').addEventListener('click', () => {
    groqKeyCache = null;
    if (cloud) {
        stopCloudChat();
        // Save any last changes online before signing out (the request is built before appState resets)
        const lastSave = plannerReady ? pushPlannerData() : Promise.resolve();
        stopPlannerSync();
        lastSave.finally(() => cloud.auth.signOut());
    }
    localStorage.removeItem(SESSION_KEY);
    appState = JSON.parse(JSON.stringify(defaultState));
    checkAuth();
});

function greetingForNow() {
    const hour = new Date().getHours();
    if (hour < 5) return 'Up late';
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function checkAuth() {
    if (appState.user && appState.user.name) {
        // User is logged in
        document.getElementById('landing-view').style.display = 'none';
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';

        protectLegacyGroqKey();

        // Greeting and the name in the phone menu
        const firstName = appState.user.name.split(' ')[0];
        document.getElementById('greeting-header').innerHTML = `${greetingForNow()}, <span class="highlight">${escapeHTML(firstName)}</span>`;
        document.getElementById('sidebar-user-class').innerText = `${appState.user.name}${appState.user.class ? ' · ' + appState.user.class : ''}`;

        // Update day order if date has changed
        if (updateDayOrderIfNeeded()) {
            saveState();
        } else {
            renderAllViews();
        }
        applyTheme(); // Ensure user preference is applied
        playViewEntrance(document.querySelector('.view.active-view'));
    } else {
        document.getElementById('main-app').style.display = 'none';
        closePhoneNav();
        applyTheme(); // logged out: follow the device's light or dark setting
        showWelcome();
    }
}

// --- Welcome page and sign-in flow ---
function showWelcome() {
    const landing = document.getElementById('landing-view');
    document.getElementById('login-overlay').style.display = 'none';
    landing.classList.remove('leaving', 'is-ready');
    landing.style.display = 'flex';
    // Next frame, start the entrance animation (title words rise, cards float in).
    // The timeout is a backup for background tabs, where animation frames are paused.
    const start = () => landing.classList.add('is-ready');
    requestAnimationFrame(() => requestAnimationFrame(start));
    setTimeout(start, 150);
}

function openAuth(mode) {
    const landing = document.getElementById('landing-view');
    const overlay = document.getElementById('login-overlay');
    landing.classList.add('leaving');
    setTimeout(() => {
        landing.style.display = 'none';
        overlay.style.display = 'flex';
        document.getElementById(mode === 'login' ? 'btn-login' : 'btn-signup')?.click();
        document.getElementById(mode === 'login' ? 'login-email' : 'login-name')?.focus({ preventScroll: true });
    }, reducedMotion.matches ? 0 : 380);
}

document.getElementById('get-started-btn')?.addEventListener('click', () => openAuth('signup'));
document.getElementById('welcome-login-btn')?.addEventListener('click', () => openAuth('login'));
document.getElementById('auth-back-btn')?.addEventListener('click', showWelcome);

// Gentle parallax on the floating preview cards
document.getElementById('landing-view')?.addEventListener('mousemove', (e) => {
    if (reducedMotion.matches) return;
    const visual = document.querySelector('.welcome-visual');
    if (!visual) return;
    const x = (e.clientX / window.innerWidth - 0.5) * 2;
    const y = (e.clientY / window.innerHeight - 0.5) * 2;
    visual.style.setProperty('--px', x.toFixed(3));
    visual.style.setProperty('--py', y.toFixed(3));
});

// --- Robot Pupil Tracker ---
let mouseX = 0, mouseY = 0;
let pupilData = new Map();

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

function animatePupils() {
    document.querySelectorAll('.robot-pupil').forEach(pupil => {
        const robot = pupil.closest('.robot-icon');
        if (!robot) return;
        const rect = robot.getBoundingClientRect();
        if (rect.width === 0) return; // Not visible

        const robotX = rect.left + rect.width / 2;
        const robotY = rect.top + rect.height / 2;
        
        const deltaX = mouseX - robotX;
        const deltaY = mouseY - robotY;
        const angle = Math.atan2(deltaY, deltaX);
        const maxDist = robot.offsetWidth * 0.055; // stay inside the eye
        
        const targetX = Math.cos(angle) * maxDist;
        const targetY = Math.sin(angle) * maxDist;
        
        let data = pupilData.get(pupil) || { x: 0, y: 0 };
        // Lerp: current += (target - current) * factor
        data.x += (targetX - data.x) * 0.12; 
        data.y += (targetY - data.y) * 0.12;
        
        pupil.style.transform = `translate(${data.x}px, ${data.y}px)`;
        pupilData.set(pupil, data);
    });
    requestAnimationFrame(animatePupils);
}
requestAnimationFrame(animatePupils);

// --- Celebrations ---
// Confetti was removed in the redesign; finishing things now has its own quiet animations
function triggerConfetti() {}

// --- Password Update Flow Logic ---
function switchPwStep(stepId) {
    document.querySelectorAll('#password-card .pw-step').forEach(step => {
        step.classList.remove('active');
    });
    const target = document.getElementById(stepId);
    if (target) {
        target.classList.add('active');
    }
}

document.getElementById('btn-verify-old')?.addEventListener('click', async () => {
    const input = document.getElementById('old-password');
    const oldPass = input.value;

    let correct = oldPass === appState.user.pass;
    if (cloud) {
        const { error } = await cloud.auth.signInWithPassword({ email: appState.user.email, password: oldPass });
        correct = !error;
    }

    if (correct) {
        switchPwStep('pw-step-2');
    } else {
        input.classList.add('shake-error');
        setTimeout(() => input.classList.remove('shake-error'), 750);
        input.value = '';
    }
});

document.getElementById('btn-update-password')?.addEventListener('click', async () => {
    const newPassInput = document.getElementById('new-password');
    const confirmPassInput = document.getElementById('confirm-password');
    const newPass = newPassInput.value;
    const confirmPass = confirmPassInput.value;
    const minLength = cloud ? 6 : 4; // Supabase's default minimum

    if (!newPass || newPass.length < minLength) {
        alert(`Password must be at least ${minLength} characters.`);
        return;
    }

    const oldPass = cloud ? document.getElementById('old-password').value : appState.user.pass;
    if (newPass === oldPass) {
        alert("New password cannot be the same as the old password.");
        return;
    }

    if (newPass !== confirmPass) {
        confirmPassInput.classList.add('shake-error');
        setTimeout(() => confirmPassInput.classList.remove('shake-error'), 750);
        return;
    }

    if (cloud) {
        const { error } = await cloud.auth.updateUser({ password: newPass });
        if (error) {
            alert(`Could not change password: ${error.message}`);
            return;
        }
    } else {
        appState.user.pass = newPass;
    }

    // Success!
    saveState();
    switchPwStep('pw-step-success');
    triggerConfetti();
});

document.getElementById('btn-reset-pw-flow')?.addEventListener('click', () => {
    // Reset fields and go back to step 1
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    
    // Also reset checkboxes and types
    ['old', 'new', 'confirm'].forEach(type => {
        const cb = document.getElementById(`show-${type}-password-cb`);
        const input = document.getElementById(`${type}-password`);
        if (cb) cb.checked = false;
        if (input) input.type = 'password';
    });

    switchPwStep('pw-step-1');
});

// Show Password Toggle for Update Flow
['old', 'new', 'confirm'].forEach(type => {
    const cb = document.getElementById(`show-${type}-password-cb`);
    const input = document.getElementById(`${type}-password`);
    if (cb && input) {
        cb.addEventListener('change', (e) => {
            input.type = e.target.checked ? 'text' : 'password';
        });
    }
});

// Security Navigation
document.getElementById('btn-go-security')?.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
    document.getElementById('security-view').classList.add('active-view');
    // Always start at step 1
    switchPwStep('pw-step-1');
});

document.getElementById('back-to-settings')?.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
    document.getElementById('settings').classList.add('active-view');
});

// --- EmailJS Configuration Logic ---
function renderEmailJSSettings() {
    const pubKeyEl = document.getElementById('emailjs-public-key');
    const svcIdEl = document.getElementById('emailjs-service-id');
    const tmplIdEl = document.getElementById('emailjs-template-id');
    
    // The saved Groq key is never put back into the page; only its status is shown
    renderGroqKeyStatus();
    
    if (appState.emailjs) {
        if (pubKeyEl) pubKeyEl.value = appState.emailjs.publicKey || '';
        if (svcIdEl) svcIdEl.value = appState.emailjs.serviceId || '';
        if (tmplIdEl) tmplIdEl.value = appState.emailjs.templateId || '';
    }
}

document.getElementById('btn-save-emailjs')?.addEventListener('click', (e) => {
    const pubKey = document.getElementById('emailjs-public-key').value;
    const svcId = document.getElementById('emailjs-service-id').value;
    const tmplId = document.getElementById('emailjs-template-id').value;
    
    if (!appState.emailjs) appState.emailjs = {};
    appState.emailjs.publicKey = pubKey;
    appState.emailjs.serviceId = svcId;
    appState.emailjs.templateId = tmplId;
    
    saveState();
    flashFeedback(e.target);
});

// --- Email Verification Logic ---
let currentOTP = null;

function switchEmailStep(stepId) {
    document.querySelectorAll('#email-verify-card .email-step').forEach(step => {
        step.style.display = 'none';
    });
    const target = document.getElementById(stepId);
    if (target) {
        target.style.display = 'block';
    }
}

async function sendVerificationEmail() {
    if (!appState.user || !appState.user.email) {
        alert("User email not found. Please log in again.");
        return;
    }

    switchEmailStep('email-step-loading');
    
    // Generate 6-digit OTP
    currentOTP = Math.floor(100000 + Math.random() * 900000).toString();
    
    const config = appState.emailjs;
    if (config && config.publicKey && config.serviceId && config.templateId) {
        try {
            await emailjs.send(config.serviceId, config.templateId, {
                to_email: appState.user.email,
                to_name: appState.user.name,
                otp_code: currentOTP
            }, config.publicKey);
            console.log(`[EmailJS] Verification email sent to ${appState.user.email}`);
            alert(`A 6-digit verification code has been sent to ${appState.user.email} using EmailJS.`);
        } catch (error) {
            console.error('[EmailJS Error]', error);
            alert(`Failed to send email via EmailJS: ${error.text || error.message || error}. Falling back to simulation mode.\n\nDemo OTP: ${currentOTP}`);
        }
    } else {
        // Fallback to simulation
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log(`[SIMULATION] Verification email sent to ${appState.user.email}`);
        console.log(`[SIMULATION] OTP: ${currentOTP}`);
        alert(`A 6-digit verification code has been sent to ${appState.user.email}.\n\n(Demo OTP: ${currentOTP})`);
    }
    
    switchEmailStep('email-step-2');
}

document.getElementById('btn-send-otp')?.addEventListener('click', sendVerificationEmail);
document.getElementById('btn-resend-otp')?.addEventListener('click', sendVerificationEmail);

document.getElementById('btn-verify-otp')?.addEventListener('click', () => {
    const input = document.getElementById('email-otp');
    const enteredOTP = input.value;
    
    if (enteredOTP === currentOTP) {
        appState.emailVerified = true;
        saveState();
        switchEmailStep('email-step-success');
        const statusEl = document.getElementById('email-verify-status');
        if (statusEl) statusEl.innerText = "Your email address is verified.";
        triggerConfetti();
    } else {
        input.classList.add('shake-error');
        setTimeout(() => input.classList.remove('shake-error'), 750);
        input.value = '';
    }
});

// Sync verification UI on load
function syncVerificationUI() {
    const statusEl = document.getElementById('email-verify-status');
    if (appState.emailVerified) {
        switchEmailStep('email-step-success');
        if (statusEl) statusEl.innerText = "Your email address is verified.";
    } else {
        switchEmailStep('email-step-1');
        if (statusEl) statusEl.innerText = "Confirm your email address for account recovery.";
    }
}
// Call this after app state is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    syncVerificationUI();
    loadTimerState();
    // Update PiP visibility after restoring timer state
    setTimeout(updatePipVisibility, 200);
});

// --- Zen Mode Logic ---
const TIMER_STATE_KEY = 'procrastinote_timer_state';
let timerInterval;
let timerSeconds = 25 * 60;
let isTimerRunning = false;
let timerMode = 'study'; // 'study' or 'break'
let timerEndTime = null;
let isFirstPlayCompleted = false;

function saveTimerState() {
    const state = {
        timerSeconds,
        isTimerRunning,
        timerMode,
        timerEndTime
    };
    localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state));
}

function loadTimerState() {
    const saved = localStorage.getItem(TIMER_STATE_KEY);
    if (saved) {
        const state = JSON.parse(saved);
        timerSeconds = state.timerSeconds;
        timerMode = state.timerMode || 'study';
        
        // If it was running, check how much time is left
        if (state.isTimerRunning && state.timerEndTime) {
            const now = Date.now();
            const remaining = Math.round((state.timerEndTime - now) / 1000);
            if (remaining > 0) {
                timerSeconds = remaining;
                timerEndTime = state.timerEndTime;
                isTimerRunning = true;
                startTimer(true); // Restart with existing endTime
            } else {
                // Timer finished while we were away
                timerSeconds = 0;
                isTimerRunning = false;
                timerEndTime = null;
                // We'll let the user see it finished or auto-switch on next tick
                updateTimerDisplay();
            }
        } else {
            isTimerRunning = false;
            timerEndTime = null;
            updateTimerDisplay();
        }
    } else {
        // Default sync
        const studyMin = document.getElementById('study-min')?.value || 25;
        timerSeconds = studyMin * 60;
        updateTimerDisplay();
    }
}
const timerProgress = document.getElementById('timer-progress');
const timerTime = document.getElementById('timer-time');
const timerLabel = document.getElementById('timer-label');
const timerStartBtn = document.getElementById('timer-start');
const timerPauseBtn = document.getElementById('timer-pause');

function updateTimerDisplay() {
    let displaySecs = timerSeconds;
    
    if (isTimerRunning && timerEndTime) {
        const now = Date.now();
        displaySecs = Math.max(0, Math.round((timerEndTime - now) / 1000));
    }

    const mins = Math.floor(displaySecs / 60);
    const secs = displaySecs % 60;
    timerTime.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    // Update progress circle
    const studyInput = document.getElementById('study-min');
    const breakInput = document.getElementById('break-min');
    const total = ((timerMode === 'study' ? (studyInput ? studyInput.value : 25) : (breakInput ? breakInput.value : 5))) * 60;
    
    const ratio = displaySecs / total;
    const offset = 282.7 * ratio;
    timerProgress.style.strokeDashoffset = offset;
    
    // Sync tab title if running
    if (isTimerRunning) {
        document.title = `(${mins}:${secs.toString().padStart(2, '0')}) Procrastinote`;
    } else {
        document.title = "Procrastinote | Educational Planner";
    }
}

function startTimer(isResume = false) {
    // If called from an event listener, isResume will be the event object.
    // We only want to resume if isResume is explicitly true.
    const resume = isResume === true;
    
    if (isTimerRunning && !resume) return;
    
    isTimerRunning = true;
    if (!resume) {
        timerEndTime = Date.now() + (timerSeconds * 1000);
    }
    
    timerStartBtn.style.display = 'none';
    timerPauseBtn.style.display = 'flex';
    
    saveTimerState();
    // Show PiP when timer starts
    setTimeout(updatePipVisibility, 50);

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const now = Date.now();
        const remaining = Math.round((timerEndTime - now) / 1000);
        
        if (remaining <= 0) {
            clearInterval(timerInterval);
            isTimerRunning = false;
            timerEndTime = null;
            
            // Switch mode
            if (timerMode === 'study') {
                if (!isFirstPlayCompleted) {
                    isFirstPlayCompleted = true;
                    timerMode = 'study';
                    timerLabel.innerText = 'Study Session';
                    timerLabel.classList.remove('break');
                    timerSeconds = (document.getElementById('study-min')?.value || 25) * 60;
                    saveTimerState();
                    updateTimerDisplay();
                    pauseTimer(); // Pause instead of transitioning to break
                } else {
                    timerMode = 'break';
                    timerLabel.innerText = 'Break Time';
                    timerLabel.classList.add('break');
                    timerSeconds = (document.getElementById('break-min')?.value || 5) * 60;
                    triggerConfetti(); // Celebrate finishing a study session!
                    saveTimerState();
                    updateTimerDisplay();
                    startTimer(); // Auto-start the break phase
                }
            } else {
                timerMode = 'study';
                timerLabel.innerText = 'Study Session';
                timerLabel.classList.remove('break');
                timerSeconds = (document.getElementById('study-min')?.value || 25) * 60;
                saveTimerState();
                updateTimerDisplay();
                startTimer(); // Auto-start the study phase
            }
        } else {
            timerSeconds = remaining;
            updateTimerDisplay();
        }
    }, 1000);
}

function pauseTimer() {
    clearInterval(timerInterval);
    isTimerRunning = false;
    timerEndTime = null;
    timerStartBtn.style.display = 'flex';
    timerPauseBtn.style.display = 'none';
    saveTimerState();
    updateTimerDisplay();
    // Update PiP visibility when timer pauses
    setTimeout(updatePipVisibility, 50);
}

function resetTimer() {
    pauseTimer();
    isFirstPlayCompleted = false;
    timerMode = 'study';
    timerLabel.innerText = 'Study Session';
    timerLabel.classList.remove('break');
    const studyMin = document.getElementById('study-min')?.value || 25;
    timerSeconds = studyMin * 60;
    saveTimerState();
    updateTimerDisplay();
    // Hide PiP when timer resets
    setTimeout(updatePipVisibility, 50);
}

timerStartBtn?.addEventListener('click', startTimer);
timerPauseBtn?.addEventListener('click', pauseTimer);
document.getElementById('timer-reset')?.addEventListener('click', resetTimer);

// Update time when settings change
document.getElementById('study-min')?.addEventListener('change', (e) => {
    if (!isTimerRunning && timerMode === 'study') {
        timerSeconds = e.target.value * 60;
        saveTimerState();
        updateTimerDisplay();
    }
});
document.getElementById('break-min')?.addEventListener('change', (e) => {
    if (!isTimerRunning && timerMode === 'break') {
        timerSeconds = e.target.value * 60;
        saveTimerState();
        updateTimerDisplay();
    }
});

// --- Zen Music Logic (Web Audio API) ---
let audioCtx = null;
let masterGain = null;
let isMusicPlaying = false;
let activeNodes = [];
let beatTimeoutId = null;
let birdTimeoutId = null;
let currentSound = 'tone852';

const musicToggleBtn = document.getElementById('music-toggle');
const musicPlayIcon = document.getElementById('music-play-icon');
const musicPauseIcon = document.getElementById('music-pause-icon');
const musicPlayerUI = document.querySelector('.music-player-ui');
const volValue = document.getElementById('vol-value');
const playerStatus = document.getElementById('player-status');

function getAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = (document.getElementById('music-volume')?.value || 50) / 100;
        masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function createNoiseBuffer(ctx, type) {
    const bufSize = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(2, bufSize, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        if (type === 'white') {
            for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
        } else if (type === 'brown') {
            let last = 0;
            for (let i = 0; i < bufSize; i++) {
                const w = Math.random() * 2 - 1;
                d[i] = (last + 0.02 * w) / 1.02;
                last = d[i];
                d[i] *= 3.5;
            }
        } else { // pink
            let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
            for (let i = 0; i < bufSize; i++) {
                const w = Math.random() * 2 - 1;
                b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
                b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
                b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
                d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
            }
        }
    }
    return buf;
}

function makeNoise(ctx, type, filterType, freq, q, gain) {
    const src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(ctx, type);
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.value = freq;
    if (q) flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(flt); flt.connect(g); g.connect(masterGain);
    src.start();
    activeNodes.push(src);
    return src;
}

function stopAllNodes() {
    clearTimeout(beatTimeoutId);
    clearTimeout(birdTimeoutId);
    beatTimeoutId = null; birdTimeoutId = null;
    activeNodes.forEach(n => { try { n.stop(); } catch(e){} try { n.disconnect(); } catch(e){} });
    activeNodes = [];
}

// 852 Hz tone. A pure tone sounds much sharper than noise at the same volume, so it plays
// quietly and fades in over 2 seconds instead of starting at full level.
function startTone852(ctx) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 852;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 2);
    osc.connect(g); g.connect(masterGain);
    osc.start();
    activeNodes.push(osc);
}

// The 852 Hz warning only shows while that tone is selected
function updateToneWarning() {
    const isTone = currentSound === 'tone852';
    const warning = document.getElementById('tone-warning');
    if (warning) warning.hidden = !isTone;
    const hint = document.querySelector('.headphones-hint');
    if (hint) {
        hint.classList.toggle('no-headphones', isTone);
        const label = hint.querySelector('span');
        if (label) label.innerText = isTone ? 'Headphones not recommended' : 'Best with headphones';
    }
}

function startRain(ctx) {
    makeNoise(ctx, 'white', 'lowpass', 2000, null, 0.4);
    makeNoise(ctx, 'brown', 'lowpass', 100, null, 0.3);
    makeNoise(ctx, 'white', 'bandpass', 3000, 2, 0.1);
}

function startForest(ctx) {
    makeNoise(ctx, 'pink', 'lowpass', 800, null, 0.15);
    makeNoise(ctx, 'white', 'bandpass', 4000, 0.5, 0.08);
    function bird() {
        if (!isMusicPlaying) return;
        const freqs = [1200,1600,2000,1800,2400];
        const base = freqs[Math.floor(Math.random()*freqs.length)];
        for (let i = 0; i < 3; i++) {
            const t = ctx.currentTime + i * 0.12;
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.setValueAtTime(base + Math.random()*200, t);
            o.frequency.exponentialRampToValueAtTime(base*1.2, t+0.08);
            g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.1);
            o.connect(g); g.connect(masterGain); o.start(t); o.stop(t+0.12);
        }
        birdTimeoutId = setTimeout(bird, 2000 + Math.random()*5000);
    }
    bird();
}

function startOcean(ctx) {
    makeNoise(ctx, 'brown', 'lowpass', 200, null, 0.35);
    // Wave with LFO
    const ws = ctx.createBufferSource();
    ws.buffer = createNoiseBuffer(ctx, 'white'); ws.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type='bandpass'; wf.frequency.value=1000; wf.Q.value=0.7;
    const wg = ctx.createGain(); wg.gain.value = 0.2;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.12; lg.gain.value = 0.15;
    lfo.connect(lg); lg.connect(wg.gain);
    ws.connect(wf); wf.connect(wg); wg.connect(masterGain);
    ws.start(); lfo.start();
    activeNodes.push(ws, lfo);
    makeNoise(ctx, 'white', 'highpass', 5000, null, 0.04);
}

// --- Dynamic Zen Background Animations ---
let bgAnimationInterval = null;

function clearBackgroundAnimations() {
    clearInterval(bgAnimationInterval);
    const fluidBg = document.querySelector('.fluid-bg');
    if (fluidBg) {
        fluidBg.classList.remove('ocean-mode');
    }
    document.querySelectorAll('.bird-particle, .rain-particle').forEach(el => el.remove());
}

function spawnBird() {
    const isLeft = Math.random() > 0.5;
    const bird = document.createElement('div');
    bird.classList.add('bird-particle');
    
    bird.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="bird-wing" d="M4 14c3-3 6-3 8 0 2-3 5-3 8 0"/></svg>`;
    
    if (isLeft) {
        bird.style.color = '#10b981';
        bird.style.animation = `flyRight ${10 + Math.random() * 5}s linear forwards`;
        bird.style.top = `${5 + Math.random() * 85}vh`;
    } else {
        bird.style.color = '#3b82f6';
        bird.style.animation = `flyLeft ${10 + Math.random() * 5}s linear forwards`;
        bird.style.top = `${5 + Math.random() * 85}vh`;
    }

    document.body.appendChild(bird);

    setTimeout(() => {
        if (bird.parentNode) bird.remove();
    }, 15000);
}

function spawnRain() {
    const isLeft = Math.random() > 0.5;
    const drop = document.createElement('div');
    drop.classList.add('rain-particle');
    
    if (isLeft) {
        drop.style.backgroundColor = '#10b981';
        drop.style.left = `${Math.random() * 50}vw`; 
    } else {
        drop.style.backgroundColor = '#3b82f6';
        drop.style.left = `${50 + Math.random() * 50}vw`; 
    }
    
    drop.style.animation = `rainDrop ${1 + Math.random()}s linear forwards`;

    document.body.appendChild(drop);

    setTimeout(() => {
        if (drop.parentNode) drop.remove();
    }, 2000);
}

function updateBackgroundAnimation() {
    clearBackgroundAnimations();
    if (!isMusicPlaying) return;

    const fluidBg = document.querySelector('.fluid-bg');

    if (currentSound === 'forest') {
        bgAnimationInterval = setInterval(() => {
            if (document.querySelectorAll('.bird-particle').length < 15) {
                spawnBird();
            }
        }, 1500);
    } else if (currentSound === 'rain') {
        bgAnimationInterval = setInterval(() => {
            if (document.querySelectorAll('.rain-particle').length < 30) {
                spawnRain();
                spawnRain(); 
            }
        }, 200);
    } else if (currentSound === 'ocean') {
        if (fluidBg) {
            fluidBg.classList.add('ocean-mode');
        }
    }
}

function startSound(soundKey) {
    const ctx = getAudioCtx();
    stopAllNodes();
    // Keep the buttons, track name and warning in step (sounds can also start from the AI assistant)
    currentSound = soundKey;
    const btn = document.querySelector(`.noise-btn[data-sound="${soundKey}"]`);
    if (btn) {
        document.querySelectorAll('.noise-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('track-name').innerText = btn.getAttribute('data-name');
    }
    updateToneWarning();
    switch(soundKey) {
        case 'tone852': startTone852(ctx); break;
        case 'rain':   startRain(ctx);   break;
        case 'forest': startForest(ctx); break;
        case 'ocean':  startOcean(ctx);  break;
    }
    updateBackgroundAnimation();
}

function setPlayingUI(playing) {
    isMusicPlaying = playing;
    musicPlayIcon.style.display  = playing ? 'none'  : 'block';
    musicPauseIcon.style.display = playing ? 'block' : 'none';
    musicPlayerUI?.classList.toggle('playing', playing);
    if (playerStatus) playerStatus.innerText = playing ? 'Now Playing' : 'Paused';
    updateBackgroundAnimation();
    // Sync PiP music display
    if (typeof updatePipMusicDisplay === 'function') updatePipMusicDisplay();
}

function toggleMusic() {
    const ctx = getAudioCtx();
    if (isMusicPlaying) {
        ctx.suspend();
        setPlayingUI(false);
    } else {
        if (activeNodes.length === 0) {
            startSound(currentSound);
        } else {
            ctx.resume();
        }
        setPlayingUI(true);
    }
}

musicToggleBtn?.addEventListener('click', toggleMusic);

document.getElementById('music-volume')?.addEventListener('input', (e) => {
    const val = e.target.value;
    if (masterGain) masterGain.gain.value = val / 100;
});

document.querySelectorAll('.noise-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const sound = btn.getAttribute('data-sound');
        const name  = btn.getAttribute('data-name');
        if (!sound) return;
        document.querySelectorAll('.noise-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('track-name').innerText = name;
        currentSound = sound;
        updateToneWarning();
        if (isMusicPlaying) startSound(sound);
    });
});
updateToneWarning();

// --- Real-time Clock Logic ---
function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    
    const timeString = `${hours}:${minutes}:${seconds}`;
    
    const timeEl = document.getElementById('clock-time');
    const ampmEl = document.getElementById('clock-ampm');
    
    if (timeEl) timeEl.innerText = timeString;
    if (ampmEl) ampmEl.innerText = ampm;
}

setInterval(updateClock, 1000);
updateClock(); // Initial call

// --- AI Assistant Logic ---
// Groq retires models from time to time (llama-3.1-8b-instant was shut down on 16 Aug 2026).
// The first model is used normally; if Groq says it's gone, the app asks Groq which models
// this key can use and switches to the first one from this list (or any other chat model).
const AI_CONFIG = {
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models"
};
let activeGroqModel = AI_CONFIG.models[0];

function addMessage(text, isBot = true) {
    const chatMessages = document.getElementById('ai-chat-messages');
    if (!chatMessages) return;
    
    const msg = document.createElement('div');
    msg.className = `ai-message ${isBot ? 'bot-message' : 'user-message'}`;
    msg.innerText = text;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Groq key protection ---
// The key is encrypted (AES-GCM) with a browser-generated key that can never be exported,
// kept in this browser's IndexedDB. Saved data only holds the encrypted form, the page
// never displays the key again, and it is only ever sent to api.groq.com.
const SECRET_DB_NAME = 'procrastinote-secrets';
let groqKeyCache = null; // { email, key }: decrypted key for the logged-in user, in memory only

function openSecretDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(SECRET_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keys');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getDeviceKey() {
    const db = await openSecretDb();
    const read = () => new Promise((resolve, reject) => {
        const req = db.transaction('keys').objectStore('keys').get('device');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const existing = await read();
    if (existing) return existing;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // add() fails if another tab created one first; then use theirs
    await new Promise(resolve => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').add(created, 'device');
        tx.oncomplete = resolve;
        tx.onerror = (e) => { e.preventDefault(); resolve(); };
    });
    return read();
}

const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function encryptSecret(plain, email) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(email) },
        await getDeviceKey(),
        new TextEncoder().encode(plain)
    );
    return { iv: toBase64(iv), data: toBase64(data) };
}

async function decryptSecret(box, email) {
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: new TextEncoder().encode(email) },
        await getDeviceKey(),
        fromBase64(box.data)
    );
    return new TextDecoder().decode(plain);
}

// Save (string) or remove (empty) the logged-in user's Groq key
async function setGroqKey(plain) {
    const email = appState.user.email.toLowerCase();
    if (!plain) {
        appState.groqKeyEnc = null;
        appState.groqKeyHint = '';
        groqKeyCache = null;
    } else {
        appState.groqKeyEnc = await encryptSecret(plain, email);
        appState.groqKeyHint = plain.slice(-4);
        groqKeyCache = { email, key: plain };
    }
    delete appState.groqKey; // never keep the readable copy
    saveState();
}

async function getGroqKey() {
    if (!appState.user) return '';
    const email = appState.user.email.toLowerCase();
    if (groqKeyCache?.email === email) return groqKeyCache.key;
    if (!appState.groqKeyEnc) return '';
    try {
        const key = await decryptSecret(appState.groqKeyEnc, email);
        groqKeyCache = { email, key };
        return key;
    } catch (e) {
        // Browser data was cleared, so the lock is gone: the saved key can't be read anymore
        return '';
    }
}

// Older versions saved the key as readable text; encrypt it once
async function protectLegacyGroqKey() {
    if (!appState.user || !appState.groqKey) return;
    try {
        await setGroqKey(appState.groqKey);
    } catch (e) {
        console.error('Could not encrypt the saved Groq key:', e.message);
    }
}

function renderGroqKeyStatus() {
    const status = document.getElementById('groq-key-status');
    const removeBtn = document.getElementById('btn-remove-ai-key');
    const saved = !!(appState.groqKeyEnc || appState.groqKey);
    // The setup guide in the AI chat is only needed until a key is saved
    const guide = document.getElementById('ai-key-guide');
    if (guide) guide.hidden = saved;
    if (!status) return;
    status.innerText = saved
        ? `A key is saved on this device${appState.groqKeyHint ? ` (ends in ••••${appState.groqKeyHint})` : ''}. It's encrypted and won't be shown again.`
        : 'No key saved.';
    if (removeBtn) removeBtn.style.display = saved ? '' : 'none';
}

async function requestGroqChat(apiKey, model, sys, prompt) {
    const response = await fetch(AI_CONFIG.baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: sys },
                { role: "user", content: prompt }
            ],
            // gpt-oss models think before answering; keep it short so replies stay quick
            ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: "low" } : {})
        })
    });
    const data = await response.json();
    console.log("[Groq API Response]", data);
    return data;
}

function isModelUnavailableError(error) {
    const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
    return text.includes('model_not_found') || text.includes('model_decommissioned') ||
        text.includes('does not exist') || text.includes('decommissioned') || text.includes('do not have access');
}

// Ask Groq which models this key can use; prefer our list, else any text chat model
async function pickAvailableGroqModel(apiKey) {
    try {
        const response = await fetch(AI_CONFIG.modelsUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const data = await response.json();
        const ids = (data.data || []).filter(m => m.active !== false).map(m => m.id);
        const preferred = AI_CONFIG.models.find(id => ids.includes(id) && id !== activeGroqModel);
        if (preferred) return preferred;
        // Skip speech, safety-filter and other non-chat models
        return ids.find(id => id !== activeGroqModel && !/whisper|guard|tts|playai|orpheus|prompt-guard|safeguard/i.test(id)) || null;
    } catch (e) {
        console.error("Could not get the Groq model list:", e);
        return null;
    }
}

async function callGroq(prompt, systemPrompt = null) {
    const apiKey = await getGroqKey();
    if (!apiKey) return "I need an API key to think better! You can add one in Settings.";

    const sys = systemPrompt || "You are a helpful student assistant for an app called Procrastinote. Keep responses concise and encouraging.";

    try {
        let data = await requestGroqChat(apiKey, activeGroqModel, sys, prompt);

        // The model was retired or isn't available to this key: pick another one and retry once
        if (data.error && isModelUnavailableError(data.error)) {
            const replacement = await pickAvailableGroqModel(apiKey);
            if (replacement && replacement !== activeGroqModel) {
                console.warn(`[Groq] ${activeGroqModel} is unavailable, switching to ${replacement}`);
                activeGroqModel = replacement;
                data = await requestGroqChat(apiKey, activeGroqModel, sys, prompt);
            }
        }

        if (data.error) {
            return `API Error: ${data.error.message || "Unknown error occurred."}`;
        }

        if (data.choices && data.choices.length > 0 && data.choices[0].message) {
            return data.choices[0].message.content;
        }

        return "I received an empty response. Check the console for details!";
    } catch (error) {
        console.error("Groq Fetch Error:", error);
        return "I'm having trouble connecting to my brain right now. Please check your internet connection and API key!";
    }
}

function handleAICommand(input) {
    const text = input.toLowerCase();
    
    // 1. Timer commands
    if (text.includes('timer') && (text.includes('start') || text.includes('set') || text.includes('begin'))) {
        const minsMatch = text.match(/(\d+)\s*min/);
        if (minsMatch) {
            const mins = parseInt(minsMatch[1]);
            const studyMin = document.getElementById('study-min');
            if (studyMin) studyMin.value = mins;
            resetTimer();
            startTimer();
            return `Sure! Starting a ${mins} minute study timer for you. ⏱️`;
        }
        startTimer();
        return "Starting your timer now! Let's get to work. 🚀";
    }
    
    if (text.includes('pause') && text.includes('timer')) {
        pauseTimer();
        return "Timer paused. Take a quick breather!";
    }

    if (text.includes('reset') && text.includes('timer')) {
        resetTimer();
        return "Timer reset to default.";
    }

    // 2. Music commands
    if (text.includes('play') || text.includes('music') || text.includes('sound') || text.includes('track')) {
        if (text.includes('rain')) { startSound('rain'); setPlayingUI(true); return "Playing relaxing rain sounds. 🌧️"; }
        if (text.includes('forest')) { startSound('forest'); setPlayingUI(true); return "Playing peaceful forest sounds. 🌲"; }
        if (text.includes('ocean')) { startSound('ocean'); setPlayingUI(true); return "Playing calming ocean waves. 🌊"; }
        if (text.includes('852') || text.includes('tone')) { startSound('tone852'); setPlayingUI(true); return "Playing the 852 Hz tone. Keep the volume low, and it's best without headphones. 🔈"; }
    }
    
    if (text.includes('stop') || text.includes('pause')) {
        if (text.includes('music') || text.includes('sound')) {
            if (isMusicPlaying) toggleMusic();
            return "Music paused.";
        }
    }

    // 3. Theme commands
    if (text.includes('dark mode') || text.includes('dark theme')) {
        appState.settings.theme = 'dark';
        applyTheme();
        saveState();
        return "Switching to Dark Mode. 🌙";
    }
    if (text.includes('light mode') || text.includes('light theme')) {
        appState.settings.theme = 'light';
        applyTheme();
        saveState();
        return "Switching to Light Mode. ☀️";
    }

    return null; // No local command matched
}

async function processAIInput() {
    const inputEl = document.getElementById('ai-user-input');
    const text = inputEl.value.trim();
    if (!text) return;
    
    addMessage(text, false);
    inputEl.value = '';
    
    const statusText = document.getElementById('ai-status-text');
    if (statusText) statusText.innerText = "Thinking...";
    
    // Check for local commands first
    const localResponse = handleAICommand(text);
    if (localResponse) {
        setTimeout(() => {
            addMessage(localResponse, true);
            if (statusText) statusText.innerText = "Online";
        }, 600);
        return;
    }
    
    // Otherwise, call Groq
    const botResponse = await callGroq(text);
    addMessage(botResponse, true);
    if (statusText) statusText.innerText = "Online";
}

// UI Event Listeners
document.getElementById('ai-mascot-fab')?.addEventListener('click', () => {
    const chat = document.getElementById('ai-chat-window');
    if (chat) {
        const isHidden = chat.style.display === 'none';
        chat.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) document.getElementById('ai-user-input')?.focus();
    }
});

// "Open AI settings" in the chat's setup guide: go to Settings > Security
document.getElementById('ai-key-guide-btn')?.addEventListener('click', () => {
    document.querySelector('.nav-links li[data-tab="settings"]')?.click();
    document.getElementById('btn-go-security')?.click();
    const chat = document.getElementById('ai-chat-window');
    if (chat) chat.style.display = 'none';
});

document.getElementById('close-chat-btn')?.addEventListener('click', () => {
    const chat = document.getElementById('ai-chat-window');
    if (chat) chat.style.display = 'none';
});

document.getElementById('ai-send-btn')?.addEventListener('click', processAIInput);
document.getElementById('ai-user-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') processAIInput();
});

// --- Password lock for the AI key settings ---
// Someone using an already logged-in computer can't change or remove the key without the password.
let aiKeyRelockTimer = null;
let aiUnlockFailures = 0;
let aiUnlockBlockedUntil = 0;

async function verifyAccountPassword(pass) {
    if (!appState.user) return false;
    if (cloud) {
        // Online accounts keep no password in the browser, so ask Supabase
        const { error } = await cloud.auth.signInWithPassword({ email: appState.user.email, password: pass });
        return !error;
    }
    return !!appState.user.pass && pass === appState.user.pass;
}

function lockAiKeySettings() {
    clearTimeout(aiKeyRelockTimer);
    document.getElementById('ai-key-lock')?.removeAttribute('hidden');
    document.getElementById('ai-key-controls')?.setAttribute('hidden', '');
    const keyInput = document.getElementById('groq-api-key');
    if (keyInput) keyInput.value = '';
    const passInput = document.getElementById('ai-unlock-password');
    if (passInput) passInput.value = '';
}

document.getElementById('btn-unlock-ai-key')?.addEventListener('click', async () => {
    const passInput = document.getElementById('ai-unlock-password');
    if (Date.now() < aiUnlockBlockedUntil) {
        alert(`Too many wrong tries. Wait ${Math.ceil((aiUnlockBlockedUntil - Date.now()) / 1000)} seconds.`);
        return;
    }
    if (!(await verifyAccountPassword(passInput.value))) {
        aiUnlockFailures++;
        if (aiUnlockFailures >= 5) {
            aiUnlockFailures = 0;
            aiUnlockBlockedUntil = Date.now() + 30000;
        }
        passInput.classList.add('shake-error');
        setTimeout(() => passInput.classList.remove('shake-error'), 750);
        passInput.value = '';
        return;
    }
    aiUnlockFailures = 0;
    passInput.value = '';
    document.getElementById('ai-key-lock').setAttribute('hidden', '');
    document.getElementById('ai-key-controls').removeAttribute('hidden');
    renderGroqKeyStatus();
    aiKeyRelockTimer = setTimeout(lockAiKeySettings, 5 * 60 * 1000); // relock after 5 minutes
});

document.getElementById('ai-unlock-password')?.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-unlock-ai-key')?.click();
});
document.getElementById('btn-lock-ai-key')?.addEventListener('click', lockAiKeySettings);
document.getElementById('btn-go-security')?.addEventListener('click', lockAiKeySettings);
document.getElementById('logout-btn')?.addEventListener('click', lockAiKeySettings);

document.getElementById('btn-save-ai-key')?.addEventListener('click', async () => {
    const input = document.getElementById('groq-api-key');
    const key = input.value.trim();
    if (!key) {
        alert("Type your Groq key first. To delete the saved key, press Remove Key.");
        return;
    }
    if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) {
        alert("That doesn't look like a Groq key. Groq keys start with gsk_.");
        return;
    }
    try {
        await setGroqKey(key);
        input.value = '';
        alert("Key saved and encrypted on this device.");
    } catch (e) {
        alert("Your browser couldn't store the key securely, so it wasn't saved. Try a normal (not private) window.");
    }
});

document.getElementById('btn-remove-ai-key')?.addEventListener('click', async () => {
    if (!confirm("Remove your saved Groq key from this device?")) return;
    await setGroqKey('');
    document.getElementById('groq-api-key').value = '';
    alert("Key removed.");
});

// --- Picture-in-Picture Widget Logic ---
const pipWidget = document.getElementById('pip-widget');
const pipBubble = document.getElementById('pip-bubble');
const pipTimerSection = document.getElementById('pip-timer-section');
const pipMusicSection = document.getElementById('pip-music-section');
const pipDivider = document.getElementById('pip-divider');
let pipMinimized = false;
let currentActiveTab = 'dashboard'; // Track the current tab

// Once sound has been played, keep the music player in the PiP even while paused
let musicWasStarted = false;
function musicInSession() {
    if (typeof isMusicPlaying !== 'undefined' && isMusicPlaying) musicWasStarted = true;
    return musicWasStarted;
}

// Determine if PiP should be visible
function shouldShowPip() {
    if (currentActiveTab === 'zen' && !extPipWindow) return false;

    const studyMin = document.getElementById('study-min');
    const breakMin = document.getElementById('break-min');
    if (!studyMin || !breakMin) return false;

    const mode = typeof timerMode !== 'undefined' ? timerMode : 'study';
    const total = (mode === 'study' ? studyMin.value : breakMin.value) * 60;
    const running = typeof isTimerRunning !== 'undefined' ? isTimerRunning : false;
    const currentSecs = typeof timerSeconds !== 'undefined' ? timerSeconds : total;
    const timerActive = running || (currentSecs > 0 && currentSecs < total);
    const musicActive = musicInSession();

    return timerActive || musicActive;
}

// Update PiP section visibility based on what's active
function updatePipSections() {
    const studyMin = document.getElementById('study-min');
    const breakMin = document.getElementById('break-min');
    const mode = typeof timerMode !== 'undefined' ? timerMode : 'study';
    const total = (mode === 'study' ? (studyMin ? studyMin.value : 25) : (breakMin ? breakMin.value : 5)) * 60;
    const running = typeof isTimerRunning !== 'undefined' ? isTimerRunning : false;
    const currentSecs = typeof timerSeconds !== 'undefined' ? timerSeconds : total;
    const timerActive = running || (currentSecs > 0 && currentSecs < total);
    const musicActive = musicInSession();

    // Show/hide timer section
    if (timerActive) {
        pipTimerSection.classList.remove('hidden');
    } else {
        pipTimerSection.classList.add('hidden');
    }

    // Show/hide music section
    if (musicActive) {
        pipMusicSection.classList.remove('hidden');
        pipMusicSection.classList.toggle('playing', !!isMusicPlaying);
    } else {
        pipMusicSection.classList.remove('playing');
        pipMusicSection.classList.add('hidden');
    }

    // Show divider only when both are visible
    if (timerActive && musicActive) {
        pipDivider.classList.remove('hidden');
    } else {
        pipDivider.classList.add('hidden');
    }
}

// Sync PiP timer display with main timer
function updatePipTimerDisplay() {
    const doc = pipWidget ? pipWidget.ownerDocument : document;
    const pipTimerText = doc.getElementById('pip-timer-text');
    const pipTimerProgress = doc.getElementById('pip-timer-progress');
    const pipTimerLabelEl = doc.getElementById('pip-timer-label');
    const pipTimerPlayBtn = doc.getElementById('pip-timer-play');
    const pipTimerPauseBtn = doc.getElementById('pip-timer-pause');

    if (!pipTimerText || !pipTimerProgress) return;

    let displaySecs = timerSeconds;
    if (isTimerRunning && timerEndTime) {
        displaySecs = Math.max(0, Math.round((timerEndTime - Date.now()) / 1000));
    }

    const mins = Math.floor(displaySecs / 60);
    const secs = displaySecs % 60;
    pipTimerText.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    // Update progress ring (circumference = 2 * PI * 42 ≈ 263.9)
    const studyMin = document.getElementById('study-min');
    const breakMin = document.getElementById('break-min');
    const total = ((timerMode === 'study' ? (studyMin ? studyMin.value : 25) : (breakMin ? breakMin.value : 5))) * 60;
    const ratio = displaySecs / total;
    pipTimerProgress.style.strokeDashoffset = 263.9 * ratio;

    // Update label
    if (pipTimerLabelEl) {
        pipTimerLabelEl.innerText = timerMode === 'study' ? 'Study Session' : 'Break Time';
        pipTimerLabelEl.classList.toggle('break', timerMode === 'break');
    }

    // Update play/pause buttons
    if (pipTimerPlayBtn && pipTimerPauseBtn) {
        pipTimerPlayBtn.style.display = isTimerRunning ? 'none' : 'flex';
        pipTimerPauseBtn.style.display = isTimerRunning ? 'flex' : 'none';
    }
}

// Sync PiP music display
function updatePipMusicDisplay() {
    const doc = pipWidget ? pipWidget.ownerDocument : document;
    const pipMusicTrack = doc.getElementById('pip-music-track');
    const pipMusicStatus = doc.getElementById('pip-music-status');
    const pipMusicPauseIcon = pipWidget?.querySelector('.pip-music-pause-icon');
    const pipMusicPlayIcon = pipWidget?.querySelector('.pip-music-play-icon');

    if (pipMusicTrack) {
        pipMusicTrack.innerText = document.getElementById('track-name')?.innerText || 'Zen Music';
    }
    if (pipMusicStatus) {
        pipMusicStatus.innerText = isMusicPlaying ? 'Now Playing' : 'Paused';
    }
    if (pipMusicPauseIcon && pipMusicPlayIcon) {
        pipMusicPauseIcon.style.display = isMusicPlaying ? 'block' : 'none';
        pipMusicPlayIcon.style.display = isMusicPlaying ? 'none' : 'block';
    }
    if (isMusicPlaying) {
        pipMusicSection.classList.add('playing');
    } else {
        pipMusicSection.classList.remove('playing');
    }
}

// Global variable to hold external Picture-in-Picture window reference
let extPipWindow = null;

// Function to open the Document Picture-in-Picture window (always on top)
async function openExternalPip() {
    if (!('documentPictureInPicture' in window)) {
        tryVideoPipFallback();
        return;
    }

    if (extPipWindow) {
        extPipWindow.close();
        extPipWindow = null;
        return;
    }

    try {
        const width = 300;
        const height = 220;
        extPipWindow = await window.documentPictureInPicture.requestWindow({
            width: width,
            height: height
        });

        // Add class to body for styling overrides
        extPipWindow.document.body.classList.add('external-pip-body');

        // Apply theme attributes
        const theme = document.documentElement.getAttribute('data-theme') || 'light';
        extPipWindow.document.documentElement.setAttribute('data-theme', theme);

        // Copy stylesheets to PiP window
        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                const style = extPipWindow.document.createElement('style');
                style.textContent = cssRules;
                extPipWindow.document.head.appendChild(style);
            } catch (e) {
                const link = extPipWindow.document.createElement('link');
                link.rel = 'stylesheet';
                link.type = styleSheet.type;
                link.media = styleSheet.media.mediaText;
                link.href = styleSheet.href;
                extPipWindow.document.head.appendChild(link);
            }
        });

        // Move the pip-widget to the PiP window body
        extPipWindow.document.body.appendChild(pipWidget);
        
        // Hide in-app bubble
        if (pipBubble) pipBubble.style.display = 'none';

        // When PiP closes, restore pip-widget to main document
        extPipWindow.addEventListener('pagehide', (event) => {
            extPipWindow = null;
            document.body.appendChild(pipWidget);
            updatePipVisibility();
        });

        // Force update displays in PiP context
        updatePipSections();
        updatePipTimerDisplay();
        updatePipMusicDisplay();

    } catch (err) {
        console.error("Failed to open Document Picture-in-Picture window:", err);
    }
}

// Canvas & Video setup for automatic browser-tab PiP
let autoPipCanvas = null;
let autoPipVideo = null;
let autoPipCtx = null;
let canvasDrawInterval = null;

function setupAutoPipElements() {
    if (autoPipVideo) return;

    autoPipCanvas = document.createElement('canvas');
    autoPipCanvas.width = 300;
    autoPipCanvas.height = 180;
    autoPipCtx = autoPipCanvas.getContext('2d');

    autoPipVideo = document.createElement('video');
    autoPipVideo.style.position = 'fixed';
    autoPipVideo.style.top = '0';
    autoPipVideo.style.left = '0';
    autoPipVideo.style.width = '10px';
    autoPipVideo.style.height = '10px';
    autoPipVideo.style.opacity = '0.001';
    autoPipVideo.style.pointerEvents = 'none';
    autoPipVideo.style.zIndex = '-9999';
    autoPipVideo.muted = true;
    autoPipVideo.playsInline = true;
    autoPipVideo.setAttribute('autopictureinpicture', '');
    autoPipVideo.autoPictureInPicture = true;

    // Capture stream from canvas at 10 FPS
    const stream = autoPipCanvas.captureStream(10);
    autoPipVideo.srcObject = stream;
    document.body.appendChild(autoPipVideo);

    // Watch for entering and leaving browser video PiP
    autoPipVideo.addEventListener('enterpictureinpicture', () => {
        updatePipVisibility();
    });
    autoPipVideo.addEventListener('leavepictureinpicture', () => {
        updatePipVisibility();
    });
}

function drawAutoPipCanvas() {
    if (!autoPipCtx) return;

    const ctx = autoPipCtx;
    const w = autoPipCanvas.width;
    const h = autoPipCanvas.height;

    // Get the theme actually showing (it may be following the device)
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    // Solid themed background colors
    const bgCol = isDark ? '#0b0f19' : '#f8fafc';
    const textPrimaryCol = isDark ? '#ffffff' : '#0f172a';
    const textSecondaryCol = isDark ? '#94a3b8' : '#475569';
    const ringBgCol = isDark ? '#1e293b' : '#cbd5e1';
    const activeLineCol = isDark ? '#334155' : '#cbd5e1';

    // Background
    ctx.fillStyle = bgCol;
    ctx.fillRect(0, 0, w, h);

    // Border
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#3b82f6');
    grad.addColorStop(1, '#10b981');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    // Timer check
    const studyMin = document.getElementById('study-min');
    const breakMin = document.getElementById('break-min');
    const mode = typeof timerMode !== 'undefined' ? timerMode : 'study';
    const total = ((mode === 'study' ? (studyMin ? studyMin.value : 25) : (breakMin ? breakMin.value : 5))) * 60;
    const running = typeof isTimerRunning !== 'undefined' ? isTimerRunning : false;
    const currentSecs = typeof timerSeconds !== 'undefined' ? timerSeconds : total;
    const timerActive = running || (currentSecs > 0 && currentSecs < total);

    // Left Side: Timer Ring
    if (timerActive) {
        const centerX = 80;
        const centerY = 90;
        const radius = 50;

        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = ringBgCol;
        ctx.lineWidth = 6;
        ctx.stroke();

        const ratio = currentSecs / total;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * ratio);
        ctx.strokeStyle = mode === 'study' ? '#3b82f6' : '#10b981';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.stroke();

        let displaySecs = timerSeconds;
        if (isTimerRunning && timerEndTime) {
            displaySecs = Math.max(0, Math.round((timerEndTime - Date.now()) / 1000));
        }
        const mins = Math.floor(displaySecs / 60);
        const secs = displaySecs % 60;
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        ctx.fillStyle = textPrimaryCol;
        ctx.font = 'bold 20px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeStr, centerX, centerY - 5);

        ctx.fillStyle = mode === 'study' ? '#3b82f6' : '#10b981';
        ctx.font = '600 10px Montserrat, sans-serif';
        ctx.fillText(mode === 'study' ? 'STUDY' : 'BREAK', centerX, centerY + 18);
    } else {
        const centerX = 80;
        const centerY = 90;
        ctx.fillStyle = ringBgCol;
        ctx.beginPath();
        ctx.arc(centerX, centerY, 40, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = textSecondaryCol;
        ctx.font = '600 12px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Zen Mode', centerX, centerY);
    }

    // Right Side: Music Status
    const musicActive = typeof isMusicPlaying !== 'undefined' ? isMusicPlaying : false;
    const trackNameStr = document.getElementById('track-name')?.innerText || 'Zen Music';

    const rightStartX = 150;
    const titleY = 50;
    const trackY = 80;
    const statusY = 105;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = textSecondaryCol;
    ctx.font = 'bold 11px Montserrat, sans-serif';
    ctx.fillText('ZEN MUSIC', rightStartX, titleY);

    ctx.fillStyle = textPrimaryCol;
    ctx.font = 'bold 14px Montserrat, sans-serif';
    let displayTrack = trackNameStr;
    if (ctx.measureText(displayTrack).width > 130) {
        while (ctx.measureText(displayTrack + '...').width > 130 && displayTrack.length > 0) {
            displayTrack = displayTrack.slice(0, -1);
        }
        displayTrack += '...';
    }
    ctx.fillText(displayTrack, rightStartX, trackY);

    ctx.fillStyle = musicActive ? '#10b981' : textSecondaryCol;
    ctx.font = '600 11px Montserrat, sans-serif';
    ctx.fillText(musicActive ? 'Playing' : 'Paused', rightStartX, statusY);

    if (musicActive) {
        ctx.fillStyle = '#10b981';
        const waveX = rightStartX;
        const waveY = 120;
        const barWidth = 4;
        const barGap = 3;
        const numBars = 12;
        const time = Date.now() * 0.005;

        for (let i = 0; i < numBars; i++) {
            const barHeight = 5 + Math.abs(Math.sin(time + i * 0.8)) * 25;
            ctx.fillRect(waveX + i * (barWidth + barGap), waveY + (25 - barHeight), barWidth, barHeight);
        }
    } else {
        ctx.fillStyle = activeLineCol;
        ctx.fillRect(rightStartX, 135, 80, 2);
    }
}

function startAutoPipLoop() {
    setupAutoPipElements();
    if (canvasDrawInterval) clearInterval(canvasDrawInterval);
    canvasDrawInterval = setInterval(drawAutoPipCanvas, 100);
    
    if (autoPipVideo) {
        autoPipVideo.play().catch(err => {
            console.log("Auto-PiP video play failed (expected on start before user gesture): ", err);
        });
    }
}

function stopAutoPipLoop() {
    if (canvasDrawInterval) {
        clearInterval(canvasDrawInterval);
        canvasDrawInterval = null;
    }
    if (autoPipVideo) {
        autoPipVideo.pause();
    }
}

async function tryVideoPipFallback() {
    setupAutoPipElements();
    if (autoPipVideo) {
        try {
            await autoPipVideo.play();
            await autoPipVideo.requestPictureInPicture();
        } catch (err) {
            console.error("Standard Video PiP fallback failed:", err);
            alert("Picture-in-Picture is not supported or was blocked by the browser.");
        }
    }
}

// Show/hide PiP widget
function updatePipVisibility() {
    const show = shouldShowPip();
    const isVideoPipActive = document.pictureInPictureElement && (document.pictureInPictureElement === autoPipVideo);

    // If an external Document PiP window is open
    if (extPipWindow) {
        if (!show) {
            extPipWindow.close();
            extPipWindow = null;
        } else {
            if (pipWidget) pipWidget.classList.remove('visible');
            if (pipBubble) pipBubble.style.display = 'none';
            // Update displays in Document PiP context
            updatePipSections();
            updatePipTimerDisplay();
            updatePipMusicDisplay();
        }
        return;
    }

    // If browser tab-level Video PiP fallback is active
    if (isVideoPipActive) {
        if (!show) {
            document.exitPictureInPicture().catch(err => console.log("Exit Video PiP failed:", err));
            stopAutoPipLoop();
        } else {
            startAutoPipLoop();
        }
        if (pipWidget) pipWidget.classList.remove('visible');
        if (pipBubble) pipBubble.style.display = 'none';
        return;
    }

    // Otherwise, ensure all in-website widgets on the main page are hidden
    if (pipWidget) pipWidget.classList.remove('visible');
    if (pipBubble) pipBubble.style.display = 'none';
    pipMinimized = false;
    stopAutoPipLoop();
}

// PiP timer control event listeners
document.getElementById('pip-timer-play')?.addEventListener('click', () => {
    startTimer();
    updatePipTimerDisplay();
});

document.getElementById('pip-timer-pause')?.addEventListener('click', () => {
    pauseTimer();
    updatePipTimerDisplay();
    setTimeout(updatePipVisibility, 50);
});

document.getElementById('pip-timer-reset')?.addEventListener('click', () => {
    resetTimer();
    updatePipTimerDisplay();
    setTimeout(updatePipVisibility, 50);
});

// PiP music toggle
document.getElementById('pip-music-toggle')?.addEventListener('click', () => {
    toggleMusic();
    updatePipMusicDisplay();
    setTimeout(updatePipVisibility, 50);
});

// PiP close (minimize to bubble)
document.getElementById('pip-close')?.addEventListener('click', () => {
    pipMinimized = true;
    updatePipVisibility();
});

// PiP bubble click (restore)
pipBubble?.addEventListener('click', () => {
    pipMinimized = false;
    updatePipVisibility();
});

// PiP "Go to Zen" button
document.getElementById('pip-go-zen')?.addEventListener('click', () => {
    // Navigate to Zen tab
    document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
    const zenTab = document.querySelector('[data-tab="zen"]');
    if (zenTab) zenTab.classList.add('active');
    document.getElementById('zen')?.classList.add('active-view');
    currentActiveTab = 'zen';
    
    if (typeof handleTimerSidebarMove === 'function') handleTimerSidebarMove('zen');
    if (typeof handleMusicSidebarMove === 'function') handleMusicSidebarMove('zen');
    
    updatePipVisibility();
});

// Register float miniplayer trigger buttons
document.getElementById('zen-float-btn')?.addEventListener('click', openExternalPip);
document.getElementById('pip-float-btn')?.addEventListener('click', openExternalPip);

// Sync theme changes to the external PiP window
if (typeof applyTheme === 'function') {
    const originalApplyTheme = applyTheme;
    applyTheme = function() {
        originalApplyTheme();
        const theme = document.documentElement.getAttribute('data-theme') || 'light';
        if (extPipWindow) {
            extPipWindow.document.documentElement.setAttribute('data-theme', theme);
        }
    };
}

// Auto-close PiP when returning to the tab
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (extPipWindow) {
            extPipWindow.close();
            extPipWindow = null;
        }
    }
});

// --- PiP Drag Logic ---
(function setupPipDrag() {
    const header = pipWidget?.querySelector('.pip-header');
    if (!header || !pipWidget) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking a button
        if (e.target.closest('button')) return;

        isDragging = true;
        pipWidget.classList.add('dragging');

        const rect = pipWidget.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;

        // Switch to absolute positioning for drag
        pipWidget.style.left = rect.left + 'px';
        pipWidget.style.top = rect.top + 'px';
        pipWidget.style.bottom = 'auto';
        pipWidget.style.right = 'auto';

        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // Constrain to viewport
        const maxLeft = window.innerWidth - pipWidget.offsetWidth - 8;
        const maxTop = window.innerHeight - pipWidget.offsetHeight - 8;
        newLeft = Math.max(8, Math.min(maxLeft, newLeft));
        newTop = Math.max(8, Math.min(maxTop, newTop));

        pipWidget.style.left = newLeft + 'px';
        pipWidget.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        pipWidget.classList.remove('dragging');
    });
})();

// Periodic PiP update (syncs timer every second when PiP or external PiP is active)
setInterval(() => {
    if ((pipWidget && pipWidget.classList.contains('visible')) || extPipWindow) {
        updatePipTimerDisplay();
        updatePipMusicDisplay();
        updatePipSections();
        // Auto-hide if nothing is active anymore
        if (!shouldShowPip()) {
            updatePipVisibility();
        }
    }
}, 1000);

// Hook into existing navigation to track current tab and update PiP
// Override the existing navigation click handler
document.querySelectorAll('.nav-links li').forEach(link => {
    link.addEventListener('click', () => {
        currentActiveTab = link.getAttribute('data-tab');
        pipMinimized = false; // Reset minimized when changing tabs
        setTimeout(updatePipVisibility, 100);
    });
});

// Hook into setPlayingUI to trigger PiP update when music state changes
const originalSetPlayingUI = setPlayingUI;
setPlayingUI = function(playing) {
    originalSetPlayingUI(playing);
    setTimeout(updatePipVisibility, 50);
};

// Initialize application
// Force-fix for Monday June 1st migration if they hit the Day Order 3 bug
if (new Date().toDateString() === 'Mon Jun 01 2026' && !localStorage.getItem('procrastinote_june1_fixed')) {
    appState.settings.currentDayOrder = 1;
    appState.settings.lastUpdatedDate = 'Mon Jun 01 2026';
    localStorage.setItem('procrastinote_june1_fixed', 'true');
    saveState();
}

// --- Friends & Chat Logic ---
const CHATS_KEY = 'school_planner_chats';
const AI_BUDDIES = [
    {
        id: 'procrasti-bot',
        name: 'Procrasti-Bot',
        role: 'Study Coach',
        desc: 'Productivity tips & motivation.',
        avatar: 'PB',
        systemPrompt: 'You are Procrasti-Bot, a friendly and encouraging productivity coach for Procrastinote. Give students quick, actionable tips to beat procrastination. Keep it short (1-3 sentences).',
        offlineResponses: [
            "Hey there! Ready to crush some tasks today? Remember, even a 5-minute study session is better than zero. Give it a shot! 🚀",
            "You've got this! Try setting a small, specific goal right now. What's one tiny thing you can complete in the next 15 minutes? ⏱️",
            "Productivity tip: Put your phone in another room or turn on Zen Mode! It works wonders. 🧘",
            "Don't wait for motivation. Action builds motivation. Start small, just do one problem or write one line!"
        ]
    },
    {
        id: 'zen-master',
        name: 'Zen Master',
        role: 'Mindfulness Guide',
        desc: 'Calm breathing & relaxation.',
        avatar: 'ZM',
        systemPrompt: 'You are Zen Master, a calm mindfulness guide for Procrastinote. Suggest brief breathing exercises, quick stretches, or relaxing thoughts to help stressed students. Keep it short (1-3 sentences).',
        offlineResponses: [
            "Take a deep breath. Inhale for 4 seconds, hold for 4, exhale for 4. Feel the tension leaving your shoulders. 🌸",
            "Remember, you are doing your best, and that is enough. Let's take a 1-minute mindfulness break together. 🧘",
            "A calm mind is a powerful mind. If you're feeling overwhelmed, try listening to some Rain sounds in Zen Mode. 🌧️",
            "Relax your jaw, roll your shoulders, and take a long, slow breath. You are capable of handling whatever comes today."
        ]
    },
    {
        id: 'study-buddy',
        name: 'Study Buddy',
        role: 'Study Partner',
        desc: 'Help with subjects & ideas.',
        avatar: 'SB',
        systemPrompt: 'You are Study Buddy, a helpful peer study partner for Procrastinote. Answer academic questions or help brainstorm ideas. Keep it short (1-3 sentences).',
        offlineResponses: [
            "Hey! What subject are we working on? I'm ready to help brainstorm or solve some problems. 📚",
            "That homework won't know what hit it! Let me know if you need to explain a concept to me - teaching is the best way to learn. ✏️",
            "I'm checking my virtual notebook now. Feel free to ask me a question about math, science, or history! 🧠",
            "Let's tackle this concept together. Break it down into smaller parts and let's go step-by-step!"
        ]
    }
];

let activeChatCategory = 'ai'; // 'ai' or 'humans'
let activeChatId = null; // AI buddy ID or human email

function getChats() {
    return JSON.parse(localStorage.getItem(CHATS_KEY)) || {};
}

function saveChats(chats) {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
}

function getRoomId(friendId) {
    if (!appState.user) return null;
    const currentEmail = appState.user.email.toLowerCase();
    
    // If it's an AI buddy, the chat room is scoped to the current user's session
    const isAi = AI_BUDDIES.some(b => b.id === friendId);
    if (isAi) {
        return `room_${currentEmail}_${friendId}`;
    }
    
    // For human friends, room ID is sorted alphabetically to be shared
    const sortedEmails = [currentEmail, friendId.toLowerCase()].sort();
    return `room_${sortedEmails[0]}_${sortedEmails[1]}`;
}

// --- Online friends chat (only when `cloud` is set up; AI buddy chats stay local) ---
let cloudRooms = {};          // roomId -> [{ id, sender, text, timestamp }]
let loadedRooms = new Set();  // rooms whose history has been fetched
let friendProfiles = {};      // email -> { id, name, class } from the profiles table
let onlineUserIds = new Set();
let cloudChannels = [];
let friendNotifications = []; // newest first: [{ id, sender, text, timestamp }] (see "Notifications")
let sharedNotes = [];         // notes friends sent you, newest first (see "Sharing notes")

// Friends are shown by name, never by email
function getFriendProfile(email) {
    const key = email.toLowerCase();
    const profile = friendProfiles[key] || allUsers[key]?.profile || {};
    return { ...profile, name: (profile.name || '').trim() || 'Friend', class: profile.class || '' };
}

function isFriendOnline(email) {
    const id = friendProfiles[email.toLowerCase()]?.id;
    return !!id && onlineUserIds.has(id);
}

function addFriendIfNew(email) {
    if (!appState.friendsList) appState.friendsList = [];
    if (appState.friendsList.includes(email)) return;
    appState.friendsList.push(email);
    saveState();
    fetchFriendProfiles([email]);
}

async function fetchFriendProfiles(emails) {
    if (!cloud || emails.length === 0) return;
    const { data, error } = await cloud.rpc('get_profiles', { emails });
    if (error) {
        console.error('Could not load friend profiles:', error.message);
        return;
    }
    data.forEach(p => { friendProfiles[p.email] = { id: p.id, name: p.name, class: p.class }; });
    renderFriends();
    renderChatHeaderStatus();
    renderNotifications(); // friends' names in message notifications
}

function addCloudMessage(row, render) {
    const myEmail = appState.user.email.toLowerCase();
    if (!cloudRooms[row.room_id]) cloudRooms[row.room_id] = [];
    const list = cloudRooms[row.room_id];
    if (list.some(m => m.id === row.id)) return;
    list.push({ id: row.id, sender: row.sender_email, text: row.text, timestamp: Date.parse(row.created_at) });
    list.sort((a, b) => a.timestamp - b.timestamp);

    addFriendIfNew(row.member_a === myEmail ? row.member_b : row.member_a);
    if (render && activeChatId && getRoomId(activeChatId) === row.room_id) renderChatWindow();
}

// --- Photos and documents in chat ---
// Files go to the private "shared-files" storage bucket at <sender id>/<receiver id>/<file>,
// with a shared_files row so they show up in the chat (see supabase/add-file-sharing.sql).
const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_FILE_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const signedFileUrls = new Map(); // path -> { url, expires }

const fileExtension = name => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// How a sent file shows in Notifications ("Sent a file: notes.pdf")
const fileNotificationRow = row => ({
    id: `file-${row.id}`, sender_email: row.sender_email, text: `Sent a file: ${row.file_name}`, created_at: row.created_at
});

function addCloudFile(row, render) {
    if (!cloudRooms[row.room_id]) cloudRooms[row.room_id] = [];
    const list = cloudRooms[row.room_id];
    const id = `file-${row.id}`;
    if (list.some(m => m.id === id)) return;
    list.push({
        id,
        sender: row.sender_email,
        timestamp: Date.parse(row.created_at),
        file: { path: row.path, name: row.file_name, type: row.mime_type, size: row.size_bytes }
    });
    list.sort((a, b) => a.timestamp - b.timestamp);
    const myEmail = appState.user.email.toLowerCase();
    addFriendIfNew(row.sender_email === myEmail ? row.recipient_email : row.sender_email);
    if (render && activeChatId && getRoomId(activeChatId) === row.room_id) renderChatWindow();
}

// Links to private files work for an hour; reuse them until shortly before that
async function getFileUrl(path, downloadName) {
    const key = downloadName ? `${path}#download` : path;
    const cached = signedFileUrls.get(key);
    if (cached && cached.expires > Date.now()) return cached.url;
    const { data, error } = await cloud.storage.from('shared-files')
        .createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
    if (error) throw error;
    signedFileUrls.set(key, { url: data.signedUrl, expires: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
}

function buildChatFile(file) {
    const box = document.createElement('div');
    box.className = 'chat-file';
    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'chat-file-image';
        img.alt = file.name;
        getFileUrl(file.path).then(url => { img.src = url; }).catch(() => { img.alt = `${file.name} (couldn't load)`; });
        box.appendChild(img);
    } else {
        const doc = document.createElement('div');
        doc.className = 'chat-file-doc';
        doc.innerHTML = `<span class="chat-file-icon">${escapeHTML((fileExtension(file.name) || 'file').toUpperCase().slice(0, 4))}</span>` +
            `<span class="chat-file-name">${escapeHTML(file.name)}<small>${escapeHTML(formatFileSize(file.size))}</small></span>`;
        box.appendChild(doc);
    }
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'chat-file-download';
    download.innerText = 'Download';
    download.addEventListener('click', async () => {
        download.disabled = true;
        try {
            const link = document.createElement('a');
            link.href = await getFileUrl(file.path, file.name);
            link.rel = 'noopener';
            link.click();
        } catch (e) {
            alert(`Couldn't download ${file.name}: ${e.message}`);
        }
        download.disabled = false;
    });
    box.appendChild(download);
    return box;
}

async function sendChatFile(file) {
    if (!file || !activeChatId || !isOnlineAccount()) return;
    const friendEmail = activeChatId.toLowerCase();
    const type = CHAT_FILE_TYPES[fileExtension(file.name)];
    if (!type) {
        alert('You can send photos (PNG, JPG, GIF, WebP), PDF, Word, PowerPoint, Excel and text files.');
        return;
    }
    if (file.size === 0 || file.size > CHAT_FILE_MAX_BYTES) {
        alert(`${file.name} is ${file.size ? formatFileSize(file.size) : 'empty'}. Files can be up to 10 MB.`);
        return;
    }
    const friendId = friendProfiles[friendEmail]?.id;
    if (!friendId) {
        alert(`${getFriendProfile(friendEmail).name} needs an online Procrastinote account before you can send them files.`);
        return;
    }

    const button = document.getElementById('chat-attach-btn');
    button.disabled = true;
    alert(`Sending ${file.name}...`);
    // Storage paths only allow simple characters; the real name is kept in shared_files
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || `file.${fileExtension(file.name)}`;
    const path = `${appState.user.cloudId}/${friendId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    try {
        const upload = await cloud.storage.from('shared-files').upload(path, file, { contentType: type, upsert: false });
        if (upload.error) throw upload.error;
        const { data, error } = await cloud.from('shared_files').insert({
            sender_email: appState.user.email.toLowerCase(),
            recipient_id: friendId,
            recipient_email: friendEmail,
            path,
            file_name: file.name.slice(0, 200),
            mime_type: type,
            size_bytes: file.size
        }).select().single();
        if (error) {
            await cloud.storage.from('shared-files').remove([path]); // don't leave an unlisted file behind
            throw error;
        }
        addCloudFile(data, true);
    } catch (e) {
        alert(/bucket|shared_files|does not exist|PGRST205|42P01/i.test(`${e.code || ''} ${e.message || ''}`)
            ? 'Sending files isn\'t switched on yet: run supabase/add-file-sharing.sql in Supabase first.'
            : `${file.name} wasn't sent: ${e.message}`);
    }
    button.disabled = false;
}

document.getElementById('chat-attach-btn')?.addEventListener('click', () => document.getElementById('chat-file-input')?.click());
document.getElementById('chat-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    sendChatFile(file);
});

async function loadCloudRoom(roomId) {
    loadedRooms.add(roomId);
    const { data, error } = await cloud.from('messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
        .limit(500);
    if (error) {
        loadedRooms.delete(roomId);
        console.error('Could not load messages:', error.message);
        return;
    }
    if (!cloudRooms[roomId]) cloudRooms[roomId] = [];
    data.forEach(row => addCloudMessage(row, false));
    // Photos and documents sent in this chat (table missing until add-file-sharing.sql is run)
    const files = await cloud.from('shared_files')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
        .limit(200);
    if (!files.error) files.data.forEach(row => addCloudFile(row, false));
    if (activeChatId && getRoomId(activeChatId) === roomId) renderChatWindow();
}

// Friends who messaged you show up in your list even if you never added them
async function loadCloudFriends() {
    const myEmail = appState.user.email.toLowerCase();
    const { data, error } = await cloud.from('messages')
        .select('member_a, member_b')
        .order('created_at', { ascending: false })
        .limit(1000);
    if (error) {
        console.error('Could not load chats:', error.message);
        return;
    }
    if (!appState.friendsList) appState.friendsList = [];
    let updated = false;
    data.forEach(row => {
        const other = row.member_a === myEmail ? row.member_b : row.member_a;
        if (!appState.friendsList.includes(other)) {
            appState.friendsList.push(other);
            updated = true;
        }
    });
    if (updated) saveState();
    fetchFriendProfiles(appState.friendsList);
}

function startCloudChat() {
    if (!cloud || !appState.user?.cloudId || cloudChannels.length) return;

    // Database security rules make sure we only receive messages from our own rooms
    const messagesChannel = cloud.channel('my-messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
            payload => {
                addCloudMessage(payload.new, true);
                addFriendNotification(payload.new);
            })
        .subscribe();

    // Presence shares only your account ID while the app is open, not your email
    const presenceChannel = cloud.channel('online-users', {
        config: { presence: { key: appState.user.cloudId } }
    });
    presenceChannel
        .on('presence', { event: 'sync' }, () => {
            onlineUserIds = new Set(Object.keys(presenceChannel.presenceState()));
            renderFriends();
            renderChatHeaderStatus();
        })
        .subscribe(status => {
            if (status === 'SUBSCRIBED') presenceChannel.track({ online_at: new Date().toISOString() });
        });

    // Notes shared with you appear (and disappear when dismissed on another device) instantly
    const sharedNotesChannel = cloud.channel('my-shared-notes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'shared_notes' },
            payload => addSharedNote(payload.new))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'shared_notes' },
            payload => removeSharedNote(payload.old?.id))
        .subscribe();

    // Photos and documents sent in chat appear instantly
    const filesChannel = cloud.channel('my-shared-files')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'shared_files' },
            payload => {
                addCloudFile(payload.new, true);
                addFriendNotification(fileNotificationRow(payload.new));
            })
        .subscribe();

    cloudChannels = [messagesChannel, presenceChannel, sharedNotesChannel, filesChannel];
    loadCloudFriends();
    loadFriendNotifications();
    loadSharedNotes();

    window.Classes?.start(); // class chats, homework and approvals (classes.js)
}

function stopCloudChat() {
    cloudChannels.forEach(channel => cloud.removeChannel(channel));
    cloudChannels = [];
    cloudRooms = {};
    loadedRooms = new Set();
    friendProfiles = {};
    onlineUserIds = new Set();
    friendNotifications = [];
    sharedNotes = [];
    window.Classes?.stop();
    renderNotifications();
    renderSharedNotes();
}

// --- Notifications: new messages from friends + "What's new" (updates.js) ---
// What each person has already seen is remembered on this device:
// { messagesSeenAt / sharedSeenAt / classSeenAt: time of the newest friend message / shared note /
//   class event seen, updatesSeen: [update ids] }
const NOTIF_MESSAGE_LIMIT = 20;

function notifStorageKey() {
    return `procrastinote_notifications_${(appState.user?.email || '').toLowerCase()}`;
}

function getNotifSeen() {
    try {
        const seen = JSON.parse(localStorage.getItem(notifStorageKey())) || {};
        return {
            messagesSeenAt: seen.messagesSeenAt || 0, sharedSeenAt: seen.sharedSeenAt || 0,
            classSeenAt: seen.classSeenAt || 0, updatesSeen: seen.updatesSeen || []
        };
    } catch (e) {
        return { messagesSeenAt: 0, sharedSeenAt: 0, classSeenAt: 0, updatesSeen: [] };
    }
}

function setNotifSeen(seen) {
    try {
        localStorage.setItem(notifStorageKey(), JSON.stringify(seen));
    } catch (e) { /* storage full or blocked: badges just reappear next time */ }
}

const appUpdates = () => (Array.isArray(window.PROCRASTINOTE_UPDATES) ? window.PROCRASTINOTE_UPDATES : []);

async function loadFriendNotifications() {
    if (!cloud || !appState.user?.cloudId) return;
    const myEmail = appState.user.email.toLowerCase();
    const { data, error } = await cloud.from('messages')
        .select('id, sender_email, text, created_at')
        .neq('sender_email', myEmail)
        .order('created_at', { ascending: false })
        .limit(NOTIF_MESSAGE_LIMIT);
    if (error) {
        console.error('Could not load notifications:', error.message);
        return;
    }
    // Files friends sent you count as messages too
    const files = await cloud.from('shared_files')
        .select('*')
        .eq('recipient_email', myEmail)
        .order('created_at', { ascending: false })
        .limit(NOTIF_MESSAGE_LIMIT);
    const rows = data.concat(files.error ? [] : files.data.map(fileNotificationRow));
    friendNotifications = rows
        .map(row => ({ id: row.id, sender: row.sender_email, text: row.text, timestamp: Date.parse(row.created_at) }))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, NOTIF_MESSAGE_LIMIT);
    renderNotifications();
}

function addFriendNotification(row) {
    const myEmail = appState.user?.email?.toLowerCase();
    if (!myEmail || row.sender_email === myEmail) return;
    if (friendNotifications.some(n => n.id === row.id)) return;
    const note = { id: row.id, sender: row.sender_email, text: row.text, timestamp: Date.parse(row.created_at) };
    friendNotifications.unshift(note);
    friendNotifications = friendNotifications.slice(0, NOTIF_MESSAGE_LIMIT);

    // Already reading that chat: it doesn't need a notification badge
    const readingIt = document.getElementById('friends')?.classList.contains('active-view') &&
        activeChatId?.toLowerCase() === note.sender;
    if (readingIt) {
        const seen = getNotifSeen();
        setNotifSeen({ ...seen, messagesSeenAt: Math.max(seen.messagesSeenAt, note.timestamp) });
    }
    renderNotifications();
}

function timeAgo(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatUpdateDate(dateString) {
    const [y, m, d] = dateString.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// `seenOverride` keeps unread highlights visible while the panel is open
// Two buttons on the dashboard: Messages (classes, friends, shared notes) and Updates (What's new)
const NOTIF_PANELS = {
    messages: { button: 'btn-messages', panel: 'msg-panel', badge: 'msg-badge', label: 'Messages' },
    updates: { button: 'btn-updates', panel: 'updates-panel', badge: 'updates-badge', label: 'Updates' }
};
let notifSeenWhileOpen = null; // what was seen before the open panel, so its new items stay highlighted

function setNotifBadge(kind, count) {
    const { badge, button, label } = NOTIF_PANELS[kind];
    const el = document.getElementById(badge);
    if (!el) return;
    el.hidden = count === 0;
    el.innerText = count > 9 ? '9+' : String(count);
    document.getElementById(button)?.setAttribute('aria-label', count ? `${label}, ${count} new` : label);
}

function renderNotifications(seenOverride) {
    const messagesEl = document.getElementById('notif-messages');
    const updatesEl = document.getElementById('notif-updates');
    if (!messagesEl || !updatesEl) return;

    const seen = seenOverride || notifSeenWhileOpen || getNotifSeen();
    const updates = appUpdates();
    const classItems = window.Classes ? Classes.notificationItems() : [];

    const badgeSeen = getNotifSeen();
    setNotifBadge('messages', friendNotifications.filter(n => n.timestamp > badgeSeen.messagesSeenAt).length +
        sharedNotes.filter(n => n.timestamp > badgeSeen.sharedSeenAt).length +
        classItems.filter(n => n.ts > badgeSeen.classSeenAt).length);
    setNotifBadge('updates', updates.filter(u => !badgeSeen.updatesSeen.includes(u.id)).length);

    const classTitle = document.getElementById('notif-classes-title');
    const classList = document.getElementById('notif-classes');
    if (window.Classes && classTitle && classList) Classes.renderNotificationList(classList, classTitle, seen.classSeenAt);

    messagesEl.innerHTML = '';
    if (!cloud || !appState.user?.cloudId) {
        messagesEl.innerHTML = '<li class="notif-empty">Log in to an online account to get messages from friends.</li>';
    } else if (friendNotifications.length === 0) {
        messagesEl.innerHTML = '<li class="notif-empty">No messages from friends yet.</li>';
    } else {
        friendNotifications.forEach(note => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notif-item' + (note.timestamp > seen.messagesSeenAt ? ' unread' : '');
            const preview = note.text.length > 90 ? note.text.slice(0, 90) + '...' : note.text;
            btn.innerHTML = `<strong>${escapeHTML(getFriendProfile(note.sender).name)}</strong>: ${escapeHTML(preview)}` +
                `<span class="notif-item-time">${escapeHTML(timeAgo(note.timestamp))}</span>`;
            btn.addEventListener('click', () => openChatFromNotification(note.sender));
            li.appendChild(btn);
            messagesEl.appendChild(li);
        });
    }

    const sharedTitle = document.getElementById('notif-shared-title');
    const sharedEl = document.getElementById('notif-shared');
    if (sharedTitle && sharedEl) {
        sharedTitle.hidden = sharedEl.hidden = sharedNotes.length === 0;
        sharedEl.innerHTML = '';
        sharedNotes.forEach(note => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notif-item' + (note.timestamp > seen.sharedSeenAt ? ' unread' : '');
            btn.innerHTML = `<strong>${escapeHTML(getFriendProfile(note.sender).name)}</strong> shared a note: ${escapeHTML(note.title || 'Untitled note')}` +
                `<span class="notif-item-time">${escapeHTML(timeAgo(note.timestamp))}</span>`;
            btn.addEventListener('click', openSharedNotes);
            li.appendChild(btn);
            sharedEl.appendChild(li);
        });
    }

    updatesEl.innerHTML = '';
    if (updates.length === 0) {
        updatesEl.innerHTML = '<li class="notif-empty">No updates yet.</li>';
    }
    updates.forEach(update => {
        const li = document.createElement('li');
        li.className = 'notif-item' + (seen.updatesSeen.includes(update.id) ? '' : ' unread');
        li.innerHTML = `<strong>${escapeHTML(update.title)}</strong><br>${escapeHTML(update.text)}` +
            `<span class="notif-item-time">${escapeHTML(formatUpdateDate(update.date))}</span>`;
        updatesEl.appendChild(li);
    });
}

// kind: 'messages' or 'updates'. What that panel shows now counts as seen; its new items stay
// highlighted until it closes.
function openNotifications(kind = 'messages') {
    closeNotifications();
    const before = getNotifSeen();
    const after = { ...before };
    if (kind === 'messages') {
        after.messagesSeenAt = Math.max(before.messagesSeenAt, ...friendNotifications.map(n => n.timestamp));
        after.sharedSeenAt = Math.max(before.sharedSeenAt, ...sharedNotes.map(n => n.timestamp));
        after.classSeenAt = Math.max(before.classSeenAt, ...(window.Classes ? Classes.notificationItems().map(n => n.ts) : []));
    } else {
        after.updatesSeen = appUpdates().map(u => u.id);
    }
    setNotifSeen(after);
    notifSeenWhileOpen = before;
    renderNotifications();
    document.getElementById(NOTIF_PANELS[kind].panel).hidden = false;
    document.getElementById(NOTIF_PANELS[kind].button).setAttribute('aria-expanded', 'true');
}

function closeNotifications() {
    let wasOpen = false;
    Object.values(NOTIF_PANELS).forEach(({ panel, button }) => {
        const el = document.getElementById(panel);
        if (!el || el.hidden) return;
        el.hidden = true;
        document.getElementById(button)?.setAttribute('aria-expanded', 'false');
        wasOpen = true;
    });
    if (!wasOpen) return;
    notifSeenWhileOpen = null;
    renderNotifications();
}

function openChatFromNotification(email) {
    closeNotifications();
    document.querySelector('.dock-item[data-tab="friends"]')?.click();
    document.querySelector('.friends-cat-tab[data-category="humans"]')?.click();
    activeChatId = email;
    renderFriends();
    renderChatWindow();
}

Object.entries(NOTIF_PANELS).forEach(([kind, { button, panel }]) => {
    document.getElementById(button)?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.getElementById(panel).hidden) openNotifications(kind);
        else closeNotifications();
    });
});
document.querySelectorAll('[data-notif-close]').forEach(btn => btn.addEventListener('click', closeNotifications));
document.addEventListener('click', (e) => {
    if (!e.target.closest('.notif-wrap')) closeNotifications();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNotifications();
});

// --- Sharing notes with friends ---
// Sharing sends a COPY of a note through Supabase (table shared_notes, see supabase/setup.sql).
// The friend sees it under "Shared with me" in Notebook and can save it to their notes or dismiss it.
// Pictures uploaded from the device stay behind (too big for the free plan); picture links are sent.
const SHARE_MAX_CHARS = 100000;

const isOnlineAccount = () => !!(cloud && appState.user?.cloudId);

const sharedNoteFromRow = row => ({
    id: row.id,
    sender: row.sender_email,
    title: row.title,
    content: row.content,
    images: Array.isArray(row.images) ? row.images.filter(src => /^https?:\/\//i.test(src)) : [],
    timestamp: Date.parse(row.created_at)
});

// The table exists only after add-note-sharing.sql was run in Supabase
const isMissingTableError = error => /shared_notes|does not exist|PGRST205|42P01/i.test(`${error?.code || ''} ${error?.message || ''}`);

async function loadSharedNotes() {
    if (!isOnlineAccount()) return;
    const myEmail = appState.user.email.toLowerCase();
    const { data, error } = await cloud.from('shared_notes')
        .select('*')
        .eq('recipient_email', myEmail)
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) {
        console.error('Could not load shared notes:', error.message);
        return;
    }
    sharedNotes = data.map(sharedNoteFromRow);
    renderSharedNotes();
    renderNotifications();
}

function addSharedNote(row) {
    if (!row || row.recipient_email !== appState.user?.email?.toLowerCase()) return;
    if (sharedNotes.some(n => n.id === row.id)) return;
    sharedNotes.unshift(sharedNoteFromRow(row));
    renderSharedNotes();
    renderNotifications();
}

function removeSharedNote(id) {
    if (id === undefined || !sharedNotes.some(n => n.id === id)) return;
    sharedNotes = sharedNotes.filter(n => n.id !== id);
    renderSharedNotes();
    renderNotifications();
}

async function deleteSharedNote(id) {
    const { error } = await cloud.from('shared_notes').delete().eq('id', id);
    if (error) {
        alert(`Couldn't remove that shared note: ${error.message}`);
        return false;
    }
    removeSharedNote(id);
    return true;
}

function saveSharedNoteToMyNotes(id) {
    const shared = sharedNotes.find(n => n.id === id);
    if (!shared) return;
    const from = getFriendProfile(shared.sender).name;
    const newId = 'nb_' + Date.now();
    if (!appState.notebooks) appState.notebooks = [];
    appState.notebooks.unshift({
        id: newId,
        title: `${shared.title || 'Untitled note'} (from ${from})`,
        content: shared.content || '',
        images: shared.images
    });
    appState.activeNotebookId = newId;
    saveState();
    deleteSharedNote(id); // it's in your notes now, so it leaves "Shared with me"
    alert(`Saved "${shared.title || 'Untitled note'}" to your notes.`);
}

function renderSharedNotes() {
    const section = document.getElementById('shared-notes-section');
    const list = document.getElementById('shared-notes-list');
    if (!section || !list) return;
    section.hidden = !isOnlineAccount() || sharedNotes.length === 0;
    list.innerHTML = '';
    sharedNotes.forEach(note => {
        const li = document.createElement('li');
        li.className = 'shared-note-item';
        li.innerHTML = `
            <div class="shared-note-info">
                ${escapeHTML(note.title || 'Untitled note')}
                <small>From ${escapeHTML(getFriendProfile(note.sender).name)} · ${escapeHTML(timeAgo(note.timestamp))}</small>
            </div>
            <div class="shared-note-buttons">
                <button type="button" class="btn primary-btn btn-sm" data-action="save">Save to my notes</button>
                <button type="button" class="btn secondary-btn btn-sm" data-action="dismiss">Dismiss</button>
            </div>
        `;
        li.querySelector('[data-action="save"]').addEventListener('click', () => saveSharedNoteToMyNotes(note.id));
        li.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
            showConfirm(`Dismiss "${note.title || 'Untitled note'}"? It won't be saved to your notes.`, () => deleteSharedNote(note.id));
        });
        list.appendChild(li);
    });
}

function openSharedNotes() {
    closeNotifications();
    document.querySelector('.dock-item[data-tab="notebook"]')?.click();
    setTimeout(() => document.getElementById('shared-notes-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

function renderSharePanel() {
    const list = document.getElementById('share-friend-list');
    if (!list) return;
    list.innerHTML = '';
    const friends = (appState.friendsList || []).filter(email => email.toLowerCase() !== appState.user?.email?.toLowerCase());
    if (!isOnlineAccount()) {
        list.innerHTML = '<li class="share-empty">Log in to an online account to share notes.</li>';
        return;
    }
    if (friends.length === 0) {
        list.innerHTML = '<li class="share-empty">Add friends on the Friends page first, then share your notes with them.</li>';
        return;
    }
    friends.forEach(email => {
        const profile = getFriendProfile(email);
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="share-friend-name">${escapeHTML(profile.name)}${profile.class ? `<small>${escapeHTML(profile.class)}</small>` : ''}</div>
            <button type="button" class="btn primary-btn btn-sm">Send</button>
        `;
        const button = li.querySelector('button');
        button.addEventListener('click', () => shareActiveNoteWith(email, button));
        list.appendChild(li);
    });
}

async function shareActiveNoteWith(email, button) {
    const note = appState.notebooks.find(n => n.id === appState.activeNotebookId);
    if (!note || !isOnlineAccount()) return;
    const content = note.content || '';
    if (content.length > SHARE_MAX_CHARS) {
        alert(`This note is too long to share (over ${SHARE_MAX_CHARS.toLocaleString()} characters). Split it into smaller notes first.`);
        return;
    }
    const allImages = note.images || [];
    const images = allImages.filter(src => /^https?:\/\//i.test(src)).slice(0, 20);
    const title = (note.title || 'Untitled note').slice(0, 200);
    const name = getFriendProfile(email).name;

    button.disabled = true;
    button.innerText = 'Sending...';
    const { error } = await cloud.from('shared_notes').insert({
        sender_email: appState.user.email.toLowerCase(),
        recipient_email: email.toLowerCase(),
        title,
        content,
        images
    });
    if (error) {
        button.disabled = false;
        button.innerText = 'Send';
        alert(isMissingTableError(error)
            ? 'Sharing isn\'t switched on yet: run supabase/add-note-sharing.sql in Supabase first.'
            : `Couldn't share the note: ${error.message}`);
        return;
    }
    button.innerText = 'Sent';
    const left = allImages.length - images.length;
    alert(`Sent "${title}" to ${name}.` + (left ? ` ${left} picture${left === 1 ? '' : 's'} uploaded from your device stayed behind.` : ''));
}

function closeSharePanel() {
    const panel = document.getElementById('share-panel');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    document.getElementById('btn-share-notebook')?.setAttribute('aria-expanded', 'false');
}

document.getElementById('btn-share-notebook')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('share-panel');
    if (!panel.hidden) return closeSharePanel();
    renderSharePanel();
    panel.style.transform = '';
    panel.hidden = false;
    e.currentTarget.setAttribute('aria-expanded', 'true');
    // On narrow phones keep the panel inside the note area, which cuts off anything outside it
    const area = panel.closest('#notebook-active-view')?.getBoundingClientRect();
    const minLeft = Math.max(8, area ? area.left : 0);
    const maxRight = Math.min(window.innerWidth - 8, area ? area.right : window.innerWidth);
    panel.style.maxWidth = `${maxRight - minLeft}px`;
    const rect = panel.getBoundingClientRect();
    const shift = rect.left < minLeft ? minLeft - rect.left : Math.min(0, maxRight - rect.right);
    if (shift) panel.style.transform = `translateX(${shift}px)`;
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('.share-wrap')) closeSharePanel();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSharePanel();
});

// On page load: make sure the saved login is still a valid online session
async function restoreCloudSession() {
    if (!cloud || !appState.user) return;
    const { data } = await cloud.auth.getSession();
    const user = data.session?.user;
    if (!user || user.email.toLowerCase() !== appState.user.email.toLowerCase()) {
        if (!appState.user.cloudId) {
            alert('Procrastinote now has online accounts, so you can use the same account on every device. Please log in again (your planner data is kept).');
        }
        localStorage.removeItem(SESSION_KEY);
        appState = JSON.parse(JSON.stringify(defaultState));
        checkAuth();
        return;
    }
    if (appState.user.cloudId !== user.id || appState.user.pass) {
        loadUserFromCloud(user);
        saveState();
    }
    startCloudChat();
    startPlannerSync();
}

// --- Planner sync: the same account works on every device ---
// Everything that belongs to the account is saved to Supabase (planner_data, one row per account).
// Kept on this device only: the encrypted Groq key (locked to this browser) and pictures uploaded
// into notes (too big for the free plan; picture links still sync). State variables are near the top.
const isUploadedPicture = src => typeof src === 'string' && src.startsWith('data:');

function buildPlannerPayload() {
    const data = {};
    PLANNER_SYNC_FIELDS.forEach(field => { data[field] = appState[field]; });
    data.notebooks = (appState.notebooks || []).map(nb => ({
        ...nb,
        images: (nb.images || []).filter(src => !isUploadedPicture(src))
    }));
    return data;
}

function schedulePlannerSync() {
    if (!cloud || !plannerReady || applyingRemotePlanner || !appState.user?.cloudId) return;
    plannerDirty = true;
    clearTimeout(plannerSyncTimer);
    plannerSyncTimer = setTimeout(pushPlannerData, 1500); // wait for typing to pause
}

// Combine changes made here and on another device since the last sync (base).
// Lists of items (homework, notes...) and maps (holidays, timetable...) merge item by item:
// additions from both sides are kept, deletions are respected, and an item edited here wins.
function mergeEntries(baseEntries, localEntries, remoteEntries) {
    const base = new Map(baseEntries.map(([k, v]) => [k, JSON.stringify(v)]));
    const local = new Map(localEntries);
    const result = [];
    const seen = new Set();
    remoteEntries.forEach(([k, remoteValue]) => {
        seen.add(k);
        if (local.has(k)) {
            const localValue = local.get(k);
            result.push([k, JSON.stringify(localValue) !== base.get(k) ? localValue : remoteValue]);
        } else if (!base.has(k)) {
            result.push([k, remoteValue]); // added on the other device
        } // else: deleted here
    });
    localEntries.forEach(([k, localValue]) => {
        if (!seen.has(k) && !base.has(k)) result.push([k, localValue]); // added here
    });
    return result;
}

function mergePlannerField(baseJson, localValue, remoteValue) {
    if (remoteValue === undefined) return localValue;
    if (JSON.stringify(localValue) === baseJson) return remoteValue;  // only the other device changed it
    if (JSON.stringify(remoteValue) === baseJson) return localValue;  // only this device changed it
    const base = baseJson === undefined ? undefined : JSON.parse(baseJson);
    if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
        const keyOf = item => (item && typeof item === 'object' && 'id' in item) ? `id:${item.id}` : `v:${JSON.stringify(item)}`;
        const toEntries = arr => (Array.isArray(arr) ? arr : []).map(item => [keyOf(item), item]);
        return mergeEntries(toEntries(base), toEntries(localValue), toEntries(remoteValue)).map(([, v]) => v);
    }
    const isMap = v => v && typeof v === 'object' && !Array.isArray(v);
    if (isMap(localValue) && isMap(remoteValue)) {
        return Object.fromEntries(mergeEntries(Object.entries(isMap(base) ? base : {}), Object.entries(localValue), Object.entries(remoteValue)));
    }
    return localValue; // simple values: the change made here wins
}

function rememberPlannerBase(data, updatedAt) {
    plannerBase = {};
    PLANNER_SYNC_FIELDS.forEach(field => { plannerBase[field] = JSON.stringify(data[field]); });
    plannerLastSynced = updatedAt;
}

async function pushPlannerData() {
    clearTimeout(plannerSyncTimer);
    if (!cloud || !plannerDirty || !appState.user?.cloudId) return true;
    const userId = appState.user.cloudId;
    const local = buildPlannerPayload(); // built before any await, so logging out right after is safe
    const base = plannerBase;
    plannerDirty = false;

    let toSave = local;
    // If another device saved since we last synced, merge instead of overwriting its changes
    if (plannerLastSynced) {
        const { data: remote } = await cloud.from('planner_data').select('data, updated_at').eq('user_id', userId).maybeSingle();
        if (remote && remote.updated_at !== plannerLastSynced) {
            toSave = { ...(remote.data || {}) };
            PLANNER_SYNC_FIELDS.forEach(field => {
                toSave[field] = mergePlannerField(base[field], local[field], (remote.data || {})[field]);
            });
            if (appState.user?.cloudId === userId) applyRemotePlanner(toSave);
        }
    }

    const updatedAt = new Date().toISOString();
    const { error } = await cloud.from('planner_data').upsert({ user_id: userId, data: toSave, updated_at: updatedAt });
    if (error) {
        plannerDirty = true; // try again on the next change, when the tab is hidden, or when back online
        console.error('Could not save your planner online:', error.message);
        return false;
    }
    rememberPlannerBase(toSave, updatedAt);
    return true;
}

function applyRemotePlanner(remote) {
    // Keep pictures that were uploaded into notes on this device
    const localPictures = {};
    (appState.notebooks || []).forEach(nb => { localPictures[nb.id] = (nb.images || []).filter(isUploadedPicture); });

    PLANNER_SYNC_FIELDS.forEach(field => { if (remote[field] !== undefined) appState[field] = remote[field]; });
    appState.notebooks = (appState.notebooks || []).map(nb => ({
        ...nb,
        images: [...(nb.images || []), ...(localPictures[nb.id] || [])]
    }));

    applyingRemotePlanner = true;
    try {
        updateDayOrderIfNeeded(); // the online copy may be from an earlier day
        saveState();
        applyTheme();
    } finally {
        applyingRemotePlanner = false;
    }
}

async function pullPlannerData() {
    if (!cloud || !appState.user?.cloudId) return;
    if (plannerDirty) {
        await pushPlannerData(); // merges with the online copy, so unsaved changes here aren't lost
        return;
    }
    const { data, error } = await cloud.from('planner_data')
        .select('data, updated_at')
        .eq('user_id', appState.user.cloudId)
        .maybeSingle();
    if (error) {
        console.error('Could not load your planner:', error.message);
        return;
    }
    if (!data) {
        // First time this account is online: upload the planner from this device
        plannerDirty = true;
        await pushPlannerData();
        return;
    }
    if (data.updated_at === plannerLastSynced) return;
    applyRemotePlanner(data.data || {});
    rememberPlannerBase(data.data || {}, data.updated_at);
}

async function startPlannerSync() {
    if (!cloud || !appState.user?.cloudId) return;
    plannerReady = false;
    plannerDirty = false;
    plannerLastSynced = null;
    plannerBase = {};
    await pullPlannerData();
    plannerReady = true;
}

function stopPlannerSync() {
    clearTimeout(plannerSyncTimer);
    plannerReady = false;
    plannerDirty = false;
    plannerLastSynced = null;
    plannerBase = {};
}

// Pick up changes made on other devices, and save before the tab is hidden or closed
document.addEventListener('visibilitychange', () => {
    if (!plannerReady) return;
    if (document.visibilityState === 'hidden') pushPlannerData();
    else pullPlannerData();
});
window.addEventListener('online', () => { if (plannerReady) pushPlannerData(); });
setInterval(() => {
    if (plannerReady && document.visibilityState === 'visible') pullPlannerData();
}, 60000);

function syncIncomingFriends() {
    if (!appState.user || !appState.user.email) return;
    const currentUserEmail = appState.user.email.toLowerCase();
    const chats = getChats();
    let updated = false;
    
    if (!appState.friendsList) appState.friendsList = [];
    
    Object.keys(chats).forEach(roomKey => {
        if (roomKey.startsWith('room_')) {
            const content = roomKey.substring(5);
            if (content.includes(currentUserEmail)) {
                const idx = content.indexOf(currentUserEmail);
                let otherEmail = '';
                if (idx === 0) {
                    otherEmail = content.substring(currentUserEmail.length + 1);
                } else {
                    otherEmail = content.substring(0, idx - 1);
                }
                
                if (otherEmail) {
                    const isAi = AI_BUDDIES.some(b => b.id === otherEmail);
                    if (!isAi && !appState.friendsList.includes(otherEmail)) {
                        appState.friendsList.push(otherEmail);
                        updated = true;
                    }
                }
            }
        }
    });
    
    if (updated) {
        const email = appState.user.email.toLowerCase();
        if (allUsers[email]) {
            if (!allUsers[email].data) allUsers[email].data = {};
            allUsers[email].data.friendsList = appState.friendsList;
            localStorage.setItem(USERS_KEY, JSON.stringify(allUsers));
        }
    }
}

function renderFriends() {
    syncIncomingFriends();
    const list = document.getElementById('friends-list');
    if (!list) return;
    list.innerHTML = '';
    
    if (activeChatCategory === 'ai') {
        AI_BUDDIES.forEach(buddy => {
            const isActive = activeChatId === buddy.id;
            const li = document.createElement('li');
            li.className = `friend-item-wrapper ${isActive ? 'active' : ''}`;
            li.innerHTML = `
                <div class="friend-item-avatar-wrapper">
                    <div class="friend-avatar" style="background: linear-gradient(135deg, #06b6d4, #8b5cf6);">${buddy.avatar}</div>
                    <span class="friend-status-dot online"></span>
                </div>
                <div class="friend-item-info">
                    <div class="friend-item-name">${buddy.name}</div>
                    <div class="friend-item-subtext">${buddy.role} &bull; ${buddy.desc}</div>
                </div>
            `;
            li.addEventListener('click', () => {
                activeChatId = buddy.id;
                renderFriends();
                renderChatWindow();
            });
            list.appendChild(li);
        });
    } else {
        // Human Friends
        const friends = appState.friendsList || [];
        if (friends.length === 0) {
            list.innerHTML = '<li class="empty-state" style="padding: 2rem 1rem; text-align: center; color: var(--text-secondary);">No friends added yet. Add a friend using their email above!</li>';
            return;
        }
        
        friends.forEach(email => {
            const isActive = activeChatId === email;
            const isOnline = isFriendOnline(email);
            const friendProfile = getFriendProfile(email);
            const initials = friendProfile.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            
            const li = document.createElement('li');
            li.className = `friend-item-wrapper ${isActive ? 'active' : ''}`;
            li.innerHTML = `
                <div class="friend-item-avatar-wrapper">
                    <div class="friend-avatar" style="background: linear-gradient(135deg, #3b82f6, #10b981);">${escapeHTML(initials)}</div>
                    <span class="friend-status-dot ${isOnline ? 'online' : 'offline'}"></span>
                </div>
                <div class="friend-item-info">
                    <div class="friend-item-name">${escapeHTML(friendProfile.name)}</div>
                    <div class="friend-item-subtext">${friendProfile.class ? `${escapeHTML(friendProfile.class)} &bull; ` : ''}${isOnline ? 'Online' : 'Offline'}</div>
                </div>
            `;
            li.addEventListener('click', () => {
                activeChatId = email;
                renderFriends();
                renderChatWindow();
            });
            list.appendChild(li);
        });
    }
}

function renderChatWindow() {
    const container = document.getElementById('chat-messages-container');
    const headerName = document.getElementById('chat-active-name');
    const headerStatus = document.getElementById('chat-active-status');
    const headerAvatar = document.getElementById('chat-active-avatar');
    const inputWrapper = document.getElementById('chat-input-wrapper');
    const typingIndicator = document.getElementById('chat-typing-indicator');
    
    if (!container) return;
    
    if (!activeChatId) {
        container.innerHTML = `
            <div class="chat-empty-state">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <p>Select an AI Buddy or add a friend to start chatting!</p>
            </div>
        `;
        if (headerName) headerName.innerText = 'Select a conversation';
        if (headerStatus) {
            headerStatus.innerText = 'Offline';
            headerStatus.className = 'chat-status-label';
        }
        if (headerAvatar) {
            headerAvatar.innerText = 'AI';
            headerAvatar.style.background = 'var(--accent-color)';
        }
        if (inputWrapper) inputWrapper.style.display = 'none';
        if (typingIndicator) typingIndicator.style.display = 'none';
        return;
    }
    
    // Find active conversation details
    let name = '';
    let statusText = 'Offline';
    let isOnline = false;
    let avatarInitials = '';
    let avatarBg = '';
    
    const buddy = AI_BUDDIES.find(b => b.id === activeChatId);
    if (buddy) {
        name = buddy.name;
        statusText = 'Online';
        isOnline = true;
        avatarInitials = buddy.avatar;
        avatarBg = 'linear-gradient(135deg, #06b6d4, #8b5cf6)';
    } else {
        const friendProfile = getFriendProfile(activeChatId);
        name = friendProfile.name;
        isOnline = isFriendOnline(activeChatId);
        statusText = isOnline ? 'Online' : 'Offline';
        avatarInitials = name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        avatarBg = 'linear-gradient(135deg, #3b82f6, #10b981)';
    }
    
    if (headerName) headerName.innerText = name;
    if (headerStatus) {
        headerStatus.innerText = statusText;
        headerStatus.className = `chat-status-label ${isOnline ? 'online' : ''}`;
    }
    if (headerAvatar) {
        headerAvatar.innerText = avatarInitials;
        headerAvatar.style.background = avatarBg;
    }
    if (inputWrapper) inputWrapper.style.display = 'flex';
    if (typingIndicator) typingIndicator.style.display = 'none';
    const attachBtn = document.getElementById('chat-attach-btn');
    if (attachBtn) attachBtn.hidden = !!buddy || !isOnlineAccount(); // files go to friends, online only

    // Load messages
    container.innerHTML = '';
    const roomId = getRoomId(activeChatId);
    let messages;
    if (cloud && !buddy) {
        if (!loadedRooms.has(roomId)) {
            container.innerHTML = `
                <div class="chat-empty-state">
                    <p>Loading messages...</p>
                </div>
            `;
            loadCloudRoom(roomId);
            return;
        }
        messages = cloudRooms[roomId] || [];
    } else {
        messages = getChats()[roomId] || [];
    }

    if (messages.length === 0) {
        container.innerHTML = `
            <div class="chat-empty-state">
                <p>No messages yet. Say hello! 👋</p>
            </div>
        `;
        return;
    }
    
    const currentUserEmail = appState.user.email.toLowerCase();
    
    messages.forEach(msg => {
        const isOutgoing = msg.sender.toLowerCase() === currentUserEmail;
        const msgWrapper = document.createElement('div');
        msgWrapper.className = `chat-msg-bubble-wrapper ${isOutgoing ? 'outgoing' : 'incoming'}`;
        
        let senderName = '';
        let senderInitials = '';
        let senderBg = '';
        
        if (isOutgoing) {
            senderName = appState.user.name;
            senderInitials = senderName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            senderBg = 'linear-gradient(135deg, #3b82f6, #10b981)';
        } else if (buddy) {
            senderName = buddy.name;
            senderInitials = buddy.avatar;
            senderBg = 'linear-gradient(135deg, #06b6d4, #8b5cf6)';
        } else {
            senderName = getFriendProfile(activeChatId).name;
            senderInitials = senderName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            senderBg = 'linear-gradient(135deg, #3b82f6, #10b981)';
        }
        
        const dateStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        msgWrapper.innerHTML = `
            <div class="friend-avatar" style="width: 32px; height: 32px; font-size: 0.8rem; background: ${senderBg};">${escapeHTML(senderInitials)}</div>
            <div class="chat-msg-bubble">
                <div>${msg.file ? '' : escapeHTML(msg.text)}</div>
                <span class="chat-msg-time">${dateStr}</span>
            </div>
        `;
        if (msg.file) msgWrapper.querySelector('.chat-msg-bubble > div').appendChild(buildChatFile(msg.file));
        container.appendChild(msgWrapper);
    });
    
    container.scrollTop = container.scrollHeight;
}

// Update only the Online/Offline label so presence changes don't redraw the messages
function renderChatHeaderStatus() {
    const headerStatus = document.getElementById('chat-active-status');
    if (!headerStatus || !activeChatId || AI_BUDDIES.some(b => b.id === activeChatId)) return;
    const isOnline = isFriendOnline(activeChatId);
    headerStatus.innerText = isOnline ? 'Online' : 'Offline';
    headerStatus.className = `chat-status-label ${isOnline ? 'online' : ''}`;
}

async function sendChatMessage() {
    const input = document.getElementById('chat-message-input');
    const text = input.value.trim();
    if (!text || !activeChatId || !appState.user) return;

    input.value = '';
    const currentUserEmail = appState.user.email.toLowerCase();
    const roomId = getRoomId(activeChatId);

    if (cloud && !AI_BUDDIES.some(b => b.id === activeChatId)) {
        if (text.length > 2000) {
            alert('Messages can be at most 2000 characters.');
            input.value = text;
            return;
        }
        // Same sorted order as getRoomId, so the database's room_id matches
        const [memberA, memberB] = [currentUserEmail, activeChatId.toLowerCase()].sort();
        const { data, error } = await cloud.from('messages')
            .insert({ member_a: memberA, member_b: memberB, sender_email: currentUserEmail, text })
            .select()
            .single();
        if (error) {
            alert(`Message not sent: ${error.message}`);
            input.value = text;
            return;
        }
        addCloudMessage(data, true);
        return;
    }

    const newMessage = {
        sender: currentUserEmail,
        text: text,
        timestamp: Date.now()
    };
    
    // Save locally
    const chats = getChats();
    if (!chats[roomId]) chats[roomId] = [];
    chats[roomId].push(newMessage);
    saveChats(chats);
    
    // Render immediately
    renderChatWindow();
    
    // Check if conversation is with AI
    const buddy = AI_BUDDIES.find(b => b.id === activeChatId);
    if (buddy) {
        const typingIndicator = document.getElementById('chat-typing-indicator');
        const container = document.getElementById('chat-messages-container');
        if (typingIndicator) typingIndicator.style.display = 'flex';
        if (container) container.scrollTop = container.scrollHeight;
        
        // Prepare prompt
        const prompt = `Student says: "${text}"\nRespond directly as their educational mascot companion.`;
        
        let aiResponse = "";
        
        // If Groq key is available, let's call API
        if ((await getGroqKey()).startsWith('gsk_')) {
            aiResponse = await callGroq(prompt, buddy.systemPrompt);
        }
        
        // If empty, failed, or standard key is used (we fallback if it looks like default/error)
        if (!aiResponse || aiResponse.includes("API Error") || aiResponse.includes("brain right now") || aiResponse.includes("API key")) {
            // Wait slightly to simulate writing
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 800));
            const fallbacks = buddy.offlineResponses;
            aiResponse = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
        
        const aiMessage = {
            sender: buddy.id,
            text: aiResponse,
            timestamp: Date.now()
        };
        
        chats[roomId].push(aiMessage);
        saveChats(chats);
        
        if (typingIndicator) typingIndicator.style.display = 'none';
        renderChatWindow();
    }
}

// Bind Friends UI actions
(function initFriendsActions() {
    // Friends & Chat stays "Coming Soon" until supabase-config.js is filled in
    if (cloud) {
        const comingSoon = document.getElementById('friends-coming-soon');
        if (comingSoon) comingSoon.style.display = 'none'; // its class sets display, so [hidden] wouldn't win
        const layout = document.getElementById('friends-layout');
        if (layout) layout.style.display = '';
    }

    // Add Friend
    document.getElementById('btn-add-friend')?.addEventListener('click', async () => {
        const input = document.getElementById('friend-search-input');
        const email = input.value.trim().toLowerCase();
        if (!email) return;
        
        if (!appState.user || !appState.user.email) {
            alert("Please log in first!");
            return;
        }
        
        if (email === appState.user.email.toLowerCase()) {
            alert("You cannot add yourself as a friend!");
            return;
        }
        
        if (!email.includes('@')) {
            alert("Please enter a valid email address!");
            return;
        }
        
        if (!appState.friendsList) appState.friendsList = [];
        if (appState.friendsList.includes(email)) {
            alert("You have already added this friend!");
            return;
        }

        if (cloud) {
            const { data, error } = await cloud.rpc('get_profiles', { emails: [email] });
            if (error) {
                alert(`Could not check that email: ${error.message}`);
                return;
            }
            if (!data || data.length === 0) {
                alert("No Procrastinote account uses that email yet. Ask your friend to sign up first!");
                return;
            }
            friendProfiles[email] = { id: data[0].id, name: data[0].name, class: data[0].class };
        }

        appState.friendsList.push(email);
        saveState();
        input.value = '';
        alert("Friend added successfully!");
    });
    
    // Search Box Enter Key
    document.getElementById('friend-search-input')?.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('btn-add-friend')?.click();
        }
    });
    
    // Category Tabs Switching
    document.querySelectorAll('.friends-cat-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.friends-cat-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeChatCategory = tab.getAttribute('data-category') || 'ai';
            activeChatId = null; // Reset selection
            renderFriends();
            renderChatWindow();
        });
    });
    
    // Chat Send message
    document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);
    document.getElementById('chat-message-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });
})();

updateTimerDisplay();
updateRobotExpression();
applyTheme();
checkAuth();
restoreCloudSession();
window.__procrastinoteStarted = true; // tells the browser check in index.html that startup worked

