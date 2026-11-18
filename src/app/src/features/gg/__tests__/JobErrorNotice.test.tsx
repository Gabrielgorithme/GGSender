// GGSender: the message for a refused job line
import { fileLineOfSeq, jobErrorText } from '../JobErrorNotice';

const CONTENT = ['(prog)', '', 'N10 G21', 'N11 G2 X16.529 Z-0.5 I0.4 K0', 'N12 G1 X1'].join('\n');

describe('GGSender: job error notice', () => {
    it('file line from the sender index (blank lines are not sent)', () => {
        expect(fileLineOfSeq(CONTENT, 2)).toBe(4);
        expect(fileLineOfSeq(CONTENT, 99)).toBeNull();
        expect(fileLineOfSeq(CONTENT, null)).toBeNull();
    });
    it('held: says where, and to stop rather than resume', () => {
        const t = jobErrorText({ code: 33, message: 'Invalid gcode target', line: 'N11 G2 X16.529 Z-0.5 I0.4 K0', seq: 2, held: true }, CONTENT);
        expect(t.title).toBe('Error 33: the controller refused a line');
        expect(t.where).toBe('N11, file line 4');
        expect(t.advice).toMatch(/machine is held/);
        expect(t.advice).toMatch(/Stop the job/);
    });
    it('not held: says the queued lines still run', () => {
        const t = jobErrorText({ code: 33, message: '', line: 'G2 X1', seq: null, held: false }, CONTENT);
        expect(t.where).toBe('line not known');
        expect(t.advice).toMatch(/still run/);
    });
});
