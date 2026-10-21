-- Procrastinote: phone notifications when the site is closed (part 1 of the Supabase setup)
-- Paste this whole file into Supabase > SQL Editor > New query, then press "Run".
-- It is safe to run again. Supabase may warn about "destructive operations": that's only the
-- "drop policy if exists" lines, which remove and recreate this feature's own rules.
--
-- Each phone that turns notifications on gets one row: where to send pushes (endpoint + keys,
-- created by the phone's browser) and what that person wants to hear about.
-- The send-push Edge Function reads these rows to send notifications.

create table if not exists public.push_subscriptions (
    id bigint generated always as identity primary key,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    endpoint text not null unique check (endpoint like 'https://%' and char_length(endpoint) < 1000),
    p256dh text not null check (char_length(p256dh) < 200),
    auth text not null check (char_length(auth) < 100),
    -- { "friends": true, "classes": true, "homework": true, "reminderTime": "18:00" }
    prefs jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object' and pg_column_size(prefs) < 2000),
    timezone text not null default 'Asia/Kolkata' check (char_length(timezone) < 60),
    last_reminded_on date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- People can only see their own phones. Changes go through the two functions below.
drop policy if exists "Users can see their own push subscriptions" on public.push_subscriptions;
create policy "Users can see their own push subscriptions" on public.push_subscriptions
    for select to authenticated
    using (user_id = auth.uid());

-- Save (or update) this phone for the logged-in account. If someone else used this phone
-- before, their old row is replaced, so notifications go to whoever is logged in now.
create or replace function public.save_push_subscription(
    p_endpoint text, p_p256dh text, p_auth text, p_prefs jsonb, p_timezone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Log in first';
    end if;
    delete from public.push_subscriptions where endpoint = p_endpoint and user_id <> auth.uid();
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, prefs, timezone)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, coalesce(p_prefs, '{}'::jsonb), coalesce(nullif(p_timezone, ''), 'Asia/Kolkata'))
    on conflict (endpoint) do update set
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        prefs = excluded.prefs,
        timezone = excluded.timezone,
        updated_at = now();
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
    delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke execute on function public.save_push_subscription(text, text, text, jsonb, text) from public, anon;
revoke execute on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, jsonb, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
