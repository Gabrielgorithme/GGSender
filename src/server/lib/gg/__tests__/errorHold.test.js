// GGSender: hold the machine at a job error (lib/gg/errorHold.js)
import { errorReport, holdOnErrorPreference } from '../errorHold';

describe('GGSender: error hold', () => {
    it('on unless switched off', () => {
        expect(holdOnErrorPreference({})).toBe(true);
        expect(holdOnErrorPreference(undefined)).toBe(true);
        expect(holdOnErrorPreference({ ggHoldOnError: false })).toBe(false);
    });
    it('reports the failing line', () => {
        expect(errorReport({ code: 33, message: 'Invalid gcode target', failed: { seq: 12, line: 'G2 X1' }, held: true })).toEqual({
            code: 33, message: 'Invalid gcode target', line: 'G2 X1', seq: 12, held: true,
        });
        expect(errorReport({ code: 20, failed: null, held: false })).toEqual({ code: 20, message: '', line: '', seq: null, held: false });
    });
});
