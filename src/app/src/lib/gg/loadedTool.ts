/*
 * GGSender addition (not part of upstream gSender).
 *
 * What gSender believes is in the spindle, and what to do when a program asks
 * for that same tool.
 *
 * Upstream keeps no memory of the loaded tool: every M6 starts a tool change,
 * and nothing on screen says which tool the last one left in the spindle.
 * Here the tool number is recorded when a tool change finishes, saved with
 * the settings (so it survives a restart), shown in the top bar, and can be
 * corrected by hand.
 *
 * About the "reference" used by the tool length sensor strategies: on the
 * first tool change of a job gSender probes the tool that is in the spindle
 * and keeps that reading (global.toolchange.TOOL_OFFSET). Every later change
 * probes the new tool and shifts work Z so the reading matches. If the first
 * M6 of a job is skipped, that reading was never taken for this job, so the
 * next real tool change has to behave like a first one and probe the old
 * tool before swapping. effectiveToolChangeCount() does that.
 */
import store from 'app/store';

export const LOADED_TOOL_KEY = 'workspace.gg.loadedTool';
export const SAME_TOOL_POLICY_KEY = 'workspace.gg.sameToolPolicy';

export const POLICY_ASK = 'Ask';
export const POLICY_CONTINUE = 'Continue without asking';
export const POLICY_ALWAYS_CHANGE = 'Always run tool change';
export const SAME_TOOL_POLICIES = [
    POLICY_ASK,
    POLICY_CONTINUE,
    POLICY_ALWAYS_CHANGE,
];

export interface LoadedTool {
    tool: string | null; // tool number as text, null = unknown
    since: number | null; // ms timestamp of when it was recorded
}

/**
 * "T5", "t05", 5, "5" -> "5". Anything that is not a tool number -> null.
 * Tool 0 is a valid number in g-code ("no tool"), so it is kept.
 */
export const normalizeTool = (value: unknown): string | null => {
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value).trim().replace(/^t\s*/i, '');
    if (!/^\d+$/.test(text)) {
        return null;
    }
    return String(Number(text));
};

export type SameToolDecision = 'run' | 'ask' | 'skip';

/**
 * What to do with an M6.
 * 'run'  -> run the tool change as upstream would
 * 'ask'  -> the requested tool is the one recorded as loaded; ask the user
 * 'skip' -> same tool, and the user chose not to be asked
 */
export const decideSameTool = ({
    requested,
    loaded,
    policy,
}: {
    requested: unknown;
    loaded: unknown;
    policy: unknown;
}): SameToolDecision => {
    const want = normalizeTool(requested);
    const have = normalizeTool(loaded);
    if (want === null || have === null || want !== have) {
        return 'run';
    }
    if (policy === POLICY_ALWAYS_CHANGE) {
        return 'run';
    }
    if (policy === POLICY_CONTINUE) {
        return 'skip';
    }
    return 'ask';
};

/**
 * The count handed to the tool change wizards. 1 makes them include the
 * "probe the tool currently in the spindle" step. See the note at the top.
 */
export const effectiveToolChangeCount = (
    count: number,
    referenceTakenThisJob: boolean,
): number => (count > 1 && !referenceTakenThisJob ? 1 : count);

// ---- stored state -----------------------------------------------------------

export const getLoadedTool = (): LoadedTool => {
    const saved = store.get(LOADED_TOOL_KEY, null) || {};
    const tool = normalizeTool(saved.tool);
    return {
        tool,
        since: tool !== null && Number.isFinite(Number(saved.since))
            ? Number(saved.since)
            : null,
    };
};

export const setLoadedTool = (tool: unknown, now = Date.now()) => {
    const normalized = normalizeTool(tool);
    store.set(LOADED_TOOL_KEY, {
        tool: normalized,
        since: normalized === null ? null : now,
    });
};

export const getSameToolPolicy = (): string => {
    const policy = store.get(SAME_TOOL_POLICY_KEY, POLICY_ASK);
    return SAME_TOOL_POLICIES.includes(policy) ? policy : POLICY_ASK;
};

// ---- one job's tool change bookkeeping (not saved) ---------------------------

export interface ToolChangeTracker {
    referenceTaken: boolean; // has a probe set the length reference this job
    pending: { tool: string | null; probes: boolean } | null;
}

export const createTracker = (): ToolChangeTracker => ({
    referenceTaken: false,
    pending: null,
});

/** A tool change request arrived. count === 1 means a new job. */
export const trackerOnRequest = (tracker: ToolChangeTracker, count: number) => {
    if (count <= 1) {
        tracker.referenceTaken = false;
    }
    tracker.pending = null;
};

/** A wizard (or a plain pause) was started for this tool. */
export const trackerOnStart = (
    tracker: ToolChangeTracker,
    tool: unknown,
    probes: boolean,
) => {
    tracker.pending = { tool: normalizeTool(tool), probes };
};

/**
 * The tool change finished and the job resumes.
 * @returns the tool to record as loaded, or undefined to leave it as it is
 */
export const trackerOnComplete = (
    tracker: ToolChangeTracker,
): string | null | undefined => {
    const { pending } = tracker;
    tracker.pending = null;
    if (!pending) {
        return undefined;
    }
    if (pending.probes) {
        tracker.referenceTaken = true;
    }
    // A request without a tool number tells us nothing about what was fitted
    return pending.tool === null ? undefined : pending.tool;
};

/**
 * The job stopped while a tool change was under way: the old tool may or may
 * not have been taken out, so the loaded tool is no longer known.
 * @returns true if the loaded tool must be set to unknown
 */
export const trackerOnAbort = (tracker: ToolChangeTracker): boolean => {
    const wasPending = tracker.pending !== null;
    tracker.pending = null;
    return wasPending;
};
