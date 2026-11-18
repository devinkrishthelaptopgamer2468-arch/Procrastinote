// Procrastinote: delete-account Edge Function
// Deletes the account of whoever calls it, and everything that belongs to it:
//   1. classes they own are handed to another admin or member (a class with nobody else is
//      deleted), so classmates don't lose their class (hand_over_classes, add-account-deletion.sql)
//   2. files they uploaded or were sent are removed from Storage (account_storage_files)
//   3. the account itself is deleted. Their profile, planner, messages, class memberships,
//      notes and files they shared, phone notifications and everything else in the tables
//      goes with it, because those rows are set to "on delete cascade".
//
// Called by the website with the student's login (keep "Verify JWT" ON for this function):
//   POST { confirm: "DELETE" }  ->  { ok: true, classes: { handed_over, deleted }, files }
//                               or  { error, message }
// It only ever deletes the account that is logged in: the user id comes from the login token,
// never from the request body.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Paste this whole file into the dashboard editor (one file, nothing else needed).

import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
});

// Storage removes at most 1000 files per call
const BATCH = 1000;

// deps: { getUserId(authHeader) -> id | null, handOverClasses(userId) -> { handed_over, deleted } | { error },
//         listFiles(userId) -> [{ bucket_id, name }] | { error }, removeFiles(bucket, names) -> { error? },
//         deleteUser(userId) -> { error? } }
export async function handleRequest(req, deps) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    const userId = await deps.getUserId(req.headers.get('Authorization') || '');
    if (!userId) return json({ error: 'login', message: 'Log in again, then try deleting your account.' }, 401);

    const body = await req.json().catch(() => ({}));
    if (body.confirm !== 'DELETE') {
        return json({ error: 'confirm', message: 'Type DELETE to confirm.' }, 400);
    }

    // 1. Classes first, so classmates keep them
    const classes = await deps.handOverClasses(userId);
    if (classes?.error) {
        return json({ error: 'classes', message: 'Couldn\'t hand over your classes, so nothing was deleted. Try again.' }, 500);
    }

    // 2. Files in Storage (best effort: a file that can't be removed doesn't stop the deletion)
    let removed = 0;
    const files = await deps.listFiles(userId);
    if (Array.isArray(files)) {
        const byBucket = {};
        files.forEach(f => { (byBucket[f.bucket_id] ||= []).push(f.name); });
        for (const [bucket, names] of Object.entries(byBucket)) {
            for (let i = 0; i < names.length; i += BATCH) {
                const part = names.slice(i, i + BATCH);
                const result = await deps.removeFiles(bucket, part);
                if (!result?.error) removed += part.length;
            }
        }
    }

    // 3. The account, and with it every row that belongs to it
    const deleted = await deps.deleteUser(userId);
    if (deleted?.error) {
        return json({ error: 'delete', message: 'Couldn\'t delete your account just now. Try again in a minute.' }, 500);
    }
    return json({ ok: true, classes, files: removed });
}

if (typeof Deno !== 'undefined') {
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
        auth: { persistSession: false }
    });
    const deps = {
        async getUserId(authHeader) {
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!token) return null;
            const { data, error } = await admin.auth.getUser(token);
            return error ? null : data.user?.id || null;
        },
        async handOverClasses(userId) {
            const { data, error } = await admin.rpc('hand_over_classes', { p_user: userId });
            if (error) { console.error('hand_over_classes failed:', error.message); return { error: 'failed' }; }
            return data ?? { handed_over: 0, deleted: 0 };
        },
        async listFiles(userId) {
            const { data, error } = await admin.rpc('account_storage_files', { p_user: userId });
            if (error) { console.error('account_storage_files failed:', error.message); return { error: 'failed' }; }
            return data ?? [];
        },
        async removeFiles(bucket, names) {
            const { error } = await admin.storage.from(bucket).remove(names);
            if (error) console.error(`removing files from ${bucket} failed:`, error.message);
            return { error };
        },
        async deleteUser(userId) {
            const { error } = await admin.auth.admin.deleteUser(userId);
            if (error) console.error('deleteUser failed:', error.message);
            return { error };
        }
    };
    Deno.serve(req => handleRequest(req, deps).catch(err => {
        console.error(err);
        return json({ error: 'failed', message: 'Something went wrong. Try again.' }, 500);
    }));
}
