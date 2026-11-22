// GGSender: the words for lines refused during a jog (lib/gg/refusedText.ts)
import { NO_REFUSED, RefusedState, normalizeRefused } from '../refusedStore';
import { READY_TEXT, refusedText } from '../refusedText';

const OWNER: RefusedState = {
    lines: [
        { source: 'job', text: 'N1052420 G28 G91 Z0' },
        { source: 'job', text: 'N1052425 G90' },
        { source: 'job', text: 'N1052430 (M6)' },
        { source: 'feeder', text: 'G4 P0.5' },
    ],
    moves: true,
    broken: null,
    replaying: false,
};

const sentences = (text: string) => text.split(/(?<=[.:])\s+/).filter(Boolean);

describe('GGSender: text for refused lines', () => {
    it('nothing refused: nothing is shown', () => {
        expect(refusedText(NO_REFUSED, true)).toBeNull();
    });

    it('the owner\'s case: the lines, why, and one button', () => {
        const t = refusedText(OWNER, true);
        expect(t.title).toBe('The controller refused 3 lines'); // the comment line is not counted
        expect(t.lines).toEqual(['N1052420 G28 G91 Z0', 'N1052425 G90', 'G4 P0.5']);
        expect(t.cause).toBe('The machine was in a jog when gSender sent these lines. The controller accepts no program line during a jog.');
        expect(t.action).toBe('Press Send again to send these lines now. The machine can move. Then the tool change continues.');
        expect(t.button).toBe('Send again');
        expect(t.buttonEnabled).toBe(true);
        expect(t.severe).toBe(false);
        expect(t.hint).toContain('jog only when the tool change window shows that the machine is ready');
    });

    it('the machine still moves: the button waits', () => {
        const t = refusedText(OWNER, false);
        expect(t.action).toBe('Wait until the machine is idle. Then press Send again.');
        expect(t.button).toBe('Send again');
        expect(t.buttonEnabled).toBe(false);
    });

    it('lines that only wait: no button, they go by themselves', () => {
        const t = refusedText({ ...OWNER, lines: [{ source: 'feeder', text: 'G4 P0.5' }], moves: false }, true);
        expect(t.title).toBe('The controller refused 1 line');
        expect(t.action).toBe('These lines move nothing. gSender sends them again when the machine is idle.');
        expect(t.button).toBeNull();
    });

    it('while they are sent again: no button', () => {
        const t = refusedText({ ...OWNER, replaying: true }, true);
        expect(t.action).toBe('gSender sends the lines again.');
        expect(t.button).toBeNull();
    });

    it('a broken sequence: stop the job, nothing to press', () => {
        const t = refusedText({ ...OWNER, broken: 'accepted-after-refused' }, true);
        expect(t.severe).toBe(true);
        expect(t.button).toBeNull();
        expect(t.action).toBe(
            'The controller then accepted a line that comes after these lines. The sequence is not correct now. Stop the job. Then use Resume From.',
        );
        const other = refusedText({ ...OWNER, broken: 'error:20' }, true);
        expect(other.action).toBe('gSender cannot send these lines again. Stop the job. Then use Resume From.');
        expect(other.severe).toBe(true);
    });

    it('many lines: the first five and a count', () => {
        const lines = Array.from({ length: 8 }, (_v, i) => ({ source: 'job' as const, text: `N${i} G1 X${i}` }));
        const t = refusedText({ ...OWNER, lines }, true);
        expect(t.title).toBe('The controller refused 8 lines');
        expect(t.lines).toHaveLength(5);
        expect(t.more).toBe('and 3 more lines');
    });

    it('every sentence is short (ASD-STE100: 25 words at most)', () => {
        const all = [
            refusedText(OWNER, true),
            refusedText(OWNER, false),
            refusedText({ ...OWNER, moves: false }, true),
            refusedText({ ...OWNER, replaying: true }, true),
            refusedText({ ...OWNER, broken: 'accepted-after-refused' }, true),
            refusedText({ ...OWNER, broken: 'unknown-line' }, true),
        ];
        const texts = all.flatMap((t) => [t.title, t.cause, t.action, t.hint ?? '']).concat([READY_TEXT.wait, READY_TEXT.ready]);
        texts.flatMap(sentences).forEach((s) => expect(s.split(/\s+/).length).toBeLessThanOrEqual(25));
    });
});

describe('GGSender: what the server says about refused lines is read with care', () => {
    it('keeps only well-formed lines; a state without lines moves nothing', () => {
        expect(normalizeRefused(null)).toEqual(NO_REFUSED);
        expect(normalizeRefused({ lines: 'x', moves: true })).toEqual(NO_REFUSED);
        expect(normalizeRefused({ lines: [{ source: 'feeder', text: 'G4 P0.5' }, { text: 5 }, null], moves: false, broken: '', replaying: 1 })).toEqual({
            lines: [{ source: 'feeder', text: 'G4 P0.5' }],
            moves: false,
            broken: null,
            replaying: false,
        });
        expect(normalizeRefused({ lines: [{ source: 'x', text: 'G0 Z5' }], moves: true, broken: 'error:20', replaying: true })).toEqual({
            lines: [{ source: 'job', text: 'G0 Z5' }],
            moves: true,
            broken: 'error:20',
            replaying: true,
        });
    });
});
