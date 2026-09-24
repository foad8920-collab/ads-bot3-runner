const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const phaseOne = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260924110000_secure_system_settings.sql'), 'utf8');
const phaseTwo = fs.readFileSync(path.join(__dirname, '../supabase/manual/phase2_install_bot3_vault_rpc.sql'), 'utf8');
const phaseThree = fs.readFileSync(path.join(__dirname, '../supabase/manual/phase3_cleanup_legacy_bot3_secrets.sql'), 'utf8');

test('Phase 1 secures system_settings without copying or deleting secrets', () => {
    assert.match(phaseOne, /alter table public\.system_settings enable row level security/i);
    assert.match(phaseOne, /revoke all on table public\.system_settings from public, anon, authenticated/i);
    assert.doesNotMatch(phaseOne, /delete\s+from\s+public\.system_settings/i);
    assert.doesNotMatch(phaseOne, /vault\.create_secret/i);
});

test('Phase 2 requires new bot3 and Gemini Vault secrets and never copies legacy values', () => {
    assert.match(phaseTwo, /where name in \('FB_COOKIES_BOT3', 'GEMINI_API_KEY'\)/i);
    assert.match(phaseTwo, /if ready_secret_count <> 2/i);
    assert.doesNotMatch(phaseTwo, /vault\.create_secret/i);
    assert.doesNotMatch(phaseTwo, /from public\.system_settings\s+where\s+key\s+in\s*\([^)]*FB_COOKIES_BOT1/i);
    assert.doesNotMatch(phaseTwo, /delete\s+from\s+public\.system_settings/i);
    assert.match(phaseTwo, /legacy\.value = fresh\.decrypted_secret/i);
});

test('Phase 3 cleans only bot3/Gemini after Vault preflight and leaves bot1/bot2 untouched', () => {
    const verification = phaseThree.indexOf('if ready_secret_count <> 2');
    const deletion = phaseThree.indexOf("delete from public.system_settings");
    assert.ok(verification >= 0);
    assert.ok(deletion > verification);
    assert.match(phaseThree, /where key in \('FB_COOKIES_BOT3', 'GEMINI_KEY', 'GITHUB_PAT'\)/i);
    assert.doesNotMatch(phaseThree, /delete from public\.system_settings\s+where key in \([^)]*FB_COOKIES_BOT1/i);
    assert.match(phaseThree, /legacy\.value = fresh\.decrypted_secret/i);
});

test('bot3 RPC allowlist is browser-inaccessible and Vault has no API role grants', () => {
    assert.match(phaseTwo, /and p_secret_name in \('FB_COOKIES_BOT3', 'GEMINI_API_KEY'\)/i);
    assert.match(phaseTwo, /revoke all on function public\.get_runner_secret\(text\) from public, anon, authenticated/i);
    assert.match(phaseTwo, /grant execute on function public\.get_runner_secret\(text\) to service_role/i);
    assert.match(phaseTwo, /revoke all on schema vault from public, anon, authenticated, service_role/i);
});
