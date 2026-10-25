-- Procrastinote: class AI keys
-- Anyone in a class can share their Groq key with the class (one each, up to 10 per class).
-- Members without their own key use the AI helper through the class-ai Edge Function, which takes
-- turns with the shared keys, up to a daily allowance each that the class admin sets.
-- Nobody can read a key back from the website (not even the person who shared it): only the
-- Edge Function uses them. Keys are checked with Groq before they're saved.
--
-- Run add-classes.sql first. Then paste this whole file into Supabase > SQL Editor > New query
-- and press "Run". It is safe to run again. Supabase may warn about "destructive operations":
-- that's only the lines that replace this feature's own older functions and table.

-- The admin's settings for each class: questions per person per day
create table if not exists public.class_ai_settings (
    class_id uuid primary key references public.classes (id) on delete cascade,
    daily_limit int not null default 15 check (daily_limit between 1 and 100),
    updated_at timestamptz not null default now()
);

-- The shared keys: one per person per class
create table if not exists public.class_ai_pool (
    id bigint generated always as identity primary key,
    class_id uuid not null references public.classes (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    api_key text not null check (api_key ~ '^gsk_[A-Za-z0-9]{20,200}$'),
    key_hint text not null default '',
    broken boolean not null default false, -- Groq refused it: skipped until its owner replaces it
    added_at timestamptz not null default now(),
    unique (class_id, owner_id)
);

-- How much each member used today (days run on India time)
create table if not exists public.class_ai_usage (
    class_id uuid not null references public.classes (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    day date not null,
    used int not null default 0 check (used >= 0),
    primary key (class_id, user_id, day)
);

-- The first version had one key per class: move it over (its admin becomes its owner)
do $$
begin
    if to_regclass('public.class_ai_keys') is not null then
        insert into public.class_ai_settings (class_id, daily_limit)
        select class_id, daily_limit from public.class_ai_keys
        on conflict (class_id) do nothing;
        insert into public.class_ai_pool (class_id, owner_id, api_key, key_hint, added_at)
        select class_id, updated_by, api_key, key_hint, updated_at from public.class_ai_keys
        where updated_by is not null
        on conflict (class_id, owner_id) do nothing;
        drop table public.class_ai_keys;
    end if;
end;
$$;
drop function if exists public.set_class_ai_key(uuid, text, int);
drop function if exists public.remove_class_ai_key(uuid);
drop function if exists public.class_ai_status();

-- Locked: no rules means nobody can read or change these from the website.
-- The functions below (and the Edge Function, with the service role) are the only way in.
alter table public.class_ai_settings enable row level security;
alter table public.class_ai_pool enable row level security;
alter table public.class_ai_usage enable row level security;
revoke all on public.class_ai_settings from anon, authenticated;
revoke all on public.class_ai_pool from anon, authenticated;
revoke all on public.class_ai_usage from anon, authenticated;

create or replace function public.class_ai_today()
returns date
language sql
stable
set search_path = ''
as $$
    select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- For every class I'm in: how many working keys it has, the allowance, my use today, and my own
-- shared key (its last 4 characters, and whether Groq stopped accepting it)
create or replace function public.class_ai_status()
returns table (class_id uuid, has_key boolean, key_count int, daily_limit int, used_today int,
               my_key_id bigint, my_key_hint text, my_key_broken boolean)
language sql
stable
security definer
set search_path = ''
as $$
    select m.class_id,
           exists (select 1 from public.class_ai_pool p where p.class_id = m.class_id and not p.broken),
           (select count(*)::int from public.class_ai_pool p where p.class_id = m.class_id and not p.broken),
           coalesce((select s.daily_limit from public.class_ai_settings s where s.class_id = m.class_id), 15),
           coalesce((select u.used from public.class_ai_usage u
                     where u.class_id = m.class_id and u.user_id = auth.uid() and u.day = public.class_ai_today()), 0),
           mine.id,
           coalesce(mine.key_hint, ''),
           coalesce(mine.broken, false)
    from public.class_members m
    left join public.class_ai_pool mine on mine.class_id = m.class_id and mine.owner_id = auth.uid()
    where m.user_id = auth.uid();
$$;

-- Who shared a key with a class (members see names; never the keys)
create or replace function public.class_ai_key_list(p_class uuid)
returns table (id bigint, owner_id uuid, broken boolean, added_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    select p.id, p.owner_id, p.broken, p.added_at
    from public.class_ai_pool p
    where p.class_id = p_class and public.is_class_member(p_class)
    order by p.added_at;
$$;

-- Remove a shared key: its owner, or an admin of the class
create or replace function public.remove_class_ai_key(p_key_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_row public.class_ai_pool;
begin
    select * into v_row from public.class_ai_pool where id = p_key_id;
    if v_row.id is null then
        return;
    end if;
    if v_row.owner_id <> auth.uid() and not public.is_class_admin(v_row.class_id) then
        raise exception 'Only the person who shared this key, or a class admin, can remove it.';
    end if;
    delete from public.class_ai_pool where id = p_key_id;
end;
$$;

-- Admins: questions per person per day
create or replace function public.set_class_ai_limit(p_class uuid, p_daily_limit int)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if not public.is_class_admin(p_class) then
        raise exception 'Only class admins can change the allowance.';
    end if;
    if p_daily_limit is null or p_daily_limit not between 1 and 100 then
        raise exception 'The daily allowance must be between 1 and 100.';
    end if;
    insert into public.class_ai_settings (class_id, daily_limit) values (p_class, p_daily_limit)
    on conflict (class_id) do update set daily_limit = excluded.daily_limit, updated_at = now();
end;
$$;

-- Edge Function only (after Groq accepted the key): share p_user's key with the class,
-- replacing the key they shared before
create or replace function public.add_class_ai_key(p_user uuid, p_class uuid, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_key text := btrim(coalesce(p_key, ''));
begin
    if not exists (select 1 from public.class_members where class_id = p_class and user_id = p_user) then
        return jsonb_build_object('error', 'not_member');
    end if;
    if not exists (select 1 from public.classes where id = p_class and status = 'approved') then
        return jsonb_build_object('error', 'not_approved');
    end if;
    if v_key !~ '^gsk_[A-Za-z0-9]{20,200}$' then
        return jsonb_build_object('error', 'format');
    end if;
    if not exists (select 1 from public.class_ai_pool where class_id = p_class and owner_id = p_user)
       and (select count(*) from public.class_ai_pool where class_id = p_class) >= 10 then
        return jsonb_build_object('error', 'full');
    end if;
    insert into public.class_ai_pool (class_id, owner_id, api_key, key_hint)
    values (p_class, p_user, v_key, right(v_key, 4))
    on conflict (class_id, owner_id) do update set
        api_key = excluded.api_key, key_hint = excluded.key_hint, broken = false, added_at = now();
    return jsonb_build_object('ok', true, 'hint', right(v_key, 4));
end;
$$;

-- Edge Function only: Groq refused this key (deleted or wrong), so stop using it
create or replace function public.mark_class_ai_key_broken(p_key_id bigint)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
    update public.class_ai_pool set broken = true where id = p_key_id;
$$;

-- Edge Function only: take p_cost from today's allowance (a negative cost gives it back when the
-- AI couldn't answer) and hand over the class's working keys in a random order, so they take
-- turns. Uses p_class if it has keys, otherwise another class of the person's.
create or replace function public.use_class_ai(p_user uuid, p_class uuid, p_cost int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_class uuid;
    v_limit int;
    v_used int;
    v_keys jsonb;
    v_day date := public.class_ai_today();
begin
    select m.class_id into v_class
    from public.class_members m
    where m.user_id = p_user
      and exists (select 1 from public.class_ai_pool p where p.class_id = m.class_id and not p.broken)
    order by (m.class_id = p_class) desc nulls last, m.joined_at
    limit 1;
    if v_class is null then
        return jsonb_build_object('error', 'no_key');
    end if;
    v_limit := coalesce((select daily_limit from public.class_ai_settings where class_id = v_class), 15);

    insert into public.class_ai_usage (class_id, user_id, day, used)
    values (v_class, p_user, v_day, 0)
    on conflict do nothing;

    update public.class_ai_usage
    set used = greatest(0, used + p_cost)
    where class_id = v_class and user_id = p_user and day = v_day
      and (p_cost < 0 or used + p_cost <= v_limit)
    returning used into v_used;

    if v_used is null then
        select used into v_used from public.class_ai_usage
        where class_id = v_class and user_id = p_user and day = v_day;
        return jsonb_build_object('error', 'limit', 'class_id', v_class, 'used', v_used, 'limit', v_limit);
    end if;
    if p_cost < 0 then
        return jsonb_build_object('class_id', v_class, 'used', v_used, 'limit', v_limit);
    end if;

    select jsonb_agg(jsonb_build_object('id', p.id, 'key', p.api_key) order by random()) into v_keys
    from public.class_ai_pool p
    where p.class_id = v_class and not p.broken;
    return jsonb_build_object('class_id', v_class, 'keys', v_keys, 'used', v_used, 'limit', v_limit);
end;
$$;

revoke execute on function public.class_ai_status() from public, anon;
revoke execute on function public.class_ai_key_list(uuid) from public, anon;
revoke execute on function public.remove_class_ai_key(bigint) from public, anon;
revoke execute on function public.set_class_ai_limit(uuid, int) from public, anon;
revoke execute on function public.add_class_ai_key(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_class_ai_key_broken(bigint) from public, anon, authenticated;
revoke execute on function public.use_class_ai(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.class_ai_status() to authenticated;
grant execute on function public.class_ai_key_list(uuid) to authenticated;
grant execute on function public.remove_class_ai_key(bigint) to authenticated;
grant execute on function public.set_class_ai_limit(uuid, int) to authenticated;
grant execute on function public.add_class_ai_key(uuid, uuid, text) to service_role;
grant execute on function public.mark_class_ai_key_broken(bigint) to service_role;
grant execute on function public.use_class_ai(uuid, uuid, int) to service_role;
