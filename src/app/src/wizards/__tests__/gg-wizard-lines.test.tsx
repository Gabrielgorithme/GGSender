/*
 * GGSender: the simulated-board test of the tool sensor reference
 * (src/server/controllers/Grbl/__tests__/gg-stream-sim.test.js) sends the
 * wizards' G-code from a copy, src/server/lib/gg/__fixtures__/wizardLines.js. This checks the copy
 * against the real wizards, line for line, so the simulation runs what the
 * app sends.
 */
import store from 'app/store';
import controller from 'app/lib/controller';
import { wizardFor } from 'app/features/gg/toolChangeFlow';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const copy = require('../../../../server/lib/gg/__fixtures__/wizardLines');

const actions = (wizard: any): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    wizard.steps.forEach((step: any) =>
        step.substeps.forEach((substep: any) =>
            (substep.actions || []).forEach((a: any) => {
                out[a.label] = a.gcodeLines;
            }),
        ),
    );
    return out;
};

const startLines = (wizard: any): string[] => {
    const spy = jest.spyOn(controller, 'command').mockImplementation(() => undefined as any);
    wizard.onStart();
    const sent = spy.mock.calls.flatMap((call) => call[1] as string[]);
    spy.mockRestore();
    return sent;
};

describe('GGSender: the wizard G-code used by the simulated-board test', () => {
    beforeEach(() => {
        store.set('workspace.toolChange.safeZ', -0.1);
        store.set('workspace.toolChange.returnToStartZ', false);
        store.set('workspace.toolChange.moveToManualPosition', false);
        store.set('workspace.toolChangePosition', { x: -10, y: -20, z: -30 });
    });

    it('"measure only" (resume choice 3, upstream\'s probe length only)', () => {
        const a = actions(wizardFor('reference'));
        expect(Object.keys(a)).toEqual(['Probe Tool Length', 'Resume']);
        expect(a['Probe Tool Length']).toEqual(copy.PROBE_AS_REFERENCE);
        expect(a.Resume).toEqual(copy.RESUME);
    });

    it('"full": the tool in the spindle as the reference, then the new tool against it', () => {
        const a = actions(wizardFor('full'));
        expect(Object.keys(a)).toEqual(['Probe Initial Tool', 'Probe Changed Tool', 'Resume Cutting']);
        expect(a['Probe Initial Tool']).toEqual(copy.PROBE_AS_REFERENCE);
        expect(a['Probe Changed Tool']).toEqual(copy.PROBE_AGAINST_REFERENCE);
        expect(a['Resume Cutting']).toEqual(copy.RESUME);
    });

    it('"measure": the new tool against the reference, nothing else', () => {
        const a = actions(wizardFor('measure'));
        expect(Object.keys(a)).toEqual(['Probe Changed Tool', 'Resume Cutting']);
        expect(a['Probe Changed Tool']).toEqual(copy.PROBE_AGAINST_REFERENCE);
    });

    it('the start code: the same lines but for the values of the settings', () => {
        const strip = (lines: string[]) => lines.map((l) => l.replace(/=(-?[\d.]+|NaN)$/, '=#'));
        expect(strip(startLines(wizardFor('measure')))).toEqual(
            strip(copy.startLines()).flatMap((l: string) =>
                // the tool change wizard also stores the manual position, which the copy leaves out
                l === '%global.toolchange.PROBE_POS_Z=#'
                    ? [l, '%global.toolchange.MANUAL_POS_X=#', '%global.toolchange.MANUAL_POS_Y=#', '%global.toolchange.MANUAL_POS_Z=#']
                    : [l],
            ),
        );
        expect(strip(startLines(wizardFor('reference')))).toEqual(strip(copy.startLines({ comment: 'Tool probe initiated' })));
    });

    it('the two wizards that can be switched have the same start code', () => {
        expect(startLines(wizardFor('full'))).toEqual(startLines(wizardFor('measure')));
    });
});
