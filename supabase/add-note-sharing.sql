-- Procrastinote: sharing notes with friends
-- Paste this whole file into Supabase > SQL Editor > New query, then press "Run".
-- It is safe to run again. (It is also part of setup.sql, section 5.)

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
