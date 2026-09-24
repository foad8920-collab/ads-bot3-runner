const { rewriteAdWithGemini } = require('../ai-utils');

const title = 'سيارة للبيع موديل 2020 بسعر 15000 ريال';
const description = 'للتواصل 777123456 في صنعاء';
const original = `${title}\n\n${description}`;

if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('Gemini smoke test failed: GEMINI_API_KEY is not configured.');
    process.exit(1);
}

rewriteAdWithGemini(title, description, {
    log: async (message) => console.log(message)
}).then((rewritten) => {
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
