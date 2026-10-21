// Procrastinote: send-push Edge Function
// Sends phone notifications (Web Push) to the phones in public.push_subscriptions.
//
// It is called two ways (see supabase/add-push-triggers.sql), always with the
// "x-push-secret" header so nobody else can make it send notifications:
//   1. By database triggers when something happens:
//      { type: 'INSERT' | 'UPDATE', table, record, old_record }
//      messages / shared_files / shared_notes  -> the friend it was sent to
//      group_messages                          -> everyone in that class / activity / private chat
//      class_homework (new)                    -> everyone in the class
//      classes (timetable changed)             -> everyone in the class
//   2. Every 15 minutes by a schedule: { job: 'homework-reminders' }
//      -> each phone that wants it, once a day at its chosen time, if homework is due tomorrow
//
// Secrets (Supabase > Edge Functions > Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// PUSH_WEBHOOK_SECRET, and optionally VAPID_SUBJECT. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Paste this whole file into the dashboard editor (one file, nothing else needed).

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const SITE = 'https://procrastinote.vercel.app';

const short = (text, max = 140) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

async function profileByEmail(db, email) {
    const { data } = await db.from('profiles').select('id, name, email').eq('email', String(email).toLowerCase()).maybeSingle();
    return data;
}

async function profileById(db, id) {
    const { data } = await db.from('profiles').select('id, name, email').eq('id', id).maybeSingle();
    return data;
}

const displayName = (profile, fallback) => (profile?.name || '').trim() || fallback;

// The phones of these people that want this kind of notification (prefs[kind] not false)
async function phonesFor(db, userIds, kind) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return [];
    const { data, error } = await db.from('push_subscriptions').select('*').in('user_id', ids);
    if (error) throw error;
    return (data || []).filter(phone => phone.prefs?.[kind] !== false);
}

// Sends to every phone; phones that no longer accept notifications are removed
async function sendToPhones(db, send, phones, message) {
    let sent = 0;
    for (const phone of phones) {
        try {
            await send({ endpoint: phone.endpoint, keys: { p256dh: phone.p256dh, auth: phone.auth } }, JSON.stringify(message));
            sent++;
        } catch (err) {
            if (err?.statusCode === 404 || err?.statusCode === 410) {
                await db.from('push_subscriptions').delete().eq('id', phone.id);
            } else {
                console.error('Push failed:', err?.statusCode, err?.body || err?.message);
            }
        }
    }
    return sent;
}

async function classMemberIds(db, classId) {
    const { data } = await db.from('class_members').select('user_id').eq('class_id', classId);
    return (data || []).map(m => m.user_id);
}

async function chatRecipients(db, chat) {
    if (chat.kind === 'private') {
        const { data } = await db.from('chat_members').select('user_id').eq('chat_id', chat.id);
        return (data || []).map(m => m.user_id);
    }
    if (chat.kind === 'activity') {
        const { data } = await db.from('activity_members').select('user_id').eq('activity_id', chat.activity_id);
        return (data || []).map(m => m.user_id);
    }
    return classMemberIds(db, chat.class_id); // the class's General chat
}

export async function onDatabaseChange(db, send, { type, table, record, old_record }) {
    if (!record) return 0;

    if (table === 'messages' && type === 'INSERT') {
        const toEmail = record.member_a === record.sender_email ? record.member_b : record.member_a;
        const [to, from] = await Promise.all([profileByEmail(db, toEmail), profileByEmail(db, record.sender_email)]);
        if (!to) return 0;
        return sendToPhones(db, send, await phonesFor(db, [to.id], 'friends'), {
            title: displayName(from, 'A friend'),
            body: short(record.text),
            url: `/#open=chat&with=${encodeURIComponent(record.sender_email)}`,
            tag: `chat-${record.sender_email}`
        });
    }

    if (table === 'shared_files' && type === 'INSERT') {
        const from = await profileById(db, record.sender_id);
        return sendToPhones(db, send, await phonesFor(db, [record.recipient_id], 'friends'), {
            title: displayName(from, 'A friend'),
            body: `Sent a file: ${short(record.file_name, 80)}`,
            url: `/#open=chat&with=${encodeURIComponent(record.sender_email)}`,
            tag: `chat-${record.sender_email}`
        });
    }

    if (table === 'shared_notes' && type === 'INSERT') {
        const [to, from] = await Promise.all([profileByEmail(db, record.recipient_email), profileById(db, record.sender_id)]);
        if (!to) return 0;
        return sendToPhones(db, send, await phonesFor(db, [to.id], 'friends'), {
            title: `${displayName(from, 'A friend')} shared a note`,
            body: short(record.title || 'Untitled note', 80),
            url: '/#open=notes',
            tag: 'shared-notes'
        });
    }

    if (table === 'group_messages' && type === 'INSERT') {
        const { data: chat } = await db.from('chats').select('*').eq('id', record.chat_id).maybeSingle();
        if (!chat) return 0;
        const [recipients, sender] = await Promise.all([chatRecipients(db, chat), profileById(db, record.sender_id)]);
        let place = chat.name;
        if (chat.activity_id) {
            const { data: activity } = await db.from('activities').select('name').eq('id', chat.activity_id).maybeSingle();
            place = activity?.name || 'Activity';
        } else {
            const { data: cls } = await db.from('classes').select('name').eq('id', chat.class_id).maybeSingle();
            place = `${cls?.name || 'Class'} · ${chat.name}`;
        }
        return sendToPhones(db, send, await phonesFor(db, recipients.filter(id => id !== record.sender_id), 'classes'), {
            title: place,
            body: `${displayName(sender, 'Someone')}: ${short(record.text, 120)}`,
            url: '/#open=classes',
            tag: `class-chat-${record.chat_id}`
        });
    }

    if (table === 'class_homework' && type === 'INSERT') {
        const { data: cls } = await db.from('classes').select('name').eq('id', record.class_id).maybeSingle();
        const members = await classMemberIds(db, record.class_id);
        return sendToPhones(db, send, await phonesFor(db, members.filter(id => id !== record.created_by), 'classes'), {
            title: `New homework · ${cls?.name || 'Class'}`,
            body: `${record.subject}: ${short(record.task, 100)} (due ${record.due_date})`,
            url: '/#open=classes',
            tag: `class-homework-${record.class_id}`
        });
    }

    if (table === 'classes' && type === 'UPDATE' && record.status === 'approved' &&
        record.timetable_updated_at && record.timetable_updated_at !== old_record?.timetable_updated_at) {
        return sendToPhones(db, send, await phonesFor(db, await classMemberIds(db, record.id), 'classes'), {
            title: `${record.name}: timetable updated`,
            body: 'Open Classes to see the new timetable.',
            url: '/#open=classes',
            tag: `class-timetable-${record.id}`
        });
    }

    return 0;
}

// Date and time on a phone's clock, e.g. { date: '2026-10-21', minutes: 1080 } for 6:00 PM
function localClock(now, timeZone) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    } catch (e) {
        parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    }
    const get = type => parts.find(p => p.type === type)?.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const nextDay = date => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

const REMINDER_WINDOW_MINUTES = 180; // turned on at 11 PM with a 6 PM time: wait for tomorrow

export async function sendHomeworkReminders(db, send, now = new Date()) {
    const { data: phones, error } = await db.from('push_subscriptions').select('*');
    if (error) throw error;
    const planners = new Map(); // user_id -> homework list (several phones, one account)
    let sent = 0;
    for (const phone of phones || []) {
        if (phone.prefs?.homework === false) continue;
        const clock = localClock(now, phone.timezone || 'Asia/Kolkata');
        const [h, m] = /^\d{2}:\d{2}$/.test(phone.prefs?.reminderTime || '') ? phone.prefs.reminderTime.split(':').map(Number) : [18, 0];
        const late = clock.minutes - (h * 60 + m);
        if (late < 0 || late > REMINDER_WINDOW_MINUTES || phone.last_reminded_on === clock.date) continue;

        if (!planners.has(phone.user_id)) {
            const { data } = await db.from('planner_data').select('data').eq('user_id', phone.user_id).maybeSingle();
            planners.set(phone.user_id, Array.isArray(data?.data?.homework) ? data.data.homework : []);
        }
        await db.from('push_subscriptions').update({ last_reminded_on: clock.date }).eq('id', phone.id);
        const due = planners.get(phone.user_id).filter(hw => hw?.date === nextDay(clock.date));
        if (!due.length) continue;
        const names = due.slice(0, 3).map(hw => short(`${hw.subject ? `${hw.subject}: ` : ''}${hw.task}`, 60));
        sent += await sendToPhones(db, send, [phone], {
            title: due.length === 1 ? 'Homework due tomorrow' : `${due.length} homework due tomorrow`,
            body: names.join(', ') + (due.length > 3 ? ', …' : ''),
            url: '/#open=homework',
            tag: 'homework-reminder'
        });
    }
    return sent;
}

export async function handleRequest(req, { db, send, secret }) {
    if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
    if (!secret || req.headers.get('x-push-secret') !== secret) return new Response('Not allowed', { status: 401 });
    const body = await req.json().catch(() => ({}));
    const sent = body.job === 'homework-reminders'
        ? await sendHomeworkReminders(db, send)
        : await onDatabaseChange(db, send, body);
    return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
}

if (typeof Deno !== 'undefined') {
    webpush.setVapidDetails(
        Deno.env.get('VAPID_SUBJECT') || SITE,
        Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
        Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
    );
    const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
        auth: { persistSession: false }
    });
    const send = (subscription, payload) => webpush.sendNotification(subscription, payload, { TTL: 60 * 60 * 12 });
    Deno.serve(req => handleRequest(req, { db, send, secret: Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '' })
        .catch(err => {
            console.error(err);
            return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500 });
        }));
}
