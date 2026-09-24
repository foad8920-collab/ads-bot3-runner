const test = require('node:test');
const assert = require('node:assert/strict');
const { RUNNER_SECRET_NAMES, createVaultSecretReader } = require('../vault-utils');

test('runner secret allowlist contains only bot3 cookies and Gemini', () => {
    assert.deepEqual([...RUNNER_SECRET_NAMES].sort(), ['FB_COOKIES_BOT3', 'GEMINI_API_KEY']);
});

test('reads an allowed secret through the restricted Supabase RPC', async () => {
    const calls = [];
    const readSecret = createVaultSecretReader({
        rpc: async (...args) => {
            calls.push(args);
            return { data: [{ secret_value: 'test-only-secret' }], error: null };
        }
    });

    assert.equal(await readSecret('GEMINI_API_KEY'), 'test-only-secret');
    assert.deepEqual(calls, [['get_runner_secret', { p_secret_name: 'GEMINI_API_KEY' }]]);
});

test('does not allow this runner to retrieve other bots secrets', async () => {
    let called = false;
    const readSecret = createVaultSecretReader({
        rpc: async () => { called = true; return { data: [], error: null }; }
    });

    await assert.rejects(readSecret('FB_COOKIES_BOT1'), /not allowed/);
    assert.equal(called, false);
});

test('sanitizes Vault errors and rejects missing secret values', async () => {
    const readFailingSecret = createVaultSecretReader({
        rpc: async () => ({ data: null, error: { message: 'provider detail with secret' } })
    });
    await assert.rejects(readFailingSecret('GEMINI_API_KEY'), /Unable to read the required secret/);

    const readMissingSecret = createVaultSecretReader({
        rpc: async () => ({ data: [], error: null })
    });
    await assert.rejects(readMissingSecret('FB_COOKIES_BOT3'), /not configured: FB_COOKIES_BOT3/);
});
