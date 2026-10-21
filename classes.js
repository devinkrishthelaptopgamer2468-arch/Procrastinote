// --- Classes and activity groups ---
// Join your class with its code, import the class timetable, get class homework added to your
// list, chat (a General chat plus invite-only chats), share files, and start activity groups
// that people from other classes can join. Everything lives in Supabase (supabase/add-classes.sql),
// whose rules decide what each person can see and do; this file only shows it.
// Loaded before school-app.js and uses its globals when called: cloud, appState, saveState,
// escapeHTML, showConfirm, timeAgo, parseDay, formatDateString, isOnlineAccount, SUBJECT_LIST,
// renderNotifications, closeNotifications. school-app.js calls window.Classes.
(function () {
    'use strict';

    const SITE_OWNER_EMAIL = 'devinthegamer2468@gmail.com'; // same as is_site_owner() in add-classes.sql
    const SCHOOL_NAME = 'Heartfulness International School, Kolapakkam';
    const BUCKET = 'class-files';
    const FILE_MAX_BYTES = 10 * 1024 * 1024;
    const GROUP_MAX_BYTES = 100 * 1024 * 1024;
    const FILE_TYPES = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
        pdf: 'application/pdf', txt: 'text/plain',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
    const UNIFORMS = ['Regular Uniform', 'Sports Uniform'];
    const SIZES = {
        small: { label: 'Small', max: 5, points: 1 },
        big: { label: 'Big', max: 20, points: 2 }
    };
    const ACTIVITY_POINTS = 6;
    const MAX_PRIVATE_CHATS = 15;
    const NOTIF_LIMIT = 30;
    const HOMEWORK_NOTIF_DAYS = 14;

    const ICONS = {
        lock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
        send: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10 14M21 3l-6.5 18-4-8-8-4z"/></svg>',
        copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
        upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
        shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/></svg>'
    };

    const freshState = () => ({
        started: false,
        loadedAt: 0,
        missingSetup: false,
        channel: null,
        classes: [],           // classes I'm in: table row + myRole
        activities: [],        // activity groups I'm in: table row + myRole
        classActivities: [],   // every activity started from a class I'm an admin of
        members: {},           // 'class:<id>' / 'activity:<id>' -> [{ user_id, name, email, class, role }]
        chats: [],             // every chat I can see
        chatMembers: {},       // chat id -> [user ids] (private chats I'm in)
        messages: {},          // chat id -> rows, oldest first
        loadedChats: new Set(),
        homework: {},          // class id -> rows
        files: {},             // group key -> rows, newest first
        requests: {},          // class id -> pending co-admin / hand-over requests
        inbox: null,           // site owner: waiting classes, requests, reports, every group
        recentMessages: [],    // newest messages from others, for Notifications
        selected: null,        // { kind: 'class' | 'activity' | 'inbox', id }
        tabs: {},              // group key -> open tab
        activeChat: {},        // group key -> open chat id
        ping: null,            // @ suggestions while typing: { options, index, start, end }
        botTyping: null,       // chat id where Procrasti-Bot is writing a reply
        uploading: false
    });
    const state = freshState();
    let reloadTimer = null;

    // ---------- Small helpers ----------
    const online = () => typeof isOnlineAccount === 'function' && isOnlineAccount();
    const myId = () => appState.user?.cloudId;
    const isSiteOwner = () => (appState.user?.email || '').toLowerCase() === SITE_OWNER_EMAIL;
    const keyOf = (kind, id) => `${kind}:${id}`;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const findClass = id => state.classes.find(c => c.id === id);
    const findActivity = id => state.activities.find(a => a.id === id) || state.classActivities.find(a => a.id === id);
    const isAdminRole = role => role === 'owner' || role === 'admin';
    const classMap = field => {
        if (!appState[field] || typeof appState[field] !== 'object' || Array.isArray(appState[field])) appState[field] = {};
        return appState[field];
    };
    const todayString = () => formatDateString(new Date());
    const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const pluralise = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const peopleCount = n => `${n} ${n === 1 ? 'person' : 'people'}`;
    const extension = name => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

    function sizeText(bytes) {
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function dueText(dateString) {
        return parseDay(dateString).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function messageTime(timestamp) {
        const date = new Date(timestamp);
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (date.toDateString() === new Date().toDateString()) return time;
        return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
    }

    // The tables exist only after add-classes.sql was run in Supabase
    const isMissingSetup = error => /does not exist|PGRST20[25]|42P01|42883|schema cache/i.test(`${error?.code || ''} ${error?.message || ''}`);

    function friendlyError(error) {
        if (isMissingSetup(error)) return 'Classes aren\'t switched on yet. The site owner needs to run supabase/add-classes.sql in Supabase.';
        return error?.message || String(error);
    }

    function memberList(kind, id) {
        return state.members[keyOf(kind, id)] || [];
    }

    // Names of people in any of my groups (for chats and notifications)
    function personName(userId) {
        if (userId === myId()) return appState.user?.name || 'You';
        for (const list of Object.values(state.members)) {
            const person = list.find(m => m.user_id === userId);
            if (person) return person.name || person.email || 'Classmate';
        }
        return 'Someone who left';
    }

    function chatGroup(chat) {
        return chat.class_id ? { kind: 'class', id: chat.class_id } : { kind: 'activity', id: chat.activity_id };
    }

    function chatPlace(chat) {
        if (chat.activity_id) return findActivity(chat.activity_id)?.name || 'Activity';
        return `${findClass(chat.class_id)?.name || 'Class'} · ${chat.name}`;
    }

    function chatsFor(kind, id) {
        return state.chats
            .filter(c => (kind === 'class' ? c.class_id === id : c.activity_id === id))
            .sort((a, b) => (a.kind === 'general' ? -1 : b.kind === 'general' ? 1 : a.name.localeCompare(b.name)));
    }

    function canUseChat(chat) {
        if (chat.kind !== 'private') return true;
        return (state.chatMembers[chat.id] || []).includes(myId());
    }

    function myPoints() {
        return state.activities
            .filter(a => a.owner_id === myId() && a.status !== 'rejected')
            .reduce((sum, a) => sum + (SIZES[a.size]?.points || 1), 0);
    }

    // Live updates and normal loads can write the same time differently
    // ("2026-10-20 05:54:28.1+00" vs "2026-10-20T05:54:28.1+00:00"), so compare the moment itself
    function sameMoment(a, b) {
        const ms = v => Date.parse(String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
        return ms(a) === ms(b) || a === b;
    }

    function timetableOutdated(cls) {
        const imported = (appState.classTimetableImported || {})[cls.id];
        return !!(imported && cls.timetable_updated_at && !sameMoment(imported, cls.timetable_updated_at));
    }

    // ---------- Loading ----------
    async function loadMembers(kind, id) {
        const { data, error } = await cloud.rpc(kind === 'class' ? 'get_class_members' : 'get_activity_members',
            kind === 'class' ? { p_class: id } : { p_activity: id });
        if (error) {
            console.error('Could not load members:', error.message);
            return;
        }
        state.members[keyOf(kind, id)] = data || [];
    }

    async function loadHomework(classId) {
        const { data, error } = await cloud.from('class_homework')
            .select('*')
            .eq('class_id', classId)
            .order('due_date', { ascending: true })
            .limit(1000);
        if (error) {
            console.error('Could not load class homework:', error.message);
            return;
        }
        state.homework[classId] = data || [];
        syncHomework(classId);
    }

    async function loadChats() {
        const { data, error } = await cloud.from('chats').select('*').order('created_at');
        if (error) {
            console.error('Could not load chats:', error.message);
            return;
        }
        state.chats = data || [];
        const ids = state.chats.filter(c => c.kind === 'private').map(c => c.id);
        state.chatMembers = {};
        if (ids.length) {
            const res = await cloud.from('chat_members').select('chat_id, user_id').in('chat_id', ids);
            (res.data || []).forEach(row => {
                (state.chatMembers[row.chat_id] = state.chatMembers[row.chat_id] || []).push(row.user_id);
            });
        }
    }

    // Newest messages from others, plus older ones that pinged you (so a ping isn't pushed out)
    async function loadRecentMessages() {
        const columns = 'id, chat_id, sender_id, text, mentions, bot, created_at';
        const [recent, pings] = await Promise.all([
            cloud.from('group_messages').select(columns).neq('sender_id', myId())
                .order('created_at', { ascending: false }).limit(20),
            cloud.from('group_messages').select(columns).contains('mentions', [myId()])
                .order('created_at', { ascending: false }).limit(10)
        ]);
        if (recent.error) return;
        const rows = recent.data.concat(pings.error ? [] : pings.data.filter(p => !recent.data.some(r => r.id === p.id)));
        state.recentMessages = rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }

    async function loadInbox() {
        if (!isSiteOwner()) return;
        const { data, error } = await cloud.rpc('site_admin_inbox');
        if (error) {
            console.error('Could not load the approval list:', error.message);
            return;
        }
        state.inbox = data;
    }

    async function loadFiles(kind, id) {
        const { data, error } = await cloud.from('group_files')
            .select('*')
            .eq(kind === 'class' ? 'class_id' : 'activity_id', id)
            .order('created_at', { ascending: false });
        if (!error) state.files[keyOf(kind, id)] = data || [];
    }

    async function loadRequests(classId) {
        const { data, error } = await cloud.from('class_requests')
            .select('*')
            .eq('class_id', classId)
            .eq('status', 'pending')
            .order('created_at');
        if (!error) state.requests[classId] = data || [];
    }

    async function loadMessages(chatId) {
        state.loadedChats.add(chatId);
        const { data, error } = await cloud.from('group_messages')
            .select('*')
            .eq('chat_id', chatId)
            .order('created_at', { ascending: false })
            .limit(300);
        if (error) {
            state.loadedChats.delete(chatId);
            console.error('Could not load messages:', error.message);
            return;
        }
        state.messages[chatId] = (data || []).reverse();
        renderMessages(chatId);
    }

    // Everything about my classes and activity groups
    async function loadAll() {
        if (!online() || !state.started) return;
        state.loadedAt = Date.now();
        const me = myId();
        const [classRes, activityRes] = await Promise.all([
            cloud.from('class_members').select('role, classes(*)').eq('user_id', me),
            cloud.from('activity_members').select('role, activities(*)').eq('user_id', me)
        ]);
        if (classRes.error || activityRes.error) {
            const error = classRes.error || activityRes.error;
            state.missingSetup = isMissingSetup(error);
            if (!state.missingSetup) console.error('Could not load classes:', error.message);
            render();
            return;
        }
        state.missingSetup = false;
        state.classes = classRes.data.filter(r => r.classes).map(r => ({ ...r.classes, myRole: r.role })).sort(byName);
        state.activities = activityRes.data.filter(r => r.activities).map(r => ({ ...r.activities, myRole: r.role })).sort(byName);

        const adminClassIds = state.classes.filter(c => isAdminRole(c.myRole)).map(c => c.id);
        state.classActivities = [];
        if (adminClassIds.length) {
            const res = await cloud.from('activities').select('*').in('class_id', adminClassIds).order('created_at', { ascending: false });
            state.classActivities = res.data || [];
        }

        await Promise.all([
            ...state.classes.map(c => loadMembers('class', c.id)),
            ...state.activities.map(a => loadMembers('activity', a.id)),
            ...state.classes.filter(c => c.status === 'approved').map(c => loadHomework(c.id)),
            ...state.classes.filter(c => c.myRole === 'owner' || c.myRole === 'admin').map(c => loadRequests(c.id)),
            loadChats(),
            loadRecentMessages(),
            loadInbox()
        ]);

        if (state.selected && state.selected.kind !== 'inbox' && !selectedGroup()) state.selected = null;
        const group = selectedGroup();
        if (group && state.selected.kind !== 'inbox') await loadFiles(state.selected.kind, group.id);
        render();
        renderNotifications();
    }

    // Many live changes can arrive at once; reload a moment later, once
    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(loadAll, 600);
    }

    // ---------- Live updates ----------
    function onMessage(payload) {
        if (payload.eventType === 'DELETE') {
            const id = payload.old?.id;
            Object.keys(state.messages).forEach(chatId => {
                const before = state.messages[chatId].length;
                state.messages[chatId] = state.messages[chatId].filter(m => m.id !== id);
                if (state.messages[chatId].length !== before) renderMessages(chatId);
            });
            state.recentMessages = state.recentMessages.filter(m => m.id !== id);
            renderNotifications();
            return;
        }
        if (payload.eventType !== 'INSERT') return;
        const row = payload.new;
        if (state.loadedChats.has(row.chat_id)) addMessage(row);
        if (row.sender_id !== myId()) {
            if (!state.recentMessages.some(m => m.id === row.id)) state.recentMessages.unshift(row);
            state.recentMessages = state.recentMessages.slice(0, 20);
            // A chat I was just added to, or someone who just joined: fetch the new lists
            const knownSender = Object.values(state.members).some(list => list.some(m => m.user_id === row.sender_id));
            if (!state.chats.some(c => c.id === row.chat_id) || !knownSender) scheduleReload();
            if (isReadingChat(row.chat_id)) markClassesSeen(Date.parse(row.created_at));
            else {
                const chat = state.chats.find(c => c.id === row.chat_id);
                showPhoneNotification('classes', {
                    title: chat ? chatPlace(chat) : 'Class chat',
                    body: `${personName(row.sender_id)}: ${row.text}`,
                    url: '/#open=classes',
                    tag: `class-chat-${row.chat_id}`
                });
            }
            renderNotifications();
        }
    }

    function onHomework(payload) {
        if (payload.eventType === 'DELETE') {
            const id = payload.old?.id;
            Object.keys(state.homework).forEach(classId => {
                const before = state.homework[classId].length;
                state.homework[classId] = state.homework[classId].filter(h => h.id !== id);
                if (state.homework[classId].length !== before) syncHomework(classId);
            });
        } else {
            const row = payload.new;
            const list = state.homework[row.class_id] = state.homework[row.class_id] || [];
            const at = list.findIndex(h => h.id === row.id);
            if (at === -1 && payload.eventType === 'INSERT' && row.created_by !== myId()) {
                showPhoneNotification('classes', {
                    title: `New homework · ${findClass(row.class_id)?.name || 'Class'}`,
                    body: `${row.subject}: ${row.task} (due ${row.due_date})`,
                    url: '/#open=classes',
                    tag: `class-homework-${row.class_id}`
                });
            }
            if (at === -1) list.push(row);
            else list[at] = row;
            list.sort((a, b) => a.due_date.localeCompare(b.due_date));
            syncHomework(row.class_id);
        }
        renderDetail();
        renderNotifications();
    }

    function onFile(payload) {
        if (payload.eventType === 'DELETE') {
            const id = payload.old?.id;
            Object.keys(state.files).forEach(key => { state.files[key] = state.files[key].filter(f => f.id !== id); });
        } else if (payload.eventType === 'INSERT') {
            const row = payload.new;
            const key = row.class_id ? keyOf('class', row.class_id) : keyOf('activity', row.activity_id);
            if (state.files[key] && !state.files[key].some(f => f.id === row.id)) state.files[key].unshift(row);
        }
        renderDetail();
    }

    function onClassChange(payload) {
        if (payload.eventType === 'UPDATE') {
            const row = payload.new;
            const at = state.classes.findIndex(c => c.id === row.id);
            if (at !== -1) {
                const approvedNow = state.classes[at].status !== 'approved' && row.status === 'approved';
                state.classes[at] = { ...row, myRole: state.classes[at].myRole };
                if (approvedNow) loadHomework(row.id);
                render();
                renderNotifications();
            }
        } else {
            scheduleReload();
        }
        if (isSiteOwner()) loadInbox().then(renderDetail);
    }

    function startLive() {
        if (state.channel) return;
        state.channel = cloud.channel('classes-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'group_messages' }, onMessage)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'class_homework' }, onHomework)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'group_files' }, onFile)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, onClassChange)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, scheduleReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, scheduleReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'class_requests' }, scheduleReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reports' },
                () => { if (isSiteOwner()) loadInbox().then(() => { renderList(); renderDetail(); renderNotifications(); }); })
            .subscribe();
    }

    // ---------- Class homework: copies in your own Homework list ----------
    // With "Follow class homework" on, each class homework becomes a normal homework item
    // (id chw_<class homework id>). Until you tick it done it follows the admin's edits and
    // disappears if they delete it. classHomeworkAdded remembers what was already added, so
    // homework you finished doesn't come back.
    function syncHomework(classId) {
        const list = state.homework[classId];
        if (!list || !(appState.classFollow || {})[classId]) return;
        // Right after logging in, wait for this account's planner to arrive from other devices,
        // or loading it would undo the copies added here
        if (cloud && typeof plannerReady !== 'undefined' && !plannerReady) {
            clearTimeout(syncHomework.retry);
            syncHomework.retry = setTimeout(() => Object.keys(state.homework).forEach(syncHomework), 1500);
            return;
        }
        const added = classMap('classHomeworkAdded');
        const today = todayString();
        let changed = false;

        list.forEach(hw => {
            const copyId = `chw_${hw.id}`;
            const copy = appState.homework.find(h => h.id === copyId);
            if (copy) {
                if (copy.task !== hw.task || copy.subject !== hw.subject || copy.date !== hw.due_date) {
                    Object.assign(copy, { task: hw.task, subject: hw.subject, date: hw.due_date });
                    changed = true;
                }
            } else if (!added[hw.id] && hw.due_date >= today) {
                appState.homework.push({ id: copyId, task: hw.task, subject: hw.subject, date: hw.due_date, classId });
                added[hw.id] = classId;
                changed = true;
            }
        });

        const stillThere = new Set(list.map(hw => String(hw.id)));
        const kept = appState.homework.filter(h => !(h.classId === classId && String(h.id).startsWith('chw_') && !stillThere.has(String(h.id).slice(4))));
        if (kept.length !== appState.homework.length) {
            appState.homework = kept;
            changed = true;
        }
        Object.keys(added).forEach(id => {
            if (added[id] === classId && !stillThere.has(id)) {
                delete added[id];
                changed = true;
            }
        });
        if (changed) saveState();
    }

    // ---------- Rendering ----------
    function selectedGroup() {
        const sel = state.selected;
        if (!sel) return null;
        if (sel.kind === 'class') return findClass(sel.id) || null;
        if (sel.kind === 'activity') return state.activities.find(a => a.id === sel.id) || null;
        return null;
    }

    function render() {
        const offline = document.getElementById('classes-offline');
        const layout = document.getElementById('classes-layout');
        if (!offline || !layout) return;
        let message = '';
        if (!cloud) message = 'Classes are on their way. Check back soon.';
        else if (!online()) message = 'Log in to your online account to join your class.';
        else if (state.missingSetup) message = 'Classes aren\'t switched on yet. Check back soon.';
        offline.hidden = !message;
        layout.hidden = !!message;
        document.getElementById('classes-create-btn').hidden = !isSiteOwner();
        document.getElementById('classes-offline-text').innerText = message;
        if (message) return;
        renderList();
        renderDetail();
    }

    function renderList() {
        const listEl = document.getElementById('classes-list');
        if (!listEl) return;
        const sel = state.selected || {};
        let html = '';

        if (isSiteOwner() && state.inbox) {
            const waiting = state.inbox.classes.filter(c => c.status === 'pending').length + state.inbox.requests.length + state.inbox.reports.length;
            html += `
                <button type="button" class="cls-item cls-item-inbox ${sel.kind === 'inbox' ? 'active' : ''}" data-act="select" data-kind="inbox">
                    <span class="cls-item-icon">${ICONS.shield}</span>
                    <span class="cls-item-text"><span class="cls-item-name">Approvals</span><span class="cls-item-sub">Site owner</span></span>
                    ${waiting ? `<span class="cls-count">${waiting}</span>` : ''}
                </button>`;
        }

        html += '<p class="cls-list-title">Your classes</p>';
        if (!state.classes.length) {
            html += '<p class="cls-list-empty">Ask your class admin for your class code and join above.</p>';
        }
        state.classes.forEach(c => {
            const status = c.status === 'pending' ? 'Waiting for approval' : c.status === 'rejected' ? 'Not approved' :
                c.myRole === 'owner' ? 'Owner' : c.myRole === 'admin' ? 'Co-admin' : peopleCount(memberList('class', c.id).length);
            const flag = timetableOutdated(c) ? '<span class="cls-dot" title="Timetable changed"></span>' : '';
            html += `
                <button type="button" class="cls-item ${sel.kind === 'class' && sel.id === c.id ? 'active' : ''}" data-act="select" data-kind="class" data-id="${c.id}">
                    <span class="friend-avatar cls-avatar">${escapeHTML(initials(c.name))}</span>
                    <span class="cls-item-text"><span class="cls-item-name">${escapeHTML(c.name)}</span><span class="cls-item-sub">${escapeHTML(status)}</span></span>
                    ${flag}
                </button>`;
        });

        if (state.activities.length) html += '<p class="cls-list-title">Activity groups</p>';
        state.activities.forEach(a => {
            const status = a.status === 'pending' ? 'Waiting for approval' : a.status === 'rejected' ? 'Not approved' :
                `${SIZES[a.size].label} group · ${memberList('activity', a.id).length}/${SIZES[a.size].max}`;
            html += `
                <button type="button" class="cls-item ${sel.kind === 'activity' && sel.id === a.id ? 'active' : ''}" data-act="select" data-kind="activity" data-id="${a.id}">
                    <span class="friend-avatar cls-avatar cls-avatar-activity">${escapeHTML(initials(a.name))}</span>
                    <span class="cls-item-text"><span class="cls-item-name">${escapeHTML(a.name)}</span><span class="cls-item-sub">${escapeHTML(status)}</span></span>
                </button>`;
        });
        if (html !== listEl._html) {
            const from = listEl._sliderRect;
            listEl._html = html;
            listEl.innerHTML = `<span class="cls-slider cls-list-slider" aria-hidden="true"></span>${html}`;
            listEl._sliderRect = placeSlider(listEl.firstElementChild, listEl.querySelector('.cls-item.active'), from);
        }
    }

    // After a resize, or when the page was hidden while it redrew, put the highlights back in place
    function realignSliders() {
        const listEl = document.getElementById('classes-list');
        if (listEl?.firstElementChild) listEl._sliderRect = placeSlider(listEl.firstElementChild, listEl.querySelector('.cls-item.active'), null);
        const detail = document.getElementById('classes-detail');
        const tabsEl = detail?.querySelector('.cls-tabs');
        if (tabsEl) detail._tabRect = placeSlider(tabsEl.querySelector('.cls-slider'), tabsEl.querySelector('.cls-tab.active'), null);
    }

    // Typed text, cursor and chat scroll survive a redraw
    function keepInputs(container, draw) {
        const kept = {};
        container.querySelectorAll('[data-keep]').forEach(el => { kept[el.id] = el.value; });
        const focused = document.activeElement?.closest?.('#classes-detail') ? document.activeElement : null;
        const caret = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
        const messagesEl = container.querySelector('.cls-messages');
        const nearBottom = !messagesEl || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
        const scrollTop = messagesEl?.scrollTop;
        draw();
        Object.entries(kept).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        });
        const refocus = focused?.id && document.getElementById(focused.id);
        if (refocus) {
            refocus.focus();
            if (caret) try { refocus.setSelectionRange(caret[0], caret[1]); } catch (e) { /* date inputs have no caret */ }
        }
        const newMessages = container.querySelector('.cls-messages');
        if (newMessages) newMessages.scrollTop = nearBottom || scrollTop === undefined ? newMessages.scrollHeight : scrollTop;
    }

    function detailHtml() {
        const sel = state.selected;
        if (sel?.kind === 'inbox' && isSiteOwner()) return inboxHtml();
        if (sel?.kind === 'class' && findClass(sel.id)) return classHtml(findClass(sel.id));
        if (sel?.kind === 'activity' && selectedGroup()) return activityHtml(selectedGroup());
        return `
            <div class="chat-empty-state cls-empty">
                <span class="tile-icon tint-indigo tile-icon-lg"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 5l9 4.5-9 4.5z"/><path d="M7 11.5v4.5c1.5 1.3 3.2 2 5 2s3.5-.7 5-2v-4.5M21 9.5V15"/></svg></span>
                <p>${state.classes.length ? 'Pick a class or activity group.' : 'Join your class with the code your class admin gives you.'}</p>
            </div>`;
    }

    function renderDetail() {
        const detail = document.getElementById('classes-detail');
        if (!detail) return;
        const html = detailHtml();
        // Redraw only when something changed, so typing and scrolling aren't disturbed
        if (html !== detail._html) {
            const before = detail._view || { key: '' };
            const now = viewOf();
            detail._html = html;
            keepInputs(detail, () => { detail.innerHTML = `<div class="cls-view">${html}</div>`; });
            detail._view = now;
            animateDetail(detail, before, now);
        }
        const chatId = currentChatId();
        if (chatId && canUseChat(state.chats.find(c => c.id === chatId) || {}) && !state.loadedChats.has(chatId)) loadMessages(chatId);
    }

    function statusChip(status) {
        if (status === 'pending') return '<span class="cls-chip cls-chip-wait">Waiting for approval</span>';
        if (status === 'rejected') return '<span class="cls-chip cls-chip-no">Not approved</span>';
        return '';
    }

    function roleChip(role) {
        if (role === 'owner') return '<span class="cls-chip">Owner</span>';
        if (role === 'admin') return '<span class="cls-chip">Co-admin</span>';
        return '';
    }

    function codeHtml(kind, group, canRenew) {
        if (group.status !== 'approved') return '';
        return `
            <div class="cls-code">
                <span class="cls-code-label">${kind === 'class' ? 'Class' : 'Group'} code</span>
                <strong class="cls-code-value">${escapeHTML(group.code)}</strong>
                <button type="button" class="btn secondary-btn btn-sm" data-act="copy-code" data-code="${escapeHTML(group.code)}">${ICONS.copy} Copy</button>
                ${canRenew ? `<button type="button" class="btn ghost-btn btn-sm" data-act="new-code" data-kind="${kind}" data-id="${group.id}">New code</button>` : ''}
            </div>`;
    }

    function tabsHtml(key, tabs, active) {
        return `<div class="cls-tabs" role="tablist"><span class="cls-slider" aria-hidden="true"></span>${tabs.map(([id, label]) =>
            `<button type="button" role="tab" aria-selected="${id === active}" class="cls-tab ${id === active ? 'active' : ''}" data-act="tab" data-key="${key}" data-tab="${id}">${label}</button>`
        ).join('')}</div>`;
    }

    // ---------- Motion: the highlight slides to the picked tab or class, and the new content
    // slides in from the side it's on (tabs sideways, classes up or down) ----------
    const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Moves a highlight (.cls-slider) over `target`. `from` is where it was before the redraw.
    function placeSlider(slider, target, from) {
        if (!slider) return;
        if (!target) {
            slider.style.opacity = '0';
            return;
        }
        const to = { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight };
        const apply = r => {
            slider.style.width = `${r.w}px`;
            slider.style.height = `${r.h}px`;
            slider.style.transform = `translate(${r.x}px, ${r.y}px)`;
        };
        slider.style.opacity = '1';
        if (from && !prefersStill()) {
            slider.style.transition = 'none';
            apply(from);
            void slider.offsetWidth; // start from the old spot, then glide
            slider.style.transition = '';
        }
        apply(to);
        return to;
    }

    function slideIn(el, direction) {
        if (!el || !direction || prefersStill()) return;
        el.classList.remove('cls-in-left', 'cls-in-right', 'cls-in-up', 'cls-in-down');
        void el.offsetWidth;
        el.classList.add(`cls-in-${direction}`);
        el.addEventListener('animationend', () => el.classList.remove(`cls-in-${direction}`), { once: true });
    }

    // Order of things in the left list, to know whether the new class is above or below
    function listOrder(sel) {
        if (!sel) return -1;
        if (sel.kind === 'inbox') return -1;
        const items = [...state.classes.map(c => keyOf('class', c.id)), ...state.activities.map(a => keyOf('activity', a.id))];
        return items.indexOf(keyOf(sel.kind, sel.id));
    }

    function viewOf() {
        const sel = state.selected;
        if (!sel) return { key: '', tab: '', order: -2 };
        if (sel.kind === 'inbox') return { key: 'inbox', tab: '', order: -1 };
        const key = keyOf(sel.kind, sel.id);
        return { key, tab: state.tabs[key] || (sel.kind === 'class' ? 'chats' : 'chat'), order: listOrder(sel) };
    }

    function animateDetail(detail, before, now) {
        const tabsEl = detail.querySelector('.cls-tabs');
        const activeTab = tabsEl?.querySelector('.cls-tab.active');
        const sameGroup = before.key === now.key;
        detail._tabRect = placeSlider(tabsEl?.querySelector('.cls-slider'), activeTab, sameGroup ? detail._tabRect : null);
        if (sameGroup && before.tab && before.tab !== now.tab && tabsEl) {
            const order = [...tabsEl.querySelectorAll('.cls-tab')].map(t => t.dataset.tab);
            slideIn(detail.querySelector('.cls-pane'), order.indexOf(now.tab) > order.indexOf(before.tab) ? 'right' : 'left');
        } else if (!sameGroup && before.key) {
            slideIn(detail.querySelector('.cls-view'), now.order >= before.order ? 'down' : 'up');
        }
    }

    function classHtml(cls) {
        const key = keyOf('class', cls.id);
        const admin = isAdminRole(cls.myRole);
        const people = memberList('class', cls.id).length;
        let html = `
            <header class="cls-head">
                <div class="cls-head-main">
                    <h3>${escapeHTML(cls.name)}</h3>
                    <p class="cls-head-sub">${escapeHTML(cls.school || SCHOOL_NAME)} · ${peopleCount(people)}</p>
                </div>
                <div class="cls-head-chips">${roleChip(cls.myRole)}${statusChip(cls.status)}</div>
            </header>
            ${codeHtml('class', cls, admin)}`;

        if (cls.status !== 'approved') {
            html += cls.status === 'pending'
                ? '<p class="cls-banner">The Procrastinote team checks every new class. Once it\'s approved you\'ll see its join code here to share with your classmates.</p>'
                : '<p class="cls-banner cls-banner-no">This class wasn\'t approved. You can delete it and create it again with a clearer name, like "Grade 8 B".</p>';
            if (cls.myRole === 'owner' || isSiteOwner()) {
                html += '<div class="cls-actions"><button type="button" class="btn danger-btn btn-sm" data-act="delete-group" data-kind="class">Delete class</button></div>';
            }
            return html;
        }

        const tabs = [['chats', 'Chats'], ['homework', 'Homework'], ['timetable', 'Timetable'], ['files', 'Files'], ['people', 'People'], ['activities', 'Activities']];
        const tab = state.tabs[key] || 'chats';
        html += tabsHtml(key, tabs, tab);
        let pane = '';
        if (tab === 'chats') pane = classChatsHtml(cls);
        else if (tab === 'homework') pane = homeworkHtml(cls);
        else if (tab === 'timetable') pane = timetableHtml(cls);
        else if (tab === 'files') pane = filesHtml('class', cls, admin);
        else if (tab === 'people') pane = peopleHtml('class', cls);
        else if (tab === 'activities') pane = classActivitiesHtml(cls);
        return `${html}<div class="cls-pane">${pane}</div>`;
    }

    function activityHtml(activity) {
        const key = keyOf('activity', activity.id);
        const size = SIZES[activity.size] || SIZES.small;
        const people = memberList('activity', activity.id).length;
        const homeClass = findClass(activity.class_id);
        const manager = activity.owner_id === myId() || isAdminRole(homeClass?.myRole) || isSiteOwner();
        let html = `
            <header class="cls-head">
                <div class="cls-head-main">
                    <h3>${escapeHTML(activity.name)}</h3>
                    <p class="cls-head-sub">${size.label} group · ${people} of ${size.max} people${homeClass ? ` · from ${escapeHTML(homeClass.name)}` : ''}</p>
                </div>
                <div class="cls-head-chips">${activity.owner_id === myId() ? '<span class="cls-chip">Started by you</span>' : ''}${statusChip(activity.status)}</div>
            </header>
            ${codeHtml('activity', activity, manager)}`;

        if (activity.status !== 'approved') {
            html += activity.status === 'pending'
                ? '<p class="cls-banner">An admin of the class you started it from needs to approve it. Then you\'ll get a code to share, even with people from other classes.</p>'
                : '<p class="cls-banner cls-banner-no">A class admin didn\'t approve this activity group.</p>';
            if (manager) html += '<div class="cls-actions"><button type="button" class="btn danger-btn btn-sm" data-act="delete-group" data-kind="activity">Delete activity group</button></div>';
            return html;
        }

        const tab = state.tabs[key] || 'chat';
        html += tabsHtml(key, [['chat', 'Chat'], ['files', 'Files'], ['people', 'People']], tab);
        let pane;
        if (tab === 'chat') {
            const chat = chatsFor('activity', activity.id)[0];
            pane = chat ? chatPaneHtml(chat, manager) : '<p class="cls-hint">This group\'s chat is loading...</p>';
        } else if (tab === 'files') {
            pane = filesHtml('activity', activity, manager);
        } else {
            pane = peopleHtml('activity', activity);
        }
        return `${html}<div class="cls-pane">${pane}</div>`;
    }

    function currentChatId() {
        const sel = state.selected;
        if (!sel || sel.kind === 'inbox') return null;
        const key = keyOf(sel.kind, sel.id);
        if (sel.kind === 'class') {
            if ((state.tabs[key] || 'chats') !== 'chats') return null;
            const chats = chatsFor('class', sel.id);
            const chosen = chats.find(c => c.id === state.activeChat[key]);
            return (chosen || chats[0])?.id || null;
        }
        if ((state.tabs[key] || 'chat') !== 'chat') return null;
        return chatsFor('activity', sel.id)[0]?.id || null;
    }

    function classChatsHtml(cls) {
        const chats = chatsFor('class', cls.id);
        const activeId = currentChatId();
        const privateCount = chats.filter(c => c.kind === 'private').length;
        const madeOne = chats.some(c => c.kind === 'private' && c.created_by === myId());
        const canMake = !madeOne && privateCount < MAX_PRIVATE_CHATS;
        let html = '<div class="cls-chat-pills">';
        chats.forEach(chat => {
            const usable = canUseChat(chat);
            html += `<button type="button" class="cls-pill ${chat.id === activeId ? 'active' : ''} ${usable ? '' : 'cls-pill-out'}" data-act="open-chat" data-chat="${chat.id}">
                ${chat.kind === 'private' ? ICONS.lock : ''}${escapeHTML(chat.name)}</button>`;
        });
        html += `<button type="button" class="cls-pill cls-pill-new" data-act="new-chat" ${canMake ? '' : `title="${madeOne ? 'You already made a chat in this class' : 'This class has 15 chats already'}"`}>+ New chat</button>`;
        html += '</div>';
        const chat = chats.find(c => c.id === activeId);
        html += chat ? chatPaneHtml(chat, isAdminRole(cls.myRole)) : '<p class="cls-hint">Loading chats...</p>';
        return html;
    }

    // ---------- Pings: @Name notifies someone, @Procrasti-Bot asks the AI helper ----------
    const BOT_NAME = 'Procrasti-Bot';
    const BOT_PING = /@procrasti[- ]?bot\b/i;
    const regexSafe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Everyone who can read this chat (the people you can ping in it)
    function chatPeople(chat) {
        if (!chat) return [];
        if (chat.activity_id) return memberList('activity', chat.activity_id);
        const all = memberList('class', chat.class_id);
        if (chat.kind !== 'private') return all;
        const ids = state.chatMembers[chat.id] || [];
        return all.filter(m => ids.includes(m.user_id));
    }

    function mentionsIn(chat, text) {
        const lower = text.toLowerCase();
        return chatPeople(chat)
            .filter(m => m.user_id !== myId() && m.name && lower.includes(`@${m.name.toLowerCase()}`))
            .map(m => m.user_id)
            .slice(0, 20);
    }

    // Message text with each @ping highlighted (yours stands out more)
    function messageTextHtml(m) {
        const pings = (m.mentions || []).map(id => ({ name: personName(id), me: id === myId() }))
            .filter(p => p.name && p.name !== 'Someone who left');
        pings.push({ name: BOT_NAME, me: false });
        pings.sort((a, b) => b.name.length - a.name.length); // "Asha Kumar" before "Asha"
        const text = escapeHTML(m.text);
        const pattern = new RegExp(`@(${pings.map(p => regexSafe(escapeHTML(p.name))).join('|')})`, 'gi');
        return text.replace(pattern, (match, name) => {
            const me = pings.some(p => p.me && escapeHTML(p.name).toLowerCase() === name.toLowerCase());
            return `<span class="cls-ping${me ? ' cls-ping-me' : ''}">${match}</span>`;
        });
    }

    function pingListHtml() {
        const ping = state.ping;
        if (!ping?.options.length) return '';
        return ping.options.map((o, i) => `
            <button type="button" role="option" aria-selected="${i === ping.index}" class="cls-ping-option${i === ping.index ? ' active' : ''}" data-act="ping-pick" data-index="${i}">
                <span class="friend-avatar cls-msg-avatar${o.bot ? ' cls-bot-avatar' : ''}">${o.bot ? 'PB' : escapeHTML(initials(o.name))}</span>
                <span><strong>${escapeHTML(o.name)}</strong><small>${escapeHTML(o.sub)}</small></span>
            </button>`).join('');
    }

    // Typing "@" (and the start of a name) shows who you can ping
    function updatePingList(input) {
        const list = document.getElementById('cls-ping-list');
        if (!list) return;
        const caret = input.selectionStart ?? input.value.length;
        const match = /(^|\s)@([^@\n]{0,30})$/.exec(input.value.slice(0, caret));
        const chat = state.chats.find(c => c.id === input.form?.dataset.chat);
        let options = [];
        if (match && chat) {
            const query = match[2].toLowerCase();
            const fits = name => name.toLowerCase().startsWith(query) || name.toLowerCase().split(/\s+/).some(w => w.startsWith(query));
            options = [{ id: 'bot', name: BOT_NAME, sub: 'AI helper: ask it anything', bot: true }]
                .concat(chatPeople(chat).filter(m => m.user_id !== myId() && m.name)
                    .map(m => ({ id: m.user_id, name: m.name, sub: m.email })))
                .filter(o => fits(o.name))
                .slice(0, 6);
        }
        state.ping = options.length ? { options, index: 0, start: caret - match[2].length - 1, end: caret } : null;
        list.innerHTML = pingListHtml();
        list.hidden = !state.ping;
    }

    function pickPing(index) {
        const input = document.getElementById('cls-chat-input');
        const ping = state.ping;
        if (!input || !ping?.options[index]) return;
        const insert = `@${ping.options[index].name} `;
        input.value = input.value.slice(0, ping.start) + insert + input.value.slice(ping.end);
        const caret = ping.start + insert.length;
        input.focus();
        input.setSelectionRange(caret, caret);
        closePingList();
    }

    function closePingList() {
        state.ping = null;
        const list = document.getElementById('cls-ping-list');
        if (list) {
            list.hidden = true;
            list.innerHTML = '';
        }
    }

    // Procrasti-Bot answers in the chat. The reply is written on the device of the person who
    // pinged it, with their AI key (only their message is sent to the AI, not the rest of the chat).
    // Without a key it answers with one of its built-in study tips.
    async function askBot(chatId, text) {
        const buddy = typeof AI_BUDDIES !== 'undefined' ? AI_BUDDIES.find(b => b.id === 'procrasti-bot') : null;
        const question = text.replace(BOT_PING, '').trim() || 'Hi!';
        state.botTyping = chatId;
        renderMessages(chatId);
        let reply = '';
        try {
            if (typeof getGroqKey === 'function' && (await getGroqKey()).startsWith('gsk_')) {
                reply = await callGroq(
                    `${(appState.user?.name || 'A student').split(' ')[0]} asked in their class group chat: "${question}"`,
                    `${buddy?.systemPrompt || 'You are Procrasti-Bot, a friendly study helper.'} You are answering in a class group chat at ${SCHOOL_NAME}, so classmates read your reply too. You may help with study questions. Keep it to 1-3 short sentences, kind and suitable for school.`
                );
            }
        } catch (e) {
            reply = '';
        }
        if (!reply || /API Error|brain right now|API key|empty response/i.test(reply)) {
            const tips = buddy?.offlineResponses || ['You\'ve got this! Start with one small step right now.'];
            reply = tips[Math.floor(Math.random() * tips.length)];
        }
        const { data, error } = await cloud.from('group_messages')
            .insert({ chat_id: chatId, sender_id: myId(), text: reply.trim().slice(0, 2000), bot: true })
            .select()
            .single();
        state.botTyping = null;
        if (error) {
            renderMessages(chatId);
            alert(`Procrasti-Bot couldn't answer: ${friendlyError(error)}`);
            return;
        }
        addMessage(data);
    }

    function chatPaneHtml(chat, moderator) {
        if (!canUseChat(chat)) {
            return `
                <div class="cls-chat-out">
                    <p><strong>${escapeHTML(chat.name)}</strong> is an invite-only chat made by ${escapeHTML(personName(chat.created_by))}. You're not in it, so you can't read it.</p>
                    ${moderator ? '<p class="cls-hint">As an admin you can delete it if nobody uses it, which frees one of the 15 chat spaces.</p>' +
                        `<button type="button" class="btn danger-btn btn-sm" data-act="chat-delete" data-chat="${chat.id}">Delete chat</button>` : ''}
                </div>`;
        }
        let head = '';
        if (chat.kind === 'private') {
            const people = (state.chatMembers[chat.id] || []).length;
            const mine = chat.created_by === myId();
            head = `
                <div class="cls-chat-head">
                    <span>${ICONS.lock}<strong>${escapeHTML(chat.name)}</strong> · ${people} ${people === 1 ? 'person' : 'people'}${mine ? '' : ` · made by ${escapeHTML(personName(chat.created_by))}`}</span>
                    <span class="cls-chat-head-actions">
                        ${mine ? `<button type="button" class="btn ghost-btn btn-sm" data-act="chat-people" data-chat="${chat.id}">Who's in it</button>` : `<button type="button" class="btn ghost-btn btn-sm" data-act="chat-leave" data-chat="${chat.id}">Leave</button>`}
                        ${mine || moderator ? `<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="chat-delete" data-chat="${chat.id}">Delete</button>` : ''}
                    </span>
                </div>`;
        }
        return `
            <div class="cls-chat" data-chat="${chat.id}">
                ${head}
                <div class="cls-messages chat-messages-container" id="cls-messages" data-moderator="${moderator ? 1 : 0}">${messagesHtml(chat.id, moderator)}</div>
                <form class="chat-input-wrapper cls-chat-form" data-form="send" data-chat="${chat.id}">
                    <div id="cls-ping-list" class="cls-ping-list" role="listbox" aria-label="People to ping" ${state.ping ? '' : 'hidden'}>${pingListHtml()}</div>
                    <input type="text" id="cls-chat-input" data-keep maxlength="2000" placeholder="Message ${escapeHTML(chat.kind === 'activity' ? 'the group' : chat.name)} · @ to ping" autocomplete="off" aria-label="Message">
                    <button type="submit" class="btn primary-btn icon-btn-large" aria-label="Send message">${ICONS.send}</button>
                </form>
            </div>`;
    }

    function messagesHtml(chatId, moderator) {
        if (!state.loadedChats.has(chatId) || !state.messages[chatId]) {
            return '<div class="chat-empty-state"><p>Loading messages...</p></div>';
        }
        const list = state.messages[chatId];
        const typing = state.botTyping === chatId ? `
            <div class="chat-msg-bubble-wrapper incoming cls-msg">
                <div class="friend-avatar cls-msg-avatar cls-bot-avatar">PB</div>
                <div class="cls-msg-body"><span class="cls-msg-name">${BOT_NAME}</span>
                    <div class="chat-msg-bubble cls-bot-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
            </div>` : '';
        if (!list.length && !typing) return '<div class="chat-empty-state"><p>No messages yet. Say hello! 👋</p></div>';
        return list.map(m => {
            const sentByMe = m.sender_id === myId();
            const mine = sentByMe && !m.bot; // bot replies always show on the left
            const name = m.bot ? BOT_NAME : personName(m.sender_id);
            const pingsMe = !sentByMe && (m.mentions || []).includes(myId());
            const actions = [
                sentByMe || moderator ? `<button type="button" data-act="msg-delete" data-msg="${m.id}">Delete</button>` : '',
                sentByMe ? '' : `<button type="button" data-act="msg-report" data-msg="${m.id}">Report</button>`
            ].join('');
            const label = m.bot ? `${BOT_NAME} <small>· asked by ${escapeHTML(sentByMe ? 'you' : personName(m.sender_id))}</small>` : escapeHTML(name);
            return `
                <div class="chat-msg-bubble-wrapper ${mine ? 'outgoing' : 'incoming'} cls-msg${pingsMe ? ' cls-pinged' : ''}${m.bot ? ' cls-bot-msg' : ''}">
                    <div class="friend-avatar cls-msg-avatar${m.bot ? ' cls-bot-avatar' : ''}">${m.bot ? 'PB' : escapeHTML(initials(name))}</div>
                    <div class="cls-msg-body">
                        ${mine ? '' : `<span class="cls-msg-name">${label}</span>`}
                        <div class="chat-msg-bubble">
                            <div>${messageTextHtml(m)}</div>
                            <span class="chat-msg-time">${escapeHTML(messageTime(Date.parse(m.created_at)))}</span>
                        </div>
                        <div class="cls-msg-actions">${actions}</div>
                    </div>
                </div>`;
        }).join('') + typing;
    }

    // Update only the message list, so typing isn't interrupted
    function renderMessages(chatId) {
        const box = document.getElementById('cls-messages');
        if (!box || box.closest('.cls-chat')?.dataset.chat !== chatId) return;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.innerHTML = messagesHtml(chatId, box.dataset.moderator === '1');
        if (nearBottom || !box.dataset.scrolled) {
            box.scrollTop = box.scrollHeight;
            box.dataset.scrolled = '1';
        }
    }

    function addMessage(row) {
        const list = state.messages[row.chat_id] = state.messages[row.chat_id] || [];
        if (list.some(m => m.id === row.id)) return;
        list.push(row);
        list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        renderMessages(row.chat_id);
    }

    function isReadingChat(chatId) {
        return document.getElementById('classes')?.classList.contains('active-view') && currentChatId() === chatId &&
            document.visibilityState === 'visible';
    }

    function homeworkHtml(cls) {
        const admin = isAdminRole(cls.myRole);
        const follow = !!(appState.classFollow || {})[cls.id];
        const list = state.homework[cls.id] || [];
        const today = todayString();
        const upcoming = list.filter(h => h.due_date >= today);
        const past = list.filter(h => h.due_date < today).reverse();
        let html = `
            <label class="cls-follow">
                <input type="checkbox" data-change="follow" data-id="${cls.id}" ${follow ? 'checked' : ''}>
                <span><strong>Follow class homework</strong><small>New homework from ${escapeHTML(cls.name)} goes straight into your Homework list. If an admin changes or deletes it, your copy changes too, until you tick it done.</small></span>
            </label>`;
        if (admin) {
            html += `
                <form class="cls-hw-form" data-form="hw-add" data-id="${cls.id}">
                    <input type="text" id="cls-hw-task" data-keep maxlength="300" placeholder="What's the homework?" aria-label="Homework" required>
                    <select id="cls-hw-subject" data-keep class="cls-select" aria-label="Subject" required>
                        <option value="">Subject</option>
                        ${SUBJECT_LIST.map(s => `<option>${escapeHTML(s)}</option>`).join('')}
                    </select>
                    <input type="date" id="cls-hw-date" data-keep aria-label="Due date" min="${today}" required>
                    <button type="submit" class="btn primary-btn btn-sm">Post</button>
                </form>`;
        }
        const item = hw => `
            <li class="cls-hw-item">
                <div class="hw-info">
                    <strong>${escapeHTML(hw.task)}</strong>
                    <span>${escapeHTML(hw.subject)} · Due ${escapeHTML(dueText(hw.due_date))} · from ${escapeHTML(personName(hw.created_by))}</span>
                </div>
                ${admin ? `<span class="cls-row-actions">
                    <button type="button" class="btn ghost-btn btn-sm" data-act="hw-edit" data-hw="${hw.id}">Edit</button>
                    <button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="hw-delete" data-hw="${hw.id}">Delete</button>
                </span>` : ''}
            </li>`;
        html += '<p class="cls-section-title">Coming up</p>';
        html += upcoming.length ? `<ul class="cls-hw-list">${upcoming.map(item).join('')}</ul>` :
            `<p class="cls-hint">${admin ? 'No homework posted yet. Add some above.' : 'No homework posted yet.'}</p>`;
        if (past.length) {
            html += `<details class="cls-past"><summary>Past homework (${past.length})</summary><ul class="cls-hw-list">${past.map(item).join('')}</ul></details>`;
        }
        return html;
    }

    function timetableHtml(cls) {
        const admin = isAdminRole(cls.myRole);
        const tt = cls.timetable;
        const imported = (appState.classTimetableImported || {})[cls.id];
        let html = '';
        if (!tt) {
            html += `<p class="cls-hint">${admin ? 'Share your timetable with the class: set it up on the Timetable page first, then press the button below.' : 'Your class admin hasn\'t shared a timetable yet.'}</p>`;
        } else {
            const when = cls.timetable_updated_at ? timeAgo(Date.parse(cls.timetable_updated_at)) : '';
            if (timetableOutdated(cls)) html += '<p class="cls-banner">The class timetable changed since you imported it. Import it again to update yours.</p>';
            else if (imported) html += '<p class="cls-hint">Your timetable matches this one.</p>';
            html += `<p class="cls-hint">${pluralise(tt.totalDays, 'day order')}${when ? ` · updated ${escapeHTML(when)}` : ''}</p>`;
            html += '<div class="cls-tt-grid">';
            for (let d = 1; d <= tt.totalDays; d++) {
                const subjects = Array.isArray(tt.timetable?.[d]) ? tt.timetable[d] : [];
                const uniform = UNIFORMS.includes(tt.uniforms?.[d]) ? tt.uniforms[d] : 'Regular Uniform';
                html += `
                    <div class="cls-tt-day">
                        <h4>Day ${d}</h4>
                        <span class="cls-tt-uniform">${escapeHTML(uniform)}</span>
                        <ol>${Array.from({ length: 8 }, (_, j) => `<li>${escapeHTML(subjects[j] || '-')}</li>`).join('')}</ol>
                    </div>`;
            }
            html += '</div>';
        }
        html += '<div class="cls-actions">';
        if (tt) html += `<button type="button" class="btn primary-btn btn-sm" data-act="tt-import">${imported ? 'Import again' : 'Import to my timetable'}</button>`;
        if (admin) html += `<button type="button" class="btn secondary-btn btn-sm" data-act="tt-publish">${tt ? 'Share my timetable instead' : 'Share my timetable'}</button>`;
        html += '</div>';
        return html;
    }

    function filesHtml(kind, group, manager) {
        const files = state.files[keyOf(kind, group.id)];
        if (!files) return '<p class="cls-hint">Loading files...</p>';
        const used = files.reduce((sum, f) => sum + f.size_bytes, 0);
        const percent = Math.min(100, Math.round((used / GROUP_MAX_BYTES) * 100));
        let html = `
            <div class="cls-files-top">
                <div class="cls-usage">
                    <span>${escapeHTML(sizeText(used))} of 100 MB used</span>
                    <span class="cls-usage-bar"><span style="width: ${percent}%"></span></span>
                </div>
                <button type="button" class="btn primary-btn btn-sm" data-act="file-upload" ${state.uploading ? 'disabled' : ''}>${ICONS.upload} ${state.uploading ? 'Uploading...' : 'Upload'}</button>
            </div>
            <p class="cls-hint">Photos, PDF, Word, PowerPoint, Excel or text files, up to 10 MB each.</p>`;
        if (!files.length) return html + '<p class="cls-hint">No files yet.</p>';
        html += '<ul class="cls-file-list">';
        files.forEach(f => {
            const canDelete = f.uploaded_by === myId() || manager;
            html += `
                <li class="cls-file">
                    <span class="cls-file-icon">${escapeHTML((extension(f.file_name) || 'file').toUpperCase().slice(0, 4))}</span>
                    <span class="cls-file-info"><strong>${escapeHTML(f.file_name)}</strong>
                        <small>${escapeHTML(sizeText(f.size_bytes))} · ${escapeHTML(personName(f.uploaded_by))} · ${escapeHTML(timeAgo(Date.parse(f.created_at)))}</small></span>
                    <span class="cls-row-actions">
                        <button type="button" class="btn secondary-btn btn-sm" data-act="file-open" data-file="${f.id}">Open</button>
                        ${canDelete ? `<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="file-delete" data-file="${f.id}">Delete</button>` : ''}
                    </span>
                </li>`;
        });
        return html + '</ul>';
    }

    function peopleHtml(kind, group) {
        const members = memberList(kind, group.id);
        const me = myId();
        const myRole = kind === 'class' ? group.myRole : (group.owner_id === me ? 'owner' : 'member');
        const homeAdmin = kind === 'activity' && isAdminRole(findClass(group.class_id)?.myRole);
        const requests = kind === 'class' ? (state.requests[group.id] || []) : [];
        // The site owner can do what a class owner does, in any class they're in
        const boss = myRole === 'owner' || (kind === 'class' && isSiteOwner());
        let html = '';
        if (requests.length) {
            html += '<p class="cls-section-title">Waiting for approval</p><ul class="cls-people">';
            requests.forEach(r => {
                const who = escapeHTML(personName(r.target_id));
                html += `<li class="cls-person"><span class="cls-person-info">${r.kind === 'make_admin' ? `Make <strong>${who}</strong> a co-admin` : `Hand the class over to <strong>${who}</strong>`}</span>
                    ${boss ? `<button type="button" class="btn ghost-btn btn-sm" data-act="request-cancel" data-req="${r.id}">Cancel</button>` : ''}</li>`;
            });
            html += '</ul>';
        }
        html += `<p class="cls-section-title">${peopleCount(members.length)}</p><ul class="cls-people">`;
        members.forEach(m => {
            const isMe = m.user_id === me;
            const roleLabel = m.role === 'owner' ? (kind === 'class' ? 'Owner' : 'Started it') : m.role === 'admin' ? 'Co-admin' : '';
            const buttons = [];
            if (!isMe && kind === 'class') {
                if (boss && m.role === 'member' && (isSiteOwner() || !requests.some(r => r.kind === 'make_admin' && r.target_id === m.user_id))) {
                    buttons.push(`<button type="button" class="btn ghost-btn btn-sm" data-act="member-admin" data-user="${m.user_id}">Make co-admin</button>`);
                }
                if (boss && m.role === 'admin') buttons.push(`<button type="button" class="btn ghost-btn btn-sm" data-act="member-demote" data-user="${m.user_id}">Remove co-admin</button>`);
                if (boss && m.role !== 'owner' && (isSiteOwner() || !requests.some(r => r.kind === 'transfer_owner'))) {
                    buttons.push(`<button type="button" class="btn ghost-btn btn-sm" data-act="member-transfer" data-user="${m.user_id}">Hand over</button>`);
                }
                if (m.role !== 'owner' && (boss || (myRole === 'admin' && m.role === 'member'))) {
                    buttons.push(`<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="member-remove" data-user="${m.user_id}">Remove</button>`);
                }
            }
            if (!isMe && kind === 'activity' && m.role !== 'owner' && (myRole === 'owner' || homeAdmin)) {
                buttons.push(`<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="member-remove" data-user="${m.user_id}">Remove</button>`);
            }
            html += `
                <li class="cls-person">
                    <span class="friend-avatar cls-avatar">${escapeHTML(initials(m.name))}</span>
                    <span class="cls-person-info">
                        <strong>${escapeHTML(m.name || 'Classmate')}${isMe ? ' (you)' : ''}</strong>${roleLabel ? `<span class="cls-chip">${roleLabel}</span>` : ''}
                        <small>${escapeHTML(m.email)}${m.class ? ` · ${escapeHTML(m.class)}` : ''}</small>
                    </span>
                    ${buttons.length ? `<span class="cls-row-actions">${buttons.join('')}</span>` : ''}
                </li>`;
        });
        html += '</ul><div class="cls-actions">';
        if (myRole === 'owner' || homeAdmin || isSiteOwner()) {
            html += `<button type="button" class="btn danger-btn btn-sm" data-act="delete-group" data-kind="${kind}">Delete ${kind === 'class' ? 'class' : 'activity group'}</button>`;
        }
        if (myRole !== 'owner') {
            html += `<button type="button" class="btn secondary-btn btn-sm" data-act="leave" data-kind="${kind}">Leave ${kind === 'class' ? 'class' : 'group'}</button>`;
        }
        if (myRole === 'owner' && kind === 'class') {
            html += isSiteOwner()
                ? '<p class="cls-hint">Hand the class over to its admin with Hand over; it happens straight away. After that you\'re a co-admin and can leave.</p>'
                : '<p class="cls-hint">To leave, hand the class over to someone first. Making co-admins and handing over are checked by the Procrastinote team.</p>';
        }
        return html + '</div>';
    }

    function classActivitiesHtml(cls) {
        const admin = isAdminRole(cls.myRole);
        const points = myPoints();
        const list = (admin ? state.classActivities : state.activities).filter(a => a.class_id === cls.id);
        let html = `
            <div class="cls-activity-top">
                <p class="cls-hint">Activity groups are for projects and events. Start one here${admin ? '' : ' and a class admin approves it'}; then share its code with anyone, from any class.
                Small groups hold 5 people (1 point), big ones 20 (2 points). You've used <strong>${points} of ${ACTIVITY_POINTS}</strong> points.</p>
                <button type="button" class="btn primary-btn btn-sm" data-act="activity-new" ${points >= ACTIVITY_POINTS ? 'disabled' : ''}>+ Start an activity</button>
            </div>`;
        if (!list.length) return html + '<p class="cls-hint">No activity groups from this class yet.</p>';
        html += '<ul class="cls-people">';
        list.forEach(a => {
            const mine = state.activities.some(x => x.id === a.id);
            const buttons = [];
            if (admin && a.status === 'pending') {
                buttons.push(`<button type="button" class="btn primary-btn btn-sm" data-act="activity-review" data-id="${a.id}" data-approve="1">Approve</button>`);
                buttons.push(`<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="activity-review" data-id="${a.id}" data-approve="0">Reject</button>`);
            }
            if (mine) buttons.push(`<button type="button" class="btn secondary-btn btn-sm" data-act="select" data-kind="activity" data-id="${a.id}">Open</button>`);
            else if (admin && a.status !== 'pending') buttons.push(`<button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="activity-delete" data-id="${a.id}">Delete</button>`);
            html += `
                <li class="cls-person">
                    <span class="friend-avatar cls-avatar cls-avatar-activity">${escapeHTML(initials(a.name))}</span>
                    <span class="cls-person-info">
                        <strong>${escapeHTML(a.name)}</strong>${statusChip(a.status)}
                        <small>${SIZES[a.size].label} group · started by ${escapeHTML(personName(a.owner_id))}</small>
                    </span>
                    ${buttons.length ? `<span class="cls-row-actions">${buttons.join('')}</span>` : ''}
                </li>`;
        });
        return html + '</ul>';
    }

    function inboxHtml() {
        const inbox = state.inbox;
        if (!inbox) return '<p class="cls-hint">Loading...</p>';
        const when = iso => escapeHTML(timeAgo(Date.parse(iso)));
        const pending = inbox.classes.filter(c => c.status === 'pending');
        let html = `
            <header class="cls-head"><div class="cls-head-main"><h3>Approvals</h3>
                <p class="cls-head-sub">Only you see this. You approve new classes, co-admins and hand-overs, and handle reported messages.</p></div></header>`;

        html += `<p class="cls-section-title">New classes (${pending.length})</p>`;
        html += pending.length ? '<ul class="cls-people">' + pending.map(c => `
            <li class="cls-person">
                <span class="cls-person-info"><strong>${escapeHTML(c.name)}</strong>
                    <small>by ${escapeHTML(c.owner_name || '?')} (${escapeHTML(c.owner_email || '')}${c.owner_class ? `, ${escapeHTML(c.owner_class)}` : ''}) · ${when(c.created_at)}</small></span>
                <span class="cls-row-actions">
                    <button type="button" class="btn primary-btn btn-sm" data-act="site-class" data-id="${c.id}" data-approve="1">Approve</button>
                    <button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="site-class" data-id="${c.id}" data-approve="0">Reject</button>
                </span>
            </li>`).join('') + '</ul>' : '<p class="cls-hint">Nothing waiting.</p>';

        html += `<p class="cls-section-title">Co-admins and hand-overs (${inbox.requests.length})</p>`;
        html += inbox.requests.length ? '<ul class="cls-people">' + inbox.requests.map(r => `
            <li class="cls-person">
                <span class="cls-person-info"><strong>${escapeHTML(r.by_name || '?')}</strong> wants to ${r.kind === 'make_admin'
                    ? `make <strong>${escapeHTML(r.target_name || '?')}</strong> a co-admin of <strong>${escapeHTML(r.class_name)}</strong>`
                    : `hand <strong>${escapeHTML(r.class_name)}</strong> over to <strong>${escapeHTML(r.target_name || '?')}</strong>`}
                    <small>${escapeHTML(r.target_email || '')} · ${when(r.created_at)}</small></span>
                <span class="cls-row-actions">
                    <button type="button" class="btn primary-btn btn-sm" data-act="site-request" data-id="${r.id}" data-approve="1">Approve</button>
                    <button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="site-request" data-id="${r.id}" data-approve="0">Reject</button>
                </span>
            </li>`).join('') + '</ul>' : '<p class="cls-hint">Nothing waiting.</p>';

        html += `<p class="cls-section-title">Reported messages (${inbox.reports.length})</p>`;
        html += inbox.reports.length ? '<ul class="cls-people">' + inbox.reports.map(r => `
            <li class="cls-person cls-report">
                <span class="cls-person-info">
                    <small>${escapeHTML(r.place)} · ${when(r.created_at)}</small>
                    <blockquote>${escapeHTML(r.message_text)}</blockquote>
                    <small>Sent by <strong>${escapeHTML(r.sender_name || '?')}</strong> (${escapeHTML(r.sender_email || '')}). Reported by ${escapeHTML(r.reporter_name || '?')}${r.reason ? `: "${escapeHTML(r.reason)}"` : ''}${r.message_exists ? '' : ' · already deleted'}</small>
                </span>
                <span class="cls-row-actions">
                    ${r.message_exists ? `<button type="button" class="btn danger-btn btn-sm" data-act="site-report" data-id="${r.id}" data-delete="1">Delete message</button>` : ''}
                    <button type="button" class="btn ghost-btn btn-sm" data-act="site-report" data-id="${r.id}" data-delete="0">${r.message_exists ? 'Keep it' : 'Done'}</button>
                </span>
            </li>`).join('') + '</ul>' : '<p class="cls-hint">No reports.</p>';

        const others = inbox.classes.filter(c => c.status !== 'pending');
        html += `<details class="cls-past"><summary>Every class (${others.length}) and activity group (${inbox.activities.length})</summary><ul class="cls-people">`;
        html += others.map(c => `
            <li class="cls-person"><span class="cls-person-info"><strong>${escapeHTML(c.name)}</strong>${statusChip(c.status)}
                <small>${c.members} people · owner ${escapeHTML(c.owner_name || '?')} (${escapeHTML(c.owner_email || '')})</small></span>
                <span class="cls-row-actions"><button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="site-delete" data-kind="class" data-id="${c.id}" data-name="${escapeHTML(c.name)}">Delete</button></span></li>`).join('');
        html += inbox.activities.map(a => `
            <li class="cls-person"><span class="cls-person-info"><strong>${escapeHTML(a.name)}</strong>${statusChip(a.status)}
                <small>Activity from ${escapeHTML(a.class_name)} · ${a.members} people · started by ${escapeHTML(a.owner_name || '?')}</small></span>
                <span class="cls-row-actions"><button type="button" class="btn ghost-btn btn-sm cls-danger-text" data-act="site-delete" data-kind="activity" data-id="${a.id}" data-name="${escapeHTML(a.name)}">Delete</button></span></li>`).join('');
        return html + '</ul></details>';
    }

    // ---------- Dialog (create class, new chat, start activity, edit homework...) ----------
    function openDialog({ title, body, submitLabel, onSubmit }) {
        const dialog = document.getElementById('classes-dialog');
        const error = document.getElementById('classes-dialog-error');
        document.getElementById('classes-dialog-title').innerText = title;
        document.getElementById('classes-dialog-body').innerHTML = body;
        document.getElementById('classes-dialog-submit').innerText = submitLabel;
        error.hidden = true;
        dialog._onSubmit = onSubmit;
        dialog.showModal();
        dialog.querySelector('#classes-dialog-body input:not([type="checkbox"]):not([type="radio"])')?.focus();
    }

    async function submitDialog(e) {
        e.preventDefault();
        const dialog = document.getElementById('classes-dialog');
        const button = document.getElementById('classes-dialog-submit');
        const error = document.getElementById('classes-dialog-error');
        button.disabled = true;
        try {
            await dialog._onSubmit(document.getElementById('classes-dialog-form'));
            dialog.close();
        } catch (err) {
            error.innerText = friendlyError(err);
            error.hidden = false;
        } finally {
            button.disabled = false;
        }
    }

    // Supabase errors come back as values; turn them into exceptions for the dialog
    async function call(promise) {
        const { data, error } = await promise;
        if (error) throw error;
        return data;
    }

    function peoplePickerHtml(classId, chosen) {
        const others = memberList('class', classId).filter(m => m.user_id !== myId());
        if (!others.length) return '<p class="cls-hint">Nobody else is in this class yet.</p>';
        return `<div class="cls-picker">${others.map(m => `
            <label class="cls-pick"><input type="checkbox" name="member" value="${m.user_id}" ${chosen.includes(m.user_id) ? 'checked' : ''}>
                <span>${escapeHTML(m.name || m.email)}<small>${escapeHTML(m.email)}</small></span></label>`).join('')}</div>`;
    }

    const checkedValues = (form, name) => Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);

    // ---------- Actions ----------
    function select(kind, id) {
        state.selected = kind === 'inbox' ? { kind } : { kind, id };
        renderList();
        renderDetail();
        if (kind === 'inbox') {
            loadInbox().then(() => { renderList(); renderDetail(); });
        } else {
            loadFiles(kind, id).then(renderDetail);
            if (kind === 'class' && isAdminRole(findClass(id)?.myRole)) loadRequests(id).then(renderDetail);
        }
        document.getElementById('classes-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Only the site owner creates classes (the database refuses everyone else)
    function createClass() {
        if (!isSiteOwner()) return;
        openDialog({
            title: 'Create a class',
            submitLabel: 'Create',
            body: `
                <p class="cls-hint">For ${escapeHTML(SCHOOL_NAME)}. It's ready straight away. Share its code with the class admin, then hand the class to them from People.</p>
                <label for="cls-new-class-name">Class name</label>
                <input type="text" id="cls-new-class-name" name="name" maxlength="60" placeholder="e.g. Grade 8 B" required>`,
            onSubmit: async form => {
                const id = await call(cloud.rpc('create_class', { p_name: form.elements.name.value }));
                await loadAll();
                select('class', id);
                alert('Class created. Its code is ready to share.');
            }
        });
    }

    async function joinWithCode(input) {
        const code = input.value.trim();
        if (!code) return;
        const button = input.form.querySelector('button');
        button.disabled = true;
        try {
            const result = await call(cloud.rpc('join_with_code', { p_code: code }));
            if (!result) {
                alert('No class or activity group uses that code. Check it with whoever gave it to you.');
                return;
            }
            input.value = '';
            await loadAll();
            select(result.kind, result.id);
            const group = result.kind === 'class' ? findClass(result.id) : findActivity(result.id);
            alert(`You joined ${group?.name || 'the group'}.`);
        } catch (err) {
            alert(friendlyError(err));
        } finally {
            button.disabled = false;
        }
    }

    function newChat(cls) {
        const chats = chatsFor('class', cls.id);
        if (chats.some(c => c.kind === 'private' && c.created_by === myId())) {
            alert('You already made a chat in this class. Each person can make one; delete yours to make a new one.');
            return;
        }
        if (chats.filter(c => c.kind === 'private').length >= MAX_PRIVATE_CHATS) {
            alert('This class already has 15 chats. Ask an admin to delete one that isn\'t used.');
            return;
        }
        openDialog({
            title: 'New invite-only chat',
            submitLabel: 'Make chat',
            body: `
                <p class="cls-hint">Only the classmates you pick can see it. Each person can make one chat per class.</p>
                <label for="cls-new-chat-name">Chat name</label>
                <input type="text" id="cls-new-chat-name" name="name" maxlength="40" placeholder="e.g. Science project" required>
                <label>Who's in it</label>
                ${peoplePickerHtml(cls.id, [])}`,
            onSubmit: async form => {
                const id = await call(cloud.rpc('create_private_chat', {
                    p_class: cls.id, p_name: form.elements.name.value, p_members: checkedValues(form, 'member')
                }));
                await loadChats();
                state.activeChat[keyOf('class', cls.id)] = id;
                renderDetail();
            }
        });
    }

    function editChatPeople(chat) {
        openDialog({
            title: `Who's in ${chat.name}`,
            submitLabel: 'Save',
            body: peoplePickerHtml(chat.class_id, state.chatMembers[chat.id] || []),
            onSubmit: async form => {
                await call(cloud.rpc('set_chat_members', { p_chat: chat.id, p_members: checkedValues(form, 'member') }));
                await loadChats();
                renderDetail();
            }
        });
    }

    async function sendMessage(form) {
        const input = form.querySelector('input');
        const text = input.value.trim();
        if (!text) return;
        if (text.length > 2000) {
            alert('Messages can be at most 2000 characters.');
            return;
        }
        input.value = '';
        closePingList();
        const chat = state.chats.find(c => c.id === form.dataset.chat);
        const { data, error } = await cloud.from('group_messages')
            .insert({ chat_id: form.dataset.chat, sender_id: myId(), text, mentions: mentionsIn(chat, text) })
            .select()
            .single();
        if (error) {
            input.value = text;
            alert(`Message not sent: ${friendlyError(error)}`);
            return;
        }
        addMessage(data);
        const box = document.getElementById('cls-messages');
        if (box) box.scrollTop = box.scrollHeight;
        if (BOT_PING.test(text)) askBot(data.chat_id, text);
    }

    function reportMessage(id) {
        openDialog({
            title: 'Report this message',
            submitLabel: 'Report',
            body: `
                <p class="cls-hint">The Procrastinote team will read it and can delete it. The sender isn't told who reported it.</p>
                <label for="cls-report-reason">What's wrong? (optional)</label>
                <input type="text" id="cls-report-reason" name="reason" maxlength="300" placeholder="e.g. Mean, rude or unsafe">`,
            onSubmit: async form => {
                await call(cloud.rpc('report_message', { p_message: Number(id), p_reason: form.elements.reason.value }));
                alert('Thanks. The message was reported.');
            }
        });
    }

    function homeworkDialog(hw) {
        openDialog({
            title: 'Edit homework',
            submitLabel: 'Save',
            body: `
                <label for="cls-edit-task">Homework</label>
                <input type="text" id="cls-edit-task" name="task" maxlength="300" value="${escapeHTML(hw.task)}" required>
                <label for="cls-edit-subject">Subject</label>
                <select id="cls-edit-subject" name="subject" class="cls-select" required>
                    ${SUBJECT_LIST.map(s => `<option ${s === hw.subject ? 'selected' : ''}>${escapeHTML(s)}</option>`).join('')}
                </select>
                <label for="cls-edit-date">Due</label>
                <input type="date" id="cls-edit-date" name="date" value="${escapeHTML(hw.due_date)}" required>`,
            onSubmit: async form => {
                if (!form.elements.date.value) throw new Error('Pick a due date.');
                await call(cloud.from('class_homework').update({
                    task: form.elements.task.value.trim(), subject: form.elements.subject.value, due_date: form.elements.date.value
                }).eq('id', hw.id));
                await loadHomework(hw.class_id);
                renderDetail();
            }
        });
    }

    async function postHomework(form) {
        const task = form.querySelector('#cls-hw-task').value.trim();
        const subject = form.querySelector('#cls-hw-subject').value;
        const date = form.querySelector('#cls-hw-date').value;
        if (!task || !subject) return;
        if (!date) { // date boxes are read-only (pickers.js), so the browser doesn't check "required"
            const box = form.querySelector('#cls-hw-date');
            box.classList.add('shake-error');
            setTimeout(() => box.classList.remove('shake-error'), 600);
            alert('Pick a due date.');
            return;
        }
        const button = form.querySelector('button');
        button.disabled = true;
        const { error } = await cloud.from('class_homework')
            .insert({ class_id: form.dataset.id, task, subject, due_date: date, created_by: myId() });
        button.disabled = false;
        if (error) {
            alert(`Homework not posted: ${friendlyError(error)}`);
            return;
        }
        form.reset();
        await loadHomework(form.dataset.id);
        renderDetail();
    }

    function setFollow(classId, on) {
        classMap('classFollow');
        if (on) appState.classFollow[classId] = true;
        else delete appState.classFollow[classId];
        saveState();
        if (on) {
            const before = appState.homework.length;
            syncHomework(classId);
            const added = appState.homework.length - before;
            alert(added ? `Added ${pluralise(added, 'homework item')} to your Homework list.` : 'You\'ll get this class\'s new homework in your Homework list.');
        }
        renderDetail();
    }

    function importTimetable(cls) {
        const tt = cls.timetable;
        if (!tt) return;
        showConfirm(`Replace your school timetable and uniforms with ${cls.name}'s? Your home study plan stays the same.`, () => {
            const days = Math.min(10, Math.max(1, parseInt(tt.totalDays, 10) || 6));
            const timetable = {};
            const uniforms = {};
            for (let d = 1; d <= days; d++) {
                const subjects = Array.isArray(tt.timetable?.[d]) ? tt.timetable[d] : [];
                // Only known subjects and uniforms, so nothing unexpected ends up in your planner
                timetable[d] = Array.from({ length: 8 }, (_, j) => (SUBJECT_LIST.includes(subjects[j]) ? subjects[j] : ''));
                uniforms[d] = UNIFORMS.includes(tt.uniforms?.[d]) ? tt.uniforms[d] : 'Regular Uniform';
            }
            appState.settings.totalDays = days;
            if (parseInt(appState.settings.currentDayOrder, 10) > days) appState.settings.currentDayOrder = days;
            appState.timetable = timetable;
            appState.uniforms = uniforms;
            classMap('classTimetableImported')[cls.id] = cls.timetable_updated_at;
            saveState();
            render();
            renderNotifications();
            alert(`Imported ${cls.name}'s timetable. Check that "Today's day order" in Settings is right.`);
        }, { title: 'Import timetable', confirmLabel: 'Import', danger: false });
    }

    function publishTimetable(cls) {
        const days = Math.min(10, Math.max(1, parseInt(appState.settings.totalDays, 10) || 6));
        const hasSubjects = Object.values(appState.timetable || {}).some(list => (list || []).some(Boolean));
        if (!hasSubjects) {
            alert('Your timetable is empty. Fill it in on the Timetable page and press Save first.');
            return;
        }
        showConfirm(`Share your timetable (${pluralise(days, 'day order')}, with uniforms) with ${cls.name}? Classmates who imported the old one will be told it changed.`, async () => {
            const payload = { totalDays: days, timetable: {}, uniforms: {} };
            for (let d = 1; d <= days; d++) {
                payload.timetable[d] = Array.from({ length: 8 }, (_, j) => {
                    const subject = (appState.timetable[d] || [])[j];
                    return SUBJECT_LIST.includes(subject) ? subject : '';
                });
                payload.uniforms[d] = UNIFORMS.includes(appState.uniforms[d]) ? appState.uniforms[d] : 'Regular Uniform';
            }
            const { data, error } = await cloud.rpc('publish_class_timetable', { p_class: cls.id, p_timetable: payload });
            if (error) {
                alert(`Timetable not shared: ${friendlyError(error)}`);
                return;
            }
            Object.assign(cls, { timetable: payload, timetable_updated_at: data });
            classMap('classTimetableImported')[cls.id] = data; // yours is the same as the class one
            saveState();
            render();
            alert(`Shared your timetable with ${cls.name}.`);
        }, { title: 'Share timetable', confirmLabel: 'Share', danger: false });
    }

    async function uploadFile(file) {
        const sel = state.selected;
        if (!file || !sel || sel.kind === 'inbox') return;
        const type = FILE_TYPES[extension(file.name)];
        if (!type) {
            alert('You can upload photos (PNG, JPG, GIF, WebP), PDF, Word, PowerPoint, Excel and text files.');
            return;
        }
        if (file.size === 0 || file.size > FILE_MAX_BYTES) {
            alert(`${file.name} is ${file.size ? sizeText(file.size) : 'empty'}. Files can be up to 10 MB.`);
            return;
        }
        const used = (state.files[keyOf(sel.kind, sel.id)] || []).reduce((sum, f) => sum + f.size_bytes, 0);
        if (used >= GROUP_MAX_BYTES) {
            alert('This group has used its 100 MB. Delete some old files to make room.');
            return;
        }
        // Storage paths only allow simple characters; the real name is kept in group_files
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || `file.${extension(file.name)}`;
        const path = `${sel.kind}/${sel.id}/${myId()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        state.uploading = true;
        renderDetail();
        try {
            const upload = await cloud.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: false });
            if (upload.error) {
                throw /row-level security|403|Unauthorized/i.test(upload.error.message)
                    ? new Error('Upload refused. The group may have used its 100 MB, or you may no longer be in it.')
                    : upload.error;
            }
            const { data, error } = await cloud.rpc('register_group_file', { p_path: path, p_file_name: file.name.slice(0, 200) });
            if (error) {
                await cloud.storage.from(BUCKET).remove([path]); // don't leave an unlisted file behind
                throw error;
            }
            const key = keyOf(sel.kind, sel.id);
            state.files[key] = state.files[key] || [];
            if (!state.files[key].some(f => f.id === data.id)) state.files[key].unshift(data);
        } catch (err) {
            alert(`${file.name} wasn't uploaded: ${friendlyError(err)}`);
        } finally {
            state.uploading = false;
            renderDetail();
        }
    }

    function findFile(id) {
        for (const list of Object.values(state.files)) {
            const file = list.find(f => String(f.id) === String(id));
            if (file) return file;
        }
        return null;
    }

    async function openFile(file) {
        if (!file) return;
        // Photos, PDFs and text open in a new tab; other files download. The tab is opened
        // straight away (before waiting for the link) so pop-up blockers allow it.
        const viewable = file.mime_type.startsWith('image/') || file.mime_type === 'application/pdf' || file.mime_type === 'text/plain';
        const tab = viewable ? window.open('', '_blank') : null;
        if (tab) tab.opener = null;
        // Links to private files work for 10 minutes
        const { data, error } = await cloud.storage.from(BUCKET)
            .createSignedUrl(file.path, 600, viewable ? undefined : { download: file.file_name });
        if (error) {
            tab?.close();
            alert(`Couldn't open ${file.file_name}: ${friendlyError(error)}`);
            return;
        }
        if (tab) {
            tab.location.href = data.signedUrl;
            return;
        }
        const link = document.createElement('a');
        link.href = data.signedUrl;
        link.rel = 'noopener noreferrer';
        link.click();
    }

    async function deleteFile(file) {
        const removed = await cloud.storage.from(BUCKET).remove([file.path]);
        if (removed.error) {
            alert(`Couldn't delete ${file.file_name}: ${friendlyError(removed.error)}`);
            return;
        }
        await cloud.from('group_files').delete().eq('id', file.id);
        Object.keys(state.files).forEach(key => { state.files[key] = state.files[key].filter(f => f.id !== file.id); });
        renderDetail();
    }

    // Deleting a class or activity also removes its files from storage (the database can't)
    async function deleteGroup(kind, id) {
        let paths = [];
        const filesOf = async (column, ids) => {
            if (!ids.length) return;
            const { data } = await cloud.from('group_files').select('path').in(column, ids);
            paths = paths.concat((data || []).map(f => f.path));
        };
        if (kind === 'class') {
            const { data: acts } = await cloud.from('activities').select('id').eq('class_id', id);
            await filesOf('class_id', [id]);
            await filesOf('activity_id', (acts || []).map(a => a.id));
        } else {
            await filesOf('activity_id', [id]);
        }
        for (let i = 0; i < paths.length; i += 100) {
            await cloud.storage.from(BUCKET).remove(paths.slice(i, i + 100));
        }
        const { error } = await cloud.from(kind === 'class' ? 'classes' : 'activities').delete().eq('id', id);
        if (error) throw error;
        if (kind === 'class') {
            delete appState.classFollow?.[id];
            delete appState.classTimetableImported?.[id];
            saveState();
        }
        if (state.selected?.id === id) state.selected = null;
        await loadAll();
    }

    function confirmDeleteGroup(kind, group) {
        const what = kind === 'class'
            ? `Delete ${group.name} for everyone? Its chats, homework, files and activity groups are deleted too. This can't be undone.`
            : `Delete the activity group ${group.name} for everyone? Its chat and files are deleted too. This can't be undone.`;
        showConfirm(what, async () => {
            try {
                await deleteGroup(kind, group.id);
            } catch (err) {
                alert(`Couldn't delete it: ${friendlyError(err)}`);
            }
        });
    }

    function newActivity(cls) {
        const left = ACTIVITY_POINTS - myPoints();
        openDialog({
            title: 'Start an activity group',
            submitLabel: 'Start',
            body: `
                <p class="cls-hint">${isAdminRole(cls.myRole) ? 'You\'re an admin, so it\'s ready straight away.' : `An admin of ${escapeHTML(cls.name)} approves it first.`} You have ${left} of ${ACTIVITY_POINTS} points left.</p>
                <label for="cls-new-activity-name">Name</label>
                <input type="text" id="cls-new-activity-name" name="name" maxlength="60" placeholder="e.g. Science fair team" required>
                <label>Size</label>
                <div class="cls-size-pick">
                    <label class="cls-pick"><input type="radio" name="size" value="small" checked>
                        <span>Small<small>Up to 5 people · 1 point</small></span></label>
                    <label class="cls-pick"><input type="radio" name="size" value="big" ${left < 2 ? 'disabled' : ''}>
                        <span>Big<small>Up to 20 people · 2 points</small></span></label>
                </div>`,
            onSubmit: async form => {
                const size = form.querySelector('input[name="size"]:checked')?.value || 'small';
                const id = await call(cloud.rpc('create_activity', { p_class: cls.id, p_name: form.elements.name.value, p_size: size }));
                await loadAll();
                select('activity', id);
            }
        });
    }

    async function runRpc(name, args, done) {
        const { error } = await cloud.rpc(name, args);
        if (error) {
            alert(friendlyError(error));
            return false;
        }
        if (done) alert(done);
        await loadAll();
        return true;
    }

    // ---------- Event handling (one listener for the whole page) ----------
    async function onClick(e) {
        const el = e.target.closest('[data-act]');
        if (!el || !document.getElementById('classes').contains(el)) return;
        const act = el.dataset.act;
        const sel = state.selected;
        const group = selectedGroup();
        const kind = sel?.kind;

        switch (act) {
            case 'select':
                select(el.dataset.kind, el.dataset.id);
                break;
            case 'create-class':
                createClass();
                break;
            case 'tab':
                state.tabs[el.dataset.key] = el.dataset.tab;
                renderDetail();
                break;
            case 'copy-code':
                try {
                    await navigator.clipboard.writeText(el.dataset.code);
                    alert(`Copied ${el.dataset.code}. Share it only with people who should join.`);
                } catch (err) {
                    alert(`The code is ${el.dataset.code}.`);
                }
                break;
            case 'new-code':
                showConfirm('Make a new code? The old one stops working, but people already inside stay.', async () => {
                    const { error } = await cloud.rpc('regenerate_code', { p_kind: el.dataset.kind, p_id: el.dataset.id });
                    if (error) alert(friendlyError(error));
                    await loadAll();
                }, { title: 'New code', confirmLabel: 'Make new code', danger: false });
                break;
            case 'open-chat':
                state.activeChat[keyOf(kind, group.id)] = el.dataset.chat;
                renderDetail();
                break;
            case 'new-chat':
                newChat(group);
                break;
            case 'chat-people':
                editChatPeople(state.chats.find(c => c.id === el.dataset.chat));
                break;
            case 'chat-leave':
                showConfirm('Leave this chat? You\'ll need the person who made it to add you back.', async () => {
                    const { error } = await cloud.from('chat_members').delete().eq('chat_id', el.dataset.chat).eq('user_id', myId());
                    if (error) alert(friendlyError(error));
                    await loadChats();
                    renderDetail();
                }, { title: 'Leave chat', confirmLabel: 'Leave' });
                break;
            case 'chat-delete':
                showConfirm('Delete this chat and all its messages for everyone?', async () => {
                    const { error } = await cloud.from('chats').delete().eq('id', el.dataset.chat);
                    if (error) alert(friendlyError(error));
                    delete state.activeChat[keyOf(kind, group.id)];
                    await loadChats();
                    renderDetail();
                });
                break;
            case 'msg-delete':
                showConfirm('Delete this message for everyone?', async () => {
                    const { error } = await cloud.from('group_messages').delete().eq('id', el.dataset.msg);
                    if (error) {
                        alert(friendlyError(error));
                        return;
                    }
                    onMessage({ eventType: 'DELETE', old: { id: Number(el.dataset.msg) } });
                });
                break;
            case 'msg-report':
                reportMessage(el.dataset.msg);
                break;
            case 'ping-pick':
                pickPing(Number(el.dataset.index));
                break;
            case 'hw-edit':
                homeworkDialog((state.homework[group.id] || []).find(h => String(h.id) === el.dataset.hw));
                break;
            case 'hw-delete':
                showConfirm('Delete this homework for the whole class? It also leaves the lists of everyone following the class.', async () => {
                    const { error } = await cloud.from('class_homework').delete().eq('id', el.dataset.hw);
                    if (error) alert(friendlyError(error));
                    else onHomework({ eventType: 'DELETE', old: { id: Number(el.dataset.hw) } });
                });
                break;
            case 'tt-import':
                importTimetable(group);
                break;
            case 'tt-publish':
                publishTimetable(group);
                break;
            case 'file-upload':
                document.getElementById('classes-file-input')?.click();
                break;
            case 'file-open':
                openFile(findFile(el.dataset.file));
                break;
            case 'file-delete': {
                const file = findFile(el.dataset.file);
                showConfirm(`Delete ${file.file_name} for everyone?`, () => deleteFile(file));
                break;
            }
            case 'member-admin': {
                // The site owner's own changes happen straight away; class owners ask first
                const now = isSiteOwner();
                showConfirm(`${now ? 'Make' : 'Ask to make'} ${personName(el.dataset.user)} a co-admin? Co-admins can post homework, share the timetable, delete messages and files, and remove members.${now ? '' : ' The Procrastinote team approves it first.'}`,
                    () => runRpc('request_class_role', { p_class: group.id, p_user: el.dataset.user, p_kind: 'make_admin' },
                        now ? `${personName(el.dataset.user)} is now a co-admin.` : 'Asked. You\'ll see the change once it\'s approved.'),
                    { title: 'Make co-admin', confirmLabel: now ? 'Make co-admin' : 'Ask', danger: false });
                break;
            }
            case 'member-transfer': {
                const now = isSiteOwner();
                showConfirm(`Hand ${group.name} over to ${personName(el.dataset.user)}? They become the owner and the current owner becomes a co-admin.${now ? '' : ' The Procrastinote team approves it first.'}`,
                    () => runRpc('request_class_role', { p_class: group.id, p_user: el.dataset.user, p_kind: 'transfer_owner' },
                        now ? `${personName(el.dataset.user)} now owns ${group.name}.` : 'Asked. You\'ll see the change once it\'s approved.'),
                    { title: 'Hand over class', confirmLabel: now ? 'Hand over' : 'Ask', danger: false });
                break;
            }
            case 'member-demote':
                showConfirm(`Make ${personName(el.dataset.user)} a normal member again?`,
                    () => runRpc('demote_class_admin', { p_class: group.id, p_user: el.dataset.user }),
                    { title: 'Remove co-admin', confirmLabel: 'Remove co-admin' });
                break;
            case 'member-remove':
                showConfirm(`Remove ${personName(el.dataset.user)} from ${group.name}?${kind === 'class' ? ' A chat they made in this class is deleted too.' : ''}`,
                    () => runRpc(kind === 'class' ? 'remove_class_member' : 'remove_activity_member',
                        kind === 'class' ? { p_class: group.id, p_user: el.dataset.user } : { p_activity: group.id, p_user: el.dataset.user }),
                    { title: 'Remove', confirmLabel: 'Remove' });
                break;
            case 'request-cancel':
                runRpc('cancel_class_request', { p_request: Number(el.dataset.req) });
                break;
            case 'leave':
                showConfirm(kind === 'class'
                    ? `Leave ${group.name}? A chat you made in this class is deleted. You'll need the code to come back.`
                    : `Leave ${group.name}? You'll need the code to come back.`, async () => {
                    if (await runRpc(kind === 'class' ? 'leave_class' : 'leave_activity', kind === 'class' ? { p_class: group.id } : { p_activity: group.id })) {
                        state.selected = null;
                        render();
                    }
                }, { title: 'Leave', confirmLabel: 'Leave' });
                break;
            case 'delete-group':
                confirmDeleteGroup(el.dataset.kind, group);
                break;
            case 'activity-new':
                newActivity(group);
                break;
            case 'activity-review':
                runRpc('review_activity', { p_activity: el.dataset.id, p_approve: el.dataset.approve === '1' });
                break;
            case 'activity-delete':
                confirmDeleteGroup('activity', findActivity(el.dataset.id));
                break;
            case 'site-class':
                runRpc('site_review_class', { p_class: el.dataset.id, p_approve: el.dataset.approve === '1' });
                break;
            case 'site-request':
                runRpc('site_review_request', { p_request: Number(el.dataset.id), p_approve: el.dataset.approve === '1' });
                break;
            case 'site-report':
                runRpc('site_resolve_report', { p_report: Number(el.dataset.id), p_delete_message: el.dataset.delete === '1' });
                break;
            case 'site-delete':
                confirmDeleteGroup(el.dataset.kind, { id: el.dataset.id, name: el.dataset.name });
                break;
        }
    }

    function onSubmit(e) {
        const form = e.target.closest('form[data-form]');
        if (!form) return;
        e.preventDefault();
        if (form.dataset.form === 'send') sendMessage(form);
        else if (form.dataset.form === 'hw-add') postHomework(form);
    }

    function onChange(e) {
        const el = e.target.closest('[data-change]');
        if (el?.dataset.change === 'follow') setFollow(el.dataset.id, el.checked);
    }

    // While the @ list is open: arrows move, Enter or Tab picks, Esc closes
    function onPingKeys(e) {
        if (e.target.id !== 'cls-chat-input' || !state.ping) return;
        const count = state.ping.options.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            state.ping.index = (state.ping.index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count;
            document.getElementById('cls-ping-list').innerHTML = pingListHtml();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pickPing(state.ping.index);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closePingList();
        }
    }

    // ---------- Notifications (shown in the dashboard bell by school-app.js) ----------
    function openFromNotification(kind, id, tab, chatId) {
        if (typeof closeNotifications === 'function') closeNotifications();
        document.querySelector('.dock-item[data-tab="classes"]')?.click();
        if (tab) state.tabs[keyOf(kind, id)] = tab;
        if (chatId) state.activeChat[keyOf(kind, id)] = chatId;
        select(kind, id);
    }

    function notificationItems() {
        if (!state.started || !online()) return [];
        const items = [];
        const me = myId();

        state.recentMessages.forEach(m => {
            const chat = state.chats.find(c => c.id === m.chat_id);
            if (!chat) return;
            const g = chatGroup(chat);
            const preview = m.text.length > 90 ? `${m.text.slice(0, 90)}...` : m.text;
            const who = m.bot ? BOT_NAME : personName(m.sender_id);
            const pinged = (m.mentions || []).includes(me);
            items.push({
                ts: Date.parse(m.created_at),
                html: pinged
                    ? `📣 <strong>${escapeHTML(who)}</strong> mentioned you in ${escapeHTML(chatPlace(chat))}: ${escapeHTML(preview)}`
                    : `<strong>${escapeHTML(who)}</strong> in ${escapeHTML(chatPlace(chat))}: ${escapeHTML(preview)}`,
                open: () => openFromNotification(g.kind, g.id, g.kind === 'class' ? 'chats' : 'chat', chat.id)
            });
        });

        const recent = Date.now() - HOMEWORK_NOTIF_DAYS * 86400000;
        Object.entries(state.homework).forEach(([classId, list]) => {
            const cls = findClass(classId);
            list.forEach(hw => {
                const ts = Date.parse(hw.created_at);
                if (!cls || hw.created_by === me || ts < recent) return;
                items.push({
                    ts,
                    html: `New homework in <strong>${escapeHTML(cls.name)}</strong>: ${escapeHTML(hw.task)} (${escapeHTML(hw.subject)}, due ${escapeHTML(dueText(hw.due_date))})`,
                    open: () => openFromNotification('class', classId, 'homework')
                });
            });
        });

        state.classes.forEach(c => {
            if (timetableOutdated(c)) {
                items.push({
                    ts: Date.parse(c.timetable_updated_at),
                    html: `<strong>${escapeHTML(c.name)}</strong>'s timetable changed. Import it again?`,
                    open: () => openFromNotification('class', c.id, 'timetable')
                });
            }
            if (c.myRole === 'owner' && c.reviewed_at && c.status !== 'pending') {
                items.push({
                    ts: Date.parse(c.reviewed_at),
                    html: c.status === 'approved'
                        ? `<strong>${escapeHTML(c.name)}</strong> was approved. Share its code with your classmates.`
                        : `<strong>${escapeHTML(c.name)}</strong> wasn't approved.`,
                    open: () => openFromNotification('class', c.id, 'people')
                });
            }
        });

        state.activities.forEach(a => {
            const selfApproved = a.reviewed_at && Math.abs(Date.parse(a.reviewed_at) - Date.parse(a.created_at)) < 5000;
            if (a.owner_id === me && a.reviewed_at && a.status !== 'pending' && !selfApproved) {
                items.push({
                    ts: Date.parse(a.reviewed_at),
                    html: a.status === 'approved'
                        ? `Your activity group <strong>${escapeHTML(a.name)}</strong> was approved. Share its code!`
                        : `Your activity group <strong>${escapeHTML(a.name)}</strong> wasn't approved.`,
                    open: () => openFromNotification('activity', a.id)
                });
            }
        });

        state.classActivities.filter(a => a.status === 'pending').forEach(a => {
            items.push({
                ts: Date.parse(a.created_at),
                html: `<strong>${escapeHTML(personName(a.owner_id))}</strong> wants to start <strong>${escapeHTML(a.name)}</strong> from ${escapeHTML(findClass(a.class_id)?.name || 'your class')}. Approve it?`,
                open: () => openFromNotification('class', a.class_id, 'activities')
            });
        });

        if (isSiteOwner() && state.inbox) {
            const toInbox = () => {
                if (typeof closeNotifications === 'function') closeNotifications();
                document.querySelector('.dock-item[data-tab="classes"]')?.click();
                select('inbox');
            };
            state.inbox.classes.filter(c => c.status === 'pending').forEach(c => items.push({
                ts: Date.parse(c.created_at),
                html: `New class waiting for you: <strong>${escapeHTML(c.name)}</strong> by ${escapeHTML(c.owner_name || '?')}`,
                open: toInbox
            }));
            state.inbox.requests.forEach(r => items.push({
                ts: Date.parse(r.created_at),
                html: `<strong>${escapeHTML(r.class_name)}</strong>: ${r.kind === 'make_admin' ? 'a co-admin' : 'a hand-over'} is waiting for you`,
                open: toInbox
            }));
            state.inbox.reports.forEach(r => items.push({
                ts: Date.parse(r.created_at),
                html: `A message in <strong>${escapeHTML(r.place)}</strong> was reported`,
                open: toInbox
            }));
        }

        return items.filter(i => Number.isFinite(i.ts)).sort((a, b) => b.ts - a.ts).slice(0, NOTIF_LIMIT);
    }

    function markClassesSeen(timestamp) {
        if (typeof getNotifSeen !== 'function') return;
        const seen = getNotifSeen();
        if (timestamp > seen.classSeenAt) setNotifSeen({ ...seen, classSeenAt: timestamp });
    }

    function renderNotificationList(listEl, titleEl, seenAt) {
        const items = notificationItems();
        titleEl.hidden = listEl.hidden = items.length === 0;
        listEl.innerHTML = '';
        items.forEach(item => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notif-item' + (item.ts > seenAt ? ' unread' : '');
            btn.innerHTML = `${item.html}<span class="notif-item-time">${escapeHTML(timeAgo(item.ts))}</span>`;
            btn.addEventListener('click', item.open);
            li.appendChild(btn);
            listEl.appendChild(li);
        });
    }

    // ---------- Start / stop ----------
    function start() {
        if (state.started || !cloud || !online()) {
            render();
            return;
        }
        state.started = true;
        startLive();
        loadAll();
    }

    function stop() {
        if (state.channel) cloud?.removeChannel(state.channel);
        clearTimeout(reloadTimer);
        Object.assign(state, freshState());
        ['classes-detail', 'classes-list'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = '';
                el._html = '';
                el._view = null;
                el._tabRect = el._sliderRect = null;
            }
        });
        render();
    }

    document.getElementById('classes')?.addEventListener('click', onClick);
    document.getElementById('classes')?.addEventListener('submit', onSubmit);
    document.getElementById('classes')?.addEventListener('change', onChange);
    document.getElementById('classes')?.addEventListener('input', e => {
        if (e.target.id === 'cls-chat-input') updatePingList(e.target);
    });
    document.getElementById('classes')?.addEventListener('keydown', onPingKeys);
    // Picking from the list mustn't take focus away from the message box
    document.getElementById('classes')?.addEventListener('mousedown', e => {
        if (e.target.closest('.cls-ping-option')) e.preventDefault();
    });
    document.addEventListener('pointerdown', e => {
        if (state.ping && !e.target.closest('.cls-chat-form')) closePingList();
    });
    document.getElementById('classes-join-form')?.addEventListener('submit', e => {
        e.preventDefault();
        joinWithCode(document.getElementById('classes-join-code'));
    });
    document.getElementById('classes-file-input')?.addEventListener('change', e => {
        const file = e.target.files[0];
        e.target.value = '';
        uploadFile(file);
    });
    document.getElementById('classes-dialog-form')?.addEventListener('submit', submitDialog);
    document.getElementById('classes-dialog-cancel')?.addEventListener('click', () => document.getElementById('classes-dialog').close());

    // Opening the page, or coming back to the tab, picks up people joining and leaving
    document.querySelector('.dock-item[data-tab="classes"]')?.addEventListener('click', () => {
        if (state.started) loadAll();
        else render();
    });
    const layoutEl = document.getElementById('classes-layout');
    if (layoutEl && window.ResizeObserver) new ResizeObserver(realignSliders).observe(layoutEl);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.started && Date.now() - state.loadedAt > 20000) loadAll();
    });
    setInterval(() => {
        if (state.started && document.visibilityState === 'visible' && document.getElementById('classes')?.classList.contains('active-view')) loadAll();
    }, 60000);

    window.Classes = {
        start,
        stop,
        render,
        notificationItems,
        renderNotificationList
    };
})();
