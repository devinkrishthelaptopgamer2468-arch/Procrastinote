-- Procrastinote: deleting your account, and reporting AI replies
-- Run this whole file once in Supabase: SQL Editor > New query > paste > Run.
-- It's safe to run again.
--
-- 1. account_storage_files: the files someone uploaded (or was sent), so the delete-account
--    Edge Function can remove them from Storage. Storage files don't disappear by themselves
--    when the account goes, unlike rows in tables.
-- 2. hand_over_classes: before an account is deleted, each class it owns passes to another
--    admin (or else the member who joined first), so the class isn't deleted for everyone.
--    A class with nobody else in it is deleted.
-- 3. ai_reports: "Report this reply" on AI answers. Anyone logged in can send a report;
--    only the site owner can read them (Table Editor > ai_reports).
--
-- 1 and 2 can only be used by the delete-account Edge Function (the service role), never
-- from the website.

-- =========================================================
-- 1. Files that belong to an account
--    shared-files: <sender>/<receiver>/...   class-files: <class>/<folder>/<uploader>/...
--    board-photos: <board>/<poster>/...
-- =========================================================
create or replace function public.account_storage_files(p_user uuid)
returns table (bucket_id text, name text)
language sql
stable
security definer
set search_path = ''
as $$
    select o.bucket_id, o.name
    from storage.objects o
    where (o.bucket_id = 'shared-files'
            and p_user::text in ((storage.foldername(o.name))[1], (storage.foldername(o.name))[2]))
       or (o.bucket_id = 'class-files' and (storage.foldername(o.name))[3] = p_user::text)
       or (o.bucket_id = 'board-photos' and (storage.foldername(o.name))[2] = p_user::text);
$$;

revoke all on function public.account_storage_files(uuid) from public, anon, authenticated;
grant execute on function public.account_storage_files(uuid) to service_role;

-- =========================================================
-- 2. Hand over classes the account owns
--    Returns how many classes were handed over and how many were deleted.
-- =========================================================
create or replace function public.hand_over_classes(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_class record;
    v_next uuid;
    v_handed int := 0;
    v_deleted int := 0;
begin
    for v_class in select c.id from public.classes c where c.owner_id = p_user loop
        select m.user_id into v_next
        from public.class_members m
        where m.class_id = v_class.id and m.user_id <> p_user
        order by (m.role = 'admin') desc, m.joined_at asc
        limit 1;

        if v_next is null then
            delete from public.classes where id = v_class.id;
            v_deleted := v_deleted + 1;
        else
            update public.classes set owner_id = v_next where id = v_class.id;
            update public.class_members set role = 'owner' where class_id = v_class.id and user_id = v_next;
            delete from public.class_members where class_id = v_class.id and user_id = p_user;
            v_handed := v_handed + 1;
        end if;
    end loop;
    return jsonb_build_object('handed_over', v_handed, 'deleted', v_deleted);
end;
$$;

revoke all on function public.hand_over_classes(uuid) from public, anon, authenticated;
grant execute on function public.hand_over_classes(uuid) to service_role;

-- =========================================================
-- 3. Reports about AI replies
-- =========================================================
create table if not exists public.ai_reports (
    id bigint generated always as identity primary key,
    reporter_id uuid default auth.uid() references auth.users (id) on delete set null,
    source text not null check (source in ('assistant', 'buddy')),
    question text check (question is null or char_length(question) <= 4000),
    reply text not null check (char_length(reply) between 1 and 8000),
    reason text not null check (reason in ('harmful', 'wrong', 'rude', 'other')),
    details text check (details is null or char_length(details) <= 500),
    created_at timestamptz not null default now()
);

alter table public.ai_reports enable row level security;

drop policy if exists "Anyone logged in can report an AI reply" on public.ai_reports;
create policy "Anyone logged in can report an AI reply" on public.ai_reports
    for insert to authenticated
    with check (reporter_id = auth.uid());

drop policy if exists "The site owner can read AI reports" on public.ai_reports;
create policy "The site owner can read AI reports" on public.ai_reports
    for select to authenticated
    using (public.is_site_owner());

drop policy if exists "The site owner can delete AI reports" on public.ai_reports;
create policy "The site owner can delete AI reports" on public.ai_reports
    for delete to authenticated
    using (public.is_site_owner());
