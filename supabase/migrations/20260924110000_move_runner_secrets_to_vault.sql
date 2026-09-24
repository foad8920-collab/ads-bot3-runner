begin;

create extension if not exists supabase_vault with schema vault;

do $migration$
declare
    source_row record;
    missing_secret_count integer;
    verified_secret_count integer;
begin
    select count(*)
      into missing_secret_count
      from (values
        ('FB_COOKIES_BOT1', 'FB_COOKIES_BOT1'),
        ('FB_COOKIES_BOT2', 'FB_COOKIES_BOT2'),
        ('FB_COOKIES_BOT3', 'FB_COOKIES_BOT3'),
        ('GEMINI_API_KEY', 'GEMINI_KEY')
      ) as required(vault_name, source_key)
     where not exists (
        select 1 from vault.secrets destination
         where destination.name = required.vault_name
     )
       and not exists (
        select 1 from public.system_settings source
         where source.key = required.source_key
           and source.value is not null
           and btrim(source.value) <> ''
     );

    if missing_secret_count <> 0 then
        raise exception 'Vault migration requires each secret to exist in Vault or in the legacy table; no rows were removed';
    end if;

    for source_row in
        select source.key,
               case when source.key = 'GEMINI_KEY' then 'GEMINI_API_KEY' else source.key end as vault_name,
               source.value
          from public.system_settings as source
         where source.key in (
            'FB_COOKIES_BOT1',
            'FB_COOKIES_BOT2',
            'FB_COOKIES_BOT3',
            'GEMINI_KEY'
         )
           and not exists (
                select 1
                  from vault.secrets destination
                 where destination.name = case
                    when source.key = 'GEMINI_KEY' then 'GEMINI_API_KEY'
                    else source.key
                 end
           )
    loop
        perform vault.create_secret(
            source_row.value,
            source_row.vault_name,
            'Migrated from system_settings by the runner security migration'
        );
    end loop;

    select count(*)
      into verified_secret_count
      from vault.decrypted_secrets
     where name in (
        'FB_COOKIES_BOT1',
        'FB_COOKIES_BOT2',
        'FB_COOKIES_BOT3',
        'GEMINI_API_KEY'
     )
       and decrypted_secret is not null
       and btrim(decrypted_secret) <> '';

    if verified_secret_count <> 4 then
        raise exception 'Vault value verification failed; the transaction will be rolled back';
    end if;

    delete from public.system_settings
     where key in (
        'FB_COOKIES_BOT1',
        'FB_COOKIES_BOT2',
        'FB_COOKIES_BOT3',
        'GEMINI_KEY',
        'GITHUB_PAT'
     );
    if exists (
        select 1 from public.system_settings
         where key in (
            'FB_COOKIES_BOT1',
            'FB_COOKIES_BOT2',
            'FB_COOKIES_BOT3',
            'GEMINI_KEY',
            'GITHUB_PAT'
         )
    ) then
        raise exception 'System settings cleanup verification failed; the transaction will be rolled back';
    end if;
end
$migration$;

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

alter table public.system_settings enable row level security;
revoke all on table public.system_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.system_settings to service_role;

commit;
