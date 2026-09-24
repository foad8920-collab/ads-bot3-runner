const axios = require('axios');
const { extractProtectedTerms, validateRewrittenText } = require('./text-utils');
const GEMINI_MODEL_PRIORITY = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
];

function buildPrompt(original, protectedTerms) {
    const newline = String.fromCharCode(10);
    return [
        'أعد صياغة الإعلان باللغة العربية الطبيعية فقط. غيّر العنوان وترتيب الجمل وأسلوب الوصف بوضوح، مع الحفاظ على جميع المعلومات.',
        '',
        'ممنوع:',
        '- تغيير أي رقم أو هاتف أو سعر أو رابط أو اسم شخص أو شركة أو مدينة أو منطقة أو منتج أو موديل أو سنة.',
        '- حذف أي معلومة أو اختراع معلومات غير موجودة.',
        '- تغيير العناصر المحمية أو ترجمة الأسماء الإنجليزية.',
        '- كتابة أحرف عربية منفصلة مثل: س و ق، أو تشويه الكلمات أو إدخال رموز غريبة داخلها.',
        '- تحويل الأرقام العربية إلى إنجليزية أو العكس.',
        '',
        'يجب إبقاء هذه العناصر كما هي حرفيًا:',
        protectedTerms.join(newline),
        '',
        'إذا تعذرت إعادة الصياغة مع إبقاء جميع الكلمات والبيانات الأساسية، أعد النص الأصلي حرفيًا.',
        '',
        'النص الأصلي:',
        original,
        '',
        'أعد نص الإعلان فقط، بلا شرح أو علامات Markdown.'
    ].join(newline);
}

function extractGeneratedText(response) {
    let text = response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join(String.fromCharCode(10)) || '';
    const fence = String.fromCharCode(96).repeat(3);
    if (text.startsWith(fence)) {
        const newlineIndex = text.indexOf(String.fromCharCode(10));
        text = newlineIndex < 0 ? '' : text.slice(newlineIndex + 1);
    }
    if (text.endsWith(fence)) text = text.slice(0, -fence.length);
    return text.trim();
}

function modelId(model) {
    return String(model?.name || '').split('/').pop().toLowerCase();
}

function orderGeminiModels(models) {
    const supported = new Map();
    for (const model of models || []) {
        if (!model?.supportedGenerationMethods?.includes('generateContent')) continue;
        const id = modelId(model);
        if (GEMINI_MODEL_PRIORITY.includes(id) && !supported.has(id)) supported.set(id, model);
    }
    return GEMINI_MODEL_PRIORITY.map((id) => supported.get(id)).filter(Boolean);
}

function selectGeminiModel(models) {
    return orderGeminiModels(models)[0] || null;
}

async function rewriteAdWithGemini(title, description, options = {}) {
    const paragraphBreak = String.fromCharCode(10).repeat(2);
    const original = [String(title || '').trim(), String(description || '').trim()]
        .filter(Boolean).join(paragraphBreak);
    const apiKey = (options.apiKey || '').trim();
    const log = options.log || (async () => {});
    if (!original || !apiKey) {
        await log('Gemini rewrite rejected - original text will be used');
        return original;
    }

    const protectedTerms = extractProtectedTerms(original, options.protectedTerms || []);
    let models;
    try {
        if (Array.isArray(options.models)) {
            models = options.models;
        } else {
            const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
                headers: { 'x-goog-api-key': apiKey }, timeout: 15000
            });
            models = response.data?.models || [];
        }
    } catch {
        await log('Gemini rewrite rejected - original text will be used');
        return original;
    }

    const candidates = orderGeminiModels(models);
    const generate = options.generate || (async (model, prompt) => {
        const response = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/' + model.name + ':generateContent',
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 60000 }
        );
        return extractGeneratedText(response);
    });

    for (const model of candidates) {
        const id = modelId(model);
        try {
            const generated = await generate(model, buildPrompt(original, protectedTerms));
            const text = typeof generated === 'string' ? generated : generated?.text;
            if (validateRewrittenText(original, text, protectedTerms).valid) {
                await log('Gemini model succeeded: ' + id);
                return text.trim();
            }
        } catch {
            // Continue to the next tested model without logging provider details or credentials.
        }
        await log('Gemini model failed: ' + id);
    }

    await log('Gemini rewrite rejected - original text will be used');
    return original;
}

module.exports = { buildPrompt, rewriteAdWithGemini, selectGeminiModel, orderGeminiModels, GEMINI_MODEL_PRIORITY };
