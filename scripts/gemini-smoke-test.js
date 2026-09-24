const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { createVaultSecretReader } = require('../vault-utils');
const { normalizeCookies } = require('../cookie-utils');
const { buildPrompt, selectGeminiModel } = require('../ai-utils');
const { extractProtectedTerms, validateRewrittenText } = require('../text-utils');

const title = 'سيارة للبيع موديل 2020 بسعر 15000 ريال';
const description = 'للتواصل 777123456 في صنعاء';
const original = `${title}\n\n${description}`;

function sanitizeProviderMessage(message, secrets = []) {
    let safe = String(message || 'Provider did not return a message');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length > 0) safe = safe.split(secret).join('[redacted]');
    }
    return safe
        .replace(/AIza[\w-]{20,}/gu, '[redacted]')
        .replace(/\beyJ[\w.-]{20,}\b/gu, '[redacted]')
        .replace(/(api[-_ ]?key|token|secret|cookie)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
        .replace(/https?:\/\/\S+/giu, '[URL redacted]')
        .replace(/[\r\n\t]+/gu, ' ')
        .slice(0, 320);
}

function safeProviderError(error, secrets = []) {
    const provider = error?.response?.data?.error || {};
    const safeToken = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/u.test(value)) return null;
        return value;
    };
    return {
        httpStatus: Number.isInteger(error?.response?.status) ? error.response.status : null,
        code: safeToken(provider.code),
        type: safeToken(provider.status || provider.type),
        message: sanitizeProviderMessage(provider.message || error?.code || error?.message, secrets)
    };
}

function extractGeneratedText(response) {
    return response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => typeof part.text === 'string' ? part.text : '')
        .join('\n')
        .replace(/^`{3}(?:\w+)?\s*|\s*`{3}$/gu, '')
        .trim() || '';
}

function printStage(name, ok, detail = '') {
    console.log(`${name}: ${ok ? 'OK' : 'FAILED'}${detail ? ` (${detail})` : ''}`);
}

async function runSmokeTest() {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const supabaseKey = process.env.SUPABASE_SECRET_KEY?.trim();
    if (!supabaseUrl || !supabaseKey) {
        printStage('Supabase connection', false, 'runner credentials are not configured');
        printStage('FB_COOKIES_BOT3 RPC read', false, 'not attempted');
        printStage('GEMINI_API_KEY RPC read', false, 'not attempted');
        printStage('Gemini HTTP request', false, 'not attempted');
        printStage('Gemini response validation', false, 'not attempted');
        return false;
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const getVaultSecret = createVaultSecretReader(supabase);
    const stages = { connection: false, cookies: false, geminiKey: false, http: false, validation: false };
    let cookieSecret = '';
    let apiKey = '';
    let providerFailure = null;
    let validationReason = null;

    try {
        const { error } = await supabase.from('bot_counters').select('bot_name').limit(1);
        stages.connection = !error;
    } catch {}

    try {
        cookieSecret = await getVaultSecret('FB_COOKIES_BOT3');
        const normalized = normalizeCookies(JSON.parse(cookieSecret));
        stages.cookies = Array.isArray(normalized) && normalized.length > 0;
    } catch {}

    try {
        apiKey = await getVaultSecret('GEMINI_API_KEY');
        stages.geminiKey = Boolean(apiKey.trim());
    } catch {}

    const privateValues = [apiKey, cookieSecret];
    const protectedTerms = extractProtectedTerms(original);
    let modelName = null;

    if (stages.geminiKey) {
        try {
            const modelsResponse = await axios.get(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { headers: { 'x-goog-api-key': apiKey }, timeout: 15000 }
            );
            const available = (modelsResponse.data?.models || []).filter((model) =>
                model.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(model.name || '')
            );
            modelName = selectGeminiModel(modelsResponse.data?.models)?.name || null;


            if (!modelName) throw new Error('No Gemini text-generation model is available');

            for (let attempt = 0; attempt < 2; attempt++) {
                let response;
                try {
                    response = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`,
                        { contents: [{ parts: [{ text: buildPrompt(original, protectedTerms, attempt === 1) }] }] },
                        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 60000 }
                    );
                } catch (error) {
                    providerFailure = safeProviderError(error, privateValues);
                    break;
                }

                stages.http = response.status >= 200 && response.status < 300;
                const generatedText = extractGeneratedText(response);
                const validation = validateRewrittenText(original, generatedText, protectedTerms);
                validationReason = validation.reason;
                stages.validation = validation.valid && generatedText !== original;
                if (stages.validation) break;
            }
        } catch (error) {
            if (!providerFailure) providerFailure = safeProviderError(error, privateValues);
        }
    }

    printStage('Supabase connection', stages.connection);
    printStage('FB_COOKIES_BOT3 RPC read', stages.cookies);
    printStage('GEMINI_API_KEY RPC read', stages.geminiKey);
    if (!stages.geminiKey) {
        printStage('Gemini HTTP request', false, 'not attempted; API key RPC read failed');
        printStage('Gemini response validation', false, 'not attempted');
    } else {
        if (providerFailure) stages.http = false;
        const httpDetail = providerFailure
            ? [providerFailure.httpStatus ? `HTTP ${providerFailure.httpStatus}` : null,
                providerFailure.code ? `code ${providerFailure.code}` : null,
                providerFailure.type ? `type ${providerFailure.type}` : null]
                .filter(Boolean).join('; ')
            : '';
        printStage('Gemini HTTP request', stages.http, httpDetail);
        if (providerFailure?.message) console.log(`Gemini API error (sanitized): ${providerFailure.message}`);
        printStage('Gemini response validation', stages.validation,
            validationReason && !stages.validation ? `reason ${validationReason}` : '');
    }

    return Object.values(stages).every(Boolean);
}

if (require.main === module) {
    runSmokeTest().then((passed) => {
        if (!passed) process.exitCode = 1;
    }).catch(() => {
        console.error('Gemini diagnostic failed unexpectedly; no secret values were logged.');
        process.exitCode = 1;
    });
}

module.exports = { runSmokeTest, safeProviderError, sanitizeProviderMessage };
