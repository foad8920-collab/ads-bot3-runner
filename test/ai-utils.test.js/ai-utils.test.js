const assert = require('node:assert/strict');
const test = require('node:test');
const { selectGeminiModel } = require('../ai-utils');

test('chooses Gemini 3.6 Flash and never falls back to the unavailable Gemini 2.5 Flash', () => {
    const models = [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['countTokens'] }
    ];
    assert.equal(selectGeminiModel(models)?.name, 'models/gemini-3.6-flash');
    assert.equal(selectGeminiModel([models[0]]), null);
    assert.equal(selectGeminiModel([{ name: 'models/other', supportedGenerationMethods: ['generateContent'] }]), null);
});
