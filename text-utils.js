const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const ARABIC_SINGLE_LETTERS = /[\u0621-\u064A]\s+[\u0621-\u064A](?:\s+[\u0621-\u064A])+/u;
const ARABIC_INTERNAL_SYMBOL = /[\u0621-\u064A][\p{P}\p{S}\p{C}][\u0621-\u064A]/u;
const DIGIT_RUN = /\p{N}+(?:[.,٫٬:/-]\p{N}+)*%?/gu;

const STOP_WORDS = new Set([
    'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
    'هو', 'هي', 'و', 'أو', 'ثم', 'كما', 'تم', 'قد', 'كان', 'تكون', 'لل', 'منها',
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with'
]);

function sourceTokens(text) {
    return (String(text || '').match(WORD_PATTERN) || [])
        .map((token) => token.toLocaleLowerCase())
        .filter((token) => !STOP_WORDS.has(token));
}

function extractProtectedTerms(original, explicitTerms = []) {
    const text = String(original || '');
    const urls = (text.match(URL_PATTERN) || []).map((url) => url.replace(/[.,،;!?]+$/u, ''));
    const phoneMatches = text.match(/(?:\+|00)?[\p{N}][\p{N}\s().-]{5,}[\p{N}]/gu) || [];
    const phones = phoneMatches.filter((candidate) => (candidate.match(/\p{N}/gu) || []).length >= 7)
        .map((candidate) => candidate.trim());
    const numbers = text.match(DIGIT_RUN) || [];
    const titleTerms = sourceTokens(text);
    const providedTerms = Array.isArray(explicitTerms) ? explicitTerms : [];

    return [...new Set([...urls, ...phones, ...numbers, ...titleTerms, ...providedTerms
        .filter((term) => typeof term === 'string' && term.trim())])];
}

function tokenOrderDifference(original, rewritten) {
    const left = (String(original).match(WORD_PATTERN) || []).map((word) => word.toLocaleLowerCase());
    const right = (String(rewritten).match(WORD_PATTERN) || []).map((word) => word.toLocaleLowerCase());
    if (!left.length || !right.length) return 0;

    // Normalized LCS score detects near-copy text while allowing sentence reordering.
    let previous = new Uint32Array(right.length + 1);
    for (const leftWord of left) {
        const current = new Uint32Array(right.length + 1);
        for (let index = 1; index <= right.length; index++) {
            current[index] = leftWord === right[index - 1]
                ? previous[index - 1] + 1
                : Math.max(previous[index], current[index - 1]);
        }
        previous = current;
    }
    return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function validateRewrittenText(original, rewritten, protectedTerms = extractProtectedTerms(original)) {
    const source = String(original || '').trim();
    const output = String(rewritten || '').trim();
    if (!output) return { valid: false, reason: 'empty' };
    if (/[\uFFFD\uE000-\uF8FF\uFDD0-\uFDEF]|\p{Cf}/u.test(output)) {
        return { valid: false, reason: 'unexpected-unicode' };
    }
    if (ARABIC_SINGLE_LETTERS.test(output)) return { valid: false, reason: 'split-arabic-word' };
    if (ARABIC_INTERNAL_SYMBOL.test(output)) return { valid: false, reason: 'unexpected-symbol-in-arabic-word' };
    if (/[\u0621-\u064A][A-Za-z][\u0621-\u064A]/u.test(output)) {
        return { valid: false, reason: 'mixed-script-word' };
    }

    const sourceCounts = new Map();
    for (const token of sourceTokens(source)) sourceCounts.set(token, (sourceCounts.get(token) || 0) + 1);
    const outputCounts = new Map();
    for (const token of sourceTokens(output)) outputCounts.set(token, (outputCounts.get(token) || 0) + 1);
    for (const [token, count] of sourceCounts) {
        if ((outputCounts.get(token) || 0) < count) return { valid: false, reason: 'source-term-missing' };
    }

    for (const term of protectedTerms) {
        if (term && !output.includes(term)) return { valid: false, reason: 'protected-term-changed' };
    }

    if (source.length >= 40 && output.length < source.length * 0.68) {
        return { valid: false, reason: 'too-short' };
    }
    if (source.length >= 40 && output.length > source.length * 2.2) {
        return { valid: false, reason: 'too-long' };
    }
    if (source.length >= 20 && tokenOrderDifference(source, output) < 0.12) {
        return { valid: false, reason: 'too-similar' };
    }

    return { valid: true, reason: 'approved' };
}

module.exports = { extractProtectedTerms, validateRewrittenText, tokenOrderDifference };
