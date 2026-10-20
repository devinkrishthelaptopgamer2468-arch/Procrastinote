-- Procrastinote: sending photos and documents to friends in chat
-- Paste this whole file into Supabase > SQL Editor > New query, then press "Run".
-- It is safe to run again. (It is also part of setup.sql, section 6.)
-- Supabase may warn about "destructive operations": that's only the "drop policy if exists"
-- lines, which remove and recreate this feature's own rules. No data is deleted.

-- Files are kept in a PRIVATE storage bucket: only the sender and the receiver can open them.
-- Up to 10 MB each; photos, PDF, Word, PowerPoint, Excel and text files only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'shared-files', 'shared-files', false, 10485760,
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

-- A file's storage path is <sender's account id>/<receiver's account id>/<file>
drop policy if exists "Users can upload files they send" on storage.objects;
create policy "Users can upload files they send" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'shared-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can open files sent by or to them" on storage.objects;
create policy "Users can open files sent by or to them" on storage.objects
    for select to authenticated
    using (bucket_id = 'shared-files' and auth.uid()::text in ((storage.foldername(name))[1], (storage.foldername(name))[2]));

drop policy if exists "Users can remove files sent by or to them" on storage.objects;
create policy "Users can remove files sent by or to them" on storage.objects
    for delete to authenticated
    using (bucket_id = 'shared-files' and auth.uid()::text in ((storage.foldername(name))[1], (storage.foldername(name))[2]));

-- Checks that an account id and email belong together (so nobody can send a file
-- that shows up for one person but is stored for another)
create or replace function public.is_user_email(uid uuid, mail text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.profiles p where p.id = uid and p.email = lower(mail));
$$;

revoke execute on function public.is_user_email(uuid, text) from public, anon;
grant execute on function public.is_user_email(uuid, text) to authenticated;

-- One row per file sent, so it shows up in the chat
create table if not exists public.shared_files (
    id bigint generated always as identity primary key,
    sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    sender_email text not null,
    recipient_id uuid not null references auth.users (id) on delete cascade,
    recipient_email text not null,
    room_id text generated always as (
        'room_' || least(sender_email, recipient_email) || '_' || greatest(sender_email, recipient_email)
    ) stored,
    path text not null unique,
    file_name text not null check (char_length(file_name) between 1 and 200),
    mime_type text not null,
    size_bytes integer not null check (size_bytes between 1 and 10485760),
    created_at timestamptz not null default now(),
    check (sender_email <> recipient_email),
    check (recipient_email = lower(recipient_email)),
    check (path like sender_id::text || '/' || recipient_id::text || '/%')
);

create index if not exists shared_files_room_idx on public.shared_files (room_id, created_at);

alter table public.shared_files enable row level security;

drop policy if exists "Users can send files as themselves" on public.shared_files;
create policy "Users can send files as themselves" on public.shared_files
    for insert to authenticated
    with check (
        sender_id = auth.uid()
        and sender_email = lower(auth.jwt() ->> 'email')
        and public.is_user_email(recipient_id, recipient_email)
    );

drop policy if exists "Users can see files sent by or to them" on public.shared_files;
create policy "Users can see files sent by or to them" on public.shared_files
    for select to authenticated
    using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists "Users can remove files sent by or to them" on public.shared_files;
create policy "Users can remove files sent by or to them" on public.shared_files
    for delete to authenticated
    using (sender_id = auth.uid() or recipient_id = auth.uid());

-- Live updates: a file appears in your friend's chat instantly
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shared_files'
    ) then
        alter publication supabase_realtime add table public.shared_files;
    end if;
end;
$$;
