/*
 * GGSender addition (not part of upstream gSender).
 *
 * Tool-change Z moves, driven by two settings instead of hard-coded values:
 *   workspace.toolChange.safeZ           machine Z (mm) used as the safe height
 *   workspace.toolChange.returnToStartZ  go back to the Z the job was at when
 *                                        the tool change started (upstream
 *                                        behaviour) or stay at the safe height
 *
 * The pure functions take their inputs as arguments so they can be unit
 * tested without the settings store; the get* wrappers read the store.
 */
import store from 'app/store';

export const DEFAULT_TOOLCHANGE_SAFE_Z = -0.1;

/**
 * Machine Z is zero at the top of travel and negative below it, so a safe
 * height can never be positive. A positive entry is read as "this far below
 * the top"; anything unusable falls back to the default.
 */
export const sanitizeSafeZ = (value: unknown): number => {
    if (value === null || value === undefined || value === '') {
        return DEFAULT_TOOLCHANGE_SAFE_Z;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return DEFAULT_TOOLCHANGE_SAFE_Z;
    }
    return n > 0 ? -n : n;
};

export const formatSafeZ = (value: unknown): string => {
    const n = sanitizeSafeZ(value);
    // Avoid "-0" and trailing zeros
    const fixed = Number(n.toFixed(3));
    return Object.is(fixed, -0) ? '0' : String(fixed);
};

/**
 * Lines that end a tool change, after the machine is back over the XY start
 * point (or just before, see callers).
 *
 * @param returnToStartZ  true = upstream behaviour
 * @param stockLines      the upstream line(s) returning to the stored Z
 */
export const buildReturnZLines = (
    returnToStartZ: boolean,
    stockLines: string[],
): string[] => {
    if (returnToStartZ) {
        return stockLines;
    }
    return ['(Z stays at tool change safe height)'];
};

export const getToolChangeSafeZ = (): string =>
    formatSafeZ(
        store.get('workspace.toolChange.safeZ', DEFAULT_TOOLCHANGE_SAFE_Z),
    );

export const shouldReturnToStartZ = (): boolean =>
    Boolean(store.get('workspace.toolChange.returnToStartZ', false));

export const getReturnZLines = (stockLines: string[]): string[] =>
    buildReturnZLines(shouldReturnToStartZ(), stockLines);
