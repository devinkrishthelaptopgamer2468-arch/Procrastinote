-- Procrastinote: phone notifications when the site is closed (part 2 of the Supabase setup)
-- Run add-push-notifications.sql first, deploy the send-push Edge Function, and save the
-- "push_webhook_secret" in Vault (SUPABASE_SETUP.md step 10 explains all of it).
-- Then paste this whole file into Supabase > SQL Editor > New query and press "Run".
-- It is safe to run again. Supabase may warn about "destructive operations": that's only the
-- "drop trigger if exists" lines, which remove and recreate this feature's own triggers.
--
-- When a message, file, note, class homework or timetable change is saved, a trigger asks the
-- send-push function to notify the right people. A schedule also calls it every 15 minutes so it
-- can send each student's daily homework reminder at the time they picked.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Calls the send-push Edge Function in the background (pg_net), so saving is never slowed down.
-- If anything is missing (no secret yet, network trouble), it quietly skips: the message,
-- file or homework still saves normally, just without a phone notification.
create or replace function public.call_send_push(payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    push_secret text;
begin
    select decrypted_secret into push_secret
    from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
    if push_secret is null or push_secret = '' then
        return;
    end if;
    perform net.http_post(
        url := 'https://nyjhisnjsuhihjonktfc.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', push_secret),
        body := payload,
        timeout_milliseconds := 10000
    );
exception when others then
    raise warning 'send-push skipped: %', sqlerrm;
end;
$$;

create or replace function public.push_on_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    rec jsonb := to_jsonb(new);
    old_rec jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
begin
    -- A class row holds the whole timetable; send only what the notification needs
    if tg_table_name = 'classes' then
        rec := jsonb_build_object('id', new.id, 'name', new.name, 'status', new.status,
            'timetable_updated_at', new.timetable_updated_at);
        old_rec := jsonb_build_object('timetable_updated_at', old.timetable_updated_at);
    end if;
    perform public.call_send_push(jsonb_build_object(
        'type', tg_op, 'table', tg_table_name, 'record', rec, 'old_record', old_rec));
    return null;
end;
$$;

-- Nobody can call these from the website; only the triggers and the schedule use them
revoke execute on function public.call_send_push(jsonb) from public, anon, authenticated;
revoke execute on function public.push_on_change() from public, anon, authenticated;

drop trigger if exists push_on_friend_message on public.messages;
create trigger push_on_friend_message after insert on public.messages
    for each row execute function public.push_on_change();

drop trigger if exists push_on_shared_file on public.shared_files;
create trigger push_on_shared_file after insert on public.shared_files
    for each row execute function public.push_on_change();

drop trigger if exists push_on_shared_note on public.shared_notes;
create trigger push_on_shared_note after insert on public.shared_notes
    for each row execute function public.push_on_change();

drop trigger if exists push_on_group_message on public.group_messages;
create trigger push_on_group_message after insert on public.group_messages
    for each row execute function public.push_on_change();

drop trigger if exists push_on_class_homework on public.class_homework;
create trigger push_on_class_homework after insert on public.class_homework
    for each row execute function public.push_on_change();

drop trigger if exists push_on_timetable_change on public.classes;
create trigger push_on_timetable_change after update of timetable_updated_at on public.classes
    for each row when (new.timetable_updated_at is distinct from old.timetable_updated_at)
    execute function public.push_on_change();

-- Class occasions (only once add-class-occasions.sql has made the table)
do $$
begin
    if to_regclass('public.class_occasions') is not null then
        drop trigger if exists push_on_class_occasion on public.class_occasions;
        create trigger push_on_class_occasion after insert on public.class_occasions
            for each row execute function public.push_on_change();
    end if;
end;
$$;

-- Daily homework reminders: every 15 minutes the function checks whose reminder time has come
select cron.schedule(
    'procrastinote-homework-reminders',
    '*/15 * * * *',
    $$ select public.call_send_push('{"job": "homework-reminders"}'::jsonb) $$
);
