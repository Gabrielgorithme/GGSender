import { overrideBase, TARGET_TRUST_MS } from '../overrideBase';
import { calcOverrides } from '../../../controllers/runOverride';

describe('GGSender: override step counting', () => {
    it('counts from the reported value when nothing was requested recently', () => {
        expect(overrideBase(100, undefined, 1000)).toBe(100);
        expect(overrideBase(100, { value: 103, at: 0 }, TARGET_TRUST_MS + 1)).toBe(100);
    });

    it('counts from the last request while the report may be stale', () => {
        expect(overrideBase(100, { value: 101, at: 1000 }, 1200)).toBe(101);
    });

    it('does not double count two quick 1% steps', () => {
        // reported stays at 100 during both requests
        let last;
        const sent = [];
        const request = (target, now) => {
            const base = overrideBase(100, last, now);
            sent.push(...calcOverrides(target - base, 'spindle'));
            last = { value: target, at: now };
        };
        request(101, 0);
        request(102, 250);
        // two "+1%" realtime commands in total, not three
        expect(sent).toEqual([String.fromCharCode(0x9c), String.fromCharCode(0x9c)]);
    });

    it('falls back to 100 when there is no usable report', () => {
        expect(overrideBase(undefined, undefined, 0)).toBe(100);
    });

    it('ignores a request stamped in the future', () => {
        expect(overrideBase(100, { value: 150, at: 5000 }, 1000)).toBe(100);
    });
});
