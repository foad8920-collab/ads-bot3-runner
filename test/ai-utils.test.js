const assert = require('node:assert/strict');
const test = require('node:test');
const { orderGeminiModels, selectGeminiModel, GEMINI_MODEL_PRIORITY } = require('../ai-utils');

test('ranks only the three tested generateContent models in the configured priority order', () => {
    const models = [
        { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['countTokens'] },
        { name: 'models/gemini-3.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] }
    ];
    assert.deepEqual(orderGeminiModels(models).map((model) => model.name), [
        'models/gemini-3.5-flash',
        'models/gemini-3.5-flash-lite',
        'models/gemini-3.1-flash-lite'
    ]);
    assert.equal(selectGeminiModel(models)?.name, 'models/gemini-3.5-flash');
    assert.deepEqual(GEMINI_MODEL_PRIORITY, [
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite'
    ]);
    assert.equal(selectGeminiModel([{ name: 'models/other', supportedGenerationMethods: ['generateContent'] }]), null);
});
