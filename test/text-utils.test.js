const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProtectedTerms, validateRewrittenText } = require('../text-utils');
const { rewriteAdWithGemini } = require('../ai-utils');

const original = 'للبيع سيارة تويوتا موديل 2020 بسعر 15000 ريال، تواصل على 777123456 في صنعاء. الرابط https://example.com/ad';

test('protects phone, price, year, model, location tokens, and URL', () => {
    const protectedTerms = extractProtectedTerms(original);
    for (const term of ['777123456', '15000', '2020', 'https://example.com/ad', 'تويوتا', 'صنعاء']) {
        assert.ok(protectedTerms.includes(term), 'missing protected term: ' + term);
    }
});

test('rejects changed phone, removed price, and changed URL', () => {
    const protectedTerms = extractProtectedTerms(original);
    assert.equal(validateRewrittenText(original, original.replace('777123456', '777123450'), protectedTerms).valid, false);
    assert.equal(validateRewrittenText(original, original.replace('15000', ''), protectedTerms).valid, false);
    assert.equal(validateRewrittenText(original, original.replace('https://example.com/ad', 'https://other.example/ad'), protectedTerms).valid, false);
});

test('rejects malformed Arabic, spaced single letters, empty text, and missing line information', () => {
    const multiLine = 'فرصة للبيع\nسيارة تويوتا بسعر 15000 ريال\nاتصل 777123456 في صنعاء';
    const terms = extractProtectedTerms(multiLine);
    assert.equal(validateRewrittenText(multiLine, multiLine.replace('سيارة', 'س ي ا ر ة'), terms).valid, false);
    assert.equal(validateRewrittenText(multiLine, multiLine.replace('سيارة', 'سي!ارة'), terms).valid, false);
    assert.equal(validateRewrittenText(multiLine, multiLine.replace('فرصة للبيع', 'فرصة'), terms).valid, false);
    assert.equal(validateRewrittenText(multiLine, '', terms).valid, false);
    assert.equal(validateRewrittenText(multiLine, multiLine.replace('في صنعاء', ''), terms).valid, false);
});

test('tries the next model after invalid text and uses original text if every model fails', async () => {
    let attempts = 0;
    const logs = [];
    const result = await rewriteAdWithGemini('سيارة للبيع بسعر 15000 ريال', 'اتصل 777123456 في صنعاء', {
        apiKey: 'test-only',
        models: [
            { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
        ],
        generate: async () => { attempts += 1; return 'نص مشوه، السعر 1 ريال'; },
        log: async (message) => logs.push(message)
    });
    assert.equal(attempts, 2);
    assert.equal(result, 'سيارة للبيع بسعر 15000 ريال\n\nاتصل 777123456 في صنعاء');
    assert.deepEqual(logs, [
        'Gemini model failed: gemini-3.5-flash',
        'Gemini model failed: gemini-3.5-flash-lite',
        'Gemini rewrite rejected - original text will be used'
    ]);
});

test('accepts a clearly reordered rewrite that preserves all protected source information', async () => {
    const result = await rewriteAdWithGemini('سيارة للبيع بسعر 15000 ريال', 'اتصل 777123456 في صنعاء', {
        apiKey: 'test-only',
        models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }],
        generate: async () => 'في صنعاء، اتصل 777123456 لشراء سيارة للبيع بسعر 15000 ريال'
    });
    assert.notEqual(result, 'سيارة للبيع بسعر 15000 ريال\n\nاتصل 777123456 في صنعاء');
});

test('continues after first-model request failure and accepts next model validated output', async () => {
    const attempted = [];
    const logs = [];
    const result = await rewriteAdWithGemini('سيارة للبيع بسعر 15000 ريال', 'اتصل 777123456 في صنعاء', {
        apiKey: 'test-only',
        models: [
            { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] }
        ],
        generate: async (model) => {
            attempted.push(model.name);
            if (model.name.endsWith('gemini-3.5-flash')) throw new Error('synthetic request failure');
            return 'في صنعاء، اتصل 777123456 لشراء سيارة للبيع بسعر 15000 ريال';
        },
        log: async (message) => logs.push(message)
    });
    assert.deepEqual(attempted, ['models/gemini-3.5-flash', 'models/gemini-3.5-flash-lite']);
    assert.equal(result, 'في صنعاء، اتصل 777123456 لشراء سيارة للبيع بسعر 15000 ريال');
    assert.deepEqual(logs, [
        'Gemini model failed: gemini-3.5-flash',
        'Gemini model succeeded: gemini-3.5-flash-lite'
    ]);
});
