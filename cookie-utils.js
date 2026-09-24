function normalizeCookies(rawCookies) {
    if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
        throw new Error('Cookie data must be a non-empty array');
    }

    return rawCookies.map((cookie) => {
        if (!cookie || typeof cookie !== 'object' || !cookie.name || typeof cookie.value !== 'string') {
            throw new Error('Cookie data contains an invalid entry');
        }

        const normalized = { ...cookie };
        if (typeof normalized.sameSite === 'string') {
            const sameSite = normalized.sameSite.toLowerCase();
            if (sameSite === 'lax') normalized.sameSite = 'Lax';
            else if (sameSite === 'strict') normalized.sameSite = 'Strict';
            else if (sameSite === 'none' || sameSite === 'no_restriction') normalized.sameSite = 'None';
            else delete normalized.sameSite;
        } else {
            delete normalized.sameSite;
        }

        if (normalized.expirationDate && !normalized.expires) {
            normalized.expires = normalized.expirationDate;
        }
        delete normalized.expirationDate;
        delete normalized.id;
        delete normalized.storeId;
        delete normalized.hostOnly;

        if (!normalized.domain && !normalized.url) {
            throw new Error('Cookie data contains an entry without a domain or URL');
        }

        return normalized;
    });
}

function cookieVaultSecretName(accountNumber) {
    if (!['1', '2', '3'].includes(String(accountNumber))) {
        throw new Error('ACCOUNT_NUMBER must be 1, 2, or 3');
    }
    return `FB_COOKIES_BOT${accountNumber}`;
}

module.exports = { cookieVaultSecretName, normalizeCookies };
