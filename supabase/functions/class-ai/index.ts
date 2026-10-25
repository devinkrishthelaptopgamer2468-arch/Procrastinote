// Procrastinote: class-ai Edge Function
// Lets students without their own Groq key use the AI helper with the keys their classmates
// shared with the class (supabase/add-class-ai.sql). The keys never reach anyone's browser:
// the site sends the question here, this function checks who is asking and their daily
// allowance, asks Groq with one of the class's keys, and sends back only the answer.
//
// Called by the website with the student's login (keep "Verify JWT" ON for this function):
//   POST { prompt: "...", system?: "...", classId?: "<class uuid>" }
//     -> { reply, used, limit } or { error: 'no_key' | 'limit' | 'busy' | ..., message }
//   POST { action: "add_key", classId: "<class uuid>", key: "gsk_..." }
//     -> { ok: true, hint } or { error, message }   (the key is checked with Groq first)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Paste this whole file into the dashboard editor (one file, nothing else needed).

import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Same models as the website; each has its own free limits, so a busy one passes to the next
const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const MAX_PROMPT = 12000;
const KEY_FORMAT = /^gsk_[A-Za-z0-9]{20,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SYSTEM = 'You are a helpful student assistant for an app called Procrastinote. Keep responses concise and encouraging.';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
});

// A short question costs 1 from the allowance; long jobs (flashcards from a note, reading a
// timetable) cost up to 4, because they use much more of the class's Groq limits
export const costOf = prompt => Math.min(4, 1 + Math.floor(prompt.length / 3000));

// One key, trying the models in turn: { reply } or { error: 'bad_key' | 'busy' | 'failed' }
export async function askGroq(fetchFn, key, system, prompt) {
    let lastStatus = 0;
    for (const model of MODELS) {
        const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
                ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {})
            })
        });
        lastStatus = res.status;
        if (res.status === 401 || res.status === 403) return { error: 'bad_key' };
        if (res.status === 429 || res.status === 404 || res.status >= 500) continue; // try the next model
        const data = await res.json().catch(() => ({}));
        const reply = data?.choices?.[0]?.message?.content;
        if (reply) return { reply };
        if (data?.error?.code === 'model_not_found' || data?.error?.code === 'model_decommissioned') continue;
        return { error: 'failed' };
    }
    return { error: lastStatus === 429 ? 'busy' : 'failed' };
}

// Is this a working Groq key? (asks Groq for its model list, which costs nothing)
export async function checkGroqKey(fetchFn, key) {
    const res = await fetchFn('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${key}` } });
    if (res.status === 200) return 'ok';
    if (res.status === 401 || res.status === 403) return 'bad';
    return 'unknown';
}

async function addKey(deps, userId, body) {
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const classId = typeof body.classId === 'string' && UUID.test(body.classId) ? body.classId : null;
    if (!classId) return json({ error: 'class', message: 'Pick a class first.' }, 400);
    if (!KEY_FORMAT.test(key)) return json({ error: 'format', message: 'That doesn\'t look like a Groq key. It starts with gsk_.' }, 400);
    const check = await checkGroqKey(deps.fetchFn, key);
    if (check === 'bad') return json({ error: 'bad_key', message: 'Groq says this key doesn\'t work. Copy it again from console.groq.com (API Keys).' });
    if (check !== 'ok') return json({ error: 'check', message: 'Couldn\'t check the key with Groq just now. Try again in a minute.' });
    const saved = await deps.addKey(userId, classId, key);
    const messages = {
        not_member: 'You can only share a key with a class you\'re in.',
        not_approved: 'This class isn\'t ready yet.',
        full: 'This class already has 10 shared keys, which is plenty.',
        format: 'That doesn\'t look like a Groq key. It starts with gsk_.'
    };
    if (saved.error) return json({ error: saved.error, message: messages[saved.error] || 'Couldn\'t save the key. Try again.' });
    return json({ ok: true, hint: saved.hint });
}

// deps: { getUserId(authHeader) -> id | null, useAllowance(userId, classId, cost) -> rpc result,
//         addKey(userId, classId, key) -> rpc result, markBroken(keyId), fetchFn }
export async function handleRequest(req, deps) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    const userId = await deps.getUserId(req.headers.get('Authorization') || '');
    if (!userId) return json({ error: 'login', message: 'Log in to use your class AI.' }, 401);

    const body = await req.json().catch(() => ({}));
    if (body.action === 'add_key') return addKey(deps, userId, body);

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const system = typeof body.system === 'string' && body.system.trim() ? body.system.slice(0, 2000) : DEFAULT_SYSTEM;
    const classId = typeof body.classId === 'string' && UUID.test(body.classId) ? body.classId : null;
    if (!prompt) return json({ error: 'empty', message: 'Ask something first.' }, 400);
    if (prompt.length > MAX_PROMPT) return json({ error: 'too_long', message: 'That is too long for the class AI. Try a shorter note.' }, 400);

    const cost = costOf(prompt);
    const take = await deps.useAllowance(userId, classId, cost);
    if (take.error === 'no_key') return json({ error: 'no_key', message: 'None of your classes has an AI key yet.' });
    if (take.error === 'limit') {
        return json({ error: 'limit', used: take.used, limit: take.limit,
            message: `You've used your ${take.limit} AI questions for today from your class. They come back tomorrow.` });
    }
    if (take.error || !Array.isArray(take.keys)) return json({ error: 'failed', message: 'Something went wrong. Try again.' }, 500);

    // The keys come in a random order, so they take turns; a busy or broken one passes to the next
    let lastError = 'failed';
    for (const k of take.keys) {
        const answer = await askGroq(deps.fetchFn, k.key, system, prompt);
        if (answer.reply) return json({ reply: answer.reply, used: take.used, limit: take.limit });
        if (answer.error === 'bad_key') await deps.markBroken(k.id); // its owner sees it on the class page
        else lastError = answer.error;
    }

    // Not answered: give the allowance back
    await deps.useAllowance(userId, take.class_id, -cost);
    const messages = {
        busy: 'The class AI is busy right now (its free limit is used up for a bit). Try again in a minute.',
        failed: 'The AI couldn\'t answer just now. Try again.'
    };
    return json({ error: lastError, message: messages[lastError] || messages.failed });
}

if (typeof Deno !== 'undefined') {
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
        auth: { persistSession: false }
    });
    const rpc = async (name, args) => {
        const { data, error } = await admin.rpc(name, args);
        if (error) {
            console.error(`${name} failed:`, error.message);
            return { error: 'failed' };
        }
        return data ?? {};
    };
    const deps = {
        fetchFn: fetch,
        async getUserId(authHeader) {
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!token) return null;
            const { data, error } = await admin.auth.getUser(token);
            return error ? null : data.user?.id || null;
        },
        useAllowance: (userId, classId, cost) => rpc('use_class_ai', { p_user: userId, p_class: classId, p_cost: cost }),
        addKey: (userId, classId, key) => rpc('add_class_ai_key', { p_user: userId, p_class: classId, p_key: key }),
        markBroken: keyId => rpc('mark_class_ai_key_broken', { p_key_id: keyId })
    };
    Deno.serve(req => handleRequest(req, deps).catch(err => {
        console.error(err);
        return json({ error: 'failed', message: 'Something went wrong. Try again.' }, 500);
    }));
}
