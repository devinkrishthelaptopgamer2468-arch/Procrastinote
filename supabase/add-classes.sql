-- Procrastinote: Classes and activity groups
-- Paste this whole file into Supabase > SQL Editor > New query, then press "Run".
-- It is safe to run again. Run setup.sql first (it makes the profiles table this uses).
-- Supabase may warn about "destructive operations": that's only the "drop policy if exists"
-- and "drop trigger if exists" lines, which remove and recreate this feature's own rules.
-- No data is deleted.
--
-- How it works
-- * Only the site owner (is_site_owner below) can create classes. Then classmates join with
--   its 6-character code. The site owner hands each class to its admin straight away.
-- * A class owner can ask for co-admins or hand the class to someone else. The site owner
--   approves those.
-- * Admins publish the class timetable and post homework. Each class has a General chat plus up
--   to 15 invite-only chats (each member can make 1). Members share files (100 MB per class).
-- * Members start activity groups from a class, and that class's admin approves them. Then anyone
--   with the activity's code can join, from any class. Small = up to 5 people (1 point),
--   Big = up to 20 people (2 points); each person can hold 6 points of activity groups.
-- * Anyone can report a message to the site owner.
-- * In chats, @Name pings someone and @Procrasti-Bot gets a reply from the AI helper.
--
-- Most changes go through the functions below (security definer), which check the rules,
-- instead of letting the app write to the tables directly.

-- =========================================================
-- 1. The site owner: creates classes, approves role changes, handles reports.
--    (The app shows the approval panel to the same email.)
-- =========================================================
create or replace function public.is_site_owner()
returns boolean
language sql
stable
set search_path = ''
as $$
    select coalesce(lower(auth.jwt() ->> 'email') = 'devinthegamer2468@gmail.com', false);
$$;

-- =========================================================
-- 2. Tables
-- =========================================================
create table if not exists public.classes (
    id uuid primary key default gen_random_uuid(),
    school text not null default 'Heartfulness International School, Kolapakkam',
    name text not null check (char_length(btrim(name)) between 1 and 60),
    code text not null unique,
    owner_id uuid not null references auth.users (id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    -- { "totalDays": 6, "timetable": { "1": [8 subjects], ... }, "uniforms": { "1": "Regular Uniform", ... } }
    timetable jsonb check (timetable is null or pg_column_size(timetable) < 20000),
    timetable_updated_at timestamptz,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists public.class_members (
    class_id uuid not null references public.classes (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'admin', 'member')),
    joined_at timestamptz not null default now(),
    primary key (class_id, user_id)
);

create index if not exists class_members_user_idx on public.class_members (user_id);

-- Making a co-admin or handing the class over waits for the site owner
create table if not exists public.class_requests (
    id bigint generated always as identity primary key,
    class_id uuid not null references public.classes (id) on delete cascade,
    kind text not null check (kind in ('make_admin', 'transfer_owner')),
    target_id uuid not null references auth.users (id) on delete cascade,
    requested_by uuid not null references auth.users (id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now(),
    reviewed_at timestamptz
);

create unique index if not exists class_requests_one_pending_idx
    on public.class_requests (class_id, kind, target_id) where status = 'pending';
create unique index if not exists class_requests_one_transfer_idx
    on public.class_requests (class_id) where status = 'pending' and kind = 'transfer_owner';

create table if not exists public.activities (
    id uuid primary key default gen_random_uuid(),
    class_id uuid not null references public.classes (id) on delete cascade, -- its admin approves it
    name text not null check (char_length(btrim(name)) between 1 and 60),
    code text not null unique,
    owner_id uuid not null references auth.users (id) on delete cascade,
    size text not null check (size in ('small', 'big')),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists activities_class_idx on public.activities (class_id);
create index if not exists activities_owner_idx on public.activities (owner_id);

create table if not exists public.activity_members (
    activity_id uuid not null references public.activities (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'member')),
    joined_at timestamptz not null default now(),
    primary key (activity_id, user_id)
);

create index if not exists activity_members_user_idx on public.activity_members (user_id);

-- general: everyone in the class. private: only the people its maker picked.
-- activity: everyone in the activity group.
create table if not exists public.chats (
    id uuid primary key default gen_random_uuid(),
    class_id uuid references public.classes (id) on delete cascade,
    activity_id uuid references public.activities (id) on delete cascade,
    kind text not null check (kind in ('general', 'private', 'activity')),
    name text not null check (char_length(btrim(name)) between 1 and 40),
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    check (
        (kind = 'activity' and activity_id is not null and class_id is null)
        or (kind <> 'activity' and class_id is not null and activity_id is null)
    )
);

create unique index if not exists chats_one_general_idx on public.chats (class_id) where kind = 'general';
create unique index if not exists chats_one_per_activity_idx on public.chats (activity_id) where kind = 'activity';
create unique index if not exists chats_one_private_each_idx on public.chats (class_id, created_by) where kind = 'private';

create table if not exists public.chat_members (
    chat_id uuid not null references public.chats (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    primary key (chat_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members (user_id);

create table if not exists public.group_messages (
    id bigint generated always as identity primary key,
    chat_id uuid not null references public.chats (id) on delete cascade,
    sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    text text not null check (char_length(text) between 1 and 2000),
    created_at timestamptz not null default now()
);

create index if not exists group_messages_chat_idx on public.group_messages (chat_id, created_at);

-- Pings: the people a message @mentions (they get a notification).
-- bot: a Procrasti-Bot reply, written by the device of the person who pinged the bot
-- (sender_id is still that person, so nobody can post as someone else).
alter table public.group_messages add column if not exists mentions uuid[] not null default '{}';
alter table public.group_messages add column if not exists bot boolean not null default false;
alter table public.group_messages drop constraint if exists group_messages_mentions_limit;
alter table public.group_messages add constraint group_messages_mentions_limit check (cardinality(mentions) <= 20);
create index if not exists group_messages_mentions_idx on public.group_messages using gin (mentions);

create table if not exists public.class_homework (
    id bigint generated always as identity primary key,
    class_id uuid not null references public.classes (id) on delete cascade,
    task text not null check (char_length(btrim(task)) between 1 and 300),
    subject text not null check (char_length(subject) between 1 and 40),
    due_date date not null,
    created_by uuid default auth.uid() references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists class_homework_class_idx on public.class_homework (class_id, due_date);

-- One row per uploaded file. The file itself is in the private "class-files" storage bucket
-- at <class|activity>/<its id>/<uploader's account id>/<file>.
create table if not exists public.group_files (
    id bigint generated always as identity primary key,
    class_id uuid references public.classes (id) on delete cascade,
    activity_id uuid references public.activities (id) on delete cascade,
    uploaded_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
    path text not null unique,
    file_name text not null check (char_length(file_name) between 1 and 200),
    mime_type text not null,
    size_bytes integer not null check (size_bytes between 1 and 10485760),
    created_at timestamptz not null default now(),
    check ((class_id is null) <> (activity_id is null))
);

create index if not exists group_files_class_idx on public.group_files (class_id);
create index if not exists group_files_activity_idx on public.group_files (activity_id);

-- A report keeps a copy of the message, so the site owner can read it without joining the chat
create table if not exists public.message_reports (
    id bigint generated always as identity primary key,
    message_id bigint references public.group_messages (id) on delete set null,
    reporter_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    sender_id uuid references auth.users (id) on delete set null,
    place text not null default '',
    message_text text not null,
    reason text not null default '' check (char_length(reason) <= 300),
    status text not null default 'open' check (status in ('open', 'resolved')),
    created_at timestamptz not null default now(),
    unique (message_id, reporter_id)
);

-- Wrong join codes, so nobody can guess codes by trying thousands of them
create table if not exists public.code_attempts (
    user_id uuid not null references auth.users (id) on delete cascade,
    attempted_at timestamptz not null default now()
);

create index if not exists code_attempts_user_idx on public.code_attempts (user_id, attempted_at);

-- =========================================================
-- 3. Helpers the security rules use
-- =========================================================
create or replace function public.class_role(p_class uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select m.role from public.class_members m where m.class_id = p_class and m.user_id = auth.uid();
$$;

create or replace function public.is_class_member(p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.class_members m where m.class_id = p_class and m.user_id = auth.uid());
$$;

create or replace function public.is_class_admin(p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.class_members m
        where m.class_id = p_class and m.user_id = auth.uid() and m.role in ('owner', 'admin')
    );
$$;

create or replace function public.is_activity_member(p_activity uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.activity_members m where m.activity_id = p_activity and m.user_id = auth.uid());
$$;

-- The activity's maker, an admin of the class it was started from, or the site owner
create or replace function public.can_manage_activity(p_activity uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.is_site_owner() or exists (
        select 1 from public.activities a
        where a.id = p_activity and (a.owner_id = auth.uid() or public.is_class_admin(a.class_id))
    );
$$;

create or replace function public.can_use_chat(p_chat uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.chats c
        where c.id = p_chat and (
            (c.kind = 'general' and public.is_class_member(c.class_id))
            or (c.kind = 'private' and public.is_class_member(c.class_id) and exists (
                select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = auth.uid()))
            or (c.kind = 'activity' and public.is_activity_member(c.activity_id))
        )
    );
$$;

-- Who can delete other people's messages in a chat
create or replace function public.can_moderate_chat(p_chat uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.is_site_owner() or exists (
        select 1 from public.chats c
        where c.id = p_chat and (
            (c.class_id is not null and public.is_class_admin(c.class_id))
            or (c.activity_id is not null and public.can_manage_activity(c.activity_id))
        )
    );
$$;

-- Storage folders: <class|activity>/<its id>/...
create or replace function public.can_read_group_folder(p_kind text, p_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_kind = 'class' then
        return public.is_class_member(p_id::uuid);
    elsif p_kind = 'activity' then
        return public.is_activity_member(p_id::uuid);
    end if;
    return false;
exception when invalid_text_representation then
    return false;
end;
$$;

create or replace function public.can_manage_group_folder(p_kind text, p_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_kind = 'class' then
        return public.is_site_owner() or public.is_class_admin(p_id::uuid);
    elsif p_kind = 'activity' then
        return public.can_manage_activity(p_id::uuid);
    end if;
    return false;
exception when invalid_text_representation then
    return false;
end;
$$;

-- Bytes stored for one class or activity (counted from the files themselves)
create or replace function public.group_storage_used(p_kind text, p_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
    from storage.objects o
    where o.bucket_id = 'class-files' and o.name like p_kind || '/' || p_id::text || '/%';
$$;

-- Members of an approved class or activity can upload until it holds 100 MB
create or replace function public.can_upload_group_file(p_kind text, p_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_id uuid;
begin
    v_id := p_id::uuid; -- inside begin, so a broken folder name is caught below
    if p_kind = 'class' then
        if not public.is_class_member(v_id)
           or not exists (select 1 from public.classes c where c.id = v_id and c.status = 'approved') then
            return false;
        end if;
    elsif p_kind = 'activity' then
        if not public.is_activity_member(v_id)
           or not exists (select 1 from public.activities a where a.id = v_id and a.status = 'approved') then
            return false;
        end if;
    else
        return false;
    end if;
    return public.group_storage_used(p_kind, v_id) < 104857600;
exception when invalid_text_representation then
    return false;
end;
$$;

-- A new random code like K7QM2X (no 0/O or 1/I, so it's easy to read out)
create or replace function public.new_group_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
    v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_bytes bytea;
    v_code text;
begin
    loop
        v_bytes := uuid_send(gen_random_uuid());
        v_code := '';
        for i in 0..5 loop
            v_code := v_code || substr(v_alphabet, 1 + get_byte(v_bytes, i) % 32, 1);
        end loop;
        exit when not exists (select 1 from public.classes c where c.code = v_code)
              and not exists (select 1 from public.activities a where a.code = v_code);
    end loop;
    return v_code;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists class_homework_touch on public.class_homework;
create trigger class_homework_touch
    before update on public.class_homework
    for each row execute function public.touch_updated_at();

-- =========================================================
-- 4. Security rules (Row Level Security)
-- =========================================================
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.class_requests enable row level security;
alter table public.activities enable row level security;
alter table public.activity_members enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.group_messages enable row level security;
alter table public.class_homework enable row level security;
alter table public.group_files enable row level security;
alter table public.message_reports enable row level security;
alter table public.code_attempts enable row level security; -- no rules: only the functions below use it

-- Classes: members see their class (and its code). Created and changed only by the functions below.
drop policy if exists "Members can see their classes" on public.classes;
create policy "Members can see their classes" on public.classes
    for select to authenticated
    using (public.is_class_member(id) or public.is_site_owner());

drop policy if exists "Owners can delete their class" on public.classes;
create policy "Owners can delete their class" on public.classes
    for delete to authenticated
    using (owner_id = auth.uid() or public.is_site_owner());

drop policy if exists "Members can see who is in their class" on public.class_members;
create policy "Members can see who is in their class" on public.class_members
    for select to authenticated
    using (public.is_class_member(class_id) or public.is_site_owner());

drop policy if exists "Admins can see role requests" on public.class_requests;
create policy "Admins can see role requests" on public.class_requests
    for select to authenticated
    using (public.is_class_admin(class_id) or public.is_site_owner());

drop policy if exists "Members and class admins can see activities" on public.activities;
create policy "Members and class admins can see activities" on public.activities
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.is_activity_member(id)
        or public.is_class_admin(class_id)
        or public.is_site_owner()
    );

drop policy if exists "Managers can delete activities" on public.activities;
create policy "Managers can delete activities" on public.activities
    for delete to authenticated
    using (public.can_manage_activity(id));

drop policy if exists "Members can see who is in their activity" on public.activity_members;
create policy "Members can see who is in their activity" on public.activity_members
    for select to authenticated
    using (public.is_activity_member(activity_id) or public.can_manage_activity(activity_id));

-- Class admins can see that private chats exist (to delete unused ones) but not read them
drop policy if exists "Members can see their chats" on public.chats;
create policy "Members can see their chats" on public.chats
    for select to authenticated
    using (public.can_use_chat(id) or (class_id is not null and public.is_class_admin(class_id)));

drop policy if exists "Makers and admins can delete private chats" on public.chats;
create policy "Makers and admins can delete private chats" on public.chats
    for delete to authenticated
    using (kind = 'private' and (created_by = auth.uid() or public.is_class_admin(class_id)));

drop policy if exists "Members can see who is in their chats" on public.chat_members;
create policy "Members can see who is in their chats" on public.chat_members
    for select to authenticated
    using (public.can_use_chat(chat_id));

-- You can leave a private chat (its maker deletes it instead)
drop policy if exists "Members can leave chats" on public.chat_members;
create policy "Members can leave chats" on public.chat_members
    for delete to authenticated
    using (
        user_id = auth.uid()
        and not exists (select 1 from public.chats c where c.id = chat_id and c.created_by = auth.uid())
    );

drop policy if exists "Members can read their chats" on public.group_messages;
create policy "Members can read their chats" on public.group_messages
    for select to authenticated
    using (public.can_use_chat(chat_id));

drop policy if exists "Members can send to their chats" on public.group_messages;
create policy "Members can send to their chats" on public.group_messages
    for insert to authenticated
    with check (sender_id = auth.uid() and public.can_use_chat(chat_id));

drop policy if exists "Senders and admins can delete messages" on public.group_messages;
create policy "Senders and admins can delete messages" on public.group_messages
    for delete to authenticated
    using (sender_id = auth.uid() or public.can_moderate_chat(chat_id));

-- No update rules: messages can't be edited.

drop policy if exists "Members can see class homework" on public.class_homework;
create policy "Members can see class homework" on public.class_homework
    for select to authenticated
    using (public.is_class_member(class_id));

drop policy if exists "Admins can post class homework" on public.class_homework;
create policy "Admins can post class homework" on public.class_homework
    for insert to authenticated
    with check (
        created_by = auth.uid()
        and public.is_class_admin(class_id)
        and exists (select 1 from public.classes c where c.id = class_id and c.status = 'approved')
    );

drop policy if exists "Admins can change class homework" on public.class_homework;
create policy "Admins can change class homework" on public.class_homework
    for update to authenticated
    using (public.is_class_admin(class_id))
    with check (public.is_class_admin(class_id));

drop policy if exists "Admins can delete class homework" on public.class_homework;
create policy "Admins can delete class homework" on public.class_homework
    for delete to authenticated
    using (public.is_class_admin(class_id));

drop policy if exists "Members can see group files" on public.group_files;
create policy "Members can see group files" on public.group_files
    for select to authenticated
    using (
        uploaded_by = auth.uid()
        or (class_id is not null and (public.is_class_member(class_id) or public.is_site_owner()))
        or (activity_id is not null and (public.is_activity_member(activity_id) or public.can_manage_activity(activity_id)))
    );

drop policy if exists "Uploaders and admins can delete group files" on public.group_files;
create policy "Uploaders and admins can delete group files" on public.group_files
    for delete to authenticated
    using (
        uploaded_by = auth.uid()
        or (class_id is not null and (public.is_class_admin(class_id) or public.is_site_owner()))
        or (activity_id is not null and public.can_manage_activity(activity_id))
    );

drop policy if exists "Reporters and the site owner can see reports" on public.message_reports;
create policy "Reporters and the site owner can see reports" on public.message_reports
    for select to authenticated
    using (reporter_id = auth.uid() or public.is_site_owner());

-- =========================================================
-- 5. File storage: a PRIVATE bucket, up to 10 MB per file;
--    photos, PDF, Word, PowerPoint, Excel and text files only
-- =========================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'class-files', 'class-files', false, 10485760,
    array[
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'application/pdf', 'text/plain',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
)
on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Class files: members upload" on storage.objects;
create policy "Class files: members upload" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'class-files'
        and (storage.foldername(name))[3] = auth.uid()::text
        and public.can_upload_group_file((storage.foldername(name))[1], (storage.foldername(name))[2])
    );

drop policy if exists "Class files: members open" on storage.objects;
create policy "Class files: members open" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'class-files' and (
            (storage.foldername(name))[3] = auth.uid()::text
            or public.can_read_group_folder((storage.foldername(name))[1], (storage.foldername(name))[2])
            or public.can_manage_group_folder((storage.foldername(name))[1], (storage.foldername(name))[2])
        )
    );

drop policy if exists "Class files: uploader or admin removes" on storage.objects;
create policy "Class files: uploader or admin removes" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'class-files' and (
            (storage.foldername(name))[3] = auth.uid()::text
            or public.can_manage_group_folder((storage.foldername(name))[1], (storage.foldername(name))[2])
        )
    );

-- =========================================================
-- 6. What the app calls
-- =========================================================

-- Create a class. Only the site owner can; it's ready to join straight away.
create or replace function public.create_class(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_id uuid;
    v_name text := btrim(coalesce(p_name, ''));
begin
    if not public.is_site_owner() then
        raise exception 'Only the Procrastinote team can create classes. Ask your class admin for your class code.';
    end if;
    if char_length(v_name) not between 1 and 60 then
        raise exception 'Give the class a name (up to 60 letters).';
    end if;
    insert into public.classes (name, code, owner_id, status, reviewed_at)
    values (v_name, public.new_group_code(), auth.uid(), 'approved', now())
    returning id into v_id;
    insert into public.class_members (class_id, user_id, role) values (v_id, auth.uid(), 'owner');
    insert into public.chats (class_id, kind, name, created_by) values (v_id, 'general', 'General', auth.uid());
    return v_id;
end;
$$;

-- Join a class or an activity group with its code. Returns { kind, id }, or null if no group
-- uses that code. 10 wrong codes in an hour pauses joining for that account.
create or replace function public.join_with_code(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
    v_class public.classes;
    v_activity public.activities;
    v_limit int;
begin
    if auth.uid() is null then
        raise exception 'Log in first.';
    end if;
    if (select count(*) from public.code_attempts a
        where a.user_id = auth.uid() and a.attempted_at > now() - interval '1 hour') >= 10 then
        raise exception 'Too many wrong codes. Try again in an hour.';
    end if;

    select * into v_class from public.classes c where c.code = v_code;
    if found then
        if v_class.status = 'pending' and not public.is_class_member(v_class.id) then
            raise exception 'That class is still waiting for approval. Try again later.';
        elsif v_class.status = 'rejected' then
            raise exception 'That class wasn''t approved, so nobody can join it.';
        end if;
        insert into public.class_members (class_id, user_id) values (v_class.id, auth.uid())
        on conflict do nothing;
        return jsonb_build_object('kind', 'class', 'id', v_class.id);
    end if;

    select * into v_activity from public.activities a where a.code = v_code for update;
    if found then
        if public.is_activity_member(v_activity.id) then
            return jsonb_build_object('kind', 'activity', 'id', v_activity.id);
        end if;
        if v_activity.status <> 'approved' then
            raise exception 'That activity group is still waiting for its class admin to approve it.';
        end if;
        v_limit := case v_activity.size when 'big' then 20 else 5 end;
        if (select count(*) from public.activity_members m where m.activity_id = v_activity.id) >= v_limit then
            raise exception 'That activity group is full (% people).', v_limit;
        end if;
        insert into public.activity_members (activity_id, user_id) values (v_activity.id, auth.uid());
        return jsonb_build_object('kind', 'activity', 'id', v_activity.id);
    end if;

    delete from public.code_attempts a where a.user_id = auth.uid() and a.attempted_at < now() - interval '1 day';
    insert into public.code_attempts (user_id) values (auth.uid());
    return null;
end;
$$;

-- A new code for a class or activity (the old one stops working)
create or replace function public.regenerate_code(p_kind text, p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_code text := public.new_group_code();
begin
    if p_kind = 'class' and (public.is_class_admin(p_id) or public.is_site_owner()) then
        update public.classes set code = v_code where id = p_id;
    elsif p_kind = 'activity' and public.can_manage_activity(p_id) then
        update public.activities set code = v_code where id = p_id;
    else
        raise exception 'Only an admin can make a new code.';
    end if;
    return v_code;
end;
$$;

-- Removes someone from a class, from its private chats, and deletes the private chat they made
create or replace function public.drop_class_member(p_class uuid, p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    delete from public.chats c where c.class_id = p_class and c.kind = 'private' and c.created_by = p_user;
    delete from public.chat_members cm using public.chats c
        where cm.chat_id = c.id and c.class_id = p_class and cm.user_id = p_user;
    delete from public.class_requests r where r.class_id = p_class and r.target_id = p_user and r.status = 'pending';
    delete from public.class_members m where m.class_id = p_class and m.user_id = p_user;
end;
$$;

create or replace function public.leave_class(p_class uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if public.class_role(p_class) = 'owner' then
        raise exception 'You own this class. Hand it over to someone first, or delete the class.';
    end if;
    perform public.drop_class_member(p_class, auth.uid());
end;
$$;

create or replace function public.remove_class_member(p_class uuid, p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mine text := coalesce(public.class_role(p_class), '');
    v_theirs text;
begin
    select m.role into v_theirs from public.class_members m where m.class_id = p_class and m.user_id = p_user;
    if v_theirs is null then
        return;
    end if;
    if v_mine not in ('owner', 'admin') and not public.is_site_owner() then
        raise exception 'Only admins can remove people.';
    end if;
    if v_theirs = 'owner' then
        raise exception 'The owner can''t be removed.';
    end if;
    if v_theirs = 'admin' and v_mine <> 'owner' and not public.is_site_owner() then
        raise exception 'Only the owner can remove a co-admin.';
    end if;
    perform public.drop_class_member(p_class, p_user);
end;
$$;

-- The owner asks to make someone a co-admin, or to hand the class over. The site owner decides.
-- When the site owner does it (e.g. handing a new class to its admin), it happens straight away.
create or replace function public.request_class_role(p_class uuid, p_user uuid, p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_theirs text;
    v_old_owner uuid;
begin
    if coalesce(public.class_role(p_class), '') <> 'owner' and not public.is_site_owner() then
        raise exception 'Only the class owner can do this.';
    end if;
    if p_kind not in ('make_admin', 'transfer_owner') then
        raise exception 'Unknown request.';
    end if;
    select m.role into v_theirs from public.class_members m where m.class_id = p_class and m.user_id = p_user;
    if v_theirs is null then
        raise exception 'That person isn''t in this class.';
    end if;
    if p_user = auth.uid() then
        raise exception 'Pick someone else.';
    end if;
    if p_kind = 'make_admin' and v_theirs <> 'member' then
        raise exception 'They are already an admin.';
    end if;
    if p_kind = 'transfer_owner' and v_theirs = 'owner' then
        raise exception 'They already own this class.';
    end if;
    if public.is_site_owner() then
        if p_kind = 'make_admin' then
            update public.class_members set role = 'admin' where class_id = p_class and user_id = p_user;
        else
            select c.owner_id into v_old_owner from public.classes c where c.id = p_class;
            update public.class_members set role = 'admin' where class_id = p_class and user_id = v_old_owner;
            update public.class_members set role = 'owner' where class_id = p_class and user_id = p_user;
            update public.classes set owner_id = p_user where id = p_class;
        end if;
        -- Anything still waiting about the same change is settled now
        update public.class_requests set status = 'approved', reviewed_at = now()
        where class_id = p_class and status = 'pending' and kind = p_kind and target_id = p_user;
        update public.class_requests set status = 'rejected', reviewed_at = now()
        where class_id = p_class and status = 'pending' and p_kind = 'transfer_owner' and kind = 'transfer_owner';
        return;
    end if;
    if exists (select 1 from public.class_requests r where r.class_id = p_class and r.status = 'pending'
               and (r.kind = 'transfer_owner' and p_kind = 'transfer_owner' or (r.kind = p_kind and r.target_id = p_user))) then
        raise exception 'That request is already waiting for approval.';
    end if;
    insert into public.class_requests (class_id, kind, target_id, requested_by)
    values (p_class, p_kind, p_user, auth.uid());
end;
$$;

create or replace function public.cancel_class_request(p_request bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    delete from public.class_requests r
    where r.id = p_request and r.status = 'pending'
      and (r.requested_by = auth.uid() or public.is_site_owner());
end;
$$;

create or replace function public.demote_class_admin(p_class uuid, p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if coalesce(public.class_role(p_class), '') <> 'owner' and not public.is_site_owner() then
        raise exception 'Only the class owner can do this.';
    end if;
    update public.class_members set role = 'member'
    where class_id = p_class and user_id = p_user and role = 'admin';
end;
$$;

-- Admins share their own timetable with the class
create or replace function public.publish_class_timetable(p_class uuid, p_timetable jsonb)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_days int;
    v_now timestamptz := now();
begin
    if not public.is_class_admin(p_class) then
        raise exception 'Only class admins can share the timetable.';
    end if;
    if jsonb_typeof(p_timetable) <> 'object'
       or jsonb_typeof(p_timetable -> 'timetable') is distinct from 'object'
       or jsonb_typeof(p_timetable -> 'uniforms') is distinct from 'object'
       or jsonb_typeof(p_timetable -> 'totalDays') is distinct from 'number' then
        raise exception 'That timetable looks broken. Open the Timetable page, save it, and try again.';
    end if;
    v_days := (p_timetable ->> 'totalDays')::numeric::int;
    if v_days not between 1 and 10 then
        raise exception 'A timetable has 1 to 10 day orders.';
    end if;
    update public.classes
    set timetable = jsonb_build_object(
            'totalDays', v_days,
            'timetable', p_timetable -> 'timetable',
            'uniforms', p_timetable -> 'uniforms'),
        timetable_updated_at = v_now
    where id = p_class;
    return v_now;
end;
$$;

-- An invite-only chat in a class. Up to 15 per class, and each member can make 1.
create or replace function public.create_private_chat(p_class uuid, p_name text, p_members uuid[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_id uuid;
    v_name text := btrim(coalesce(p_name, ''));
begin
    if not public.is_class_member(p_class)
       or not exists (select 1 from public.classes c where c.id = p_class and c.status = 'approved') then
        raise exception 'You can only make chats in an approved class you are in.';
    end if;
    if char_length(v_name) not between 1 and 40 then
        raise exception 'Give the chat a name (up to 40 letters).';
    end if;
    perform 1 from public.classes c where c.id = p_class for update; -- one at a time, so the limit holds
    if exists (select 1 from public.chats c where c.class_id = p_class and c.kind = 'private' and c.created_by = auth.uid()) then
        raise exception 'You already made a chat in this class. Delete it to make a new one.';
    end if;
    if (select count(*) from public.chats c where c.class_id = p_class and c.kind = 'private') >= 15 then
        raise exception 'This class already has 15 chats. Ask an admin to delete one that isn''t used.';
    end if;
    insert into public.chats (class_id, kind, name, created_by)
    values (p_class, 'private', v_name, auth.uid())
    returning id into v_id;
    insert into public.chat_members (chat_id, user_id)
    select v_id, m.user_id from public.class_members m
    where m.class_id = p_class and (m.user_id = auth.uid() or m.user_id = any (coalesce(p_members, '{}')));
    return v_id;
end;
$$;

-- The chat's maker changes who is in it (only people in the class)
create or replace function public.set_chat_members(p_chat uuid, p_members uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_chat public.chats;
begin
    select * into v_chat from public.chats c where c.id = p_chat;
    if not found or v_chat.kind <> 'private' or v_chat.created_by is distinct from auth.uid() then
        raise exception 'Only the person who made this chat can change who is in it.';
    end if;
    delete from public.chat_members cm
    where cm.chat_id = p_chat and cm.user_id <> auth.uid() and not (cm.user_id = any (coalesce(p_members, '{}')));
    insert into public.chat_members (chat_id, user_id)
    select p_chat, m.user_id from public.class_members m
    where m.class_id = v_chat.class_id and m.user_id = any (coalesce(p_members, '{}'))
    on conflict do nothing;
end;
$$;

-- Start an activity group from a class. Small = 1 point (5 people), Big = 2 points (20 people),
-- 6 points per person. A class admin's own activities don't need approval.
create or replace function public.create_activity(p_class uuid, p_name text, p_size text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_id uuid;
    v_name text := btrim(coalesce(p_name, ''));
    v_points int;
    v_admin boolean := public.is_class_admin(p_class);
begin
    if not public.is_class_member(p_class)
       or not exists (select 1 from public.classes c where c.id = p_class and c.status = 'approved') then
        raise exception 'You can only start an activity from an approved class you are in.';
    end if;
    if char_length(v_name) not between 1 and 60 then
        raise exception 'Give the activity a name (up to 60 letters).';
    end if;
    if p_size is null or p_size not in ('small', 'big') then
        raise exception 'Pick Small or Big.';
    end if;
    perform 1 from public.profiles p where p.id = auth.uid() for update; -- one at a time, so the points hold
    select coalesce(sum(case a.size when 'big' then 2 else 1 end), 0) into v_points
    from public.activities a where a.owner_id = auth.uid() and a.status in ('pending', 'approved');
    if v_points + (case p_size when 'big' then 2 else 1 end) > 6 then
        raise exception 'You''ve used % of your 6 activity points (Small = 1, Big = 2). Delete an activity you started to make room.', v_points;
    end if;
    insert into public.activities (class_id, name, code, owner_id, size, status, reviewed_at)
    values (p_class, v_name, public.new_group_code(), auth.uid(), p_size,
            case when v_admin then 'approved' else 'pending' end,
            case when v_admin then now() end)
    returning id into v_id;
    insert into public.activity_members (activity_id, user_id, role) values (v_id, auth.uid(), 'owner');
    insert into public.chats (activity_id, kind, name, created_by) values (v_id, 'activity', left(v_name, 40), auth.uid());
    return v_id;
end;
$$;

create or replace function public.review_activity(p_activity uuid, p_approve boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_activity public.activities;
begin
    select * into v_activity from public.activities a where a.id = p_activity for update;
    if not found then
        raise exception 'That activity is gone.';
    end if;
    if not public.is_class_admin(v_activity.class_id) and not public.is_site_owner() then
        raise exception 'Only an admin of the class it was started from can approve it.';
    end if;
    if v_activity.status = 'pending' then
        update public.activities
        set status = case when p_approve then 'approved' else 'rejected' end, reviewed_at = now()
        where id = p_activity;
    end if;
end;
$$;

create or replace function public.leave_activity(p_activity uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if exists (select 1 from public.activities a where a.id = p_activity and a.owner_id = auth.uid()) then
        raise exception 'You started this activity, so delete it instead of leaving.';
    end if;
    delete from public.activity_members m where m.activity_id = p_activity and m.user_id = auth.uid();
end;
$$;

create or replace function public.remove_activity_member(p_activity uuid, p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if not public.can_manage_activity(p_activity) then
        raise exception 'Only the person who started the activity, or a class admin, can remove people.';
    end if;
    if exists (select 1 from public.activities a where a.id = p_activity and a.owner_id = p_user) then
        raise exception 'The person who started the activity can''t be removed.';
    end if;
    delete from public.activity_members m where m.activity_id = p_activity and m.user_id = p_user;
end;
$$;

-- Names, emails and roles of everyone in a class or activity
create or replace function public.get_class_members(p_class uuid)
returns table (user_id uuid, name text, email text, class text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    select m.user_id, coalesce(p.name, ''), coalesce(p.email, ''), coalesce(p.class, ''), m.role, m.joined_at
    from public.class_members m
    left join public.profiles p on p.id = m.user_id
    where m.class_id = p_class and (public.is_class_member(p_class) or public.is_site_owner())
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(coalesce(p.name, ''));
$$;

create or replace function public.get_activity_members(p_activity uuid)
returns table (user_id uuid, name text, email text, class text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    select m.user_id, coalesce(p.name, ''), coalesce(p.email, ''), coalesce(p.class, ''), m.role, m.joined_at
    from public.activity_members m
    left join public.profiles p on p.id = m.user_id
    where m.activity_id = p_activity
      and (public.is_activity_member(p_activity) or public.can_manage_activity(p_activity))
    order by case m.role when 'owner' then 0 else 1 end, lower(coalesce(p.name, ''));
$$;

-- After uploading a file to storage, list it in the class or activity
create or replace function public.register_group_file(p_path text, p_file_name text)
returns public.group_files
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_parts text[] := string_to_array(coalesce(p_path, ''), '/');
    v_meta jsonb;
    v_row public.group_files;
begin
    if coalesce(array_length(v_parts, 1), 0) <> 4 or v_parts[3] <> auth.uid()::text
       or v_parts[1] not in ('class', 'activity') then
        raise exception 'That file isn''t yours.';
    end if;
    if not public.can_read_group_folder(v_parts[1], v_parts[2]) then
        raise exception 'You''re not in that group.';
    end if;
    select o.metadata into v_meta from storage.objects o where o.bucket_id = 'class-files' and o.name = p_path;
    if not found then
        raise exception 'The file didn''t finish uploading. Try again.';
    end if;
    insert into public.group_files (class_id, activity_id, uploaded_by, path, file_name, mime_type, size_bytes)
    values (
        case when v_parts[1] = 'class' then v_parts[2]::uuid end,
        case when v_parts[1] = 'activity' then v_parts[2]::uuid end,
        auth.uid(),
        p_path,
        left(coalesce(nullif(btrim(p_file_name), ''), 'file'), 200),
        coalesce(v_meta ->> 'mimetype', 'application/octet-stream'),
        least(10485760, greatest(1, coalesce((v_meta ->> 'size')::bigint, 1)))::int
    )
    returning * into v_row;
    return v_row;
end;
$$;

-- Report a message to the site owner
create or replace function public.report_message(p_message bigint, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_message public.group_messages;
    v_place text;
begin
    select * into v_message from public.group_messages g where g.id = p_message;
    if not found or not public.can_use_chat(v_message.chat_id) then
        raise exception 'That message is gone.';
    end if;
    if v_message.sender_id = auth.uid() then
        raise exception 'This is your own message. You can delete it instead.';
    end if;
    if (select count(*) from public.message_reports r where r.reporter_id = auth.uid() and r.status = 'open') >= 20 then
        raise exception 'You already have 20 reports waiting. Please wait until they are checked.';
    end if;
    select case when c.kind = 'activity' then a.name || ' (activity)' else cl.name || ' · ' || c.name end
    into v_place
    from public.chats c
    left join public.classes cl on cl.id = c.class_id
    left join public.activities a on a.id = c.activity_id
    where c.id = v_message.chat_id;
    insert into public.message_reports (message_id, reporter_id, sender_id, place, message_text, reason)
    values (p_message, auth.uid(), v_message.sender_id, coalesce(v_place, 'A chat'), v_message.text,
            left(btrim(coalesce(p_reason, '')), 300))
    on conflict (message_id, reporter_id) do nothing;
end;
$$;

-- ---------- Site owner only ----------
create or replace function public.site_review_class(p_class uuid, p_approve boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if not public.is_site_owner() then
        raise exception 'Only the site owner can approve classes.';
    end if;
    update public.classes
    set status = case when p_approve then 'approved' else 'rejected' end, reviewed_at = now()
    where id = p_class and status = 'pending';
end;
$$;

create or replace function public.site_review_request(p_request bigint, p_approve boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_request public.class_requests;
    v_ok boolean := p_approve;
begin
    if not public.is_site_owner() then
        raise exception 'Only the site owner can approve this.';
    end if;
    select * into v_request from public.class_requests r where r.id = p_request and r.status = 'pending' for update;
    if not found then
        return;
    end if;
    -- Still valid? (the person may have left, or the requester may no longer own the class)
    if v_ok and not exists (select 1 from public.class_members m
                            where m.class_id = v_request.class_id and m.user_id = v_request.target_id) then
        v_ok := false;
    end if;
    if v_ok and v_request.kind = 'make_admin' then
        update public.class_members set role = 'admin'
        where class_id = v_request.class_id and user_id = v_request.target_id and role = 'member';
    elsif v_ok and v_request.kind = 'transfer_owner' then
        if not exists (select 1 from public.classes c where c.id = v_request.class_id and c.owner_id = v_request.requested_by) then
            v_ok := false;
        else
            update public.class_members set role = 'admin'
            where class_id = v_request.class_id and user_id = v_request.requested_by;
            update public.class_members set role = 'owner'
            where class_id = v_request.class_id and user_id = v_request.target_id;
            update public.classes set owner_id = v_request.target_id where id = v_request.class_id;
        end if;
    end if;
    update public.class_requests
    set status = case when v_ok then 'approved' else 'rejected' end, reviewed_at = now()
    where id = p_request;
end;
$$;

create or replace function public.site_resolve_report(p_report bigint, p_delete_message boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_message bigint;
begin
    if not public.is_site_owner() then
        raise exception 'Only the site owner can handle reports.';
    end if;
    select r.message_id into v_message from public.message_reports r where r.id = p_report;
    if not found then
        return;
    end if;
    update public.message_reports
    set status = 'resolved'
    where id = p_report or (p_delete_message and v_message is not null and message_id = v_message);
    if p_delete_message and v_message is not null then
        delete from public.group_messages g where g.id = v_message;
    end if;
end;
$$;

-- Everything waiting for the site owner, plus every class and activity (to delete any of them)
create or replace function public.site_admin_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_site_owner() then
        raise exception 'Only the site owner can see this.';
    end if;
    return jsonb_build_object(
        'classes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'status', c.status, 'created_at', c.created_at,
                'owner_name', p.name, 'owner_email', p.email, 'owner_class', p.class,
                'members', (select count(*) from public.class_members m where m.class_id = c.id))
                order by c.status <> 'pending', c.created_at desc)
            from public.classes c
            left join public.profiles p on p.id = c.owner_id), '[]'::jsonb),
        'activities', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', a.id, 'name', a.name, 'status', a.status, 'size', a.size, 'created_at', a.created_at,
                'class_name', c.name, 'owner_name', p.name, 'owner_email', p.email,
                'members', (select count(*) from public.activity_members m where m.activity_id = a.id))
                order by a.created_at desc)
            from public.activities a
            join public.classes c on c.id = a.class_id
            left join public.profiles p on p.id = a.owner_id), '[]'::jsonb),
        'requests', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', r.id, 'kind', r.kind, 'created_at', r.created_at, 'class_name', c.name,
                'target_name', t.name, 'target_email', t.email, 'by_name', b.name, 'by_email', b.email)
                order by r.created_at)
            from public.class_requests r
            join public.classes c on c.id = r.class_id
            left join public.profiles t on t.id = r.target_id
            left join public.profiles b on b.id = r.requested_by
            where r.status = 'pending'), '[]'::jsonb),
        'reports', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', x.id, 'place', x.place, 'message_text', x.message_text, 'reason', x.reason,
                'created_at', x.created_at, 'message_exists', x.message_id is not null,
                'sender_name', s.name, 'sender_email', s.email,
                'reporter_name', rp.name, 'reporter_email', rp.email)
                order by x.created_at)
            from public.message_reports x
            left join public.profiles s on s.id = x.sender_id
            left join public.profiles rp on rp.id = x.reporter_id
            where x.status = 'open'), '[]'::jsonb)
    );
end;
$$;

-- Only signed-in accounts can call these (the database rules inside still check who you are)
do $$
declare
    f text;
begin
    foreach f in array array[
        'public.is_site_owner()', 'public.class_role(uuid)', 'public.is_class_member(uuid)',
        'public.is_class_admin(uuid)', 'public.is_activity_member(uuid)', 'public.can_manage_activity(uuid)',
        'public.can_use_chat(uuid)', 'public.can_moderate_chat(uuid)', 'public.can_read_group_folder(text, text)',
        'public.can_manage_group_folder(text, text)', 'public.can_upload_group_file(text, text)',
        'public.create_class(text)', 'public.join_with_code(text)', 'public.regenerate_code(text, uuid)',
        'public.leave_class(uuid)', 'public.remove_class_member(uuid, uuid)',
        'public.request_class_role(uuid, uuid, text)', 'public.cancel_class_request(bigint)',
        'public.demote_class_admin(uuid, uuid)', 'public.publish_class_timetable(uuid, jsonb)',
        'public.create_private_chat(uuid, text, uuid[])', 'public.set_chat_members(uuid, uuid[])',
        'public.create_activity(uuid, text, text)', 'public.review_activity(uuid, boolean)',
        'public.leave_activity(uuid)', 'public.remove_activity_member(uuid, uuid)',
        'public.get_class_members(uuid)', 'public.get_activity_members(uuid)',
        'public.register_group_file(text, text)', 'public.report_message(bigint, text)',
        'public.site_review_class(uuid, boolean)', 'public.site_review_request(bigint, boolean)',
        'public.site_resolve_report(bigint, boolean)', 'public.site_admin_inbox()'
    ] loop
        execute format('revoke execute on function %s from public, anon', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
    -- Used only inside the functions above
    foreach f in array array['public.new_group_code()', 'public.drop_class_member(uuid, uuid)',
                             'public.group_storage_used(text, uuid)'] loop
        execute format('revoke execute on function %s from public, anon, authenticated', f);
    end loop;
end;
$$;

-- =========================================================
-- 7. Live updates: new messages, homework, files and approvals appear instantly
--    (who-is-in-which-group lists refresh when the app opens or every minute instead,
--    so nobody gets told about other people joining or leaving groups they're not in)
-- =========================================================
do $$
declare
    t text;
begin
    foreach t in array array['classes', 'class_requests', 'activities', 'chats', 'group_messages',
                             'class_homework', 'group_files', 'message_reports'] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end;
$$;
