/*
 * GGSender: an M6 always runs its tool change, even for the tool recorded as
 * loaded (the 0.3.0-0.5.0 "already loaded" prompt is gone). The loaded tool
 * is still recorded when the change finishes.
 * Drives the real 'gcode:toolChange' listener of the controller saga.
 */
import pubsub from 'pubsub-js';
import store from 'app/store';
import { getLoadedTool, setLoadedTool } from 'app/lib/gg/loadedTool';

const handlers: Record<string, (...args: any[]) => any> = {};
const commands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: {
        addListener: (event: string, fn: (...args: any[]) => any) => {
            handlers[event] = fn;
        },
        command: (...args: any[]) => commands.push(args),
        settings: {},
        state: {},
        type: 'Grbl',
    },
}));
const confirms: any[] = [];
jest.mock('app/components/ConfirmationDialog/ConfirmationDialogLib', () => ({
    Confirm: (opts: any) => confirms.push(opts),
}));

// eslint-disable-next-line import/first
import { initialize } from '../controllerSagas';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GGSender: tool change request', () => {
    let wizards: any[] = [];
    let token: string;

    beforeAll(() => {
        initialize().next();
    });

    beforeEach(() => {
        wizards = [];
        confirms.length = 0;
        commands.length = 0;
        token = pubsub.subscribe('wizard:load', (_m: string, data: any) => wizards.push(data));
        store.set('workspace.toolChangeOption', 'Fixed Tool Sensor');
        store.set('workspace.toolChange.firstToolBehaviour', 'Always run full wizard');
        store.set('workspace.toolChange.skipDialog', false);
    });

    afterEach(() => {
        pubsub.unsubscribe(token);
    });

    // what the server adds (lib/gg/probeHistory.js, resumeSplice.js)
    const VALID: Record<string, any> = {
        status: 'valid',
        reference: { value: -15, tool: '45', at: 1000, wcs: 'G54', wcoZ: -50 },
        lastProbe: { kind: 'reference', tool: '45', at: 1000 },
        stale: null,
        watching: true,
        wcs: 'G54',
        history: [],
    };
    const NONE: Record<string, any> = { status: 'none', reference: null, lastProbe: null, stale: null, watching: true, wcs: 'G54', history: [] };

    const request = async (tool: string, count: number, extra: Record<string, unknown> = {}) => {
        await handlers['gcode:toolChange'](
            {
                option: 'Fixed Tool Sensor',
                count,
                tool,
                line: 12,
                // a first M6 has no reference yet; a later one has the one the first left
                ggReference: count > 1 ? VALID : NONE,
                ggResume: { resumed: false, mode: null },
                ...extra,
            },
            '',
        );
        await tick();
        await tick();
    };

    it('T45 loaded, program asks for T45: the wizard opens, no prompt, nothing skipped', async () => {
        setLoadedTool('T45');
        await request('T45', 1);
        expect(confirms).toEqual([]);
        expect(wizards).toHaveLength(1);
        expect(wizards[0].title).toBe('Fixed Tool Sensor Tool Change');
        // the job is not resumed behind the user's back
        expect(commands.some(([cmd, lines]) => cmd === 'gcode' && String(lines).includes('%toolchange_complete'))).toBe(false);
    });

    it('first M6 of a job keeps upstream\'s "probe the initial tool" step', async () => {
        setLoadedTool('T45');
        await request('T45', 1);
        const steps = wizards[0].instructions.steps.map((s: any) => s.title);
        expect(steps[0]).toBe('Starting Off');
        // a later M6 of the same job does not have it
        wizards = [];
        await request('T40', 2);
        expect(wizards[0].instructions.steps.map((s: any) => s.title)).not.toContain('Starting Off');
    });

    it('the wizard gets the decision and the server is told which wizard runs', async () => {
        await request('T40', 2);
        expect(wizards[0].context.ggDecision).toMatchObject({ active: 'measure', decision: { reason: 'valid', overrule: 'full' } });
        expect(wizards[0].context.tool).toBe('T40');
        expect(commands).toContainEqual(['gg:probe:wizard', { variant: 'measure', target: 'T40' }]);
    });

    it('a resumed job: its M6 is never taken for the first tool, whatever the "First tool" setting', async () => {
        for (const behaviour of ['Always probe length only', 'Prompt for first tool', 'Always run full wizard']) {
            store.set('workspace.toolChange.firstToolBehaviour', behaviour);
            wizards = [];
            await request('T40', 1, { ggReference: VALID, ggResume: { resumed: true, mode: null } });
            expect(confirms).toEqual([]);
            const steps = wizards[0].instructions.steps.map((s: any) => s.title);
            // the new tool is asked for and measured; the tool in the spindle is not taken for it
            expect(steps).toEqual(['Prepare New Tool', 'Resume Job']);
        }
    });

    it('a context without the fork\'s fields (older server) behaves as upstream', async () => {
        await handlers['gcode:toolChange']({ option: 'Fixed Tool Sensor', count: 1, tool: 'T45', line: 12 }, '');
        await tick();
        expect(wizards[0].instructions.steps[0].title).toBe('Starting Off');
    });

    it('the reference state from the server reaches the interface store', () => {
        // eslint-disable-next-line global-require
        const { getReference } = require('app/lib/gg/probeStore');
        handlers['gg:probe:state'](VALID);
        expect(getReference().status).toBe('valid');
        handlers['serialport:close']({}, 0);
        expect(getReference().status).toBe('none');
        expect(getReference().live).toBe(false);
    });

    it('the tool is recorded as loaded once the change is complete', async () => {
        setLoadedTool('T45');
        await request('T40', 2);
        expect(getLoadedTool().tool).toBe('45');
        handlers['gg:toolchange:complete']();
        expect(getLoadedTool().tool).toBe('40');
    });

    it('a job stopped during the change makes the loaded tool unknown', async () => {
        setLoadedTool('T45');
        await request('T40', 2);
        handlers['workflow:state']('idle');
        expect(getLoadedTool().tool).toBeNull();
    });
});
