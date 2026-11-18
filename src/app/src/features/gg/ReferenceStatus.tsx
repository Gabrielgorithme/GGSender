/*
 * GGSender addition (not part of upstream gSender).
 *
 * The tool sensor reference at a glance: a pictogram for its state (correct,
 * not correct, none), which tool was probed and when, what a tool change
 * will do with it, and the history. Used by the chip in the top bar, the
 * resume dialog and the tool change window, so that all three show the same
 * thing (the words are in lib/gg/referenceText.ts).
 */
import cx from 'classnames';
import { MdBlock, MdCheckCircle, MdCode, MdLayers, MdPanTool, MdStraighten, MdSwapVert, MdWarning } from 'react-icons/md';

import { HistoryEntry, ReferenceSnapshot, ReferenceStatus as Status } from 'app/lib/gg/probeStore';
import { STATUS_LABEL, clock, historyLine, referenceEffect, referenceHeadline } from 'app/lib/gg/referenceText';

export const STATUS_COLOUR: Record<Status, string> = {
    valid: 'text-emerald-600 dark:text-emerald-400',
    stale: 'text-amber-600 dark:text-amber-400',
    none: 'text-gray-500 dark:text-gray-400',
};

/** The pictogram of the state. */
export const ReferenceIcon = ({ status, className = '' }: { status: Status; className?: string }) => {
    const Icon = status === 'valid' ? MdCheckCircle : status === 'stale' ? MdWarning : MdBlock;
    return (
        <span
            className={cx('inline-flex shrink-0', STATUS_COLOUR[status], className)}
            role="img"
            aria-label={STATUS_LABEL[status]}
            title={STATUS_LABEL[status]}
            data-testid={`gg-reference-icon-${status}`}
        >
            <Icon aria-hidden />
        </span>
    );
};

const HISTORY_ICON = {
    reference: MdStraighten,
    measured: MdSwapVert,
    zero: MdPanTool,
    wcs: MdLayers,
    program: MdCode,
} as const;

const HISTORY_COLOUR = {
    reference: 'text-emerald-600 dark:text-emerald-400',
    measured: 'text-blue-600 dark:text-blue-400',
    zero: 'text-amber-600 dark:text-amber-400',
    wcs: 'text-amber-600 dark:text-amber-400',
    program: 'text-amber-600 dark:text-amber-400',
} as const;

export const ReferenceHistory = ({ history, limit = 8 }: { history: HistoryEntry[]; limit?: number }) => {
    if (history.length === 0) {
        return null;
    }
    const shown = history.slice(-limit).reverse(); // newest first
    return (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" data-testid="gg-reference-history">
            {shown.map((e, i) => {
                const Icon = HISTORY_ICON[e.kind] ?? MdPanTool;
                return (
                    <li key={`${e.at}-${i}`} className="flex items-start gap-1.5">
                        <Icon className={cx('mt-0.5 shrink-0 text-sm', HISTORY_COLOUR[e.kind] ?? '')} aria-hidden />
                        <span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{clock(e.at)}</span>
                        <span>{historyLine(e)}</span>
                    </li>
                );
            })}
        </ul>
    );
};

interface Props {
    snapshot: ReferenceSnapshot;
    effect?: boolean; // also say what a tool change will do
    history?: boolean;
    className?: string;
}

export const ReferenceStatus = ({ snapshot, effect = false, history = false, className = '' }: Props) => (
    <div className={cx('flex flex-col gap-1.5', className)} data-testid="gg-reference-status" data-status={snapshot.status}>
        <div className="flex items-start gap-2 text-sm">
            <ReferenceIcon status={snapshot.status} className="mt-0.5 text-lg" />
            <div className="flex flex-col gap-0.5">
                <span data-testid="gg-reference-headline">{referenceHeadline(snapshot)}</span>
                {effect && (
                    <span className="text-xs text-gray-600 dark:text-gray-300" data-testid="gg-reference-effect">
                        {referenceEffect(snapshot)}
                    </span>
                )}
            </div>
        </div>
        {history && <ReferenceHistory history={snapshot.history} />}
    </div>
);

export default ReferenceStatus;
