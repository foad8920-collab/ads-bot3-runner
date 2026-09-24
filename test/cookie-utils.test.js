const test = require('node:test');
const assert = require('node:assert/strict');
const { cookieVaultSecretName, normalizeCookies } = require('../cookie-utils');

test('maps an account to its Vault cookie secret name', () => {
    assert.equal(cookieVaultSecretName('2'), 'FB_COOKIES_BOT2');
    assert.throws(() => cookieVaultSecretName('4'), /ACCOUNT_NUMBER/);
});

test('normalizes exported cookies to Playwright format', () => {
    const cookies = normalizeCookies([{
        name: 'session',
        value: 'sensitive-cookie-value',
        domain: '.facebook.com',
        path: '/',
        sameSite: 'no_restriction',
        expirationDate: 1900000000,
        id: 12,
        storeId: '0',
        hostOnly: false
    }]);

    assert.deepEqual(cookies[0], {
        name: 'session',
        value: 'sensitive-cookie-value',
        domain: '.facebook.com',
        path: '/',
        sameSite: 'None',
        expires: 1900000000
    });
});

test('rejects malformed cookie payloads', () => {
    assert.throws(() => normalizeCookies([]), /non-empty array/);
    assert.throws(() => normalizeCookies([{ name: 'session', value: 'x' }]), /domain or URL/);
});
