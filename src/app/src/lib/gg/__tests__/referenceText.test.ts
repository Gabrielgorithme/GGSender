// GGSender: the words for the tool sensor reference (lib/gg/referenceText.ts)
import { HistoryEntry, NO_REFERENCE, ReferenceSnapshot } from '../probeStore';
import { clock, decisionText, historyLine, referenceEffect, referenceHeadline, referenceId, toolName } from '../referenceText';
import { DecisionInput, WizardVariant, decideFixedSensor } from '../toolChangeDecision';

const at = (h: number, m: number) => new Date(2026, 10, 18, h, m, 0).getTime();
const NOW = at(15, 0);

const valid: ReferenceSnapshot = {
    status: 'valid',
    reference: { value: -15.002, tool: '45', at: at(14, 32), wcs: 'G54' },
    lastProbe: { kind: 'reference', tool: '45', at: at(14, 32) },
    stale: null,
    watching: true,
    wcs: 'G54',
    history: [],
    live: true,
};
const stale: ReferenceSnapshot = { ...valid, status: 'stale', stale: { kind: 'zero', at: at(14, 40), deltaZ: -8.12 } };

/** STE: no sentence longer than 25 words (20 for instructions; checked by eye). */
const sentences = (text: string) =>
    text
        .replace(/\(([^)]*)\)/g, ' $1 ')
        .split(/(?<=[.:?!])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
const longest = (text: string) => Math.max(...sentences(text).map((s) => s.split(/\s+/).length));

describe('GGSender: reference text', () => {
    it('times: the hour today, the date on another day', () => {
        expect(clock(at(14, 32), NOW)).toBe('14:32');
        expect(clock(at(9, 5), NOW)).toBe('09:05');
        expect(clock(new Date(2026, 10, 17, 14, 32).getTime(), NOW)).toBe('17 Nov 14:32');
        expect(clock(null, NOW)).toBe('?');
    });

    it('tool names', () => {
        expect(toolName('45')).toBe('T45');
        expect(toolName('T45')).toBe('T45');
        expect(toolName(null)).toBe('T?');
        expect(referenceId(valid, NOW)).toBe('T45, 14:32');
    });

    it('valid: which tool, when, and that Z zero did not change', () => {
        expect(referenceHeadline(valid, NOW)).toBe('Reference: T45, probed at 14:32. Z zero did not change after that.');
        const after: ReferenceSnapshot = { ...valid, lastProbe: { kind: 'measured', tool: '20', at: at(14, 45) } };
        expect(referenceHeadline(after, NOW)).toBe(
            'Last probe: T20 at 14:45, against the reference (T45, 14:32). Z zero did not change after that.',
        );
        expect(referenceEffect(valid, NOW)).toMatch(/measures the new tool against this reference. Z zero stays/);
    });

    it('stale: what changed and when, and that the reference is not correct', () => {
        expect(referenceHeadline(stale, NOW)).toBe(
            'Z zero changed at 14:40, after the last probe (T45, 14:32). The reference is not correct now.',
        );
        expect(referenceEffect(stale, NOW)).toMatch(/first measures the tool in the spindle as the new reference/);
        expect(referenceEffect(stale, NOW)).toMatch(/If you use the old reference, Z zero goes back to its position of 14:32/);
        const wcs: ReferenceSnapshot = { ...stale, stale: { kind: 'wcs', at: at(14, 41), deltaZ: 3, from: 'G54', to: 'G55' } };
        expect(referenceHeadline(wcs, NOW)).toMatch(/^The work coordinate system changed at 14:41 \(G54 to G55\)/);
        const program: ReferenceSnapshot = { ...stale, stale: { kind: 'program', at: at(14, 42), deltaZ: 3 } };
        expect(referenceHeadline(program, NOW)).toMatch(/^The program changed the work Z offset at 14:42/);
    });

    it('none: says so, and what the next tool change does', () => {
        expect(referenceHeadline(NO_REFERENCE, NOW)).toBe('No reference. gSender did not probe a tool after it connected.');
        expect(referenceEffect(NO_REFERENCE, NOW)).toMatch(/first measures the tool in the spindle. That tool becomes the reference/);
    });

    it('a controller that does not report its work offset: said plainly', () => {
        expect(referenceHeadline({ ...valid, watching: false }, NOW)).toMatch(/gSender cannot see a change of Z zero/);
    });

    it('history lines', () => {
        const line = (e: Partial<HistoryEntry>) => historyLine({ kind: 'zero', at: 1, ...e } as HistoryEntry);
        expect(line({ kind: 'reference', tool: '45' })).toBe('T45 probed as the reference.');
        expect(line({ kind: 'reference', tool: '45', zeroShift: 0.12 })).toBe(
            'T45 probed as the reference. Z zero is 0.120 mm higher than with the old reference.',
        );
        expect(line({ kind: 'reference', tool: '45', zeroShift: -1.5 })).toMatch(/1.500 mm lower than with the old reference/);
        expect(line({ kind: 'reference', tool: '45', zeroShift: 0.004 })).toMatch(/Same Z zero as the old reference \(difference 0.004 mm\)/);
        expect(line({ kind: 'measured', tool: '20' })).toBe('T20 measured against the reference. Z zero stays on the part.');
        expect(line({ kind: 'measured', tool: '20', oldReference: true })).toMatch(/against the old reference. Z zero went back/);
        expect(line({ kind: 'zero' })).toBe('Z zero changed (by hand, pendant, probe or command).');
        expect(line({ kind: 'zero', restored: true })).toMatch(/The reference is correct again/);
        expect(line({ kind: 'wcs', from: 'G54', to: 'G55' })).toBe('Work coordinate system changed: G54 to G55.');
        expect(line({ kind: 'program' })).toBe('The program changed the work Z offset.');
        expect(line({ kind: 'reference', tool: null })).toBe('T? probed as the reference.');
    });

    describe('the tool change window', () => {
        const text = (over: Partial<DecisionInput>, s: ReferenceSnapshot, active?: WizardVariant) => {
            const d = decideFixedSensor({ count: 2, reference: s, resumed: false, resumeMode: null, guard: true, ...over });
            return decisionText(d, active ?? (d.variant as WizardVariant), s, 'T20', NOW);
        };

        it('valid reference: against it, Z zero stays; the old tool can be measured first', () => {
            const t = text({}, valid);
            expect(t.headline).toBe('gSender measures T20 against the reference (T45, 14:32).');
            expect(t.why).toBe('Z zero did not change after the last probe.');
            expect(t.zero).toEqual({ effect: 'stays', label: 'Z zero stays on the part' });
            expect(t.warning).toBe(false);
            expect(t.overruleLabel).toBe('Measure the tool in the spindle first');
        });

        it('Z zero changed: the tool in the spindle first, with the cause; the old reference can be used', () => {
            const t = text({}, stale);
            expect(t.headline).toBe('gSender first measures the tool in the spindle as the new reference. Then you fit T20.');
            expect(t.why).toMatch(/^Z zero changed at 14:40, after the last probe \(T45, 14:32\)/);
            expect(t.zero.effect).toBe('stays');
            expect(t.warning).toBe(true);
            expect(t.overruleLabel).toBe('Use the old reference');
        });

        it('overruled to the old reference: says that Z zero goes back, and offers the way back', () => {
            const t = text({}, stale, 'measure');
            expect(t.headline).toBe('gSender measures T20 against the old reference (T45, 14:32).');
            expect(t.why).toMatch(/Z zero goes back to its position of 14:32/);
            expect(t.zero).toEqual({ effect: 'goes-back', label: 'Z zero goes back to 14:32' });
            expect(t.warning).toBe(true);
            expect(t.overruleLabel).toBe('Back to the default: measure the tool in the spindle first');
        });

        it('overruled to "measure the old tool first": says who chose, and offers the way back', () => {
            const t = text({}, valid, 'full');
            expect(t.headline).toMatch(/first measures the tool in the spindle as the new reference. Then you fit T20/);
            expect(t.why).toMatch(/^You selected this/);
            expect(t.overruleLabel).toBe('Back to the default: use the reference');
        });

        it('no reference: the tool in the spindle first, no other way', () => {
            const t = text({}, NO_REFERENCE);
            expect(t.why).toMatch(/^There is no reference/);
            expect(t.overruleLabel).toBeNull();
        });

        it('resume, choice 1 with the tool measured first: says why, and does not say that Z zero was set by hand', () => {
            const t = text({ resumed: true, count: 1, resumeMode: 'reference-same' }, { ...valid, status: 'none', reference: null, lastProbe: null });
            expect(t.headline).toBe('gSender measures T20 as the reference.');
            expect(t.why).toBe('You selected this: the same tool is in the spindle, and Z zero did not change.');
            expect(t.zero).toEqual({ effect: 'unchanged', label: 'Z zero does not change' });
            expect(t.warning).toBe(false);
            expect(t.overruleLabel).toBeNull();
        });

        it('resume, choice 3: this tool as the new reference, Z zero not changed', () => {
            const t = text({ resumed: true, count: 1, resumeMode: 'reference' }, stale);
            expect(t.headline).toBe('gSender measures T20 as the new reference.');
            expect(t.why).toBe('You set Z zero with this tool.');
            expect(t.zero).toEqual({ effect: 'unchanged', label: 'Z zero does not change' });
            expect(t.overruleLabel).toBeNull();
        });

        it('resume, old reference accepted: the warning stays in the window', () => {
            const t = text({ resumed: true, count: 1, resumeMode: 'measure-old' }, stale);
            expect(t.zero.effect).toBe('goes-back');
            expect(t.warning).toBe(true);
            expect(t.overruleLabel).toBeNull();
        });

        it('resume, the reference changed after the dialog: a warning to stop if the tool is broken', () => {
            const t = text({ resumed: true, count: 1, resumeMode: 'measure' }, stale);
            expect(t.why).toMatch(/^WARNING: Z zero changed after you selected the tool option/);
            expect(t.why).toMatch(/stop the job/);
            expect(t.overruleLabel).toBe('Use the old reference');
        });

        it('first tool of a job: says which of upstream\'s two wizards runs', () => {
            const only = text({ count: 1 }, valid, 'reference');
            expect(only.headline).toMatch(/You do not fit a tool/);
            expect(only.why).toBe('First tool change of the job.');
            const full = text({ count: 1 }, valid, 'full');
            expect(full.headline).toMatch(/Then you fit T20/);
        });

        it('setting off with a stale reference: upstream uses it; the window says what that does', () => {
            const t = text({ guard: false }, stale);
            expect(t.why).toMatch(/^WARNING: Z zero changed after the last probe/);
            expect(t.zero.effect).toBe('goes-back');
        });
    });

    it('STE: no sentence above 25 words, in every state and decision', () => {
        const snaps: ReferenceSnapshot[] = [
            valid,
            stale,
            NO_REFERENCE,
            { ...valid, watching: false },
            { ...valid, lastProbe: { kind: 'measured', tool: '20', at: at(14, 45) } },
            { ...stale, stale: { kind: 'wcs', at: at(14, 41), deltaZ: 3, from: 'G54', to: 'G55' } },
            { ...stale, stale: { kind: 'program', at: at(14, 42), deltaZ: 3 } },
        ];
        const texts: string[] = [];
        snaps.forEach((s) => {
            texts.push(referenceHeadline(s, NOW), referenceEffect(s, NOW));
            [1, 2].forEach((count) => {
                [true, false].forEach((resumed) => {
                    [true, false].forEach((guard) => {
                        ([null, 'measure', 'measure-old', 'full', 'reference'] as const).forEach((resumeMode) => {
                            const d = decideFixedSensor({ count, reference: s, resumed, resumeMode: resumed ? resumeMode : null, guard });
                            const variants: WizardVariant[] = d.variant === 'first-tool' ? ['full', 'reference'] : [d.variant, ...(d.overrule ? [d.overrule] : [])];
                            variants.forEach((v) => {
                                const t = decisionText(d, v, s, 'T20', NOW);
                                texts.push(t.headline, t.why, t.zero.label, t.overruleLabel ?? '');
                            });
                        });
                    });
                });
            });
        });
        const kinds: HistoryEntry[] = [
            { kind: 'reference', at: 1, tool: '45', zeroShift: 0.12 },
            { kind: 'reference', at: 1, tool: '45', zeroShift: 0.001 },
            { kind: 'measured', at: 1, tool: '20' },
            { kind: 'measured', at: 1, tool: '20', oldReference: true },
            { kind: 'zero', at: 1 },
            { kind: 'zero', at: 1, restored: true },
            { kind: 'wcs', at: 1, from: 'G54', to: 'G55', restored: true },
            { kind: 'program', at: 1, restored: true },
        ];
        kinds.forEach((k) => texts.push(historyLine(k)));
        const tooLong = [...new Set(texts)].filter((t) => t && longest(t) > 25);
        expect(tooLong).toEqual([]);
    });
});
