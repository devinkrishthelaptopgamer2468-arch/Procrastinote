// Procrastinote: class-ai Edge Function
// Lets students without their own Groq key use the AI helper with their class's key
// (supabase/add-class-ai.sql). The key never reaches the browser: the site sends the question
// here, this function checks who is asking and their daily allowance, asks Groq, and sends back
// only the answer.
//
// Called by the website with the student's login (keep "Verify JWT" ON for this function):
//   POST { prompt: "...", system?: "...", classId?: "<class uuid>" }
//   -> { reply, used, limit } or { error: 'no_key' | 'limit' | 'busy' | 'bad_key' | ..., message }
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
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
const DEFAULT_SYSTEM = 'You are a helpful student assistant for an app called Procrastinote. Keep responses concise and encouraging.';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
});

// A short question costs 1 from the allowance; long jobs (flashcards from a note, reading a
// timetable) cost up to 4, because they use much more of the class's Groq limits
export const costOf = prompt => Math.min(4, 1 + Math.floor(prompt.length / 3000));

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
        return { error: 'failed', message: data?.error?.message || 'Empty answer' };
    }
    return { error: lastStatus === 429 ? 'busy' : 'failed' };
}

// deps: { getUserId(authHeader) -> id | null, useAllowance(userId, classId, cost) -> rpc result,
//         fetchFn }
export async function handleRequest(req, deps) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    const userId = await deps.getUserId(req.headers.get('Authorization') || '');
    if (!userId) return json({ error: 'login', message: 'Log in to use your class AI key.' }, 401);

    const body = await req.json().catch(() => ({}));
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const system = typeof body.system === 'string' && body.system.trim() ? body.system.slice(0, 2000) : DEFAULT_SYSTEM;
    const classId = typeof body.classId === 'string' && /^[0-9a-f-]{36}$/i.test(body.classId) ? body.classId : null;
    if (!prompt) return json({ error: 'empty', message: 'Ask something first.' }, 400);
    if (prompt.length > MAX_PROMPT) return json({ error: 'too_long', message: 'That is too long for the class AI. Try a shorter note.' }, 400);

    const cost = costOf(prompt);
    const take = await deps.useAllowance(userId, classId, cost);
    if (take.error === 'no_key') return json({ error: 'no_key', message: 'None of your classes has an AI key yet.' });
    if (take.error === 'limit') {
        return json({ error: 'limit', used: take.used, limit: take.limit,
            message: `You've used your ${take.limit} AI questions for today from your class. They come back tomorrow.` });
    }
    if (take.error) return json({ error: 'failed', message: 'Something went wrong. Try again.' }, 500);

    const answer = await askGroq(deps.fetchFn, take.key, system, prompt);
    if (answer.reply) return json({ reply: answer.reply, used: take.used, limit: take.limit });

    // Not answered: give the allowance back
    await deps.useAllowance(userId, take.class_id, -cost);
    const messages = {
        busy: 'The class AI is busy right now (its free limit is used up for a bit). Try again in a minute.',
        bad_key: 'Your class\'s AI key isn\'t working any more. Ask your class admin to add a new one.',
        failed: 'The AI couldn\'t answer just now. Try again.'
    };
    return json({ error: answer.error, message: messages[answer.error] || messages.failed });
}

if (typeof Deno !== 'undefined') {
    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
    const deps = {
        fetchFn: fetch,
        async getUserId(authHeader) {
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!token) return null;
            const { data, error } = await admin.auth.getUser(token);
            return error ? null : data.user?.id || null;
        },
        async useAllowance(userId, classId, cost) {
            const { data, error } = await admin.rpc('use_class_ai', { p_user: userId, p_class: classId, p_cost: cost });
            if (error) {
                console.error('use_class_ai failed:', error.message);
                return { error: 'failed' };
            }
            return data;
        }
    };
    Deno.serve(req => handleRequest(req, deps).catch(err => {
        console.error(err);
        return json({ error: 'failed', message: 'Something went wrong. Try again.' }, 500);
    }));
}
