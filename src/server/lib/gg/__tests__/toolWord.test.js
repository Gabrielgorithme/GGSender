import {
    findToolNumber,
    shouldStripToolWord,
    stripToolWord,
} from '../toolWord';

describe('GGSender: tool word handling', () => {
    it('finds the tool number on a line', () => {
        expect(findToolNumber('T405 M6')).toBe('405');
        expect(findToolNumber('M6 T5')).toBe('5');
        expect(findToolNumber('T12')).toBe('12');
        expect(findToolNumber('t3 m6')).toBe('3');
        expect(findToolNumber('M06T7')).toBe('7');
        expect(findToolNumber('G1 X10 Y20 F1000')).toBeNull();
        expect(findToolNumber('')).toBeNull();
    });

    it('removes the T word and nothing else', () => {
        expect(stripToolWord('T405 M6')).toBe('M6');
        expect(stripToolWord('M6 T405')).toBe('M6');
        expect(stripToolWord('T405')).toBe('');
        expect(stripToolWord('T405 (M6)')).toBe('(M6)');
        expect(stripToolWord('G43 H5 T5 M6')).toBe('G43 H5 M6');
        expect(stripToolWord('G1 X10 Y20 F1000')).toBe('G1 X10 Y20 F1000');
        expect(stripToolWord('M3 S12000')).toBe('M3 S12000');
    });

    it('leaves firmware commands and gSender expressions alone', () => {
        expect(stripToolWord('$T')).toBe('$T');
        expect(stripToolWord('$Tool/Test=1')).toBe('$Tool/Test=1');
        expect(stripToolWord('%global.toolchange.T1=5')).toBe('%global.toolchange.T1=5');
        expect(findToolNumber('$T12')).toBeNull();
    });

    it('strips only when gSender owns the tool change', () => {
        expect(shouldStripToolWord({})).toBe(true);
        expect(shouldStripToolWord(undefined)).toBe(true);
        expect(shouldStripToolWord({ passthrough: false, sendToolNumber: false })).toBe(true);
        expect(shouldStripToolWord({ passthrough: true })).toBe(false);
        expect(shouldStripToolWord({ sendToolNumber: true })).toBe(false);
    });
});
