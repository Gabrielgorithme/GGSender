import { PreflightReport, analyzeProgram } from '../preflight';

const codes = (r: PreflightReport) => r.issues.map((i) => i.code).sort();
const issue = (r: PreflightReport, code: string) => r.issues.find((i) => i.code === code);

const TWO_TOOLS = `%
(job)
G21 G90
(T5 D=6 flat end mill)
T5 M6
S18000 M3
G0 X0 Y0 Z5
G1 Z-3 F300
G1 X40 F1200
G1 Y20
G0 Z5
(T12 D=3 ball)
M6 T12
S20000 M3
G0 X10 Y10
G1 Z-1.5 F200
G1 X30 Y10 F800
G0 Z10
M5
M30
%`;

describe('GGSender pre-flight: tools', () => {
    const r = analyzeProgram(TWO_TOOLS);

    it('lists each tool with the line of its change and its description', () => {
        expect(r.toolChanges).toBe(2);
        expect(r.sections.map((s) => s.tool)).toEqual(['5', '12']);
        expect(r.sections.map((s) => s.changeLine)).toEqual([5, 13]);
        expect(r.sections[0].comment).toBe('T5 D=6 flat end mill');
        expect(r.sections[1].comment).toBe('T12 D=3 ball');
    });

    it('gives depth, height, feed and speed per tool', () => {
        const [t5, t12] = r.sections;
        expect(t5.cutZMin).toBe(-3);
        expect(t5.zMax).toBe(5);
        expect(t5.maxFeed).toBe(1200);
        expect(t5.spindleSpeeds).toEqual([18000]);
        expect(t12.cutZMin).toBe(-1.5);
        expect(t12.zMax).toBe(10);
        expect(t12.maxFeed).toBe(800);
        expect(t12.spindleSpeeds).toEqual([20000]);
    });

    it('gives the extents of the whole job', () => {
        expect(r.bounds.min).toEqual({ x: 0, y: 0, z: -3 });
        expect(r.bounds.max).toEqual({ x: 40, y: 20, z: 10 });
        expect(r.cutBounds.max.z).toBe(-1.5);
        expect(r.units).toBe('mm');
        expect(r.maxSpindle).toBe(20000);
    });

    it('finds nothing wrong with a clean program', () => {
        expect(r.issues).toEqual([]);
    });
});

describe('GGSender pre-flight: problems', () => {
    it('flags a feed move before any F word', () => {
        const r = analyzeProgram('G21\nM3 S1000\nG1 X10 Z-1\nG1 X20');
        expect(issue(r, 'FEED_UNDEFINED')).toMatchObject({ severity: 'error', line: 3, count: 2 });
    });

    it('flags cutting below Z0 with the spindle stopped', () => {
        const r = analyzeProgram('G21\nG1 X0 Y0 Z1 F100\nG1 Z-1\nM3 S1000\nG1 Z-2');
        expect(issue(r, 'CUT_SPINDLE_OFF')).toMatchObject({ line: 3, count: 1 });
    });

    it('flags rapids that end below Z0', () => {
        const r = analyzeProgram('G0 Z5\nG0 Z-2\nG0 X5');
        expect(issue(r, 'RAPID_BELOW_ZERO')).toMatchObject({ line: 2, count: 2 });
    });

    it('flags cutting before the first tool change', () => {
        const r = analyzeProgram('M3 S1000\nG1 X1 Z-1 F100\nT2 M6\nM3\nG1 X2 Z-1');
        expect(issue(r, 'CUT_BEFORE_M6')).toMatchObject({ line: 2 });
        expect(r.sections.map((s) => s.tool)).toEqual([null, '2']);
    });

    it('does not mention tool changes for a program without any', () => {
        const r = analyzeProgram('M3 S1000\nG1 X1 Z-1 F100');
        expect(issue(r, 'CUT_BEFORE_M6')).toBeUndefined();
        expect(r.sections).toHaveLength(1);
        expect(r.sections[0].tool).toBeNull();
    });

    it('flags M6 without a tool number and repeated tools', () => {
        const r = analyzeProgram('M6\nG0 X1\nT3 M6\nG0 X2\nT3 M6');
        expect(issue(r, 'M6_NO_TOOL')).toMatchObject({ line: 1 });
        expect(issue(r, 'SAME_TOOL_TWICE')).toMatchObject({ line: 5 });
    });

    it('takes the tool from a T word on an earlier line', () => {
        const r = analyzeProgram('T7\nG0 Z5\nM6\nG0 X1');
        expect(r.sections.map((s) => s.tool)).toEqual(['7']);
    });

    it('notes tool numbers above 255', () => {
        expect(issue(analyzeProgram('T405 M6\nG0 X1'), 'TOOL_OVER_255')).toMatchObject({ severity: 'info' });
    });

    it('flags mixed units and converts inches to mm', () => {
        const r = analyzeProgram('G20\nG0 X1 Y2\nG21\nG0 X10');
        expect(codes(r)).toContain('MIXED_UNITS');
        expect(r.bounds.max.y).toBe(50.8);
        expect(analyzeProgram('G20\nG1 X1 F10').sections[0].maxFeed).toBe(254);
    });

    it('leaves machine-coordinate and homing moves out of the extents', () => {
        const r = analyzeProgram('G0 X5 Y5 Z5\nG53 G0 Z-1\nG28\nG0 X1');
        expect(r.bounds.max).toEqual({ x: 5, y: 5, z: 5 });
        expect(codes(r)).toEqual(['G28_G30', 'G53_IN_PROGRAM']);
    });
});

describe('GGSender pre-flight: geometry', () => {
    it('follows incremental moves', () => {
        const r = analyzeProgram('G90 G0 X10 Y10 Z5\nG91\nG0 X5\nG0 X5 Z-10');
        expect(r.bounds.max.x).toBe(20);
        expect(r.bounds.min.z).toBe(-5);
    });

    it('ignores incremental moves from an unknown position', () => {
        const r = analyzeProgram('G91 G0 X5\nG90 G0 Y1');
        expect(r.bounds.max.x).toBeNull();
        expect(r.bounds.max.y).toBe(1);
    });

    it('includes the bulge of an arc, not just its end points', () => {
        // half circle from (-10,0) to (10,0) around the origin, clockwise: goes over the top
        const cw = analyzeProgram('G0 X-10 Y0\nG2 X10 Y0 I10 J0 F100');
        expect(cw.bounds.max.y).toBe(10);
        expect(cw.bounds.min.y).toBe(0);
        // same with G3: goes under
        const ccw = analyzeProgram('G0 X-10 Y0\nG3 X10 Y0 I10 J0 F100');
        expect(ccw.bounds.min.y).toBe(-10);
        expect(ccw.bounds.max.y).toBe(0);
    });

    it('handles full circles and R arcs', () => {
        const full = analyzeProgram('G0 X10 Y0\nG2 X10 Y0 I-10 J0 F100');
        expect(full.bounds.min).toMatchObject({ x: -10, y: -10 });
        expect(full.bounds.max).toMatchObject({ x: 10, y: 10 });
        const r = analyzeProgram('G0 X-10 Y0\nG2 X10 Y0 R10 F100');
        expect(r.bounds.max.y).toBe(10);
    });

    it('applies G92 to the current position', () => {
        const r = analyzeProgram('G0 X50\nG92 X0\nG91 G0 X5');
        expect(r.bounds.max.x).toBe(50);
        expect(r.bounds.min.x).toBe(5);
        expect(codes(r)).toContain('G92');
    });

    it('skips comments, blank lines and controller commands', () => {
        const r = analyzeProgram('; G0 Z-50\n(G0 Z-50)\n\n$H\n%\nG0 Z5 (G0 Z-50)');
        expect(r.bounds.min.z).toBe(5);
        expect(r.issues).toEqual([]);
    });

    it('notes a rotary axis', () => {
        expect(analyzeProgram('G0 A90').usesA).toBe(true);
    });

    it('copes with empty input', () => {
        const r = analyzeProgram('');
        expect(r.sections).toHaveLength(1);
        expect(r.issues).toEqual([]);
        expect(analyzeProgram(undefined as any).lines).toBe(1);
    });

    it('is fast enough for a large file', () => {
        const parts = ['G21 G90', 'T1 M6', 'M3 S12000'];
        for (let i = 0; i < 300000; i++) {
            parts.push(`G1 X${(i % 500) * 0.1} Y${(i % 300) * 0.2} Z-1 F1000`);
        }
        const t0 = Date.now();
        analyzeProgram(parts.join('\n'));
        expect(Date.now() - t0).toBeLessThan(3000);
    });
});
