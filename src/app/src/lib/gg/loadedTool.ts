/*
 * GGSender addition (not part of upstream gSender).
 *
 * What gSender believes is in the spindle.
 *
 * Upstream keeps no memory of the loaded tool: nothing on screen says which
 * tool the last tool change left in the spindle. Here the tool number is
 * recorded when a tool change finishes, saved with the settings (so it
 * survives a restart), shown in the top bar, and can be corrected by hand.
 *
 * It is only recorded and shown. Every M6 runs the tool change as upstream
 * does, whatever is recorded. (0.3.0 to 0.5.0 offered to skip an M6 asking
 * for the recorded tool; removed in 0.5.1 at the owner's request.)
 */
import store from 'app/store';

export const LOADED_TOOL_KEY = 'workspace.gg.loadedTool';

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

/** "today at 14:05" or "16/11/2026 at 14:05" */
export const formatSince = (since: number | null): string => {
    if (!since) {
        return '';
    }
    const date = new Date(since);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
    return sameDay ? `today at ${time}` : `${date.toLocaleDateString()} at ${time}`;
};

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

// ---- the tool change under way (not saved) -----------------------------------

export interface ToolChangeTracker {
    pending: { tool: string | null } | null;
}

export const createTracker = (): ToolChangeTracker => ({
    pending: null,
});

/** A tool change request arrived. */
export const trackerOnRequest = (tracker: ToolChangeTracker) => {
    tracker.pending = null;
};

/** A wizard was started for this tool. */
export const trackerOnStart = (tracker: ToolChangeTracker, tool: unknown) => {
    tracker.pending = { tool: normalizeTool(tool) };
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
