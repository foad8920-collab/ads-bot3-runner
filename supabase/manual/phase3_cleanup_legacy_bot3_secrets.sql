begin;

-- Run only after Phase 2 and a successful RPC + Gemini smoke test using the
-- GitHub Runner key. This script never copies any credential into Vault.
do $preflight$
declare
    ready_secret_count integer;
begin
    select count(*)
      into ready_secret_count
      from vault.decrypted_secrets
     where name in ('FB_COOKIES_BOT3', 'GEMINI_API_KEY')
       and decrypted_secret is not null
       and btrim(decrypted_secret) <> '';

    if ready_secret_count <> 2 then
        raise exception 'Legacy cleanup requires both rotated bot3 and Gemini secrets in Vault';
    end if;

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
        raise exception 'Legacy cleanup refuses a Vault value that matches the compromised legacy credential';
    end if;
end
$preflight$;

delete from public.system_settings
 where key in ('FB_COOKIES_BOT3', 'GEMINI_KEY', 'GITHUB_PAT');

do $verify_cleanup$
begin
    if exists (
        select 1
          from public.system_settings
         where key in ('FB_COOKIES_BOT3', 'GEMINI_KEY', 'GITHUB_PAT')
    ) then
        raise exception 'Bot3/Gemini legacy-secret cleanup was incomplete';
    end if;
end
$verify_cleanup$;

commit;
