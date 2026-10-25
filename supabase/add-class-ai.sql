-- Procrastinote: one AI key per class
-- A class admin saves a Groq key for the class; members without their own key use the AI helper
-- through the class-ai Edge Function, up to a daily allowance each. Nobody can read the key back
-- from the website (not even the admin who saved it): only the Edge Function can use it.
--
-- Run add-classes.sql first. Then paste this whole file into Supabase > SQL Editor > New query
-- and press "Run". It is safe to run again.

create table if not exists public.class_ai_keys (
    class_id uuid primary key references public.classes (id) on delete cascade,
    api_key text not null check (api_key ~ '^gsk_[A-Za-z0-9]{20,200}$'),
    key_hint text not null default '',
    daily_limit int not null default 15 check (daily_limit between 1 and 100),
    updated_by uuid default auth.uid() references auth.users (id) on delete set null,
    updated_at timestamptz not null default now()
);

-- How much each member used today (days run on India time)
create table if not exists public.class_ai_usage (
    class_id uuid not null references public.classes (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    day date not null,
    used int not null default 0 check (used >= 0),
    primary key (class_id, user_id, day)
);

-- Locked: no rules means nobody can read or change these from the website.
-- The functions below (and the Edge Function, with the service role) are the only way in.
alter table public.class_ai_keys enable row level security;
alter table public.class_ai_usage enable row level security;
revoke all on public.class_ai_keys from anon, authenticated;
revoke all on public.class_ai_usage from anon, authenticated;

create or replace function public.class_ai_today()
returns date
language sql
stable
set search_path = ''
as $$
    select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- For every class I'm in: does it have a key, its last 4 characters, the allowance, my use today
create or replace function public.class_ai_status()
returns table (class_id uuid, has_key boolean, key_hint text, daily_limit int, used_today int)
language sql
stable
security definer
set search_path = ''
as $$
    select m.class_id,
           k.class_id is not null,
           coalesce(k.key_hint, ''),
           coalesce(k.daily_limit, 15),
           coalesce((select u.used from public.class_ai_usage u
                     where u.class_id = m.class_id and u.user_id = auth.uid() and u.day = public.class_ai_today()), 0)
    from public.class_members m
    left join public.class_ai_keys k on k.class_id = m.class_id
    where m.user_id = auth.uid();
$$;

-- Admins: save or replace the class key (and the daily allowance per person)
create or replace function public.set_class_ai_key(p_class uuid, p_key text, p_daily_limit int)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_key text := btrim(coalesce(p_key, ''));
begin
    if not public.is_class_admin(p_class) then
        raise exception 'Only class admins can set the class AI key.';
    end if;
    if v_key !~ '^gsk_[A-Za-z0-9]{20,200}$' then
        raise exception 'That doesn''t look like a Groq key. It starts with gsk_.';
    end if;
    if p_daily_limit is null or p_daily_limit not between 1 and 100 then
        raise exception 'The daily allowance must be between 1 and 100.';
    end if;
    insert into public.class_ai_keys (class_id, api_key, key_hint, daily_limit, updated_by, updated_at)
    values (p_class, v_key, right(v_key, 4), p_daily_limit, auth.uid(), now())
    on conflict (class_id) do update set
        api_key = excluded.api_key, key_hint = excluded.key_hint, daily_limit = excluded.daily_limit,
        updated_by = excluded.updated_by, updated_at = now();
end;
$$;

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
    update public.class_ai_keys set daily_limit = p_daily_limit, updated_at = now() where class_id = p_class;
end;
$$;

create or replace function public.remove_class_ai_key(p_class uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if not public.is_class_admin(p_class) then
        raise exception 'Only class admins can remove the class AI key.';
    end if;
    delete from public.class_ai_keys where class_id = p_class;
end;
$$;

-- Edge Function only: take p_cost from today's allowance (a negative cost gives it back when the
-- AI couldn't answer). Uses p_class if it has a key, otherwise another class of the person's.
create or replace function public.use_class_ai(p_user uuid, p_class uuid, p_cost int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_class uuid;
    v_key text;
    v_limit int;
    v_used int;
    v_day date := public.class_ai_today();
begin
    select k.class_id, k.api_key, k.daily_limit into v_class, v_key, v_limit
    from public.class_ai_keys k
    join public.class_members m on m.class_id = k.class_id and m.user_id = p_user
    order by (k.class_id = p_class) desc nulls last, k.updated_at
    limit 1;
    if v_class is null then
        return jsonb_build_object('error', 'no_key');
    end if;

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
    return jsonb_build_object('class_id', v_class, 'key', v_key, 'used', v_used, 'limit', v_limit);
end;
$$;

revoke execute on function public.class_ai_status() from public, anon;
revoke execute on function public.set_class_ai_key(uuid, text, int) from public, anon;
revoke execute on function public.set_class_ai_limit(uuid, int) from public, anon;
revoke execute on function public.remove_class_ai_key(uuid) from public, anon;
revoke execute on function public.use_class_ai(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.class_ai_status() to authenticated;
grant execute on function public.set_class_ai_key(uuid, text, int) to authenticated;
grant execute on function public.set_class_ai_limit(uuid, int) to authenticated;
grant execute on function public.remove_class_ai_key(uuid) to authenticated;
grant execute on function public.use_class_ai(uuid, uuid, int) to service_role;
