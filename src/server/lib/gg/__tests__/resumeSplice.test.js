// GGSender: resume from a line, server half (lib/gg/resumeSplice.js)
import { ResumeSession, hasToolReference, spliceResume } from '../resumeSplice';

const program = () => [...Array.from({ length: 30 }, (_, i) => `N${i + 1} G1 X${i}`), '%wait ; Wait for the planner to empty'];
const PRE = ['(resume)', 'G21 G53 G0 Z-0.1', 'G21 G90 G94 G17 G54', 'G0 X1 Y1', 'G1 Z-1 F100'];
const plan = (over = {}) => ({ seq: 20, text: 'N21 G1 X20', total: 30, preamble: PRE, target: null, ...over });

describe('GGSender: resume splice', () => {
    it('the entry lines take the place of the lines just before; the rest keep their index', () => {
        const lines = program();
        const r = spliceResume(lines, plan());
        expect(r.from).toBe(15);
        expect(r.lines.slice(15, 20)).toEqual(PRE);
        expect(r.lines.slice(20)).toEqual(lines.slice(20));
        expect(r.lines.slice(0, 15)).toEqual(lines.slice(0, 15));
        expect(r.lines).toHaveLength(lines.length);
        expect(lines[15]).toBe('N16 G1 X15'); // the loaded program is not changed
    });

    it('a rewritten line (modal arc) replaces the chosen line too', () => {
        const r = spliceResume(program(), plan({ target: 'N21 G3 X20 I1 J0' }));
        expect(r.from).toBe(15);
        expect(r.lines.slice(15, 21)).toEqual([...PRE, 'N21 G3 X20 I1 J0']);
        expect(r.lines[21]).toBe('N22 G1 X21');
    });

    it('refuses a program or line that is not the one planned, and anything but plain G-code', () => {
        expect(spliceResume(program(), plan({ text: 'N21 G1 X99' })).error).toMatch(/not the same/);
        expect(spliceResume(program(), plan({ total: 31 })).error).toMatch(/30 lines/);
        expect(spliceResume(program(), plan({ seq: 99 })).error).toMatch(/outside/);
        expect(spliceResume(program(), plan({ preamble: ['$H'] })).error).toMatch(/plain G-code/);
        expect(spliceResume(program(), plan({ preamble: ['%wait'] })).error).toMatch(/plain G-code/);
        expect(spliceResume(program(), plan({ preamble: ['G0 X[posx]'] })).error).toMatch(/plain G-code/);
        expect(spliceResume(program(), plan({ preamble: ['G0 X1\nG0 Y1'] })).error).toMatch(/plain G-code/);
        expect(spliceResume(program(), plan({ preamble: [] })).error).toMatch(/plain G-code/);
        expect(spliceResume(program(), plan({ seq: 2, text: 'N3 G1 X2' })).error).toMatch(/too close/);
        expect(spliceResume([], plan()).error).toMatch(/No program/);
    });

    it('tool reference: a number left by an earlier tool change', () => {
        expect(hasToolReference({ toolchange: { TOOL_OFFSET: -42.1 } })).toBe(true);
        expect(hasToolReference({ toolchange: { TOOL_OFFSET: '-42.1' } })).toBe(true);
        expect(hasToolReference({ toolchange: {} })).toBe(false);
        expect(hasToolReference({})).toBe(false);
        expect(hasToolReference(undefined)).toBe(false);
    });
});

describe('GGSender: resume session', () => {
    const fakeSender = () => {
        const calls = [];
        return {
            calls,
            state: { lines: program(), toolChanges: 0 },
            setStartLine(n) {
                calls.push(['start', n]);
            },
            next(o) {
                calls.push(['next', o]);
            },
        };
    };

    it('prepare, begin from the entry lines, restore the program as loaded', () => {
        const sender = fakeSender();
        const original = sender.state.lines;
        const s = new ResumeSession();
        expect(s.prepare(sender, plan()).from).toBe(15);
        expect(sender.state.lines).not.toBe(original);
        const p = s.take();
        expect(s.take()).toBeNull(); // once
        s.begin(sender, p);
        expect(sender.calls).toEqual([['start', 15], ['next', { startFromLine: true }]]);
        expect(sender.state.toolChanges).toBe(0);
        s.restore(sender);
        expect(sender.state.lines).toBe(original);
    });

    it('measuring the tool with a reference: the change count starts at 1', () => {
        const sender = fakeSender();
        const s = new ResumeSession();
        s.prepare(sender, plan({ measureTool: true }), { toolReference: true });
        s.begin(sender, s.take());
        expect(sender.state.toolChanges).toBe(1);
        const other = fakeSender();
        s.prepare(other, plan({ measureTool: true }), { toolReference: false });
        s.begin(other, s.take());
        expect(other.state.toolChanges).toBe(0);
    });

    it('a program loaded in between is never replaced by the old one', () => {
        const sender = fakeSender();
        const s = new ResumeSession();
        s.prepare(sender, plan());
        const newer = ['G0 X0'];
        sender.state.lines = newer; // gcode:load
        s.restore(sender);
        expect(sender.state.lines).toBe(newer);
    });

    it('a refused plan changes nothing', () => {
        const sender = fakeSender();
        const original = sender.state.lines;
        const logs = [];
        const s = new ResumeSession({ log: (m) => logs.push(m) });
        expect(s.prepare(sender, plan({ text: 'x' })).error).toBeTruthy();
        expect(sender.state.lines).toBe(original);
        expect(s.take()).toBeNull();
        expect(logs[0]).toMatch(/refused/);
    });
});
