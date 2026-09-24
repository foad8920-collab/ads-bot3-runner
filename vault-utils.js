const RUNNER_SECRET_NAMES = new Set(['FB_COOKIES_BOT3', 'GEMINI_API_KEY']);

function createVaultSecretReader(supabase) {
    if (!supabase || typeof supabase.rpc !== 'function') {
        throw new TypeError('A Supabase client is required');
    }

    return async function getVaultSecret(secretName) {
        if (!RUNNER_SECRET_NAMES.has(secretName)) {
            throw new Error('This runner is not allowed to request that Vault secret');
        }

        const { data, error } = await supabase.rpc('get_runner_secret', {
            p_secret_name: secretName
        });

        if (error) throw new Error('Unable to read the required secret from Supabase Vault');

        const secretValue = Array.isArray(data) ? data[0]?.secret_value : null;
        if (typeof secretValue !== 'string' || !secretValue.trim()) {
            throw new Error(`Required Vault secret is not configured: ${secretName}`);
        }

        return secretValue;
    };
}

module.exports = { RUNNER_SECRET_NAMES, createVaultSecretReader };
