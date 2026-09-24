const { rewriteAdWithGemini } = require('../ai-utils');
const { createClient } = require('@supabase/supabase-js');
const { createVaultSecretReader } = require('../vault-utils');

const title = 'سيارة للبيع موديل 2020 بسعر 15000 ريال';
const description = 'للتواصل 777123456 في صنعاء';
const original = `${title}\n\n${description}`;

if (!process.env.SUPABASE_URL?.trim() || !process.env.SUPABASE_SECRET_KEY?.trim()) {
    console.error('Gemini smoke test failed: Supabase runner credentials are not configured.');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});
const getVaultSecret = createVaultSecretReader(supabase);

getVaultSecret('GEMINI_API_KEY').then((apiKey) => rewriteAdWithGemini(title, description, {
    apiKey,
    log: async (message) => console.log(message)
})).then((rewritten) => {
    if (!rewritten || rewritten === original) {
        console.error('Gemini smoke test failed: no validated rewrite was returned.');
        process.exitCode = 1;
        return;
    }
    console.log('Gemini smoke test passed: a validated Arabic rewrite differs from the sample.');
}).catch(() => {
    console.error('Gemini smoke test failed without exposing provider details.');
    process.exitCode = 1;
});
