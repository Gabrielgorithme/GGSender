// GGSender: lines refused because the machine jogged (lib/gg/refusedLines.js)
import { RefusedLines, codeOf, isWaitOnly, jogRecoveryPreference } from '../refusedLines';

const setup = () => {
    const changes = [];
    const r = new RefusedLines({ onChange: (s) => changes.push(s) });
    return { r, changes };
};

describe('GGSender: refused lines', () => {
    it('on unless switched off', () => {
        expect(jogRecoveryPreference({})).toBe(true);
        expect(jogRecoveryPreference(undefined)).toBe(true);
        expect(jogRecoveryPreference({ ggJogRecovery: false })).toBe(false);
    });

    it('reads the code of a line without its N word and comments', () => {
        expect(codeOf('N1052420 G28 G91 Z0')).toBe('G28 G91 Z0');
        expect(codeOf('N1052430 (M6)')).toBe('');
        expect(codeOf('(Restart Spindle)')).toBe('');
        expect(codeOf('g4 p0.5 ; wait')).toBe('G4 P0.5');
    });

    it('knows the lines that only wait', () => {
        ['G4 P0.5', 'G04 P1', 'N12 (M6)', '', '(note)'].forEach((l) => expect(isWaitOnly(l)).toBe(true));
        ['G28 G91 Z0', 'G90', 'M5', 'G4 P0.5 G0 X1', 'G0 Z5', 'M3 S1000'].forEach((l) => expect(isWaitOnly(l)).toBe(false));
    });

    it('keeps the refused lines in order and sends them again one by one', () => {
        const { r, changes } = setup();
        r.add('job', 'N10 G28 G91 Z0');
        r.add('job', 'N11 G90');
        r.add('job', 'N12 (M6)');
        r.add('feeder', 'G4 P0.5');
        expect(changes[changes.length - 1]).toEqual({
            lines: [
                { source: 'job', text: 'N10 G28 G91 Z0' },
                { source: 'job', text: 'N11 G90' },
                { source: 'job', text: 'N12 (M6)' },
                { source: 'feeder', text: 'G4 P0.5' },
            ],
            moves: true,
            broken: null,
            replaying: false,
        });
        expect(r.pending).toBe(true);
        expect(r.waitOnly).toBe(false); // G28 moves: the owner must ask
        expect(r.start()).toBe('N10 G28 G91 Z0');
        expect(r.replaying).toBe(true);
        expect(r.ok()).toBe('N11 G90');
        expect(r.ok()).toBe('G4 P0.5'); // the comment line is dropped
        expect(r.pending).toBe(true); // the last one waits for its reply
        expect(r.ok()).toBeNull();
        expect(r.replaying).toBe(false);
        expect(r.pending).toBe(false);
        expect(r.takeFeederWait()).toBe(true);
        expect(r.takeFeederWait()).toBe(false);
        expect(changes[changes.length - 1]).toEqual({ lines: [], moves: false, broken: null, replaying: false });
    });

    it('lines that only wait can go by themselves', () => {
        const { r } = setup();
        r.add('feeder', 'G4 P0.5');
        expect(r.waitOnly).toBe(true);
        expect(r.snapshot().moves).toBe(false);
        expect(r.start()).toBe('G4 P0.5');
        expect(r.waitOnly).toBe(false); // not twice
        expect(r.ok()).toBeNull();
    });

    it('only comments: nothing is sent, and it is done at once', () => {
        const { r } = setup();
        r.add('job', 'N12 (M6)');
        expect(r.start()).toBeNull();
        expect(r.replaying).toBe(false);
        expect(r.pending).toBe(false);
    });

    it('a line accepted after a refused one breaks the sequence; a line that only waits does not', () => {
        const { r } = setup();
        r.add('job', 'N10 G28 G91 Z0');
        r.accepted('G4 P0.5');
        expect(r.snapshot().broken).toBeNull();
        r.accepted('N11 G90');
        expect(r.snapshot().broken).toBe('accepted-after-refused');
        expect(r.canReplay()).toBe(false);
        expect(r.start()).toBeNull();
        expect(r.waitOnly).toBe(false);
        expect(r.pending).toBe(true); // the feeder stays held: the owner must stop the job
    });

    it('accepted lines mean nothing when no line waits', () => {
        const { r, changes } = setup();
        r.accepted('N11 G90');
        expect(r.snapshot().broken).toBeNull();
        expect(changes).toEqual([]);
    });

    it('a line with no record cannot be sent again', () => {
        const { r } = setup();
        r.add('job', null);
        expect(r.snapshot().broken).toBe('unknown-line');
        expect(r.start()).toBeNull();
    });

    it('refused again while it is sent again: it waits again, first in line', () => {
        const { r } = setup();
        r.add('job', 'N10 G28 G91 Z0');
        r.add('job', 'N11 G90');
        expect(r.start()).toBe('N10 G28 G91 Z0');
        r.refusedAgain();
        expect(r.replaying).toBe(false);
        expect(r.snapshot().lines.map((l) => l.text)).toEqual(['N10 G28 G91 Z0', 'N11 G90']);
        expect(r.start()).toBe('N10 G28 G91 Z0');
        expect(r.ok()).toBe('N11 G90');
        expect(r.ok()).toBeNull();
    });

    it('another error for a line sent again: nothing more is sent', () => {
        const { r } = setup();
        r.add('job', 'N10 G28 G91 Z0');
        r.add('job', 'N11 G90');
        r.start();
        r.failed(20);
        expect(r.snapshot()).toMatchObject({ broken: 'error:20', replaying: false });
        expect(r.snapshot().lines).toHaveLength(2);
        expect(r.start()).toBeNull();
    });

    it('reset forgets everything and says so once', () => {
        const { r, changes } = setup();
        r.reset();
        expect(changes).toEqual([]);
        r.add('feeder', 'G4 P0.5');
        r.reset();
        expect(changes[changes.length - 1]).toEqual({ lines: [], moves: false, broken: null, replaying: false });
        expect(r.pending).toBe(false);
    });
});
