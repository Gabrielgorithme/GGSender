// GGSender: hold the machine at a job error (lib/gg/errorHold.js)
import { SentLines, errorReport, holdOnErrorPreference } from '../errorHold';

describe('GGSender: error hold', () => {
    it('on unless switched off', () => {
        expect(holdOnErrorPreference({})).toBe(true);
        expect(holdOnErrorPreference(undefined)).toBe(true);
        expect(holdOnErrorPreference({ ggHoldOnError: false })).toBe(false);
    });
    it('each reply answers the oldest line written', () => {
        const q = new SentLines();
        q.push(10, 'G1 X1 ');
        q.push(12, 'G2 X16.529 Z-0.5 I0.4 K0');
        expect(q.shift()).toEqual({ seq: 10, line: 'G1 X1' });
        expect(q.shift()).toEqual({ seq: 12, line: 'G2 X16.529 Z-0.5 I0.4 K0' });
        expect(q.shift()).toBeNull();
        q.push(1, 'x');
        q.reset();
        expect(q.shift()).toBeNull();
    });
    it('reports the failing line', () => {
        expect(errorReport({ code: 33, message: 'Invalid gcode target', failed: { seq: 12, line: 'G2 X1' }, held: true })).toEqual({
            code: 33, message: 'Invalid gcode target', line: 'G2 X1', seq: 12, held: true,
        });
        expect(errorReport({ code: 20, failed: null, held: false })).toEqual({ code: 20, message: '', line: '', seq: null, held: false });
    });
});
