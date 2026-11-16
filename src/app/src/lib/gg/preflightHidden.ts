/*
 * GGSender addition (not part of upstream gSender).
 *
 * Kinds of pre-flight warning the user chose to hide. Stored as text, one
 * code per line (commas also accepted), so it can be edited in Settings.
 *
 * Errors are never hidden: they mean the job will fail or leave the
 * machine's travel. Warnings and notes can be.
 */
import store from 'app/store';
import { PreflightIssue } from './preflight';

export const PREFLIGHT_HIDDEN_KEY = 'workspace.gg.preflightHidden';

export const parseHiddenCodes = (text: unknown): Set<string> => {
    if (typeof text !== 'string') {
        return new Set();
    }
    return new Set(
        text
            .split(/[\s,;]+/)
            .map((c) => c.trim().toUpperCase())
            .filter((c) => /^[A-Z0-9_]+$/.test(c)),
    );
};

export const formatHiddenCodes = (codes: Set<string>): string =>
    Array.from(codes).sort().join('\n');

export const canHide = (issue: PreflightIssue): boolean =>
    issue.severity !== 'error';

export const splitIssues = (
    issues: PreflightIssue[],
    hidden: Set<string>,
): { shown: PreflightIssue[]; hidden: PreflightIssue[] } => {
    const shown: PreflightIssue[] = [];
    const hid: PreflightIssue[] = [];
    issues.forEach((issue) => {
        if (canHide(issue) && hidden.has(issue.code)) {
            hid.push(issue);
        } else {
            shown.push(issue);
        }
    });
    return { shown, hidden: hid };
};

// ---- stored setting -----------------------------------------------------------

export const getHiddenCodes = (): Set<string> =>
    parseHiddenCodes(store.get(PREFLIGHT_HIDDEN_KEY, ''));

export const hideCode = (code: string) => {
    const codes = getHiddenCodes();
    codes.add(code.toUpperCase());
    store.set(PREFLIGHT_HIDDEN_KEY, formatHiddenCodes(codes));
};

export const unhideCode = (code: string) => {
    const codes = getHiddenCodes();
    codes.delete(code.toUpperCase());
    store.set(PREFLIGHT_HIDDEN_KEY, formatHiddenCodes(codes));
};
