// Online accounts + friends chat (Supabase).
// Paste your values from Supabase > Project Settings > API Keys (see SUPABASE_SETUP.md).
//
// The publishable key is MEANT to be public: it is visible to anyone who opens the site,
// and the database security rules in supabase/setup.sql decide what it can do.
// NEVER put the "secret" or "service_role" key here. The app refuses to use one.
//
// Leave both empty to keep using local-only accounts (chat stays on this device).
window.PROCRASTINOTE_SUPABASE = {
    url: 'https://nyjhisnjsuhihjonktfc.supabase.co',
    publishableKey: 'sb_publishable_QkUL8INjcDCwR6M8ZHzphw_kF4jJGgv',  // public key, safe to share
    // Phone notifications when the site is closed: the PUBLIC half of the push key pair.
    // Set up in Supabase with SUPABASE_SETUP.md, section 10. It's safe to be public.
    // The private half only ever goes into Supabase's Edge Function secrets, never here.
    pushPublicKey: 'BKOYEEiN7SmAgyCARJ8DrkOALLiHt28gRPvstqK6N2R_Cb-9LQxhH4VnMJWfqLpz8NIGZcGBSAYbNXEeWNkgJhQ'
};
