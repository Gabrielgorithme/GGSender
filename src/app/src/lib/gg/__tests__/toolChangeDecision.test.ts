// GGSender: which wizard a Fixed Tool Sensor tool change runs (lib/gg/toolChangeDecision.ts)
import { DecisionInput, decideFixedSensor, overruled } from '../toolChangeDecision';

const ref = (status: 'valid' | 'stale' | 'none') => ({ status });
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    count: 2,
    reference: ref('valid'),
    resumed: false,
    resumeMode: null,
    guard: true,
    ...over,
});

describe('GGSender: tool change decision (Fixed Tool Sensor)', () => {
    describe('a job started from the top', () => {
        it('first M6: upstream\'s "First tool" setting, whatever the reference', () => {
            (['valid', 'stale', 'none'] as const).forEach((status) => {
                expect(decideFixedSensor(input({ count: 1, reference: ref(status) }))).toEqual({
                    variant: 'first-tool',
                    reason: 'first-tool',
                    overrule: null,
                });
            });
        });

        it('later M6, reference valid: the new tool against the reference; the owner can measure the old tool first', () => {
            expect(decideFixedSensor(input())).toEqual({ variant: 'measure', reason: 'valid', overrule: 'full' });
        });

        it('later M6, Z zero changed after the last probe: the tool in the spindle is measured first; the old reference can be used', () => {
            expect(decideFixedSensor(input({ reference: ref('stale') }))).toEqual({ variant: 'full', reason: 'stale', overrule: 'measure' });
        });

        it('later M6, no reference: the tool in the spindle is measured first, nothing else is possible', () => {
            expect(decideFixedSensor(input({ reference: ref('none') }))).toEqual({ variant: 'full', reason: 'none', overrule: null });
        });

        it('setting off: upstream\'s count, the reference is not looked at', () => {
            (['valid', 'stale', 'none'] as const).forEach((status) => {
                expect(decideFixedSensor(input({ guard: false, reference: ref(status) }))).toEqual({
                    variant: 'measure',
                    reason: 'count',
                    overrule: null,
                });
            });
            expect(decideFixedSensor(input({ guard: false, count: 1 })).variant).toBe('first-tool');
        });
    });

    describe('a resumed job', () => {
        it('never takes an M6 for "the first tool, already in the spindle"', () => {
            // every count, every state of the reference, the setting on or off
            [1, 2, 3].forEach((count) => {
                (['valid', 'stale', 'none'] as const).forEach((status) => {
                    [true, false].forEach((guard) => {
                        const d = decideFixedSensor(input({ resumed: true, count, guard, reference: ref(status) }));
                        expect(d.variant).not.toBe('first-tool');
                        // and always asks for the new tool: never the wizard that only measures
                        expect(d.variant).not.toBe('reference');
                    });
                });
            });
        });

        it('a program M6 after a resume that kept the tool (count 1) follows the reference', () => {
            expect(decideFixedSensor(input({ resumed: true, count: 1 }))).toEqual({ variant: 'measure', reason: 'valid', overrule: 'full' });
            expect(decideFixedSensor(input({ resumed: true, count: 1, reference: ref('stale') }))).toEqual({
                variant: 'full',
                reason: 'stale',
                overrule: 'measure',
            });
            expect(decideFixedSensor(input({ resumed: true, count: 1, reference: ref('none') }))).toEqual({
                variant: 'full',
                reason: 'none',
                overrule: null,
            });
        });
    });

    describe("the resume's own tool change", () => {
        const resume = (resumeMode: DecisionInput['resumeMode'], status: 'valid' | 'stale' | 'none') =>
            decideFixedSensor(input({ resumed: true, count: 1, resumeMode, reference: ref(status) }));

        it('choice 3 (Z zero set by hand with this tool): only measured, as the new reference, whatever the old one', () => {
            (['valid', 'stale', 'none'] as const).forEach((status) => {
                expect(resume('reference', status)).toEqual({ variant: 'reference', reason: 'resume-reference', overrule: null });
            });
        });

        it('choice 1 with the tool measured first: the same measurement, its own reason, whatever the reference', () => {
            (['valid', 'stale', 'none'] as const).forEach((status) => {
                expect(resume('reference-same', status)).toEqual({ variant: 'reference', reason: 'resume-same-reference', overrule: null });
            });
        });

        it('choice 2 with a valid reference: against the reference', () => {
            expect(resume('measure', 'valid')).toEqual({ variant: 'measure', reason: 'resume-measure', overrule: null });
            expect(resume('measure-old', 'valid')).toEqual({ variant: 'measure', reason: 'resume-measure', overrule: null });
        });

        it('choice 2, old reference accepted in the dialog: against the old reference', () => {
            expect(resume('measure-old', 'stale')).toEqual({ variant: 'measure', reason: 'resume-old-reference', overrule: null });
        });

        it('choice 2, old tool measured first', () => {
            (['valid', 'stale', 'none'] as const).forEach((status) => {
                expect(resume('full', status)).toEqual({ variant: 'full', reason: 'resume-full', overrule: null });
            });
        });

        it('choice 2, but the reference is not what the dialog saw: never silently against a stale or missing reference', () => {
            expect(resume('measure', 'stale')).toEqual({ variant: 'full', reason: 'resume-changed', overrule: 'measure' });
            expect(resume('measure', 'none')).toEqual({ variant: 'full', reason: 'resume-changed', overrule: null });
            expect(resume('measure-old', 'none')).toEqual({ variant: 'full', reason: 'resume-changed', overrule: null });
        });

        it('what went wrong in 0.7.0: Z zero set by hand, then "change or measure" set the tool against the old reference', () => {
            // now the dialog sends "reference" for that case; and even "measure" does not use the stale reference
            expect(resume('reference', 'stale').variant).toBe('reference');
            expect(resume('measure', 'stale').variant).not.toBe('measure');
        });
    });

    it('the overrule switches between the two wizards and back', () => {
        const valid = decideFixedSensor(input());
        expect(overruled(valid, 'measure')).toBe('full');
        expect(overruled(valid, 'full')).toBe('measure');
        const stale = decideFixedSensor(input({ reference: ref('stale') }));
        expect(overruled(stale, 'full')).toBe('measure');
        expect(overruled(stale, 'measure')).toBe('full');
        // nothing to switch to
        expect(overruled(decideFixedSensor(input({ reference: ref('none') })), 'full')).toBeNull();
        expect(overruled(decideFixedSensor(input({ count: 1 })), 'full')).toBeNull();
    });
});
