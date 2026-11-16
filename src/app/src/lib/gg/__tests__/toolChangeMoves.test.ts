import {
    buildReturnZLines,
    formatSafeZ,
    sanitizeSafeZ,
} from '../toolChangeMoves';

describe('GGSender: tool change safe height', () => {
    it('keeps valid machine heights', () => {
        expect(sanitizeSafeZ(-0.1)).toBe(-0.1);
        expect(sanitizeSafeZ('-5')).toBe(-5);
        expect(sanitizeSafeZ(0)).toBe(0);
    });

    it('never returns a height above the top of travel', () => {
        expect(sanitizeSafeZ(5)).toBe(-5);
        expect(sanitizeSafeZ('0.2')).toBe(-0.2);
    });

    it('falls back to the default for unusable values', () => {
        expect(sanitizeSafeZ(undefined)).toBe(-0.1);
        expect(sanitizeSafeZ(null)).toBe(-0.1);
        expect(sanitizeSafeZ('')).toBe(-0.1);
        expect(sanitizeSafeZ('abc')).toBe(-0.1);
        expect(sanitizeSafeZ(NaN)).toBe(-0.1);
    });

    it('formats for g-code without "-0" or noise', () => {
        expect(formatSafeZ(-0.1)).toBe('-0.1');
        expect(formatSafeZ(0)).toBe('0');
        expect(formatSafeZ(-0)).toBe('0');
        expect(formatSafeZ(-0.00001)).toBe('0');
        expect(formatSafeZ(-5.12345)).toBe('-5.123');
    });
});

describe('GGSender: return to starting Z', () => {
    const stock = ['G90 G0 Z[global.toolchange.ZPOS]'];

    it('keeps the upstream move when enabled', () => {
        expect(buildReturnZLines(true, stock)).toEqual(stock);
    });

    it('sends no Z move when disabled', () => {
        const lines = buildReturnZLines(false, stock);
        expect(lines.join('\n')).not.toMatch(/ZPOS/);
        // only a comment is left
        expect(lines.every((l) => /^\(.*\)$/.test(l))).toBe(true);
    });
});
