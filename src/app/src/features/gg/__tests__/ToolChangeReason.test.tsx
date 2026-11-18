/*
 * GGSender: in the tool change window, what the tool change does with the
 * tool sensor reference, why, and the overrule. Drives the real wizard
 * (provider, window, steps) with the real upstream wizards.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import store from 'app/store';

const mockCommands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: {
        command: (...args: any[]) => mockCommands.push(args),
        addListener: () => {},
        removeListener: () => {},
    },
}));
const mockConfirms: any[] = [];
jest.mock('app/components/ConfirmationDialog/ConfirmationDialogLib', () => ({
    Confirm: (opts: any) => mockConfirms.push(opts),
}));
jest.mock('app/lib/toaster/ToasterLib', () => ({ Toaster: { clear: jest.fn(), pop: jest.fn() }, TOASTER_INFO: 'info' }));

// eslint-disable-next-line import/first
import { WizardProvider } from 'app/features/Helper/context';
// eslint-disable-next-line import/first
import HelperWrapper from 'app/features/Helper/HelperWrapper';
// eslint-disable-next-line import/first
import { FIXED_SENSOR_TITLE, chooseFixedSensorWizard } from '../toolChangeFlow';
// eslint-disable-next-line import/first
import { REFERENCE_GUARD_KEY, setReference } from 'app/lib/gg/probeStore';

const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
};
const VALID: Record<string, any> = {
    status: 'valid',
    reference: { value: -15.002, tool: '45', at: at(14, 32), wcs: 'G54', wcoZ: -50 },
    lastProbe: { kind: 'reference', tool: '45', at: at(14, 32) },
    stale: null,
    watching: true,
    wcs: 'G54',
    history: [],
};
const STALE: Record<string, any> = { ...VALID, status: 'stale', stale: { kind: 'zero', at: at(14, 40), deltaZ: -8 } };
const NONE: Record<string, any> = { status: 'none', reference: null, lastProbe: null, stale: null, watching: true, wcs: 'G54', history: [] };

const renderWizard = () =>
    render(
        <Provider
            store={configureStore({
                reducer: () =>
                    ({
                        controller: { state: { status: { activeState: 'Idle' }, parserstate: { modal: { tool: '20' } } }, settings: { settings: { $132: '80' } } },
                        helper: { wizardActive: true, infoHelperActive: false },
                        preferences: { accessibility: {} },
                    }) as any,
            })}
        >
            <WizardProvider>
                <HelperWrapper />
            </WizardProvider>
        </Provider>,
    );

/** What the controller saga does at an M6. */
const toolChange = async (context: Record<string, any>) => {
    const gg = await chooseFixedSensorWizard({ option: 'Fixed Tool Sensor', tool: 'T20', line: 40, ...context }, '');
    await act(async () => {
        pubsub.publishSync('wizard:load', { context: gg.context, comment: '', title: FIXED_SENSOR_TITLE, instructions: gg.instructions });
    });
    return gg;
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: HTMLElement) => {
    await act(async () => {
        fireEvent.click(el);
        await tick(); // the wizard reloads on a published message
    });
};
const banner = () => screen.getByTestId('gg-toolchange-reason');
const wizardSaid = () => mockCommands.filter(([c]) => c === 'gg:probe:wizard').map(([, w]) => w);

describe('GGSender: the reference in the tool change window', () => {
    beforeEach(() => {
        mockCommands.length = 0;
        mockConfirms.length = 0;
        setReference(null);
        store.set(REFERENCE_GUARD_KEY, true);
        store.set('workspace.toolChange.firstToolBehaviour', 'Always probe length only');
        store.set('workspace.toolChange.moveToManualPosition', false);
        store.set('workspace.toolChangePosition', { x: -10, y: -10, z: -20 });
    });

    it('valid reference: measures the new tool against it, says so, and tells the server', async () => {
        renderWizard();
        await toolChange({ count: 2, ggReference: VALID, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('measure');
        expect(screen.getByTestId('gg-toolchange-reason-headline')).toHaveTextContent('gSender measures T20 against the reference (T45, 14:32).');
        expect(screen.getByTestId('gg-toolchange-zero')).toHaveTextContent('Z zero stays on the part');
        expect(screen.getByText('Probe Changed Tool')).toBeInTheDocument();
        expect(screen.queryByText('Probe Initial Tool')).toBeNull();
        expect(wizardSaid()).toEqual([{ variant: 'measure', target: 'T20' }]);
    });

    it('Z zero changed after the last probe: the tool in the spindle first, with the cause; the overrule uses the old reference and can be undone', async () => {
        renderWizard();
        await toolChange({ count: 2, ggReference: STALE, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('full');
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('Z zero changed at 14:40, after the last probe (T45, 14:32).');
        expect(screen.getByText('Probe Initial Tool')).toBeInTheDocument();
        // overrule
        const button = screen.getByTestId('gg-toolchange-overrule');
        expect(button).toHaveTextContent('Use the old reference');
        await click(button);
        expect(banner().getAttribute('data-variant')).toBe('measure');
        expect(screen.queryByText('Probe Initial Tool')).toBeNull();
        expect(screen.getByText('Probe Changed Tool')).toBeInTheDocument();
        expect(screen.getByTestId('gg-toolchange-zero')).toHaveTextContent('Z zero goes back to 14:32');
        expect(screen.getByTestId('gg-toolchange-zero').getAttribute('data-effect')).toBe('goes-back');
        expect(wizardSaid()).toEqual([
            { variant: 'full', target: 'T20' },
            { variant: 'measure', target: 'T20' },
        ]);
        // and back
        expect(screen.getByTestId('gg-toolchange-overrule')).toHaveTextContent('Back to the default: measure the tool in the spindle first');
        await click(screen.getByTestId('gg-toolchange-overrule'));
        expect(banner().getAttribute('data-variant')).toBe('full');
        expect(screen.getByText('Probe Initial Tool')).toBeInTheDocument();
        // no machine code was sent by switching
        expect(mockCommands.filter(([c]) => c === 'gcode')).toEqual([]);
    });

    it('the overrule is gone once the first step has run', async () => {
        renderWizard();
        await toolChange({ count: 2, ggReference: STALE, ggResume: { resumed: false, mode: null } });
        expect(screen.getByTestId('gg-toolchange-overrule')).toBeInTheDocument();
        await click(screen.getByTestId('wizard-run'));
        // running: no switch while the machine probes
        expect(screen.queryByTestId('gg-toolchange-overrule')).toBeNull();
        expect(mockCommands.some(([c, lines]) => c === 'gcode' && String(lines).includes('%global.toolchange.TOOL_OFFSET=posz'))).toBe(true);
    });

    it('a resumed job with "First tool" = probe length only: the next M6 still asks for the new tool', async () => {
        renderWizard();
        // count 1: upstream would only measure the tool in the spindle and carry on
        await toolChange({ count: 1, ggReference: VALID, ggResume: { resumed: true, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('measure');
        expect(screen.getByText('Probe Changed Tool')).toBeInTheDocument();
        expect(screen.getByText('Install New Tool')).toBeInTheDocument();
        expect(mockConfirms).toEqual([]);
    });

    it('a resumed job with "First tool" = prompt: no prompt, the new tool is asked for', async () => {
        store.set('workspace.toolChange.firstToolBehaviour', 'Prompt for first tool');
        renderWizard();
        await toolChange({ count: 1, ggReference: NONE, ggResume: { resumed: true, mode: null } });
        expect(mockConfirms).toEqual([]);
        expect(banner().getAttribute('data-variant')).toBe('full');
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('There is no reference.');
        expect(screen.queryByTestId('gg-toolchange-overrule')).toBeNull();
    });

    it('resume choice 3: only measures this tool as the new reference; Z zero is not written', async () => {
        renderWizard();
        const gg = await toolChange({ count: 1, tool: 'T45', ggReference: STALE, ggResume: { resumed: true, mode: 'reference' } });
        expect(banner().getAttribute('data-variant')).toBe('reference');
        expect(screen.getByTestId('gg-toolchange-reason-headline')).toHaveTextContent('gSender measures T45 as the new reference.');
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('You set Z zero with this tool.');
        expect(screen.getByTestId('gg-toolchange-zero')).toHaveTextContent('Z zero does not change');
        expect(screen.queryByTestId('gg-toolchange-overrule')).toBeNull();
        expect(wizardSaid()).toEqual([{ variant: 'reference', target: 'T45' }]);
        // the wizard's code: sets the reference, never writes the work offset
        const lines = gg.instructions.steps.flatMap((s: any) => s.substeps.flatMap((ss: any) => ss.actions.flatMap((a: any) => a.gcodeLines)));
        expect(lines).toContain('%global.toolchange.TOOL_OFFSET=posz');
        expect(lines.some((l: string) => /G10/i.test(l))).toBe(false);
        expect(lines.some((l: string) => /G92/i.test(l))).toBe(false);
    });

    it('the wizards: "measure" writes Z zero from the reference and never sets the reference; "full" sets it first', async () => {
        renderWizard();
        const codes = (gg: any) =>
            gg.instructions.steps.flatMap((s: any) => s.substeps.flatMap((ss: any) => ss.actions.flatMap((a: any) => a.gcodeLines))) as string[];
        const measure = codes(await toolChange({ count: 2, ggReference: VALID, ggResume: { resumed: false, mode: null } }));
        expect(measure).toContain('G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]');
        expect(measure).not.toContain('%global.toolchange.TOOL_OFFSET=posz');
        const full = codes(await toolChange({ count: 2, ggReference: STALE, ggResume: { resumed: false, mode: null } }));
        expect(full.indexOf('%global.toolchange.TOOL_OFFSET=posz')).toBeGreaterThanOrEqual(0);
        expect(full.indexOf('G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]')).toBeGreaterThan(full.indexOf('%global.toolchange.TOOL_OFFSET=posz'));
    });

    it('first tool of a job from the top: upstream\'s setting and prompt, and the window says which wizard runs', async () => {
        renderWizard();
        await toolChange({ count: 1, ggReference: NONE, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('reference'); // "Always probe length only"
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('First tool change of the job.');
        store.set('workspace.toolChange.firstToolBehaviour', 'Prompt for first tool');
        const pending = chooseFixedSensorWizard({ option: 'Fixed Tool Sensor', tool: 'T20', count: 1, ggReference: NONE, ggResume: { resumed: false, mode: null } }, '');
        expect(mockConfirms).toHaveLength(1);
        mockConfirms[0].onConfirm(); // "Run Full Toolchange Routine"
        expect((await pending).context.ggDecision.active).toBe('full');
    });

    it('setting off: a later tool change uses the reference by count, as upstream', async () => {
        store.set(REFERENCE_GUARD_KEY, false);
        renderWizard();
        await toolChange({ count: 2, ggReference: STALE, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('measure');
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('WARNING: Z zero changed after the last probe.');
    });

    it('Z zero set from the pendant while the window is open, nothing run yet: the window decides again by itself', async () => {
        renderWizard();
        await toolChange({ count: 2, ggReference: VALID, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('measure');
        await act(async () => {
            setReference(STALE); // the server reports the change
            await tick();
        });
        expect(banner().getAttribute('data-variant')).toBe('full');
        expect(banner().getAttribute('data-reason')).toBe('stale');
        expect(screen.getByText('Probe Initial Tool')).toBeInTheDocument();
        expect(screen.getByTestId('gg-toolchange-reason-why')).toHaveTextContent('Z zero changed at 14:40');
        expect(wizardSaid().pop()).toEqual({ variant: 'full', target: 'T20' });
        // and back when the offset is put back
        await act(async () => {
            setReference(VALID);
            await tick();
        });
        expect(banner().getAttribute('data-variant')).toBe('measure');
        expect(mockCommands.filter(([c]) => c === 'gcode')).toEqual([]);
    });

    it('resume choice 3 and the first tool of a job do not change wizard when the reference changes', async () => {
        renderWizard();
        await toolChange({ count: 1, tool: 'T45', ggReference: STALE, ggResume: { resumed: true, mode: 'reference' } });
        await act(async () => {
            setReference(VALID);
            await tick();
        });
        expect(banner().getAttribute('data-variant')).toBe('reference');
        expect(banner().getAttribute('data-reason')).toBe('resume-reference');
    });

    it('Z zero changed after the first step ran: the wizard is not swapped, and a warning says that the next probe puts Z zero back', async () => {
        renderWizard();
        await toolChange({ count: 2, ggReference: STALE, ggResume: { resumed: false, mode: null } });
        expect(banner().getAttribute('data-variant')).toBe('full');
        await click(screen.getByTestId('wizard-run')); // the tool in the spindle is being probed
        await act(async () => {
            // the probe made a new reference; then Z zero is set from the pendant
            setReference({ ...VALID, reference: { ...VALID.reference, at: at(14, 50) } });
            setReference({ ...STALE, reference: { ...VALID.reference, at: at(14, 50) }, stale: { kind: 'zero', at: at(14, 52), deltaZ: 1 } });
            await tick();
        });
        expect(banner().getAttribute('data-variant')).toBe('full');
        expect(screen.getByTestId('gg-toolchange-late-change')).toHaveTextContent(
            'WARNING: Z zero changed at 14:52, after this tool change started. The next probe puts Z zero back to its position of 14:50. To keep the new Z zero, stop the job.',
        );
    });

    it('another tool change strategy has no banner', async () => {
        renderWizard();
        await act(async () => {
            pubsub.publishSync('wizard:load', {
                context: { option: 'Standard Re-zero', tool: 'T20' },
                comment: '',
                title: 'Standard Re-zero Tool Change',
                instructions: { steps: [{ title: 'A', substeps: [{ title: 'B', description: 'c', actions: [] }] }] },
            });
        });
        expect(screen.queryByTestId('gg-toolchange-reason')).toBeNull();
    });
});
