// GGSender: overrides back to 100% at each operation (lib/gg/opResets.js)
import {
    OperationResets,
    SYNC_WORDS,
    programLength,
    overridesToReset,
    qualifiesForSync,
    resetPreference,
} from '../opResets';

describe('GGSender: which lines can take "G4 P0"', () => {
    it('plain moves', () => {
        expect(qualifiesForSync('N76941 G0 X43.057 Y17.572')).toBe(true);
        expect(qualifiesForSync('G1 Z-4.793 F75')).toBe(true);
        expect(qualifiesForSync('X12 Y3')).toBe(true);
        expect(qualifiesForSync('G18 G3 X57.929 Z-5.187 I-0.4 K0 F1000')).toBe(true);
        expect(qualifiesForSync('G0 G40 X1 Y1')).toBe(true); // G40 is not G4
    });
    it('anything that is not a plain move', () => {
        expect(qualifiesForSync('')).toBe(false);
        expect(qualifiesForSync('G17 G90 G94')).toBe(false); // no axis word
        expect(qualifiesForSync('S24000 M3')).toBe(false);
        expect(qualifiesForSync('G28 G91 Z0')).toBe(false);
        expect(qualifiesForSync('G53 G0 Z-1')).toBe(false);
        expect(qualifiesForSync('G10 L20 P1 X0')).toBe(false);
        expect(qualifiesForSync('G92 X0')).toBe(false);
        expect(qualifiesForSync('G38.2 Z-10 F100')).toBe(false);
        expect(qualifiesForSync('G4 P1')).toBe(false);
        expect(qualifiesForSync('G04 P1')).toBe(false);
        expect(qualifiesForSync('G2 X1 Y1 I1 J0 P2')).toBe(false); // P = turns
        expect(qualifiesForSync('G0 X1 M8')).toBe(false);
        expect(qualifiesForSync('G0 X[posx]')).toBe(false);
        expect(qualifiesForSync('%wait')).toBe(false);
        expect(qualifiesForSync('$J=G91 X1 F100')).toBe(false);
    });
});

describe('GGSender: settings and decision', () => {
    it('on unless switched off', () => {
        expect(resetPreference({})).toBe(true);
        expect(resetPreference(undefined)).toBe(true);
        expect(resetPreference(null)).toBe(true);
        expect(resetPreference({ ggResetOverridesPerOp: true })).toBe(true);
        expect(resetPreference({ ggResetOverridesPerOp: false })).toBe(false);
    });
    it('only what is not at 100 already', () => {
        expect(overridesToReset(100, 100)).toEqual({ feed: false, spindle: false });
        expect(overridesToReset(80, 100)).toEqual({ feed: true, spindle: false });
        expect(overridesToReset(100, 91)).toEqual({ feed: false, spindle: true });
        expect(overridesToReset(undefined, NaN)).toEqual({ feed: false, spindle: false });
    });
});

describe('GGSender: operation starts in the stream', () => {
    // a 20-line program as the sender holds it (gcode:load adds %wait)
    const linesWith = (at) => {
        const l = Array.from({ length: 20 }, (_, i) => `G1 X${i}`);
        Object.entries(at).forEach(([k, v]) => {
            l[Number(k)] = v;
        });
        return [...l, '%wait ; Wait for the planner to empty'];
    };
    const LINES = linesWith({ 5: 'N100 G0 X1 Y1', 12: 'N200 G0 X2 Y2' });
    const program = (resets) =>
        resets.setProgram({
            name: 'job.nc',
            total: 20,
            boundaries: [
                { seq: 5, text: 'N100 G0 X1 Y1', name: 'Flat1' },
                { seq: 12, text: 'N200 G0 X2 Y2', name: 'Parallel1' },
                { seq: -1, text: 'bad', name: 'x' },
                { seq: 3, text: '', name: 'empty' },
            ],
        });

    it('adds the dwell to an operation start and resets on its reply, not before', () => {
        const done = [];
        const r = new OperationResets({ onReset: (op) => done.push(op.name) });
        program(r);
        expect(r.boundaries.size).toBe(2);

        // lines 3 and 4 written, then the start of Flat1, then line 6
        expect(r.filter('G1 X0', { seq: 3, lines: LINES })).toBe('G1 X0');
        r.onWritten();
        expect(r.filter('G1 X0.5', { seq: 4, lines: LINES })).toBe('G1 X0.5');
        r.onWritten();
        expect(r.filter('N100 G0 X1 Y1', { seq: 5, lines: LINES })).toBe(`N100 G0 X1 Y1 ${SYNC_WORDS}`);
        r.onWritten();
        expect(r.filter('G1 Z-1', { seq: 6, lines: LINES })).toBe('G1 Z-1');
        r.onWritten();

        expect(r.onReply()).toBeNull(); // line 3
        expect(r.onReply()).toBeNull(); // line 4
        expect(done).toEqual([]);
        expect(r.onReply().name).toBe('Flat1'); // the dwell line's ok
        expect(done).toEqual(['Flat1']);
        expect(r.onReply()).toBeNull();
        expect(done).toEqual(['Flat1']);
    });

    it('a different program, or a different line at that index: nothing added', () => {
        const done = [];
        const logs = [];
        const r = new OperationResets({ onReset: (op) => done.push(op.name), log: (m) => logs.push(m) });
        program(r);
        const longer = [...LINES.slice(0, -1), 'M5', LINES[LINES.length - 1]];
        expect(r.filter('N100 G0 X1 Y1', { seq: 5, lines: longer })).toBe('N100 G0 X1 Y1');
        const otherLine = linesWith({ 5: 'N101 G0 X1 Y1' });
        expect(r.filter('N101 G0 X1 Y1', { seq: 5, lines: otherLine })).toBe('N101 G0 X1 Y1');
        r.onWritten();
        r.onReply();
        expect(done).toEqual([]);
        expect(logs).toHaveLength(2);
    });

    it('the setting off: nothing added', () => {
        const r = new OperationResets();
        program(r);
        expect(r.filter('N100 G0 X1 Y1', { seq: 5, lines: LINES, enabled: false })).toBe('N100 G0 X1 Y1');
    });

    it('a line the dwell cannot go on (after the other filters): no reset for that operation', () => {
        const done = [];
        const r = new OperationResets({ onReset: (op) => done.push(op.name) });
        r.setProgram({ name: 'j', total: 20, boundaries: [{ seq: 2, text: 'G0 X1 M8', name: 'A' }] });
        expect(r.filter('G0 X1 M8', { seq: 2, lines: linesWith({ 2: 'G0 X1 M8' }) })).toBe('G0 X1 M8');
        r.onWritten();
        r.onReply();
        expect(done).toEqual([]);
    });

    it('a stop forgets what was in flight', () => {
        const done = [];
        const r = new OperationResets({ onReset: (op) => done.push(op.name) });
        program(r);
        r.filter('N100 G0 X1 Y1', { seq: 5, lines: LINES });
        r.onWritten();
        r.reset();
        expect(r.onReply()).toBeNull();
        expect(done).toEqual([]);
        // a tag set by the filter but never written does not leak to the next line
        r.filter('N100 G0 X1 Y1', { seq: 5, lines: LINES });
        r.reset();
        r.onWritten();
        expect(r.onReply()).toBeNull();
    });

    it('no program sent yet: lines pass untouched', () => {
        const r = new OperationResets();
        expect(r.filter('G0 X1', { seq: 0, lines: ['G0 X1'] })).toBe('G0 X1');
        r.setProgram(undefined);
        expect(r.filter('G0 X1', { seq: 0, lines: ['G0 X1'] })).toBe('G0 X1');
    });

    it('the %wait line the server appends is not counted', () => {
        expect(programLength(['a', 'b', '%wait ; Wait for the planner to empty'])).toBe(2);
        expect(programLength(['a', 'b'])).toBe(2);
        expect(programLength(undefined)).toBe(0);
    });
});
