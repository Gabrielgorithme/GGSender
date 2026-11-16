/*
 * GGSender addition (not part of upstream gSender).
 *
 * Where a running job is, in terms of the operations of jobOperations.ts.
 *
 * The server's Sender reports (controller.sender.status):
 * - received: lines the controller acknowledged. Grbl acknowledges a line
 *   when it enters the planner, so this runs ahead of the motion by up to a
 *   planner's worth of moves.
 * - currentLineRunning: gSender's own guess of the line in motion, from its
 *   time estimate (the line whose estimated time is counting down, + 1). It
 *   never passes received + 1. It stays 0 when the file has no estimate.
 * Both count non-blank lines (see `seq` in jobOperations.ts). The progress
 * percentage, the grey toolpath and the editor highlight use
 * currentLineRunning; so does this, falling back to received.
 * The Sender is rewound (sent = 0) when a job stops or finishes.
 */
import { JobInfo, JobOperation, ToolGroup } from './jobOperations';

export interface SenderProgress {
    sent?: number;
    received?: number;
    total?: number;
    currentLineRunning?: number;
    ovF?: number;
}

export type OperationState = 'done' | 'current' | 'upcoming';

const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
};

/**
 * Sender index of the line the machine is running, or null when no job is
 * under way. Past the last line: `total`.
 */
export const runningSeq = (status: SenderProgress | null | undefined, jobActive: boolean): number | null => {
    if (!jobActive || !status) {
        return null;
    }
    const sent = n(status.sent);
    const received = n(status.received);
    const total = n(status.total);
    if (sent <= 0 && received <= 0) {
        return null;
    }
    if (total > 0 && received >= total) {
        return total;
    }
    const byAck = Math.max(received - 1, 0);
    const byTime = n(status.currentLineRunning);
    return byTime > 0 ? Math.min(byTime - 1, byAck) : byAck;
};

/** Index of the operation that contains `seq`; -1 before the first one. */
export const currentOperation = (ops: JobOperation[], seq: number | null): number => {
    if (seq === null) {
        return -1;
    }
    let found = -1;
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].seq <= seq) {
            found = i;
        } else {
            break;
        }
    }
    if (found >= 0 && seq >= ops[found].endSeq) {
        return ops.length; // past the end: everything is done
    }
    return found;
};

export const operationStates = (ops: JobOperation[], seq: number | null): OperationState[] | null => {
    if (seq === null) {
        return null;
    }
    const cur = currentOperation(ops, seq);
    return ops.map((_op, i) => (i < cur ? 'done' : i === cur ? 'current' : 'upcoming'));
};

/** Share of an operation's lines already run, 0..1. */
export const operationFraction = (op: JobOperation, seq: number): number => {
    const span = op.endSeq - op.seq;
    if (span <= 0) {
        return 1;
    }
    return Math.min(1, Math.max(0, (seq - op.seq) / span));
};

/**
 * Estimated seconds until the next tool change, from gSender's estimate and
 * the feed override; null when there is no next change, no job, or no
 * estimate.
 */
export const secondsToNextToolChange = (info: JobInfo, seq: number | null, feedOverride = 100): number | null => {
    if (seq === null) {
        return null;
    }
    const cur = currentOperation(info.operations, seq);
    if (cur < 0 || cur >= info.operations.length) {
        return null;
    }
    const op = info.operations[cur];
    const group = info.groups[op.group];
    if (!group || !info.groups[op.group + 1]) {
        return null;
    }
    if (op.seconds === null) {
        return null;
    }
    let s = op.seconds * (1 - operationFraction(op, seq));
    for (const i of group.operations) {
        if (i > cur) {
            const later = info.operations[i].seconds;
            if (later === null) {
                return null;
            }
            s += later;
        }
    }
    const ov = feedOverride > 0 ? feedOverride : 100;
    return s / (ov / 100);
};

/** "45 s", "12 min", "1 h 05" */
export const formatDuration = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
        return '';
    }
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) {
        return `${s} s`;
    }
    const min = Math.round(s / 60);
    if (min < 60) {
        return `${min} min`;
    }
    const h = Math.floor(min / 60);
    return `${h} h ${String(min % 60).padStart(2, '0')}`;
};

/**
 * The tool group of a tool change. `m6Seq` is the sender index of the M6
 * being run (the server's tool change event gives `line` = that index + 1).
 * 1. the group whose M6 is that line, if its tool matches;
 * 2. else the latest group for `tool` at or before that line;
 * 3. else the first group for `tool`.
 */
export const groupForToolChange = (info: JobInfo, tool: unknown, m6Seq: number | null): ToolGroup | null => {
    const key = tool === null || tool === undefined ? '' : String(tool).trim().replace(/^t\s*/i, '');
    const t = /^\d+$/.test(key) ? String(Number(key)) : null;
    if (m6Seq !== null) {
        const exact = info.groups.find((g) => g.changeSeq === m6Seq);
        if (exact && (t === null || exact.tool === t)) {
            return exact;
        }
    }
    if (t === null) {
        return null;
    }
    const candidates = info.groups.filter((g) => g.tool === t && g.changeSeq !== null);
    if (candidates.length === 0) {
        return null;
    }
    let best: ToolGroup | null = null;
    if (m6Seq !== null) {
        for (const g of candidates) {
            if ((g.changeSeq as number) <= m6Seq) {
                best = g;
            }
        }
    }
    return best ?? candidates[0];
};
