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

    const request = async (tool: string, count: number) => {
        await handlers['gcode:toolChange']({ option: 'Fixed Tool Sensor', count, tool, line: 12 }, '');
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
