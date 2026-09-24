const axios = require('axios');
const { extractProtectedTerms, validateRewrittenText } = require('./text-utils');
let cachedModelsPromise;

function buildPrompt(original, protectedTerms, strictRetry = false) {
    return `أعد صياغة الإعلان باللغة العربية الطبيعية فقط. غيّر العنوان وترتيب الجمل وأسلوب الوصف بوضوح، مع الحفاظ على جميع المعلومات.

ممنوع:
- تغيير أي رقم أو هاتف أو سعر أو رابط أو اسم شخص أو شركة أو مدينة أو منطقة أو منتج أو موديل أو سنة.
- حذف أي معلومة أو اختراع معلومات غير موجودة.
- تغيير العناصر المحمية أو ترجمة الأسماء الإنجليزية.
- كتابة أحرف عربية منفصلة مثل: س و ق، أو تشويه الكلمات أو إدخال رموز غريبة داخلها.
- تحويل الأرقام العربية إلى إنجليزية أو العكس.

يجب إبقاء هذه العناصر كما هي حرفيًا:
${protectedTerms.join('\n')}

إذا تعذرت إعادة الصياغة مع إبقاء جميع الكلمات والبيانات الأساسية، أعد النص الأصلي حرفيًا.
${strictRetry ? '\nهذه محاولة أخيرة: أعد الصياغة بترتيب وجمل مختلفين بوضوح، ولا تحذف أو تعدل أي كلمة مهمة أو عنصر محمي.' : ''}

النص الأصلي:
${original}

أعد نص الإعلان فقط، بلا شرح أو علامات Markdown.`;
}

function extractGeneratedText(response) {
    return response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .replace(/^```(?:\w+)?\s*|\s*```$/gu, '')
        .trim() || '';
}

async function rewriteAdWithGemini(title, description, options = {}) {
    const original = [String(title || '').trim(), String(description || '').trim()]
        .filter(Boolean).join('\n\n');
    const apiKey = (options.apiKey || process.env.GEMINI_API_KEY || '').trim();
    const log = options.log || (async () => {});
    if (!original || !apiKey) {
        await log('Gemini rewrite rejected - original text will be used');
        return original;
    }

    const explicit = options.protectedTerms || [];
    const protectedTerms = extractProtectedTerms(original, explicit);
    const generate = options.generate || (async (prompt, retry) => {
        if (!cachedModelsPromise) {
            cachedModelsPromise = axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
                headers: { 'x-goog-api-key': apiKey }, timeout: 15000
            }).catch((error) => {
                cachedModelsPromise = undefined;
                throw error;
            });
        }
        const models = await cachedModelsPromise;
        const available = (models.data?.models || []).filter((model) =>
            model.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(model.name || '')
        );
        const preferred = available.find((model) => /gemini-2\.5-flash/i.test(model.name)) || available[0];
        if (!preferred) throw new Error('No Gemini text-generation model is available');
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/${preferred.name}:generateContent`,
            { contents: [{ parts: [{ text: buildPrompt(original, protectedTerms, retry) }] }] },
            { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 60000 }
        );
        return { text: extractGeneratedText(response), model: preferred.name.replace(/^models\//u, '') };
    });

    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            const generated = await generate(buildPrompt(original, protectedTerms, attempt === 1), attempt === 1);
            const result = typeof generated === 'string' ? { text: generated, model: 'Gemini' } : generated;
            if (validateRewrittenText(original, result.text, protectedTerms).valid) {
                await log(`Gemini rewrite accepted (model: ${result.model || 'unknown'})`);
                return result.text.trim();
            }
        }
    } catch {
        // Do not emit request URLs, headers, response bodies, or provider errors to logs.
    }

    await log('Gemini rewrite rejected - original text will be used');
    return original;
}

module.exports = { buildPrompt, rewriteAdWithGemini };
