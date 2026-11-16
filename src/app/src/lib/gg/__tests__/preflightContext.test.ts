import { analyzeProgram } from '../preflight';
import { PreflightIssue } from '../preflight';
import { ContextInput, allIssues, checkTravel, contextIssues, countSerious } from '../preflightContext';

// job spans X 0..40, Y 0..20, Z -3..10 (work)
const PROGRAM = `G21 G90
T5 M6
S18000 M3
G0 X0 Y0 Z10
G1 Z-3 F300
G1 X40 Y20 F1200
G0 Z10
M6 T12
S24000 M3
G1 X10 Z-1 F200`;
const report = analyzeProgram(PROGRAM);

const travel = (over = {}) => ({
    hasHomed: true,
    maxTravel: { x: 300, y: 300, z: 80 },
    // work zero at machine X-200 Y-150 Z-40
    mpos: { x: -200, y: -150, z: -40 },
    wpos: { x: 0, y: 0, z: 0 },
    ...over,
});

const ctx = (over: Partial<ContextInput> = {}): ContextInput => ({
    strategy: 'Fixed Tool Sensor',
    loadedTool: null as string | null,
    sendsToolNumbers: false,
    spindleMax: 24000,
    feedRules: '',
    travel: checkTravel(report, travel()),
    ...over,
});

const codes = (issues: PreflightIssue[]) => issues.map((i) => i.code);

describe('GGSender pre-flight: travel', () => {
    it('places the job in machine coordinates', () => {
        const t = checkTravel(report, travel());
        expect(t.status).toBe('ok');
        expect(t.axes).toEqual([
            { axis: 'x', jobMin: -200, jobMax: -160, rangeMin: -300, rangeMax: 0, over: 0, ambiguous: false },
            { axis: 'y', jobMin: -150, jobMax: -130, rangeMin: -300, rangeMax: 0, over: 0, ambiguous: false },
            { axis: 'z', jobMin: -43, jobMax: -30, rangeMin: -80, rangeMax: 0, over: 0, ambiguous: false },
        ]);
    });

    it('accounts for the machine not being at the work zero', () => {
        // machine at X-190 with work X at 10 -> zero is still at -200
        const t = checkTravel(report, travel({ mpos: { x: -190, y: -150, z: -40 }, wpos: { x: 10, y: 0, z: 0 } }));
        expect(t.axes[0].jobMin).toBe(-200);
    });

    it('catches a job that would go above the top of Z', () => {
        // zero set 5mm below the top: the 10mm clearance moves go 5mm too high
        const t = checkTravel(report, travel({ mpos: { x: -200, y: -150, z: -5 } }));
        expect(t.status).toBe('outside');
        const z = t.axes.find((a) => a.axis === 'z');
        expect(z.jobMax).toBe(5);
        expect(z.over).toBe(5);
        const issues = contextIssues(report, ctx({ travel: t }));
        expect(issues[0]).toMatchObject({ severity: 'error', code: 'TRAVEL_Z' });
        expect(issues[0].message).toMatch(/5 mm above/);
    });

    it('catches a job that runs off the far end', () => {
        // zero near the far end: fits, just
        const t = checkTravel(report, travel({ mpos: { x: -280, y: -150, z: -40 } }));
        expect(t.status).toBe('ok');
        expect(t.axes[0]).toMatchObject({ jobMin: -280, jobMax: -240, over: 0 });
        // zero 10mm from the home end: the 40mm wide job runs 30mm past it
        const t2 = checkTravel(report, travel({ mpos: { x: -10, y: -150, z: -40 } }));
        expect(t2.status).toBe('outside');
        expect(t2.axes[0]).toMatchObject({ jobMax: 30, over: 30 });
        // zero 10mm from the far end, job going the other way
        const t3 = checkTravel(analyzeProgram('G0 X-40 Y0 Z1\nG0 X0'), travel({ mpos: { x: -290, y: -150, z: -40 } }));
        expect(t3.axes[0]).toMatchObject({ jobMin: -330, over: 30 });
    });

    it('uses [0, travel] for an axis that reports positive positions', () => {
        const t = checkTravel(report, travel({ mpos: { x: 100, y: -150, z: -40 } }));
        expect(t.axes[0]).toMatchObject({ rangeMin: 0, rangeMax: 300, jobMin: 100, jobMax: 140, over: 0 });
    });

    it('does not call an axis at 0 outside when the job fits on the positive side', () => {
        // machine at X0 right after homing; job runs positive in X
        const job = analyzeProgram('G0 X0 Y0 Z1\nG1 X100 F500');
        const t = checkTravel(job, travel({ mpos: { x: 0, y: -150, z: -40 }, wpos: { x: 0, y: 0, z: 0 } }));
        const x = t.axes.find((a) => a.axis === 'x');
        expect(x.ambiguous).toBe(true);
        expect(t.status).not.toBe('outside');
        const issues = contextIssues(job, ctx({ travel: t }));
        expect(issues.some((i) => i.code === 'TRAVEL_X_AMBIGUOUS' && i.severity === 'warning')).toBe(true);
        expect(issues.some((i) => i.code === 'TRAVEL_X')).toBe(false);
    });

    it('still reports an error at 0 when the job fits on neither side', () => {
        const job = analyzeProgram('G0 X-50 Y0 Z1\nG1 X50 F500');
        const t = checkTravel(job, travel({ mpos: { x: 0, y: -150, z: -40 }, wpos: { x: 0, y: 0, z: 0 } }));
        expect(t.status).toBe('outside');
        expect(t.axes.find((a) => a.axis === 'x').ambiguous).toBe(false);
    });

    it('does not check without homing, connection or travel settings', () => {
        expect(checkTravel(report, travel({ hasHomed: false })).status).toBe('unchecked');
        expect(checkTravel(report, null).status).toBe('unchecked');
        expect(checkTravel(report, travel({ maxTravel: { x: null, y: null, z: null } })).status).toBe('unchecked');
        expect(checkTravel(analyzeProgram('G0 A90 X1'), travel()).status).toBe('unchecked');
    });
});

describe('GGSender pre-flight: machine and settings', () => {
    it('warns when the spindle speed is above $30', () => {
        expect(codes(contextIssues(report, ctx({ spindleMax: 20000 })))).toContain('SPINDLE_ABOVE_MAX');
        expect(codes(contextIssues(report, ctx({ spindleMax: 24000 })))).not.toContain('SPINDLE_ABOVE_MAX');
        expect(codes(contextIssues(report, ctx({ spindleMax: null })))).not.toContain('SPINDLE_ABOVE_MAX');
    });

    it('warns when tool changes would be ignored', () => {
        const issues = contextIssues(report, ctx({ strategy: 'Ignore' }));
        expect(issues.find((i) => i.code === 'STRATEGY_IGNORE')).toMatchObject({ line: 2 });
    });

    it('warns about tool numbers above 255 only when they are sent', () => {
        const big = analyzeProgram('T405 M6\nG0 X1');
        expect(codes(contextIssues(big, ctx({ sendsToolNumbers: true })))).toContain('TOOL_NUMBER_SENT');
        expect(codes(contextIssues(big, ctx({ sendsToolNumbers: false })))).not.toContain('TOOL_NUMBER_SENT');
    });

    it('compares the first tool with the loaded tool', () => {
        expect(codes(contextIssues(report, ctx({ loadedTool: null })))).toContain('LOADED_UNKNOWN');
        expect(codes(contextIssues(report, ctx({ loadedTool: '5' })))).toContain('LOADED_MATCHES');
        const differs = contextIssues(report, ctx({ loadedTool: '3' })).find((i) => i.code === 'LOADED_DIFFERS');
        expect(differs.message).toMatch(/T3 .* T5/);
    });

    it('says which tool cuts the moves before the first change', () => {
        const r = analyzeProgram('M3 S1\nG1 X1 Z-1 F100\nT2 M6\nG1 X2');
        expect(contextIssues(r, ctx({ loadedTool: '7' })).find((i) => i.code === 'CUTS_WITH_LOADED').message).toMatch(/T7/);
    });

    it('reports feed rules that will change the program, and those that will not', () => {
        const issues = contextIssues(report, ctx({ feedRules: 'T5 F* -> 50%\nT9 F* -> 50%' }));
        expect(issues.find((i) => i.code === 'FEED_RULES_ACTIVE').message).toMatch(/1 feed.*T5/);
        expect(issues.find((i) => i.code === 'FEED_RULES_UNUSED').message).toMatch(/T9/);
        expect(codes(contextIssues(report, ctx({ feedRules: '' })))).not.toContain('FEED_RULES_ACTIVE');
    });

    it('sorts errors first and counts the serious ones', () => {
        const r = analyzeProgram('G1 X1 F100\nT1 M6\nG0 Z-1');
        const issues = allIssues(r, ctx({ strategy: 'Ignore' }));
        const severities = issues.map((i) => i.severity);
        expect(severities).toEqual([...severities].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
        expect(countSerious(issues)).toBe(issues.filter((i) => i.severity !== 'info').length);
    });
});
