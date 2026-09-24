const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260924110000_move_runner_secrets_to_vault.sql'), 'utf8');

test('Vault migration verifies every destination before deleting source rows', () => {
    const verification = migration.indexOf('if verified_secret_count <> 4');
    const deletion = migration.indexOf('delete from public.system_settings');
    assert.ok(verification >= 0);
    assert.ok(deletion > verification);
    assert.match(migration, /vault\.create_secret\(/i);
    assert.match(migration, /'GEMINI_KEY' then 'GEMINI_API_KEY'/i);
    assert.match(migration, /'GITHUB_PAT'/i);
});

test('browser roles cannot read Vault or execute the runner-secret RPC', () => {
    assert.match(migration, /revoke all on function public\.get_runner_secret\(text\) from public, anon, authenticated/i);
    assert.match(migration, /grant execute on function public\.get_runner_secret\(text\) to service_role/i);
    assert.match(migration, /revoke all on schema vault from public, anon, authenticated, service_role/i);
    assert.match(migration, /alter table public\.system_settings enable row level security/i);
});
