/*
 * GGSender addition (not part of upstream gSender).
 *
 * Operations and tools of a program, read from its comments the way Fusion's
 * posts write them:
 *
 *   (1)                                                <- program name
 *   (T45 D=4 CR=0.5 - ZMIN=-5.8 - bullnose end mill)   <- tool table
 *   N10 G90 G94
 *   ...
 *
 *   (3D Adaptive Roughing1)                            <- operation name
 *   N15 T45 M6
 *   ...
 *   (Flat1)                                            <- next operation, same tool
 *
 * Rules, for any program:
 * - Header: the comment lines before the first line with code. Tool table
 *   entries (T<n> ... D=...) are read into `tools` wherever they are; the
 *   first other header comment is the program name.
 * - Operation: a run of comment-only lines after the header (blank lines may
 *   separate them, code may not). Its first comment is the name, the others
 *   are notes.
 * - A run with no motion before the next run (a manual NC comment, a "flip
 *   the part" note before an M0) is kept as a note of the next operation,
 *   which starts at that note. Comments after the last motion of the file
 *   are notes of the last operation.
 * - A run right after an M6, when that M6 already had an operation name
 *   before it, is the tool's description (Fusion writes the tool's
 *   description there), not an operation.
 * - Tool groups: each M6 starts one; an operation belongs to the group in
 *   force at its first motion line (at its name when it has no motion).
 *   Operations before the first M6 get a group with tool null.
 *
 * Line numbering:
 * - `line`: 0-based file line, counted on "\n" like the editor and the
 *   toolpath picker.
 * - `seq`: index among non-blank lines. The server's Sender numbers lines this
 *   way (it drops lines whose trim() is empty), so `seq` compares directly
 *   with a running job's `received` and `currentLineRunning`.
 *
 * Durations come from gSender's own estimate (GCodeVirtualizer.estimates, one
 * value per line that has code) and are as good as that estimate.
 */
import { createFastLineScanScratch, scanLineFast } from 'app/lib/GCodeParser';
import { ToolSpec, parseToolSpec } from './toolSpec';

export interface JobOperation {
    index: number;
    name: string;
    notes: string[];
    line: number; // 0-based file line where the operation starts (its first comment)
    seq: number; // sender index of that line
    endSeq: number; // sender index where the next operation starts (exclusive)
    firstMotionLine: number | null; // 0-based file line of its first move
    firstMotionSeq: number | null; // sender index of that line
    firstMotionText: string | null; // that line, trimmed
    group: number; // index into groups
    seconds: number | null; // estimated duration
}

export interface ToolGroup {
    index: number;
    tool: string | null; // null before the first M6, or M6 without a T word
    changeLine: number | null; // 0-based file line of the M6
    changeSeq: number | null;
    comment: string; // tool description written after the M6, if any
    operations: number[]; // indices into operations
    seconds: number | null; // estimated duration from this M6 to the next
}

export interface JobInfo {
    version: 1;
    programName: string;
    units: 'mm' | 'inch'; // units of the tool dimensions (the program's units)
    tools: Record<string, ToolSpec>;
    operations: JobOperation[];
    groups: ToolGroup[];
    totalSeq: number; // number of non-blank lines
    totalSeconds: number | null;
}

const COMMENT_RE = /\(([^)]*)\)|;(.*)$/g;
const AXIS_RE = /[XYZABC][-+.\d]/;
// moves that are not part of a toolpath: machine coordinates, home, offsets, probing, dwell
const NOT_PATH_RE = /G(?:28|30|53|10|92|4)(?![0-9])|G38/;
const M6_RE = /M0*6(?![0-9])/;
const T_RE = /T(\d+)/;

const commentsOf = (raw: string): string[] => {
    const out: string[] = [];
    COMMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMMENT_RE.exec(raw)) !== null) {
        const text = (m[1] !== undefined ? m[1] : (m[2] ?? '')).trim();
        if (text) {
            out.push(text);
        }
    }
    return out;
};

/** The line without comments, line number and spaces, in upper case. */
const codeOf = (raw: string): string =>
    raw
        .replace(/\([^)]*\)/g, ' ')
        .replace(/;.*$/, '')
        .replace(/^\s*N\d+/i, '')
        .replace(/\s+/g, '')
        .toUpperCase();

const sumRange = (values: ArrayLike<number> | null, from: number, to: number): number | null => {
    if (!values) {
        return null;
    }
    let s = 0;
    const end = Math.min(to, values.length);
    for (let i = Math.max(0, from); i < end; i++) {
        const v = Number(values[i]);
        if (Number.isFinite(v)) {
            s += v;
        }
    }
    return s;
};

interface Pos {
    line: number;
    seq: number;
    tok: number; // index into estimates
}

interface OpRun extends Pos {
    texts: string[];
    motion: Pos | null;
}

interface Change extends Pos {
    tool: string | null;
    named: boolean;
    comment: string;
}

/**
 * @param content   the program, as loaded
 * @param estimates gSender's per-line time estimates (seconds, one per line
 *                  with code); omit for no durations
 */
export const analyzeJob = (content: string, estimates?: ArrayLike<number> | null): JobInfo => {
    const lines = content.split('\n');
    const scratch = createFastLineScanScratch();
    const est = estimates && estimates.length > 0 ? estimates : null;

    const tools: Record<string, ToolSpec> = {};
    const headerComments: string[] = [];
    const runs: OpRun[] = [];
    const changes: Change[] = [];
    let units: 'mm' | 'inch' | null = null;

    let seq = 0;
    let tok = 0; // lines with code, counted as GCodeVirtualizer counts them
    let inHeader = true;
    // the run being read: an operation run, or the description after an M6
    let reading: { kind: 'op'; run: OpRun } | { kind: 'tool'; change: Change } | null = null;
    let lastCodeWasM6: Change | null = null;
    let nameSinceMotion = false;
    let pendingT: string | null = null;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.trim().length === 0) {
            continue; // blank: the Sender skips it; it does not end a run
        }
        const pos: Pos = { line: i, seq, tok };
        seq++;
        if (scanLineFast(raw, scratch).count > 0) {
            tok++;
        }
        const code = codeOf(raw);

        if (code.length === 0 || code === '%') {
            const texts: string[] = [];
            for (const t of commentsOf(raw)) {
                const spec = parseToolSpec(t);
                if (spec) {
                    tools[spec.number] = tools[spec.number] ?? spec;
                } else {
                    texts.push(t);
                }
            }
            if (texts.length === 0) {
                continue;
            }
            if (inHeader) {
                headerComments.push(...texts);
                continue;
            }
            if (reading?.kind === 'op') {
                reading.run.texts.push(...texts);
            } else if (reading?.kind === 'tool') {
                const ch = reading.change;
                ch.comment = [ch.comment, ...texts].filter(Boolean).join(' ');
            } else if (lastCodeWasM6 && lastCodeWasM6.named) {
                lastCodeWasM6.comment = texts.join(' ');
                reading = { kind: 'tool', change: lastCodeWasM6 };
            } else {
                const run: OpRun = { ...pos, texts, motion: null };
                runs.push(run);
                reading = { kind: 'op', run };
                nameSinceMotion = true;
            }
            continue;
        }

        // a line with code
        inHeader = false;
        reading = null;
        if (units === null) {
            if (/G20(?![0-9])/.test(code)) {
                units = 'inch';
            } else if (/G21(?![0-9])/.test(code)) {
                units = 'mm';
            }
        }
        const t = T_RE.exec(code);
        if (t) {
            pendingT = String(Number(t[1]));
        }
        if (M6_RE.test(code)) {
            const change: Change = { ...pos, tool: pendingT, named: nameSinceMotion, comment: '' };
            changes.push(change);
            lastCodeWasM6 = change;
            continue;
        }
        lastCodeWasM6 = null;
        if (AXIS_RE.test(code) && !NOT_PATH_RE.test(code)) {
            nameSinceMotion = false;
            const last = runs[runs.length - 1];
            if (last && last.motion === null) {
                last.motion = pos;
            }
        }
    }
    const totalSeq = seq;
    const totalTok = tok;

    // Operations: runs without motion are notes of the next run with motion;
    // runs after the last motion are notes of the last operation.
    interface Draft {
        start: OpRun;
        name: OpRun;
        notes: string[];
    }
    const drafts: Draft[] = [];
    let waiting: OpRun[] = [];
    for (const run of runs) {
        if (run.motion === null) {
            waiting.push(run);
            continue;
        }
        const before = waiting.flatMap((r) => r.texts);
        drafts.push({
            start: waiting[0] ?? run,
            name: run,
            notes: [...before, ...run.texts.slice(1)],
        });
        waiting = [];
    }
    if (waiting.length > 0) {
        const texts = waiting.flatMap((r) => r.texts);
        if (drafts.length > 0) {
            drafts[drafts.length - 1].notes.push(...texts);
        } else {
            drafts.push({ start: waiting[0], name: waiting[0], notes: texts.slice(1) });
        }
    }

    // Tool groups: last change at or before a sender index; -1 = none yet
    const changeAt = (s: number): number => {
        let lo = 0;
        let hi = changes.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (changes[mid].seq <= s) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    };
    const opChange = drafts.map((d) => changeAt((d.name.motion ?? d.start).seq));
    const pre = opChange.some((c) => c === -1) ? 1 : 0;

    const groups: ToolGroup[] = [];
    if (pre) {
        groups.push({
            index: 0,
            tool: null,
            changeLine: null,
            changeSeq: null,
            comment: '',
            operations: [],
            seconds: sumRange(est, 0, changes.length > 0 ? changes[0].tok : totalTok),
        });
    }
    changes.forEach((ch, k) => {
        groups.push({
            index: groups.length,
            tool: ch.tool,
            changeLine: ch.line,
            changeSeq: ch.seq,
            comment: ch.comment,
            operations: [],
            seconds: sumRange(est, ch.tok, k + 1 < changes.length ? changes[k + 1].tok : totalTok),
        });
    });

    const operations: JobOperation[] = drafts.map((d, k) => {
        const next = drafts[k + 1];
        const group = opChange[k] + pre;
        groups[group].operations.push(k);
        return {
            index: k,
            name: d.name.texts[0],
            notes: d.notes,
            line: d.start.line,
            seq: d.start.seq,
            endSeq: next ? next.start.seq : totalSeq,
            firstMotionLine: d.name.motion ? d.name.motion.line : null,
            firstMotionSeq: d.name.motion ? d.name.motion.seq : null,
            firstMotionText: d.name.motion ? lines[d.name.motion.line].trim() : null,
            group,
            seconds: sumRange(est, d.start.tok, next ? next.start.tok : totalTok),
        };
    });

    return {
        version: 1,
        programName: headerComments[0] ?? '',
        units: units ?? 'mm',
        tools,
        operations,
        groups,
        totalSeq,
        totalSeconds: sumRange(est, 0, totalTok),
    };
};

/** Tool spec for a tool number in any form (5, "5", "T5"), or null. */
export const findToolSpec = (info: JobInfo | null, tool: unknown): ToolSpec | null => {
    if (!info || tool === null || tool === undefined) {
        return null;
    }
    const key = String(tool).trim().replace(/^t\s*/i, '');
    if (!/^\d+$/.test(key)) {
        return null;
    }
    return info.tools[String(Number(key))] ?? null;
};

/** Operations a tool group will run, by name. */
export const groupOperationNames = (info: JobInfo, group: ToolGroup): string[] =>
    group.operations.map((i) => info.operations[i].name);
