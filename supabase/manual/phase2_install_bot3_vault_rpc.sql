begin;

create extension if not exists supabase_vault with schema vault;

do $preflight$
declare
    ready_secret_count integer;
begin
    -- Never fall back to, copy, or compare against the compromised legacy rows.
    select count(*)
      into ready_secret_count
      from vault.decrypted_secrets
     where name in ('FB_COOKIES_BOT3', 'GEMINI_API_KEY')
       and decrypted_secret is not null
       and btrim(decrypted_secret) <> '';

    if ready_secret_count <> 2 then
        raise exception 'Phase 2 requires newly rotated bot3 cookies and Gemini key in Supabase Vault';
    end if;

    -- Refuse any Vault value that is just the compromised credential moved over.
    -- Comparisons are internal and never returned or logged.
    if exists (
        select 1
          from vault.decrypted_secrets fresh
          join public.system_settings legacy
            on legacy.key = case
                when fresh.name = 'GEMINI_API_KEY' then 'GEMINI_KEY'
                else fresh.name
            end
           and legacy.value = fresh.decrypted_secret
         where fresh.name in ('FB_COOKIES_BOT3', 'GEMINI_API_KEY')
    ) then
        raise exception 'Phase 2 refuses a Vault value that matches the compromised legacy credential';
    end if;
end
$preflight$;

create or replace function public.get_runner_secret(p_secret_name text)
returns table(secret_value text)
language sql
security definer
set search_path = pg_catalog
as $function$
    select decrypted_secret
      from vault.decrypted_secrets
     where name = p_secret_name
       and p_secret_name in ('FB_COOKIES_BOT3', 'GEMINI_API_KEY')
     limit 1;
$function$;

alter function public.get_runner_secret(text) owner to postgres;
revoke all on function public.get_runner_secret(text) from public, anon, authenticated;
grant execute on function public.get_runner_secret(text) to service_role;

revoke all on schema vault from public, anon, authenticated, service_role;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;

commit;
