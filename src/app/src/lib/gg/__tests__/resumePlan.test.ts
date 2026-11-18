// GGSender: resume from a line, the plan (lib/gg/resumePlan.ts)
import fs from 'fs';
import path from 'path';
import { analyzeJob } from '../jobOperations';
import {
    applyLine,
    initialState,
    nearestMove,
    planResume,
    resolveQuery,
    resumePayload,
} from '../resumePlan';

const OPTS = { safeZ: -0.1, measureTool: false, spinupSeconds: 5 };

const PROGRAM = [
    '(1)',
    '(T45 D=4 CR=0.5 - ZMIN=-9.846 - bullnose end mill)',
    'N10 G90 G94',
    'N11 G17',
    'N12 G21',
    'N13 G28 G91 Z0',
    'N14 G90',
    '',
    '(3D Adaptive Roughing2)',
    'N15 T45 M6',
    'N16 S24000 M3',
    'N17 G17 G90 G94',
    'N18 G54',
    'N19 M8',
    'N20 G0 X10 Y10',
    'N21 Z15',
    'N22 G0 Z3',
    'N23 Z1.2',
    'N24 G1 Z-2 F300',
    'N25 G1 X20 Y10 F1200',
    'N26 X20 Y20 Z-2.5',
    'N27 G3 X25 Y25 I5 J0',
    'N28 X30 Y20 I0 J-5',
    'N29 G1 X40 Y20',
    'N30 G0 Z15',
    'N31 M9',
    'N32 M5',
    'N33 G28 G91 Z0',
    'N34 M30',
].join('\n');

const lineOf = (content: string, n: string) => content.split('\n').findIndex((l) => l.startsWith(`${n} `));
const plan = (n: string, opts = {}, content = PROGRAM) =>
    planResume(content, analyzeJob(content), lineOf(content, n), { ...OPTS, ...opts });

describe('GGSender: resume plan', () => {
    it('the way it is done by hand: up, over, rapid to the retract height, feed down, carry on', () => {
        const p = plan('N26');
        expect(p.ok).toBe(true);
        expect(p.text).toBe('N26 X20 Y20 Z-2.5');
        expect(p.nWord).toBe('N26');
        expect(p.operation?.name).toBe('3D Adaptive Roughing2');
        expect(p.start).toEqual({ x: 20, y: 10, z: -2 }); // where N25 ended
        expect(p.preamble).toEqual([
            '(GGSender resume at line 21 N26 "3D Adaptive Roughing2")', // file line 21
            'G21 G53 G0 Z-0.1',
            'G21 G90 G94 G17 G54',
            'S24000 M3',
            'G4 P5',
            'M8',
            'G0 X20 Y10',
            'G0 Z15', // the operation's highest rapid
            'G1 Z-2 F300', // its plunge feed
            'G1 F1200', // the program's feed and motion at that line
        ]);
        expect(p.rapidDownFromOperation).toBe(true);
        expect(p.plungeFromOperation).toBe(true);
        expect(p.target).toBeNull();
        expect(p.problems).toEqual([]);
        expect(p.warnings).toEqual([]);
    });

    it('entry lines take the place of the lines just before, so every line keeps its index', () => {
        const p = plan('N26');
        expect(p.spliceSeq).toBe(p.seq - p.preamble.length);
        const payload = resumePayload(p, 30, false);
        expect(payload).toEqual({ seq: p.seq, text: 'N26 X20 Y20 Z-2.5', total: 30, preamble: p.preamble, target: null, measureTool: false });
    });

    it('tool change first when asked', () => {
        const p = plan('N26', { measureTool: true });
        // the modes again after the wizard
        expect(p.preamble.slice(2, 5)).toEqual(['G21 G90 G94 G17 G54', 'T45 M6', 'G21 G90 G94 G17 G54']);
    });

    it('options: rapid-down height and plunge feed', () => {
        const p = plan('N26', { rapidDownTo: 3, plungeFeed: 150 });
        expect(p.preamble).toContain('G0 Z3');
        expect(p.preamble).toContain('G1 Z-2 F150');
        expect(p.rapidDownFromOperation).toBe(false);
        expect(p.plungeFromOperation).toBe(false);
        // spin-up wait off
        expect(plan('N26', { spinupSeconds: 0 }).preamble).not.toContain('G4 P5');
    });

    it('a line continuing an arc gets its G2/G3 written on it (the firmware refuses G3 alone)', () => {
        const p = plan('N28');
        expect(p.start).toEqual({ x: 25, y: 25, z: -2.5 });
        expect(p.target).toBe('N28 G3 X30 Y20 I0 J-5');
        expect(p.preamble[p.preamble.length - 1]).toBe('F1200');
        expect(p.spliceSeq).toBe(p.seq + 1 - (p.preamble.length + 1));
    });

    it('a start point above the retract height: straight rapid to it', () => {
        const content = PROGRAM.replace('N23 Z1.2', 'N23 Z20');
        const p = plan('N24', {}, content);
        expect(p.start.z).toBe(20);
        expect(p.preamble).toContain('G0 Z20');
        expect(p.preamble.some((l) => /^G1 Z/.test(l))).toBe(false);
    });

    it('the plane of the line is restored (Fusion parallel passes use G18)', () => {
        const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'fusion-job-trimmed.nc'), 'utf8');
        const p = plan('N77437', {}, content);
        expect(p.ok).toBe(true);
        expect(p.operation?.name).toBe('Parallel1');
        expect(p.preamble).toContain('G21 G90 G94 G18 G54');
        expect(p.start).toEqual({ x: 57.35, y: 6.946, z: -5.079 });
        expect(p.preamble).toContain('G0 Z2'); // Parallel1's highest rapid
        expect(p.preamble).toContain('G1 Z-5.079 F75'); // and its plunge feed
        expect(p.state.tool).toBe('45');
    });

    it('Z not known after a homing move: stays at the safe height', () => {
        const content = PROGRAM.replace('N30 G0 Z15', 'N30 G0 Z15\nN30.1 G28 G91 Z0\nN30.2 G90\nN30.3 G0 X50 Y50\nN30.4 Z5\nN30.5 G1 Z-1 F300');
        const p = plan('N30.3', {}, content);
        expect(p.ok).toBe(true);
        expect(p.start.z).toBeNull();
        expect(p.preamble.some((l) => /^G[01] Z/.test(l))).toBe(false);
        expect(p.warnings.join(' ')).toMatch(/Z at this line is not known/);
    });

    it('refuses what it cannot rebuild', () => {
        expect(plan('N15').problems.join(' ')).toMatch(/tool change/);
        expect(plan('N14').problems.join(' ')).toMatch(/at or before the first move/);
        expect(plan('N20').problems.join(' ')).toMatch(/at or before the first move/);
        const g92 = PROGRAM.replace('N22 G0 Z3', 'N22 G92 Z3');
        expect(plan('N26', {}, g92).problems.join(' ')).toMatch(/G10\/G92/);
        const inc = PROGRAM.replace('N25 G1 X20 Y10 F1200', 'N25 G91 G1 X10 F1200');
        expect(plan('N26', {}, inc).problems.join(' ')).toMatch(/G91/);
        const rotary = PROGRAM.replace('N25 G1 X20 Y10 F1200', 'N25 G1 X20 Y10 A90 F1200');
        expect(plan('N26', {}, rotary).problems.join(' ')).toMatch(/Rotary/);
        const ended = PROGRAM.replace('N25 G1 X20 Y10 F1200', 'N25 M30');
        expect(plan('N26', {}, ended).problems.join(' ')).toMatch(/ends at line/);
        const inverse = PROGRAM.replace('N24 G1 Z-2 F300', 'N24 G93 G1 Z-2 F3');
        expect(plan('N26', {}, inverse).problems.join(' ')).toMatch(/G93/);
        expect(plan('N26').ok).toBe(true);
    });

    it('too close to the start for the entry lines: refused', () => {
        const short = ['G21 G90', 'S1000 M3', 'G0 X0 Y0 Z1', 'G1 Z-1 F100', 'G1 X5', 'G1 Y5'].join('\n');
        const p = planResume(short, analyzeJob(short), 5, OPTS);
        expect(p.problems.join(' ')).toMatch(/too close to the start/);
    });

    it('a comment or blank line chosen: resumes at the next line with code', () => {
        const p = planResume(PROGRAM, analyzeJob(PROGRAM), lineOf(PROGRAM, 'N26') - 0, OPTS);
        const blank = planResume(PROGRAM, analyzeJob(PROGRAM), 7, OPTS); // the blank line before the operation
        expect(blank.text).toBe('N15 T45 M6');
        expect(p.text).toBe('N26 X20 Y20 Z-2.5');
    });
});

describe('GGSender: what broke the manual resume (XZ arcs, error:33)', () => {
    // a Fusion parallel pass: G18 set once, then arcs with I/K and lines
    // without any G word. Resumed without G18, every arc is an error:33.
    const XZ = PROGRAM.replace(
        'N27 G3 X25 Y25 I5 J0\nN28 X30 Y20 I0 J-5',
        'N27 G18 G2 X21 Z-3 I0.5 K0\nN28 X22 Z-3.5 I0.4 K0\nN28.5 G1 X23 Z-3.4',
    );
    it('plane, motion mode and feed are sent before the line; the arc line gets its G2', () => {
        const p = plan('N28', {}, XZ);
        expect(p.ok).toBe(true);
        expect(p.preamble).toContain('G21 G90 G94 G18 G54');
        expect(p.target).toBe('N28 G2 X22 Z-3.5 I0.4 K0');
        expect(p.preamble[p.preamble.length - 1]).toBe('F1200');
        // a straight line after the arcs: G1 restored explicitly
        const q = plan('N28.5', {}, XZ);
        expect(q.preamble).toContain('G21 G90 G94 G18 G54');
    });
    it('a tool length offset set by the program is restored, and its Z is not a move', () => {
        const tlo = PROGRAM.replace('N22 G0 Z3', 'N22 G43.1 Z1.25\nN22.5 G0 Z3');
        const p = plan('N26', {}, tlo);
        expect(p.preamble).toContain('G43.1 Z1.25');
        expect(p.start.z).toBe(-2);
        const cancelled = tlo.replace('N24 G1 Z-2 F300', 'N24 G49 G1 Z-2 F300');
        expect(plan('N26', {}, cancelled).preamble.some((l) => l.startsWith('G43.1'))).toBe(false);
    });
    it('G90.1 is refused (the firmware does not support it)', () => {
        const abs = PROGRAM.replace('N17 G17 G90 G94', 'N17 G17 G90 G94 G90.1');
        expect(plan('N26', {}, abs).problems.join(' ')).toMatch(/G90.1/);
        // and is not read as G90
        expect(plan('N26', {}, abs).state.distance).toBe('G90');
    });
});

describe('GGSender: modal state', () => {
    it('inch programs: positions and feeds follow the units', () => {
        const s = initialState();
        applyLine(s, 'G21 G90');
        applyLine(s, 'G0 X25.4 Y50.8 Z2.54');
        applyLine(s, 'G1 F254');
        applyLine(s, 'G20');
        expect(s.units).toBe('G20');
        expect(s.pos.x).toBeCloseTo(1);
        expect(s.pos.y).toBeCloseTo(2);
        expect(s.pos.z).toBeCloseTo(0.1);
        expect(s.feed).toBeCloseTo(10);
    });
    it('G53 and G28 leave the named axes unknown; G28 alone all of them', () => {
        const s = initialState();
        applyLine(s, 'G0 X1 Y2 Z3');
        applyLine(s, 'G53 G0 Z-1');
        expect(s.pos).toEqual({ x: 1, y: 2, z: null });
        applyLine(s, 'G0 Z5');
        applyLine(s, 'G28');
        expect(s.pos).toEqual({ x: null, y: null, z: null });
    });
    it('coolant, spindle, tool, work offset', () => {
        const s = initialState();
        applyLine(s, 'T7');
        expect(s.tool).toBeNull();
        applyLine(s, 'M6');
        expect(s.tool).toBe('7');
        applyLine(s, 'S18000 M4 M7 M8 G55');
        expect([s.spindle, s.speed, s.mist, s.flood, s.wcs]).toEqual(['M4', 18000, true, true, 'G55']);
        applyLine(s, 'M9 M5 G59.1');
        expect([s.spindle, s.mist, s.flood, s.wcs]).toEqual(['M5', false, false, 'G59.1']);
    });
});

describe('GGSender: finding the line', () => {
    it('N numbers when the program has them', () => {
        expect(resolveQuery(PROGRAM, 'N26').line).toBe(lineOf(PROGRAM, 'N26'));
        expect(resolveQuery(PROGRAM, '26').line).toBe(lineOf(PROGRAM, 'N26'));
        expect(resolveQuery(PROGRAM, ' n 26 ').line).toBe(lineOf(PROGRAM, 'N26'));
        expect(resolveQuery(PROGRAM, 'N999').error).toMatch(/No line N999/);
        expect(resolveQuery(PROGRAM, 'L3')).toMatchObject({ line: 2, how: 'line' });
    });
    it('file lines when it has none', () => {
        const plain = 'G21\nG0 X0\nG1 X1 F100\n';
        expect(resolveQuery(plain, '2')).toMatchObject({ line: 1, how: 'line' });
        expect(resolveQuery(plain, '99').error).toMatch(/has 4 lines/);
        expect(resolveQuery(plain, 'abc').error).toBeTruthy();
    });
});

describe('GGSender: where the job stopped', () => {
    const lines = PROGRAM.split('\n').filter((l) => l.trim());
    const seqOf = (n: string) => lines.findIndex((l) => l.startsWith(`${n} `));

    it('the move the tool was on', () => {
        // halfway along N25 (X10..20 at Y10, Z-2)
        const m = nearestMove(PROGRAM, { x: 15, y: 10, z: -2 }, 0, seqOf('N29'));
        expect(m?.line).toBe(lineOf(PROGRAM, 'N25'));
        expect(m?.distance).toBeCloseTo(0);
    });
    it('on an arc', () => {
        // N27: G3 from (20,20) around (25,20), radius 5, counter-clockwise to
        // (25,25): the long way, through (25,15) and (30,20), so it passes the
        // point at 45 degrees; N28 continues from 90 to 0 the long way and does not
        const m = nearestMove(PROGRAM, { x: 25 + 5 * Math.SQRT1_2, y: 20 + 5 * Math.SQRT1_2, z: -2.5 }, 0, seqOf('N29'));
        expect(m?.line).toBe(lineOf(PROGRAM, 'N27'));
        expect(m?.distance).toBeLessThan(0.05);
    });
    it('only among the lines given; the latest when two pass as close', () => {
        // (20,10,-2) is the end of N25 and the start of N26
        const both = nearestMove(PROGRAM, { x: 20, y: 10, z: -2 }, 0, seqOf('N29'));
        expect(both?.line).toBe(lineOf(PROGRAM, 'N26'));
        const early = nearestMove(PROGRAM, { x: 20, y: 10, z: -2 }, 0, seqOf('N25'));
        expect(early?.line).toBe(lineOf(PROGRAM, 'N25'));
    });
});
