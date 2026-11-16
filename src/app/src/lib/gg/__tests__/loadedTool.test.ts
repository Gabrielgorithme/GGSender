import {
    POLICY_ALWAYS_CHANGE,
    POLICY_ASK,
    POLICY_CONTINUE,
    createTracker,
    decideSameTool,
    effectiveToolChangeCount,
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

describe('GGSender: same tool decision', () => {
    it('runs the change when the tools differ or either is unknown', () => {
        expect(decideSameTool({ requested: 'T5', loaded: '4', policy: POLICY_CONTINUE })).toBe('run');
        expect(decideSameTool({ requested: 'T5', loaded: null, policy: POLICY_CONTINUE })).toBe('run');
        expect(decideSameTool({ requested: null, loaded: '5', policy: POLICY_CONTINUE })).toBe('run');
        expect(decideSameTool({ requested: null, loaded: null, policy: POLICY_CONTINUE })).toBe('run');
    });
    it('follows the policy when the tool is already loaded', () => {
        expect(decideSameTool({ requested: 'T5', loaded: '5', policy: POLICY_ASK })).toBe('ask');
        expect(decideSameTool({ requested: 'T5', loaded: '5', policy: POLICY_CONTINUE })).toBe('skip');
        expect(decideSameTool({ requested: 'T5', loaded: '5', policy: POLICY_ALWAYS_CHANGE })).toBe('run');
    });
    it('asks when the policy is missing or unknown', () => {
        expect(decideSameTool({ requested: 'T5', loaded: '5', policy: undefined })).toBe('ask');
        expect(decideSameTool({ requested: 'T5', loaded: '5', policy: 'whatever' })).toBe('ask');
    });
});

describe('GGSender: length reference across a job', () => {
    it('keeps upstream counts when the first change ran normally', () => {
        expect(effectiveToolChangeCount(1, false)).toBe(1);
        expect(effectiveToolChangeCount(2, true)).toBe(2);
        expect(effectiveToolChangeCount(5, true)).toBe(5);
    });
    it('treats the next change as a first one when no reference was taken', () => {
        expect(effectiveToolChangeCount(2, false)).toBe(1);
        expect(effectiveToolChangeCount(3, false)).toBe(1);
    });

    it('first M6 skipped, second M6 changes tool: the old tool gets probed', () => {
        const t = createTracker();
        // M6 #1: same tool, skipped (no wizard started)
        trackerOnRequest(t, 1);
        expect(trackerOnComplete(t)).toBeUndefined();
        expect(t.referenceTaken).toBe(false);
        // M6 #2: different tool
        trackerOnRequest(t, 2);
        expect(effectiveToolChangeCount(2, t.referenceTaken)).toBe(1);
        trackerOnStart(t, 'T7', true);
        expect(trackerOnComplete(t)).toBe('7');
        expect(t.referenceTaken).toBe(true);
        // M6 #3: reference exists now
        trackerOnRequest(t, 3);
        expect(effectiveToolChangeCount(3, t.referenceTaken)).toBe(3);
    });

    it('a new job forgets the previous job\'s reference', () => {
        const t = createTracker();
        trackerOnRequest(t, 1);
        trackerOnStart(t, 'T1', true);
        trackerOnComplete(t);
        expect(t.referenceTaken).toBe(true);
        trackerOnRequest(t, 1);
        expect(t.referenceTaken).toBe(false);
    });

    it('a plain pause records the tool but takes no reference', () => {
        const t = createTracker();
        trackerOnRequest(t, 1);
        trackerOnStart(t, 'T3', false);
        expect(trackerOnComplete(t)).toBe('3');
        expect(t.referenceTaken).toBe(false);
    });

    it('a change without a tool number leaves the recorded tool alone', () => {
        const t = createTracker();
        trackerOnRequest(t, 1);
        trackerOnStart(t, null, true);
        expect(trackerOnComplete(t)).toBeUndefined();
        expect(t.referenceTaken).toBe(true);
    });

    it('stopping the job during a change makes the loaded tool unknown', () => {
        const t = createTracker();
        trackerOnRequest(t, 1);
        trackerOnStart(t, 'T3', true);
        expect(trackerOnAbort(t)).toBe(true);
        // and only once
        expect(trackerOnAbort(t)).toBe(false);
    });

    it('stopping the job outside a change keeps the loaded tool', () => {
        const t = createTracker();
        expect(trackerOnAbort(t)).toBe(false);
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
