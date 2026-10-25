-- Procrastinote: class occasions (Sports Day, PTM...) that class admins add for the whole class
-- Run add-classes.sql first. Then paste this whole file into Supabase > SQL Editor > New query
-- and press "Run". It is safe to run again. Supabase may warn about "destructive operations":
-- that's only the "drop ... if exists" lines, which recreate this feature's own rules.
--
-- Every member sees the class's occasions in their Calendar and on the dashboard, and gets a
-- reminder the day before (the send-push function reads this table).

create table if not exists public.class_occasions (
    id bigint generated always as identity primary key,
    class_id uuid not null references public.classes (id) on delete cascade,
    occasion_date date not null,
    name text not null check (char_length(btrim(name)) between 1 and 60),
    created_by uuid default auth.uid() references auth.users (id) on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists class_occasions_class_idx on public.class_occasions (class_id, occasion_date);

alter table public.class_occasions enable row level security;

drop policy if exists "Members can see class occasions" on public.class_occasions;
create policy "Members can see class occasions" on public.class_occasions
    for select to authenticated
    using (public.is_class_member(class_id));

-- Admins of an approved class, up to 300 occasions per class
drop policy if exists "Admins can add class occasions" on public.class_occasions;
create policy "Admins can add class occasions" on public.class_occasions
    for insert to authenticated
    with check (
        created_by = auth.uid()
        and public.is_class_admin(class_id)
        and exists (select 1 from public.classes c where c.id = class_id and c.status = 'approved')
        and (select count(*) from public.class_occasions o where o.class_id = class_occasions.class_id) < 300
    );

drop policy if exists "Admins can delete class occasions" on public.class_occasions;
create policy "Admins can delete class occasions" on public.class_occasions
    for delete to authenticated
    using (public.is_class_admin(class_id));

grant select, insert, delete on public.class_occasions to authenticated;

-- Live updates, so a new occasion shows up for everyone straight away
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'class_occasions') then
        alter publication supabase_realtime add table public.class_occasions;
    end if;
end;
$$;

-- Phone notification to the class when an admin adds one (only if phone notifications are set
-- up, i.e. add-push-triggers.sql has been run)
do $$
begin
    if to_regprocedure('public.push_on_change()') is not null then
        drop trigger if exists push_on_class_occasion on public.class_occasions;
        create trigger push_on_class_occasion after insert on public.class_occasions
            for each row execute function public.push_on_change();
    end if;
end;
$$;
