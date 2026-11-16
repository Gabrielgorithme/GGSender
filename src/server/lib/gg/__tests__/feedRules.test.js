import { applyFeedRules, parseFeedRules, rulesFromContext } from '../feedRules';

const rules = (text) => parseFeedRules(text).rules;

describe('GGSender: feed rule parsing', () => {
    it('reads each kind of rule', () => {
        const { rules: r, errors } = parseFeedRules(`
            # slow the small cutter
            T5 F1000 -> F200
            T5 F>800 -> F800
            T5 F<100 -> F100
            t5 f* -> 50%
            T12 S18000 -> S12000
            T* S* -> 90%
            ; done
        `);
        expect(errors).toEqual([]);
        expect(r).toHaveLength(6);
        expect(r[0]).toEqual({ tool: '5', word: 'F', match: { type: 'equal', value: 1000 }, target: { type: 'value', value: 200 } });
        expect(r[1].match).toEqual({ type: 'above', value: 800 });
        expect(r[2].match).toEqual({ type: 'below', value: 100 });
        expect(r[3]).toEqual({ tool: '5', word: 'F', match: { type: 'any' }, target: { type: 'percent', value: 50 } });
        expect(r[5].tool).toBe('*');
    });

    it('reports lines it cannot use, with their line number', () => {
        const { rules: r, errors } = parseFeedRules('T5 F1000 -> F200\nmake it slower\nT5 F1000 -> S200\nT5 F* -> F0\nT5 F* -> 200');
        expect(r).toHaveLength(1);
        expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    });

    it('accepts empty or missing text', () => {
        expect(parseFeedRules('')).toEqual({ rules: [], errors: [] });
        expect(parseFeedRules(undefined)).toEqual({ rules: [], errors: [] });
        expect(parseFeedRules(null)).toEqual({ rules: [], errors: [] });
    });
});

describe('GGSender: feed rule application', () => {
    it('replaces an exact feed for that tool only', () => {
        const r = rules('T5 F1000 -> F200');
        expect(applyFeedRules('G1 X10 Y5 F1000', '5', r)).toBe('G1 X10 Y5 F200');
        expect(applyFeedRules('G1 X10 Y5 F1000', 5, r)).toBe('G1 X10 Y5 F200');
        expect(applyFeedRules('G1 X10 Y5 F1000', '6', r)).toBe('G1 X10 Y5 F1000');
        expect(applyFeedRules('G1 X10 Y5 F1000', null, r)).toBe('G1 X10 Y5 F1000');
        expect(applyFeedRules('G1 X10 Y5 F900', '5', r)).toBe('G1 X10 Y5 F900');
        expect(applyFeedRules('G1 X10 Y5 F1000.0', '5', r)).toBe('G1 X10 Y5 F200');
    });

    it('caps, floors and scales', () => {
        expect(applyFeedRules('G1 X1 F1200', '5', rules('T5 F>800 -> F800'))).toBe('G1 X1 F800');
        expect(applyFeedRules('G1 X1 F800', '5', rules('T5 F>800 -> F800'))).toBe('G1 X1 F800');
        expect(applyFeedRules('G1 X1 F50', '5', rules('T5 F<100 -> F100'))).toBe('G1 X1 F100');
        expect(applyFeedRules('G1 X1 F1000', '5', rules('T5 F* -> 50%'))).toBe('G1 X1 F500');
        expect(applyFeedRules('G1 X1 F333', '5', rules('T5 F* -> 33.3%'))).toBe('G1 X1 F110.889');
    });

    it('handles spindle speed separately from feed', () => {
        const r = rules('T12 S18000 -> S12000\nT12 F* -> 50%');
        expect(applyFeedRules('M3 S18000', '12', r)).toBe('M3 S12000');
        expect(applyFeedRules('G1 X1 F600 S18000', '12', r)).toBe('G1 X1 F300 S12000');
    });

    it('uses the first matching rule', () => {
        const r = rules('T5 F1000 -> F200\nT5 F* -> 50%');
        expect(applyFeedRules('G1 X1 F1000', '5', r)).toBe('G1 X1 F200');
        expect(applyFeedRules('G1 X1 F600', '5', r)).toBe('G1 X1 F300');
    });

    it('applies T* to every tool, including an unknown one', () => {
        const r = rules('T* S* -> 90%');
        expect(applyFeedRules('M3 S10000', '3', r)).toBe('M3 S9000');
        expect(applyFeedRules('M3 S10000', null, r)).toBe('M3 S9000');
    });

    it('leaves everything else on the line untouched', () => {
        const r = rules('T5 F* -> 50%');
        expect(applyFeedRules('G1 X10.5 Y-3.25 Z-1 F1000', '5', r)).toBe('G1 X10.5 Y-3.25 Z-1 F500');
        expect(applyFeedRules('G0 X10 Y10', '5', r)).toBe('G0 X10 Y10');
        expect(applyFeedRules('G2 X1 Y1 I0.5 J0 F400', '5', r)).toBe('G2 X1 Y1 I0.5 J0 F200');
        expect(applyFeedRules('', '5', r)).toBe('');
    });

    it('does not touch firmware commands or gSender expressions', () => {
        const r = rules('T* F* -> 50%\nT* S* -> 50%');
        expect(applyFeedRules('$J=G91 X10 F1000', '5', r)).toBe('$J=G91 X10 F1000');
        expect(applyFeedRules('$110=5000', '5', r)).toBe('$110=5000');
        expect(applyFeedRules('%global.x.FEEDRATE=F1000', '5', r)).toBe('%global.x.FEEDRATE=F1000');
    });

    it('never produces a zero feed', () => {
        expect(applyFeedRules('G1 X1 F0.001', '5', rules('T5 F* -> 1%'))).toBe('G1 X1 F0.001');
    });

    it('returns the line unchanged without rules', () => {
        expect(applyFeedRules('G1 X1 F1000', '5', [])).toBe('G1 X1 F1000');
        expect(applyFeedRules('G1 X1 F1000', '5', undefined)).toBe('G1 X1 F1000');
    });
});

describe('GGSender: rules from the tool change context', () => {
    it('parses once per text and follows changes', () => {
        const a = rulesFromContext({ feedRules: 'T5 F* -> 50%' });
        expect(a).toHaveLength(1);
        expect(rulesFromContext({ feedRules: 'T5 F* -> 50%' })).toBe(a);
        expect(rulesFromContext({ feedRules: '' })).toEqual([]);
        expect(rulesFromContext({})).toEqual([]);
        expect(rulesFromContext(undefined)).toEqual([]);
    });
});
