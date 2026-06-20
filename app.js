// --- State & Local Storage Management ---
const STATE_KEY = 'school_planner_data';

let defaultState = {
    settings: {
        totalDays: 6,
        currentDayOrder: 1, // Represents 'Today'
        lastUpdatedDate: new Date().toDateString(),
        theme: 'light'
    },
    uniforms: {}, // e.g., { "1": "Regular", "2": "PE" }
    timetable: {}, // e.g., { "1": ["Math", "English"], "2": ["Science"] }
    homework: [] // e.g., { id, task, subject, date }
};

let appState = JSON.parse(localStorage.getItem(STATE_KEY)) || defaultState;

// Simple state management script
function saveState() {
    localStorage.setItem(STATE_KEY, JSON.stringify(appState));
    renderAllViews();
}

// --- Navigation Logic ---
document.querySelectorAll('.nav-links li').forEach(link => {
    link.addEventListener('click', (e) => {
        document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
        
        e.target.classList.add('active');
        const tabId = e.target.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active-view');
    });
});

// --- Date & Day Order Math ---
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
            let dayOfWeek = temp.getDay(); // 0 is Sunday, 6 is Saturday
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
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

function getTomorrowDayOrder() {
    // If today is Day Order X, tomorrow is Day Order X+1 (wrapping around)
    let current = parseInt(appState.settings.currentDayOrder);
    let total = parseInt(appState.settings.totalDays);
    let tmrw = current + 1;
    if (tmrw > total) tmrw = 1;
    return tmrw;
}

// --- Render Logic ---

function renderAllViews() {
    renderSettings();
    renderTimetable();
    renderHomework();
    renderDashboard();
}

function renderSettings() {
    // Basic settings
    document.getElementById('total-days').value = appState.settings.totalDays;
    document.getElementById('current-day-order').value = appState.settings.currentDayOrder;

    // Uniforms
    const container = document.getElementById('uniform-setup-container');
    container.innerHTML = '';
    
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        const val = appState.uniforms[i] || '';
        container.innerHTML += `
            <div class="form-group">
                <label>Day ${i} Uniform</label>
                <input type="text" id="uniform-day-${i}" value="${val}" placeholder="e.g. Regular or PE">
            </div>
        `;
    }
}

function renderTimetable() {
    const container = document.getElementById('timetable-container');
    container.innerHTML = '';
    
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        // Assume 5 periods per day for simplicity
        let subjectsHtml = '';
        const daySubjects = appState.timetable[i] || ['', '', '', '', ''];
        
        for (let j = 0; j < 5; j++) {
            let val = daySubjects[j] || '';
            subjectsHtml += `<input type="text" class="subject-input day-${i}-sub" value="${val}" placeholder="Subject ${j+1}">`;
        }

        container.innerHTML += `
            <div class="day-column">
                <h4>Day ${i}</h4>
                ${subjectsHtml}
            </div>
        `;
    }
}

function renderHomework() {
    const list = document.getElementById('active-homework-list');
    list.innerHTML = '';

    // Sort by date mostly
    appState.homework.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (appState.homework.length === 0) {
        list.innerHTML = '<li class="empty-state">No active homework! 🎉</li>';
        return;
    }

    appState.homework.forEach((hw, index) => {
        list.innerHTML += `
            <li>
                <div class="hw-info">
                    <strong>${hw.task} (${hw.subject})</strong>
                    <span>Due: ${new Date(hw.date).toLocaleDateString()}</span>
                </div>
                <button class="done-btn" onclick="completeHomework(${index})">Mark Done</button>
            </li>
        `;
    });
}

function renderDashboard() {
    const tmrwDay = getTomorrowDayOrder();
    document.getElementById('dash-day-order-display').innerText = `Tomorrow is Day Order: ${tmrwDay}`;

    // Uniform
    const unif = appState.uniforms[tmrwDay];
    document.getElementById('dash-uniform').innerText = unif ? unif : "Not Set up - Check settings!";

    // Subjects & Books
    // Get ALL unique subjects to know our master list
    let allSubjects = new Set();
    Object.values(appState.timetable).forEach(dayList => {
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
            packListEl.innerHTML += `<li>${sub}</li>`;
        });
    }

    // Leave list = All subjects minus tomorrow's subjects
    const leaveListEl = document.getElementById('dash-leave-list');
    leaveListEl.innerHTML = '';
    let leftBehind = 0;
    allSubjects.forEach(sub => {
        if (!tmrwSubjects.has(sub)) {
            leaveListEl.innerHTML += `<li>${sub}</li>`;
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
        const diffTime = new Date(hw.date) - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        if (diffDays <= 3) { // Shows due soon
            hwList.innerHTML += `<li>${hw.task} - Due in ${diffDays} days</li>`;
            urgentHw++;
        }
    });

    if (urgentHw === 0) {
        hwList.innerHTML = '<li class="empty-state">No homework due soon!</li>';
    }
}

// --- Action Bindings ---

// Settings setup
document.getElementById('save-school-setup').addEventListener('click', () => {
    appState.settings.totalDays = document.getElementById('total-days').value;
    appState.settings.currentDayOrder = document.getElementById('current-day-order').value;
    saveState();
    alert('School Setup Updated!');
});

document.getElementById('save-uniforms-btn').addEventListener('click', () => {
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        const input = document.getElementById(`uniform-day-${i}`);
        if(input) {
            appState.uniforms[i] = input.value;
        }
    }
    saveState();
    alert('Uniforms Saved!');
});

// Timetable setup
document.getElementById('save-timetable-btn').addEventListener('click', () => {
    for (let i = 1; i <= appState.settings.totalDays; i++) {
        let subs = [];
        document.querySelectorAll(`.day-${i}-sub`).forEach(input => {
            subs.push(input.value);
        });
        appState.timetable[i] = subs;
    }
    saveState();
    alert('Timetable Saved!');
});

// Homework setup
document.getElementById('homework-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const hw = {
        task: document.getElementById('hw-task').value,
        subject: document.getElementById('hw-subject').value,
        date: document.getElementById('hw-deadline').value
    };
    appState.homework.push(hw);
    
    // Clear inputs
    document.getElementById('hw-task').value = '';
    document.getElementById('hw-subject').value = '';
    document.getElementById('hw-deadline').value = '';
    
    saveState();
});

window.completeHomework = function(index) {
    appState.homework.splice(index, 1);
    saveState();
}

// --- Theme Toggle Logic ---
function applyTheme() {
    const theme = appState.settings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
}

document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    appState.settings.theme = appState.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveState();
});

// Initialize application
applyTheme();
// Force-fix for Monday June 1st migration if they hit the Day Order 3 bug
if (new Date().toDateString() === 'Mon Jun 01 2026' && !localStorage.getItem('procrastinote_june1_fixed')) {
    appState.settings.currentDayOrder = 1;
    appState.settings.lastUpdatedDate = 'Mon Jun 01 2026';
    localStorage.setItem('procrastinote_june1_fixed', 'true');
    saveState();
}

if (updateDayOrderIfNeeded()) {
    saveState();
} else {
    renderAllViews();
}
