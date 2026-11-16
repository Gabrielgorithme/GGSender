/*
 * GGSender addition (not part of upstream gSender).
 *
 * Pre-flight check of the loaded file: problems found, tools used with their
 * depth, height, feed and speed, and where the job lands in the machine's
 * travel with the current zero. A button in the 3D view opens it; it opens by
 * itself on file load according to the "Pre-flight check on file load"
 * setting. Line numbers are links that show the line in the 3D view.
 */
import { useEffect, useMemo, useState } from 'react';
import pubsub from 'pubsub-js';
import get from 'lodash/get';

import store from 'app/store';
import { useTypedSelector } from 'app/hooks/useTypedSelector';
import { PreflightIssue, PreflightReport } from 'app/lib/gg/preflight';
import {
    TravelResult,
    allIssues,
    checkTravel,
    countSerious,
} from 'app/lib/gg/preflightContext';
import {
    PREFLIGHT_TOPIC,
    PreflightEntry,
    getPreflight,
} from 'app/lib/gg/preflightStore';
import { LOADED_TOOL_KEY, normalizeTool } from 'app/lib/gg/loadedTool';
import { requestPickLine } from './pickTopics';
import {
    canHide,
    getHiddenCodes,
    hideCode,
    splitIssues,
    unhideCode,
} from 'app/lib/gg/preflightHidden';

export const PREFLIGHT_OPEN_KEY = 'workspace.gg.preflightOnLoad';
export const PREFLIGHT_ALWAYS = 'Every file';
export const PREFLIGHT_WARNINGS = 'When there are warnings';
export const PREFLIGHT_NEVER = 'Never';
export const PREFLIGHT_OPTIONS = [PREFLIGHT_WARNINGS, PREFLIGHT_ALWAYS, PREFLIGHT_NEVER];

const num = (v: number | null | undefined, digits = 3) =>
    v === null || v === undefined || !Number.isFinite(v)
        ? '–'
        : String(Number(v.toFixed(digits)));

const SEVERITY_STYLE = {
    error: 'text-red-600 dark:text-red-400',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-gray-500 dark:text-gray-400',
};
const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' };

/** Everything the checks need from the stores, read once per render. */
const useContextInput = (report: PreflightReport | null) => {
    const settings = useTypedSelector(
        (s) => get(s, 'controller.settings.settings', {}) as Record<string, string | undefined>,
    );
    const mpos = useTypedSelector((s) => get(s, 'controller.mpos', null));
    const wpos = useTypedSelector((s) => get(s, 'controller.wpos', null));
    const hasHomed = useTypedSelector((s) => Boolean(get(s, 'controller.hasHomed', false)));
    const isConnected = useTypedSelector((s) => Boolean(get(s, 'connection.isConnected', false)));
    const [, setTick] = useState(0);

    // follow the gSender settings the checks use
    useEffect(() => {
        const onChange = () => setTick((t) => t + 1);
        store.on('change', onChange);
        return () => {
            store.removeListener('change', onChange);
        };
    }, []);

    if (!report) {
        return null;
    }

    const travelNumber = (key: string) => {
        const n = Number(settings?.[key]);
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    const toNumbers = (p: { x: unknown; y: unknown; z: unknown } | null) =>
        p ? { x: Number(p.x), y: Number(p.y), z: Number(p.z) } : null;
    const machine = toNumbers(mpos);
    const work = toNumbers(wpos);

    const travel: TravelResult = checkTravel(
        report,
        isConnected && machine && work
            ? {
                  hasHomed,
                  maxTravel: {
                      x: travelNumber('$130'),
                      y: travelNumber('$131'),
                      z: travelNumber('$132'),
                  },
                  mpos: machine,
                  wpos: work,
              }
            : null,
    );

    const spindleMax = Number(settings?.$30);
    const passthrough = Boolean(store.get('workspace.toolChange.passthrough', false));
    const sendToolNumber = Boolean(store.get('workspace.toolChange.sendToolNumber', false));

    return {
        strategy: store.get('workspace.toolChangeOption', 'Ignore'),
        loadedTool: normalizeTool(get(store.get(LOADED_TOOL_KEY, {}), 'tool', null)),
        sendsToolNumbers: passthrough || sendToolNumber,
        spindleMax: Number.isFinite(spindleMax) && spindleMax > 0 ? spindleMax : null,
        feedRules: store.get('workspace.toolChange.feedRules', ''),
        travel,
    };
};

const LineLink = ({ line }: { line?: number }) =>
    line ? (
        <button
            type="button"
            className="underline text-blue-600 dark:text-blue-400 whitespace-nowrap"
            onClick={() => requestPickLine(line - 1)}
            title="Show in the 3D view"
        >
            line {line}
        </button>
    ) : null;

const IssueRow = ({ issue }: { issue: PreflightIssue }) => (
    <li className="flex gap-2 py-0.5 group" data-testid={`gg-preflight-issue-${issue.code}`}>
        <span className={`w-16 flex-shrink-0 font-semibold ${SEVERITY_STYLE[issue.severity]}`}>
            {SEVERITY_LABEL[issue.severity]}
        </span>
        <span className="flex-1">
            {issue.message} <LineLink line={issue.line} />
        </span>
        {canHide(issue) && (
            <button
                type="button"
                className="flex-shrink-0 self-start text-xs px-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                onClick={() => hideCode(issue.code)}
                title="Hide this kind of warning for every file. Bring it back at the bottom of this list or in Settings."
                data-testid={`gg-preflight-hide-${issue.code}`}
            >
                Hide this kind
            </button>
        )}
    </li>
);

/** The kinds the user hid, with how many of each this file has. */
const HiddenList = ({ hiddenIssues }: { hiddenIssues: PreflightIssue[] }) => {
    const codes = Array.from(getHiddenCodes()).sort();
    if (codes.length === 0) {
        return null;
    }
    const here = (code: string) => hiddenIssues.filter((i) => i.code === code).length;
    return (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="gg-preflight-hidden">
            <div>Hidden kinds of warning:</div>
            <ul>
                {codes.map((code) => (
                    <li key={code} className="flex gap-2 items-center">
                        <span className="font-mono">{code}</span>
                        <span>{here(code) > 0 ? `(${here(code)} in this file)` : ''}</span>
                        <button
                            type="button"
                            className="underline"
                            onClick={() => unhideCode(code)}
                            data-testid={`gg-preflight-unhide-${code}`}
                        >
                            show again
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

interface PanelProps {
    entry: PreflightEntry;
    onClose: () => void;
}

export const PreflightPanel = ({ entry, onClose }: PanelProps) => {
    const { report, fileName } = entry;
    const ctx = useContextInput(report);
    const allFound = useMemo(() => (ctx ? allIssues(report, ctx) : report.issues), [report, ctx]);
    // GGSender: kinds of warning the user hid (re-read on every render; the
    // context hook re-renders on settings changes)
    const { shown: issues, hidden: hiddenIssues } = splitIssues(allFound, getHiddenCodes());
    const travel = ctx?.travel;

    return (
        <div
            className="absolute top-4 left-4 z-30 w-[38rem] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-auto rounded-md border border-gray-300 dark:border-gray-600 bg-white/95 dark:bg-dark/95 shadow-lg text-sm text-gray-900 dark:text-gray-100"
            data-testid="gg-preflight-panel"
        >
            <div className="sticky top-0 flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-dark">
                <span className="font-bold">Pre-flight</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{fileName}</span>
                <div className="flex-1" />
                <button type="button" onClick={onClose} aria-label="Close" title="Close">
                    ✕
                </button>
            </div>

            <div className="px-3 py-2 flex flex-col gap-3">
                <section>
                    {issues.length === 0 ? (
                        <p className="text-green-700 dark:text-green-400" data-testid="gg-preflight-clean">
                            Nothing to report.
                        </p>
                    ) : (
                        <ul>
                            {issues.map((issue) => (
                                <IssueRow key={`${issue.code}-${issue.line ?? ''}`} issue={issue} />
                            ))}
                        </ul>
                    )}
                    <HiddenList hiddenIssues={hiddenIssues} />
                </section>

                <section>
                    <h4 className="font-semibold mb-1">
                        Tools{report.toolChanges === 0 ? ' (no tool change in the file)' : ''}
                    </h4>
                    <table className="w-full text-xs" data-testid="gg-preflight-tools">
                        <thead className="text-gray-500 dark:text-gray-400 text-left">
                            <tr>
                                <th className="pr-2">Tool</th>
                                <th className="pr-2">Change</th>
                                <th className="pr-2 text-right">Deepest</th>
                                <th className="pr-2 text-right">Highest</th>
                                <th className="pr-2 text-right">Max feed</th>
                                <th className="pr-2 text-right">Speed</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.sections.map((s, i) => (
                                <tr key={i} className="align-top">
                                    <td className="pr-2 font-mono font-bold">{s.tool === null ? '–' : `T${s.tool}`}</td>
                                    <td className="pr-2">
                                        {s.changeLine ? <LineLink line={s.changeLine} /> : 'start'}
                                    </td>
                                    <td className="pr-2 text-right font-mono">{num(s.cutZMin)}</td>
                                    <td className="pr-2 text-right font-mono">{num(s.zMax)}</td>
                                    <td className="pr-2 text-right font-mono">{num(s.maxFeed, 0)}</td>
                                    <td className="pr-2 text-right font-mono">
                                        {s.spindleSpeeds.length === 0 ? '–' : s.spindleSpeeds.join(', ')}
                                    </td>
                                    <td className="text-gray-600 dark:text-gray-300">{s.comment}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        Z in work coordinates, mm; feed in mm/min.
                        {report.units === 'inch' ? ' Converted from inches.' : ''}
                    </p>
                </section>

                <section>
                    <h4 className="font-semibold mb-1">Travel with the current zero</h4>
                    {!travel || travel.status === 'unchecked' ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="gg-preflight-travel-unchecked">
                            Not checked. {travel?.reason}
                        </p>
                    ) : (
                        <>
                            <table className="w-full text-xs" data-testid="gg-preflight-travel">
                                <thead className="text-gray-500 dark:text-gray-400 text-left">
                                    <tr>
                                        <th className="pr-2">Axis</th>
                                        <th className="pr-2 text-right">Job (work)</th>
                                        <th className="pr-2 text-right">Job (machine)</th>
                                        <th className="pr-2 text-right">Machine travel</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {travel.axes.map((a) => (
                                        <tr key={a.axis}>
                                            <td className="pr-2 font-bold">{a.axis.toUpperCase()}</td>
                                            <td className="pr-2 text-right font-mono">
                                                {num(report.bounds.min[a.axis])} … {num(report.bounds.max[a.axis])}
                                            </td>
                                            <td className="pr-2 text-right font-mono">
                                                {num(a.jobMin)} … {num(a.jobMax)}
                                            </td>
                                            <td className="pr-2 text-right font-mono">
                                                {num(a.rangeMin)} … {num(a.rangeMax)}
                                            </td>
                                            <td
                                                className={
                                                    a.over > 0 && !a.ambiguous
                                                        ? 'text-red-600 dark:text-red-400 font-semibold'
                                                        : a.ambiguous
                                                          ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                                          : 'text-green-700 dark:text-green-400'
                                                }
                                            >
                                                {a.ambiguous
                                                    ? 'at 0: unsure'
                                                    : a.over > 0
                                                      ? `${num(a.over)} mm out`
                                                      : 'fits'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Travel from $130–$132. Z is for the tool now in the spindle: after a
                                tool change, work Z moves by the difference in tool length.
                            </p>
                        </>
                    )}
                </section>
            </div>
        </div>
    );
};

/**
 * Should the panel open by itself? Decided with all issues, the machine
 * checks included (a job that leaves the travel is the main reason to open).
 */
export const shouldAutoOpen = (policy: string, issues: PreflightIssue[]) => {
    if (policy === PREFLIGHT_NEVER) {
        return false;
    }
    if (policy === PREFLIGHT_ALWAYS) {
        return true;
    }
    return countSerious(issues) > 0;
};

/**
 * Button for the 3D view, with the number of errors and warnings, and the
 * panel it opens.
 */
export const PreflightControl = () => {
    const [entry, setEntry] = useState<PreflightEntry | null>(getPreflight());
    const [open, setOpen] = useState(false);
    // set when a file is loaded: decide whether to open once the machine
    // checks for it are available (next render)
    const [decideOpen, setDecideOpen] = useState(false);
    const ctx = useContextInput(entry?.report ?? null);
    // GGSender: hidden kinds count neither in the badge nor for auto-open
    const issues = entry && ctx
        ? splitIssues(allIssues(entry.report, ctx), getHiddenCodes()).shown
        : [];
    const serious = countSerious(issues);
    const hasError = issues.some((i) => i.severity === 'error');

    useEffect(() => {
        const token = pubsub.subscribe(PREFLIGHT_TOPIC, (_msg, next: PreflightEntry | null) => {
            setEntry(next);
            setOpen(false);
            setDecideOpen(Boolean(next));
        });
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);

    useEffect(() => {
        if (!decideOpen || !entry || !ctx) {
            return;
        }
        setDecideOpen(false);
        setOpen(shouldAutoOpen(store.get(PREFLIGHT_OPEN_KEY, PREFLIGHT_WARNINGS), issues));
    });

    if (!entry) {
        return null;
    }

    return (
        <>
            <button
                type="button"
                // above the lightweight-mode button (bottom-44, 64px high)
                className="absolute left-5 bottom-[248px] portrait:right-5 portrait:left-auto bg-gray-600 bg-opacity-50 rounded-full w-16 h-16 text-white text-xs font-bold"
                onClick={() => setOpen(!open)}
                title="Pre-flight check of the loaded file"
                data-testid="gg-preflight-button"
            >
                CHK
                {serious > 0 && (
                    <span
                        className={`absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full text-[11px] leading-5 ${hasError ? 'bg-red-600' : 'bg-amber-500'}`}
                        data-testid="gg-preflight-badge"
                    >
                        {serious}
                    </span>
                )}
            </button>
            {open && <PreflightPanel entry={entry} onClose={() => setOpen(false)} />}
        </>
    );
};

export default PreflightControl;
