// GGSender: the tool sensor reference as the interface holds it (lib/gg/probeStore.ts)
import store from 'app/store';

const mockCommands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: { command: (...args: any[]) => mockCommands.push(args) },
}));

// eslint-disable-next-line import/first
import { LOADED_TOOL_KEY, setLoadedTool } from '../loadedTool';
// eslint-disable-next-line import/first
import { NO_REFERENCE, getReference, normalizeReference, pushLoadedTool, setReference, watchLoadedTool } from '../probeStore';

describe('GGSender: reference store', () => {
    it('reads what the server sends', () => {
        const s = normalizeReference({
            status: 'stale',
            reference: { value: -15.002, tool: '45', at: 1000, wcs: 'G54', wcoZ: -50 },
            lastProbe: { kind: 'measured', tool: '20', at: 2000 },
            stale: { kind: 'zero', at: 3000, deltaZ: -8.1 },
            watching: true,
            wcs: 'G54',
            history: [{ kind: 'reference', at: 1000, tool: '45', value: -15.002 }, { nonsense: true }, null],
        });
        expect(s.status).toBe('stale');
        expect(s.reference).toEqual({ value: -15.002, tool: '45', at: 1000, wcs: 'G54' });
        expect(s.lastProbe).toEqual({ kind: 'measured', tool: '20', at: 2000 });
        expect(s.stale).toMatchObject({ kind: 'zero', at: 3000, deltaZ: -8.1 });
        expect(s.history).toHaveLength(1);
        expect(s.live).toBe(true);
    });

    it('never calls a reference valid when there is none in the message', () => {
        expect(normalizeReference({ status: 'valid' }).status).toBe('none');
        expect(normalizeReference({ status: 'valid', reference: { value: 'x', at: 1 } }).status).toBe('none');
        expect(normalizeReference({ status: 'valid', reference: { value: 1 } }).status).toBe('none');
        expect(normalizeReference({ status: 'whatever', reference: { value: 1, at: 1 } }).status).toBe('none');
        expect(normalizeReference(undefined).status).toBe('none');
        expect(normalizeReference('junk').status).toBe('none');
        // stale details only with the stale state
        expect(normalizeReference({ status: 'valid', reference: { value: 1, at: 1 }, stale: { kind: 'zero', at: 2 } }).stale).toBeNull();
    });

    it('a disconnection clears it', () => {
        setReference({ status: 'valid', reference: { value: 1, at: 1, tool: '5' } });
        expect(getReference().status).toBe('valid');
        expect(getReference().live).toBe(true);
        setReference(null);
        expect(getReference()).toBe(NO_REFERENCE);
        expect(getReference().live).toBe(false);
    });

    it('tells the server the recorded tool, on connection and when it changes', () => {
        mockCommands.length = 0;
        store.set(LOADED_TOOL_KEY, { tool: '45', since: 1 });
        pushLoadedTool(true);
        expect(mockCommands).toEqual([['gg:probe:loaded', '45']]);
        pushLoadedTool(); // nothing new
        expect(mockCommands).toHaveLength(1);
        watchLoadedTool();
        setLoadedTool('T20');
        expect(mockCommands[mockCommands.length - 1]).toEqual(['gg:probe:loaded', '20']);
        const n = mockCommands.length;
        store.set('workspace.gg.somethingElse', 1); // another setting: nothing sent
        expect(mockCommands).toHaveLength(n);
        setLoadedTool(null);
        expect(mockCommands[mockCommands.length - 1]).toEqual(['gg:probe:loaded', null]);
    });
});
