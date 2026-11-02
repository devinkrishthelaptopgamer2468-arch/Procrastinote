-- Procrastinote: polls in class chats, and the grade's Lost & found / book swap board
-- Run add-classes.sql first. Then paste this whole file into Supabase > SQL Editor > New query
-- and press "Run". It is safe to run again. Supabase may warn about "destructive operations":
-- that's only the "drop ... if exists" lines, which recreate this feature's own rules.
--
-- Polls: anyone in a chat can start one ("Which day for the project meeting?"). It's posted as a
-- chat message, so it notifies people like any message. Everyone in the chat can vote (and change
-- their vote) and see who voted for what. The person who made it, or an admin, can close it;
-- deleting its message deletes the poll.
--
-- Board: one per grade. Every class whose name starts with the same number ("10 A", "10 B",
-- "Grade 10 C") shares it; a class without a number gets a board of its own. Post something you
-- lost, found, or a book to swap or give away, with a photo if you like, and mark it sorted when
-- it's done. Admins of the grade's classes can delete any post.

-- =========================================================
-- 1. Polls
-- =========================================================
create table if not exists public.class_polls (
    id bigint generated always as identity primary key,
    message_id bigint not null unique references public.group_messages (id) on delete cascade,
    chat_id uuid not null references public.chats (id) on delete cascade,
    question text not null check (char_length(btrim(question)) between 1 and 150),
    options text[] not null check (cardinality(options) between 2 and 6),
    created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
    closed boolean not null default false,
    created_at timestamptz not null default now()
);

create index if not exists class_polls_chat_idx on public.class_polls (chat_id);
create index if not exists class_polls_maker_idx on public.class_polls (created_by, created_at);

create table if not exists public.class_poll_votes (
    poll_id bigint not null references public.class_polls (id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    choice smallint not null check (choice between 0 and 5),
    voted_at timestamptz not null default now(),
    primary key (poll_id, user_id)
);

alter table public.class_polls enable row level security;
alter table public.class_poll_votes enable row level security;

drop policy if exists "Chat members can see polls" on public.class_polls;
create policy "Chat members can see polls" on public.class_polls
    for select to authenticated
    using (public.can_use_chat(chat_id));

drop policy if exists "Chat members can see votes" on public.class_poll_votes;
create policy "Chat members can see votes" on public.class_poll_votes
    for select to authenticated
    using (exists (select 1 from public.class_polls p where p.id = poll_id and public.can_use_chat(p.chat_id)));

-- Reading only: making polls, voting and closing go through the functions below
revoke all on public.class_polls from anon, authenticated;
revoke all on public.class_poll_votes from anon, authenticated;
grant select on public.class_polls to authenticated;
grant select on public.class_poll_votes to authenticated;

-- Start a poll: posts "📊 Poll: <question>" in the chat and attaches the choices to it
create or replace function public.create_poll(p_chat uuid, p_question text, p_options text[])
returns public.class_polls
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_question text := btrim(coalesce(p_question, ''));
    v_options text[];
    v_message_id bigint;
    v_poll public.class_polls;
begin
    if auth.uid() is null or not public.can_use_chat(p_chat) then
        raise exception 'You''re not in that chat.';
    end if;
    select coalesce(array_agg(left(btrim(t.o), 80) order by t.n), '{}') into v_options
    from unnest(coalesce(p_options, '{}'::text[])) with ordinality as t(o, n)
    where btrim(t.o) <> '';
    if char_length(v_question) not between 1 and 150 then
        raise exception 'Write a question (up to 150 characters).';
    end if;
    if cardinality(v_options) not between 2 and 6 then
        raise exception 'A poll needs 2 to 6 choices.';
    end if;
    if (select count(distinct lower(o)) from unnest(v_options) as o) <> cardinality(v_options) then
        raise exception 'Two of the choices are the same.';
    end if;
    if (select count(*) from public.class_polls p
        where p.created_by = auth.uid() and p.created_at > now() - interval '1 day') >= 10 then
        raise exception 'You can start up to 10 polls a day.';
    end if;
    insert into public.group_messages (chat_id, sender_id, text)
    values (p_chat, auth.uid(), left('📊 Poll: ' || v_question, 2000))
    returning id into v_message_id;
    insert into public.class_polls (message_id, chat_id, question, options, created_by)
    values (v_message_id, p_chat, v_question, v_options, auth.uid())
    returning * into v_poll;
    return v_poll;
end;
$$;

-- Vote, change your vote, or take it back (p_choice null). Choices are numbered from 0.
create or replace function public.vote_poll(p_poll bigint, p_choice int)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_poll public.class_polls;
begin
    select * into v_poll from public.class_polls p where p.id = p_poll;
    if not found or auth.uid() is null or not public.can_use_chat(v_poll.chat_id) then
        raise exception 'That poll isn''t in one of your chats.';
    end if;
    if v_poll.closed then
        raise exception 'This poll is closed.';
    end if;
    if p_choice is null then
        delete from public.class_poll_votes v where v.poll_id = p_poll and v.user_id = auth.uid();
        return;
    end if;
    if p_choice < 0 or p_choice >= cardinality(v_poll.options) then
        raise exception 'Pick one of the choices.';
    end if;
    insert into public.class_poll_votes (poll_id, user_id, choice)
    values (p_poll, auth.uid(), p_choice)
    on conflict (poll_id, user_id) do update set choice = excluded.choice, voted_at = now();
end;
$$;

-- Close (or reopen) a poll: the person who made it, or someone who can delete messages there
create or replace function public.close_poll(p_poll bigint, p_closed boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_poll public.class_polls;
begin
    select * into v_poll from public.class_polls p where p.id = p_poll;
    if not found or not public.can_use_chat(v_poll.chat_id) then
        raise exception 'That poll isn''t in one of your chats.';
    end if;
    if v_poll.created_by <> auth.uid() and not public.can_moderate_chat(v_poll.chat_id) then
        raise exception 'Only the person who started the poll, or an admin, can close it.';
    end if;
    update public.class_polls set closed = coalesce(p_closed, true) where id = p_poll;
end;
$$;

-- =========================================================
-- 2. The grade's Lost & found / book swap board
-- =========================================================

-- Which board a class uses: 'grade-10' for "10 A" or "Grade 10 B", else one just for that class
create or replace function public.board_of_class(p_name text, p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
    select coalesce('grade-' || (regexp_match(coalesce(p_name, ''), '(\d{1,2})'))[1]::int::text, 'class-' || p_id::text);
$$;

-- The boards I can use: those of the approved classes I'm in
create or replace function public.my_boards()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(array_agg(distinct public.board_of_class(c.name, c.id)), '{}')
    from public.class_members m
    join public.classes c on c.id = m.class_id
    where m.user_id = auth.uid() and c.status = 'approved';
$$;

-- Admins of the board's classes, and the site owner, can delete any post on it
create or replace function public.can_moderate_board(p_board text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.is_site_owner() or exists (
        select 1 from public.class_members m
        join public.classes c on c.id = m.class_id
        where m.user_id = auth.uid() and m.role in ('owner', 'admin') and c.status = 'approved'
          and public.board_of_class(c.name, c.id) = p_board
    );
$$;

create table if not exists public.board_posts (
    id bigint generated always as identity primary key,
    board text not null check (char_length(board) between 1 and 60),
    kind text not null check (kind in ('lost', 'found', 'swap')),
    title text not null check (char_length(btrim(title)) between 1 and 80),
    details text not null default '' check (char_length(details) <= 500),
    -- The photo is in the private "board-photos" bucket at <board>/<poster's account id>/<file>
    photo_path text check (photo_path is null or char_length(photo_path) <= 300),
    posted_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
    resolved boolean not null default false,
    created_at timestamptz not null default now()
);

create index if not exists board_posts_board_idx on public.board_posts (board, created_at desc);
create index if not exists board_posts_poster_idx on public.board_posts (posted_by, created_at);

alter table public.board_posts enable row level security;

drop policy if exists "Grade members can see board posts" on public.board_posts;
create policy "Grade members can see board posts" on public.board_posts
    for select to authenticated
    using (board = any (public.my_boards()) or public.is_site_owner());

-- Your own posts on your own board, with your own photo; up to 10 a day and 10 not sorted yet
drop policy if exists "Grade members can post on the board" on public.board_posts;
create policy "Grade members can post on the board" on public.board_posts
    for insert to authenticated
    with check (
        posted_by = auth.uid()
        and resolved = false
        and board = any (public.my_boards())
        and (photo_path is null or starts_with(photo_path, board || '/' || auth.uid()::text || '/'))
        and (select count(*) from public.board_posts b
             where b.posted_by = auth.uid() and b.created_at > now() - interval '1 day') < 10
        and (select count(*) from public.board_posts b
             where b.posted_by = auth.uid() and not b.resolved) < 10
    );

drop policy if exists "Posters and admins can delete board posts" on public.board_posts;
create policy "Posters and admins can delete board posts" on public.board_posts
    for delete to authenticated
    using (posted_by = auth.uid() or public.can_moderate_board(board));

-- No update rules: marking a post sorted goes through set_board_post_resolved
revoke all on public.board_posts from anon, authenticated;
grant select, insert, delete on public.board_posts to authenticated;

create or replace function public.set_board_post_resolved(p_post bigint, p_resolved boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    update public.board_posts b set resolved = coalesce(p_resolved, true)
    where b.id = p_post and (b.posted_by = auth.uid() or public.can_moderate_board(b.board));
    if not found then
        raise exception 'Only the person who posted it, or an admin, can change that.';
    end if;
end;
$$;

-- A board's posts with each poster's name and class (newest first, sorted ones last)
create or replace function public.get_board(p_board text)
returns table (
    id bigint, board text, kind text, title text, details text, photo_path text,
    posted_by uuid, resolved boolean, created_at timestamptz, poster_name text, poster_class text
)
language sql
stable
security definer
set search_path = ''
as $$
    select b.id, b.board, b.kind, b.title, b.details, b.photo_path, b.posted_by, b.resolved, b.created_at,
           coalesce(p.name, ''),
           coalesce((select min(c.name) from public.class_members m
                     join public.classes c on c.id = m.class_id
                     where m.user_id = b.posted_by and c.status = 'approved'
                       and public.board_of_class(c.name, c.id) = b.board), '')
    from public.board_posts b
    left join public.profiles p on p.id = b.posted_by
    where b.board = p_board and (p_board = any (public.my_boards()) or public.is_site_owner())
    order by b.resolved, b.created_at desc
    limit 300;
$$;

-- Photos: a PRIVATE bucket, pictures only, up to 5 MB each
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('board-photos', 'board-photos', false, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Board photos: grade members upload" on storage.objects;
create policy "Board photos: grade members upload" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'board-photos'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[1] = any (public.my_boards())
    );

drop policy if exists "Board photos: grade members open" on storage.objects;
create policy "Board photos: grade members open" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'board-photos'
        and ((storage.foldername(name))[1] = any (public.my_boards()) or public.is_site_owner())
    );

drop policy if exists "Board photos: poster or admin removes" on storage.objects;
create policy "Board photos: poster or admin removes" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'board-photos'
        and ((storage.foldername(name))[2] = auth.uid()::text or public.can_moderate_board((storage.foldername(name))[1]))
    );

-- =========================================================
-- 3. Who can call the functions, and live updates
-- =========================================================
revoke execute on function public.create_poll(uuid, text, text[]) from public, anon;
revoke execute on function public.vote_poll(bigint, int) from public, anon;
revoke execute on function public.close_poll(bigint, boolean) from public, anon;
revoke execute on function public.my_boards() from public, anon;
revoke execute on function public.can_moderate_board(text) from public, anon;
revoke execute on function public.set_board_post_resolved(bigint, boolean) from public, anon;
revoke execute on function public.get_board(text) from public, anon;
grant execute on function public.create_poll(uuid, text, text[]) to authenticated;
grant execute on function public.vote_poll(bigint, int) to authenticated;
grant execute on function public.close_poll(bigint, boolean) to authenticated;
grant execute on function public.my_boards() to authenticated;
grant execute on function public.can_moderate_board(text) to authenticated;
grant execute on function public.set_board_post_resolved(bigint, boolean) to authenticated;
grant execute on function public.get_board(text) to authenticated;

do $$
declare
    t text;
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        foreach t in array array['class_polls', 'class_poll_votes', 'board_posts'] loop
            if not exists (select 1 from pg_publication_tables
                           where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
                execute format('alter publication supabase_realtime add table public.%I', t);
            end if;
        end loop;
    end if;
end;
$$;
