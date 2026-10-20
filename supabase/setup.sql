-- Procrastinote online chat: database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then press "Run".
-- It is safe to run again if you change something later.

-- =========================================================
-- 1. Profiles: the name + class friends see next to your email
-- =========================================================
create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null unique,
    name text not null default '',
    class text not null default '',
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile" on public.profiles
    for select to authenticated
    using (id = auth.uid());

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles
    for update to authenticated
    using (id = auth.uid())
    with check (id = auth.uid() and email = lower(auth.jwt() ->> 'email'));

-- Create a profile automatically when someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email, name, class)
    values (
        new.id,
        lower(new.email),
        left(coalesce(new.raw_user_meta_data ->> 'name', ''), 80),
        left(coalesce(new.raw_user_meta_data ->> 'class', ''), 40)
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Look up friends by exact email. You must already know someone's email,
-- so nobody can download a list of every user.
create or replace function public.get_profiles(emails text[])
returns table (id uuid, email text, name text, class text)
language sql
stable
security definer
set search_path = ''
as $$
    select p.id, p.email, p.name, p.class
    from public.profiles p
    where auth.uid() is not null
      and p.email = any (select lower(e) from unnest(emails) as e)
    limit 200;
$$;

revoke execute on function public.get_profiles(text[]) from public, anon;
grant execute on function public.get_profiles(text[]) to authenticated;

-- =========================================================
-- 2. Messages between two friends
-- room_id matches the app's scheme: room_<emailA>_<emailB> (sorted)
-- =========================================================
create table if not exists public.messages (
    id bigint generated always as identity primary key,
    member_a text not null,
    member_b text not null,
    room_id text generated always as ('room_' || member_a || '_' || member_b) stored,
    sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    sender_email text not null,
    text text not null check (char_length(text) between 1 and 2000),
    created_at timestamptz not null default now(),
    check (member_a <> member_b),
    check (member_a = lower(member_a) and member_b = lower(member_b))
);

create index if not exists messages_room_idx on public.messages (room_id, created_at);

alter table public.messages enable row level security;

-- You can only read messages in rooms that include your own email
drop policy if exists "Members can read their rooms" on public.messages;
create policy "Members can read their rooms" on public.messages
    for select to authenticated
    using (lower(auth.jwt() ->> 'email') in (member_a, member_b));

-- You can only send as yourself, into a room that includes you
drop policy if exists "Members can send to their rooms" on public.messages;
create policy "Members can send to their rooms" on public.messages
    for insert to authenticated
    with check (
        sender_id = auth.uid()
        and sender_email = lower(auth.jwt() ->> 'email')
        and sender_email in (member_a, member_b)
    );

-- No update/delete policies: messages can't be edited or deleted by anyone using the app.

-- =========================================================
-- 3. Planner data: homework, timetable, notes, etc. for each account,
--    so the same account works on every device
-- =========================================================
create table if not exists public.planner_data (
    user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    check (pg_column_size(data) < 5000000) -- about 5 MB per account
);

alter table public.planner_data enable row level security;

-- Only you can read, create or change your own planner
drop policy if exists "Users can read their own planner" on public.planner_data;
create policy "Users can read their own planner" on public.planner_data
    for select to authenticated
    using (user_id = auth.uid());

drop policy if exists "Users can create their own planner" on public.planner_data;
create policy "Users can create their own planner" on public.planner_data
    for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists "Users can update their own planner" on public.planner_data;
create policy "Users can update their own planner" on public.planner_data
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- =========================================================
-- 4. Live updates: new messages are pushed to the app instantly
-- =========================================================
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
    ) then
        alter publication supabase_realtime add table public.messages;
    end if;
end;
$$;

-- =========================================================
-- 5. Sharing notes with friends (also in add-note-sharing.sql)
-- =========================================================
-- A shared note is a COPY sent from one account to another.
create table if not exists public.shared_notes (
    id bigint generated always as identity primary key,
    sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    sender_email text not null,
    recipient_email text not null,
    title text not null default '' check (char_length(title) <= 200),
    content text not null default '' check (char_length(content) <= 100000),
    images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and pg_column_size(images) < 20000),
    created_at timestamptz not null default now(),
    check (recipient_email = lower(recipient_email)),
    check (sender_email <> recipient_email)
);

create index if not exists shared_notes_recipient_idx on public.shared_notes (recipient_email, created_at desc);

alter table public.shared_notes enable row level security;

-- You can only share as yourself
drop policy if exists "Users can share notes as themselves" on public.shared_notes;
create policy "Users can share notes as themselves" on public.shared_notes
    for insert to authenticated
    with check (sender_id = auth.uid() and sender_email = lower(auth.jwt() ->> 'email'));

-- You can only see notes you sent or that were sent to you
drop policy if exists "Users can read notes shared with or by them" on public.shared_notes;
create policy "Users can read notes shared with or by them" on public.shared_notes
    for select to authenticated
    using (sender_id = auth.uid() or recipient_email = lower(auth.jwt() ->> 'email'));

-- The receiver can dismiss a shared note, and the sender can take it back
drop policy if exists "Users can remove notes shared with or by them" on public.shared_notes;
create policy "Users can remove notes shared with or by them" on public.shared_notes
    for delete to authenticated
    using (sender_id = auth.uid() or recipient_email = lower(auth.jwt() ->> 'email'));

-- No update policy: a shared note can't be changed after it is sent.

-- Live updates: a shared note appears for your friend instantly
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shared_notes'
    ) then
        alter publication supabase_realtime add table public.shared_notes;
    end if;
end;
$$;
