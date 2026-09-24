begin;

-- Phase 1: close browser-facing access immediately, without moving or deleting
-- any setting. Existing service-role consumers retain their current grants.
alter table public.system_settings enable row level security;
revoke all on table public.system_settings from public, anon, authenticated;

do $verify$
begin
    if not (
        select relrowsecurity
          from pg_catalog.pg_class
         where oid = 'public.system_settings'::regclass
    ) then
        raise exception 'system_settings RLS was not enabled';
    end if;

    if has_table_privilege('anon', 'public.system_settings', 'SELECT')
       or has_table_privilege('authenticated', 'public.system_settings', 'SELECT') then
        raise exception 'Browser roles still have SELECT access to system_settings';
    end if;
end
$verify$;

commit;
