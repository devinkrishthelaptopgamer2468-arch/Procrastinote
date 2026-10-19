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
    publishableKey: 'sb_publishable_QkUL8INjcDCwR6M8ZHzphw_kF4jJGgv'  // public key, safe to share
};
