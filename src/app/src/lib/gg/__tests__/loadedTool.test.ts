import {
    createTracker,
    formatSince,
    getLoadedTool,
    normalizeTool,
    setLoadedTool,
    trackerOnAbort,
    trackerOnComplete,
    trackerOnRequest,
    trackerOnStart,
} from '../loadedTool';

describe('GGSender: tool numbers', () => {
    it('normalizes the usual spellings', () => {
        expect(normalizeTool('T5')).toBe('5');
        expect(normalizeTool('t05')).toBe('5');
        expect(normalizeTool(5)).toBe('5');
        expect(normalizeTool('405')).toBe('405');
        expect(normalizeTool('T0')).toBe('0');
    });
    it('rejects what is not a tool number', () => {
        expect(normalizeTool(null)).toBeNull();
        expect(normalizeTool(undefined)).toBeNull();
        expect(normalizeTool('')).toBeNull();
        expect(normalizeTool('-')).toBeNull();
        expect(normalizeTool('T')).toBeNull();
        expect(normalizeTool('5.5')).toBeNull();
        expect(normalizeTool('-3')).toBeNull();
    });
});

describe('GGSender: tool change bookkeeping', () => {
    it('records the tool once the change completes', () => {
        const t = createTracker();
        trackerOnRequest(t);
        trackerOnStart(t, 'T7');
        expect(trackerOnComplete(t)).toBe('7');
        // and only once
        expect(trackerOnComplete(t)).toBeUndefined();
    });

    it('a completion without a started change records nothing', () => {
        const t = createTracker();
        trackerOnRequest(t);
        expect(trackerOnComplete(t)).toBeUndefined();
    });

    it('a new request forgets a change that never completed', () => {
        const t = createTracker();
        trackerOnStart(t, 'T3');
        trackerOnRequest(t);
        expect(trackerOnComplete(t)).toBeUndefined();
    });

    it('a change without a tool number leaves the recorded tool alone', () => {
        const t = createTracker();
        trackerOnRequest(t);
        trackerOnStart(t, null);
        expect(trackerOnComplete(t)).toBeUndefined();
    });

    it('stopping the job during a change makes the loaded tool unknown', () => {
        const t = createTracker();
        trackerOnRequest(t);
        trackerOnStart(t, 'T3');
        expect(trackerOnAbort(t)).toBe(true);
        // and only once
        expect(trackerOnAbort(t)).toBe(false);
    });

    it('stopping the job outside a change keeps the loaded tool', () => {
        const t = createTracker();
        expect(trackerOnAbort(t)).toBe(false);
    });
});

describe('GGSender: time the tool was recorded', () => {
    it('today shows only the time; other days the date too; none is empty', () => {
        const now = new Date();
        now.setHours(9, 5, 0, 0);
        expect(formatSince(now.getTime())).toMatch(/^today at /);
        expect(formatSince(new Date(2020, 0, 2, 9, 5).getTime())).not.toMatch(/^today/);
        expect(formatSince(null)).toBe('');
    });
});

describe('GGSender: stored loaded tool', () => {
    it('starts unknown', () => {
        setLoadedTool(null);
        expect(getLoadedTool()).toEqual({ tool: null, since: null });
    });
    it('stores and reads a tool with its time', () => {
        setLoadedTool('T12', 1234);
        expect(getLoadedTool()).toEqual({ tool: '12', since: 1234 });
    });
    it('can be set back to unknown', () => {
        setLoadedTool('T12', 1234);
        setLoadedTool(null);
        expect(getLoadedTool()).toEqual({ tool: null, since: null });
    });
});
