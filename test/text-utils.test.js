const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProtectedTerms, validateRewrittenText } = require('../text-utils');
const { rewriteAdWithGemini } = require('../ai-utils');

const original = 'للبيع سيارة تويوتا موديل 2020 بسعر 15000 ريال، تواصل على 777123456 في صنعاء. الرابط https://example.com/ad';

test('protects phone, price, year, model, location tokens, and URL', () => {
    const protectedTerms = extractProtectedTerms(original);
    for (const term of ['777123456', '15000', '2020', 'https://example.com/ad', 'تويوتا', 'صنعاء']) {
        assert.ok(protectedTerms.includes(term), `missing protected term: ${term}`);
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

test('uses original text after two rejected generations and never saves output', async () => {
    let attempts = 0;
    const logs = [];
    const result = await rewriteAdWithGemini('سيارة للبيع بسعر 15000 ريال', 'اتصل 777123456 في صنعاء', {
        apiKey: 'test-only',
        generate: async () => { attempts += 1; return { text: 'نص مشوه، السعر 1 ريال', model: 'test-model' }; },
        log: async (message) => logs.push(message)
    });
    assert.equal(attempts, 2);
    assert.equal(result, 'سيارة للبيع بسعر 15000 ريال\n\nاتصل 777123456 في صنعاء');
    assert.deepEqual(logs, ['Gemini rewrite rejected - original text will be used']);
});

test('accepts a clearly reordered, distinct rewrite preserving all source terms', async () => {
    const result = await rewriteAdWithGemini('سيارة للبيع بسعر 15000 ريال', 'اتصل 777123456 في صنعاء', {
        apiKey: 'test-only',
        generate: async () => ({ text: 'في صنعاء، اتصل 777123456 لشراء سيارة للبيع بسعر 15000 ريال', model: 'test-model' })
    });
    assert.notEqual(result, 'سيارة للبيع بسعر 15000 ريال\n\nاتصل 777123456 في صنعاء');
});
