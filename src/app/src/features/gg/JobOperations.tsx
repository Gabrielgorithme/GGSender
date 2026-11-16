/*
 * GGSender addition (not part of upstream gSender).
 *
 * The loaded file's operations, grouped by tool change, in the top-left
 * corner of the 3D view: done, running, coming up, with gSender's time
 * estimate and the time left until the next tool change. Replaces the
 * upstream tool timeline when the file has operations and the setting
 * "Operations list in the 3D view" is on; otherwise the upstream timeline is
 * shown (it stays mounted either way, so it keeps its own subscriptions).
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import pubsub from 'pubsub-js';
import get from 'lodash/get';
import cx from 'classnames';

import { useTypedSelector } from 'app/hooks/useTypedSelector';
import { WORKFLOW_STATE_PAUSED, WORKFLOW_STATE_RUNNING } from 'app/constants';
import { JobInfo } from 'app/lib/gg/jobOperations';
import { JOB_INFO_TOPIC, JobInfoEntry, getJobInfo } from 'app/lib/gg/jobInfoStore';
import {
    OperationState,
    SenderProgress,
    currentOperation,
    formatDuration,
    operationFraction,
    operationStates,
    runningSeq,
    secondsToNextToolChange,
} from 'app/lib/gg/jobProgress';
import { toolSummary } from 'app/lib/gg/toolSpec';
import { ToolDrawing } from './ToolDrawing';
import { requestPickLine } from './pickTopics';
import { useStoreSetting } from './useStoreSetting';

export const OPERATIONS_PANEL_KEY = 'workspace.gg.operationsPanel';

const STATE_MARK: Record<OperationState, string> = {
    done: '✓',
    current: '▶',
    upcoming: '',
};

interface ListProps {
    info: JobInfo;
    seq: number | null; // sender index running, null when no job
    feedOverride?: number;
}

export const OperationsList = ({ info, seq, feedOverride = 100 }: ListProps) => {
    const [collapsed, setCollapsed] = useState(false);
    const currentRef = useRef<HTMLLIElement | null>(null);
    const states = operationStates(info.operations, seq);
    const cur = currentOperation(info.operations, seq);
    const curOp = cur >= 0 && cur < info.operations.length ? info.operations[cur] : null;
    const nextGroup = curOp ? info.groups[curOp.group + 1] : null;
    const toNext = secondsToNextToolChange(info, seq, feedOverride);
    const finished = seq !== null && cur >= info.operations.length;

    useEffect(() => {
        currentRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [cur, collapsed]);

    const nextChangeLine =
        nextGroup && seq !== null ? (
            <div className="text-xs text-amber-700 dark:text-amber-300" data-testid="gg-ops-next-change">
                Next tool change: <b>{nextGroup.tool !== null ? `T${nextGroup.tool}` : 'M6'}</b>
                {toNext !== null ? ` in ~${formatDuration(toNext)}` : ''}
            </div>
        ) : null;

    const total = info.operations.length;
    const headerStatus = finished
        ? 'all done'
        : curOp
          ? `${cur + 1}/${total}`
          : `${total} operation${total === 1 ? '' : 's'}`;

    return (
        <div
            className="absolute top-4 left-4 z-10 w-[22rem] max-w-[calc(100%_-_2rem)] rounded-md border border-gray-300 dark:border-gray-600 bg-white/90 dark:bg-dark/90 shadow-lg text-sm text-gray-900 dark:text-gray-100 flex flex-col max-h-[max(10rem,calc(100%_-_21rem))]"
            data-testid="gg-ops-panel"
        >
            <button
                type="button"
                className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 text-left w-full"
                onClick={() => setCollapsed(!collapsed)}
                title={collapsed ? 'Show the operations' : 'Hide the list'}
                data-testid="gg-ops-toggle"
            >
                <span className="font-bold">Operations</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{headerStatus}</span>
                {collapsed && curOp && <span className="truncate text-xs font-semibold">{curOp.name}</span>}
                <span className="flex-1" />
                {info.totalSeconds !== null && !collapsed && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">~{formatDuration(info.totalSeconds)}</span>
                )}
                <span aria-hidden>{collapsed ? '▾' : '▴'}</span>
            </button>
            {nextChangeLine && <div className="px-3 py-1 border-b border-gray-200 dark:border-gray-700">{nextChangeLine}</div>}
            {!collapsed && (
                <ol className="overflow-y-auto px-1 py-1" data-testid="gg-ops-list">
                    {info.groups.map((g) => {
                        if (g.operations.length === 0) {
                            return null;
                        }
                        const spec = g.tool !== null ? info.tools[g.tool] : undefined;
                        const groupStates = states ? g.operations.map((i) => states[i]) : [];
                        const groupDone = groupStates.length > 0 && groupStates.every((s) => s === 'done');
                        const groupCurrent = groupStates.includes('current');
                        return (
                            <li key={g.index} className={cx('mb-1', { 'opacity-60': groupDone })} data-testid={`gg-ops-group-${g.index}`}>
                                <div
                                    className={cx('flex items-center gap-2 px-2 py-0.5 rounded', {
                                        'bg-gray-100 dark:bg-gray-800': !groupCurrent,
                                        'bg-sky-100 dark:bg-sky-900/60': groupCurrent,
                                    })}
                                    title={spec ? spec.text : g.comment}
                                >
                                    {spec ? (
                                        <ToolDrawing spec={spec} height={22} compact className="flex-shrink-0 text-gray-600 dark:text-gray-300" />
                                    ) : (
                                        <span className="w-4" />
                                    )}
                                    <span className="font-mono font-bold">{g.tool !== null ? `T${g.tool}` : 'No M6'}</span>
                                    <span className="truncate text-xs text-gray-600 dark:text-gray-300">
                                        {spec ? toolSummary(spec) : g.comment}
                                    </span>
                                    <span className="flex-1" />
                                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDuration(g.seconds)}</span>
                                </div>
                                <ol>
                                    {g.operations.map((i) => {
                                        const op = info.operations[i];
                                        const state: OperationState | null = states ? states[i] : null;
                                        const isCurrent = state === 'current';
                                        return (
                                            <li
                                                key={i}
                                                ref={isCurrent ? currentRef : undefined}
                                                className={cx('pl-7 pr-2 py-0.5 rounded', {
                                                    'bg-sky-50 dark:bg-sky-950/60 font-semibold': isCurrent,
                                                    'text-gray-500 dark:text-gray-400': state === 'done',
                                                })}
                                                data-testid={`gg-op-${i}`}
                                                data-state={state ?? 'idle'}
                                            >
                                                <div className="flex items-center gap-1.5">
                                                    <span className="w-3 text-xs text-sky-600 dark:text-sky-400">{state ? STATE_MARK[state] : ''}</span>
                                                    <button
                                                        type="button"
                                                        className="truncate text-left hover:underline"
                                                        onClick={() => requestPickLine(op.firstMotionLine ?? op.line)}
                                                        title={`${op.name}${op.notes.length ? ` — ${op.notes.join(' / ')}` : ''}\nLine ${op.line + 1}. Click: show its first move in the 3D view.`}
                                                    >
                                                        {op.name}
                                                    </button>
                                                    <span className="flex-1" />
                                                    <span className="text-xs font-normal text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                                        {formatDuration(op.seconds)}
                                                    </span>
                                                </div>
                                                {op.notes.length > 0 && (
                                                    <div className="pl-[1.125rem] text-xs font-normal text-gray-500 dark:text-gray-400 truncate">
                                                        {op.notes.join(' / ')}
                                                    </div>
                                                )}
                                                {isCurrent && seq !== null && (
                                                    <div className="ml-[1.125rem] mt-0.5 h-1 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
                                                        <div
                                                            className="h-full bg-sky-500"
                                                            style={{ width: `${Math.round(operationFraction(op, seq) * 100)}%` }}
                                                            data-testid="gg-op-progress"
                                                        />
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ol>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
};

/** Hook: the job info of the loaded file, following new files. */
export const useJobInfo = (): JobInfoEntry | null => {
    const [entry, setEntry] = useState<JobInfoEntry | null>(getJobInfo());
    useEffect(() => {
        const token = pubsub.subscribe(JOB_INFO_TOPIC, (_msg: string, next: JobInfoEntry | null) => setEntry(next));
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);
    return entry;
};

/** Sender index the machine is running (null when no job), from the redux store. */
export const useRunningSeq = (): { seq: number | null; feedOverride: number } => {
    const status = useTypedSelector((s) => get(s, 'controller.sender.status', null)) as SenderProgress | null;
    const workflowState = useTypedSelector((s) => get(s, 'controller.workflow.state', ''));
    const active = workflowState === WORKFLOW_STATE_RUNNING || workflowState === WORKFLOW_STATE_PAUSED;
    const ov = Number(status?.ovF);
    return { seq: runningSeq(status, active), feedOverride: Number.isFinite(ov) && ov > 0 ? ov : 100 };
};

/** For the 3D view: the operations list, or the upstream timeline. */
export const JobOperations = ({ fallback }: { fallback?: ReactNode }) => {
    const enabled = useStoreSetting<boolean>(OPERATIONS_PANEL_KEY, true);
    const entry = useJobInfo();
    const fileLoaded = useTypedSelector((s) => Boolean(get(s, 'file.fileLoaded', false)));
    const { seq, feedOverride } = useRunningSeq();
    const show = Boolean(enabled && entry && fileLoaded && entry.info.operations.length > 0);
    return (
        <>
            <div className={show ? 'hidden' : undefined} data-testid="gg-ops-fallback">
                {fallback}
            </div>
            {show && entry && <OperationsList info={entry.info} seq={seq} feedOverride={feedOverride} />}
        </>
    );
};

export default JobOperations;
