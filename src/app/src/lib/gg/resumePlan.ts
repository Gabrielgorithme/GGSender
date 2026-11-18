/*
 * GGSender addition (not part of upstream gSender).
 *
 * Resume a program from a chosen line, the way it is done by hand: keep the
 * program's set-up, go to where the tool was at that line from above, feed
 * down the last part, carry on. Replaces upstream's "Start From" (which
 * rapids straight down to the cut and knows nothing of tools).
 *
 * The program is read from its start to the chosen line to know, at that
 * line: units, distance mode, feed mode, plane, work offset, motion mode,
 * feed, spindle and speed, coolant, tool, and where the tool is (the end of
 * the previous move, which is where the chosen line starts from). Then the
 * entry moves, in program units:
 *
 *   G21 G53 G0 Z<safe>        up to the tool change safe height (machine Z, mm)
 *   G21 G90 G94 G17 G54       the program's modes at that line
 *   T45 M6                    only when a tool is to be fitted or measured
 *   S24000 M3 / G4 P5         spindle as at that line, spin-up wait
 *   M8                        coolant as at that line
 *   G0 X.. Y..                over the start point, at the safe height
 *   G0 Z<retract>             down to the operation's retract height
 *   G1 Z<start> F<plunge>     the rest at the operation's plunge feed
 *   G1 F<feed>                the program's motion mode and feed
 *
 * Why the last part can be fed straight down: the start point is a point the
 * tool reached when the job ran, so the column above it, as wide as the tool,
 * was empty at that moment. It is true when resuming at or before where the
 * job stopped, with a tool of the same diameter. Resuming further on can
 * plunge into material that is still there; the plunge is at the
 * operation's plunge feed for that reason.
 *
 * The server puts these lines in place of the program lines just before the
 * chosen one (src/server/lib/gg/resumeSplice.js), so every line keeps its
 * number: the progress, the operations list and the tool change wizard work
 * as in a normal run.
 */
import { JobInfo, JobOperation } from './jobOperations';

export type Units = 'G20' | 'G21';

export interface Position {
    x: number | null;
    y: number | null;
    z: number | null;
}

export interface ModalState {
    units: Units;
    unitsSeen: boolean;
    distance: 'G90' | 'G91';
    feedMode: 'G93' | 'G94' | 'G95';
    plane: 'G17' | 'G18' | 'G19';
    wcs: string;
    motion: string; // G0 G1 G2 G3 G38.2 ... G80
    feed: number | null;
    spindle: 'M3' | 'M4' | 'M5';
    speed: number | null;
    mist: boolean;
    flood: boolean;
    tool: string | null; // tool in the spindle (last M6)
    nextTool: string | null; // last T word
    pos: Position;
    usesA: boolean;
    tlo: number | null; // G43.1 dynamic tool length offset set by the program; null after G49
    absoluteArcs: boolean; // G90.1 seen (Grbl and FluidNC refuse it)
}

export interface Word {
    letter: string;
    value: number;
    text: string; // as written, e.g. "38.2"
}

const COMMENTS_RE = /\([^)]*\)|;.*$/g;
const WORD_RE = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi;

export const codeOfLine = (raw: string): string => String(raw).replace(COMMENTS_RE, ' ').trim();

export const wordsOf = (raw: string): Word[] => {
    const code = codeOfLine(raw).toUpperCase();
    const out: Word[] = [];
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(code)) !== null) {
        out.push({ letter: m[1].toUpperCase(), value: Number(m[2]), text: m[2] });
    }
    return out;
};

// G01 is "1", G38.2 is "38.2"
const gCode = (w: Word) => String(Number(w.text));

export const initialState = (): ModalState => ({
    units: 'G21',
    unitsSeen: false,
    distance: 'G90',
    feedMode: 'G94',
    plane: 'G17',
    wcs: 'G54',
    motion: 'G0',
    feed: null,
    spindle: 'M5',
    speed: null,
    mist: false,
    flood: false,
    tool: null,
    nextTool: null,
    pos: { x: null, y: null, z: null },
    usesA: false,
    tlo: null,
    absoluteArcs: false,
});

export interface LineEffect {
    moved: boolean; // a move in work coordinates with known result
    motion: string | null; // the motion this line made, if any
    explicitMotion: boolean; // the line has its own G0/G1/G2/G3
    machineMove: boolean; // G53, G28, G30, probing: the position after it is not known
    offsets: boolean; // G10 / G92
    programEnd: boolean; // M2 / M30
    toolChange: boolean;
    from: Position;
    to: Position;
    arc: { cx: number; cy: number; cz: number; plane: string; cw: boolean } | null;
}

const MOTION_CODES = new Set(['0', '1', '2', '3', '38.2', '38.3', '38.4', '38.5', '80']);
const WCS_CODES = new Set(['54', '55', '56', '57', '58', '59', '59.1', '59.2', '59.3']);

/** Apply one line to the state (in place); what it did. */
export const applyLine = (state: ModalState, raw: string): LineEffect => {
    const words = wordsOf(raw);
    const from: Position = { ...state.pos };
    const effect: LineEffect = {
        moved: false,
        motion: null,
        explicitMotion: false,
        machineMove: false,
        offsets: false,
        programEnd: false,
        toolChange: false,
        from,
        to: from,
        arc: null,
    };
    if (words.length === 0) {
        return effect;
    }
    const gs = words.filter((w) => w.letter === 'G').map(gCode);
    const ms = words.filter((w) => w.letter === 'M').map((w) => Number(w.value));
    const get = (l: string) => words.find((w) => w.letter === l);

    // units: convert what is known
    const newUnits = gs.includes('20') ? 'G20' : gs.includes('21') ? 'G21' : null;
    if (newUnits) {
        if (newUnits !== state.units) {
            const k = newUnits === 'G20' ? 1 / 25.4 : 25.4;
            (['x', 'y', 'z'] as const).forEach((a) => {
                const v = state.pos[a];
                state.pos[a] = v === null ? null : v * k;
            });
            if (state.feed !== null) {
                state.feed *= k;
            }
        }
        state.units = newUnits;
        state.unitsSeen = true;
    }
    if (gs.includes('93')) state.feedMode = 'G93';
    if (gs.includes('94')) state.feedMode = 'G94';
    if (gs.includes('95')) state.feedMode = 'G95';
    if (gs.includes('17')) state.plane = 'G17';
    if (gs.includes('18')) state.plane = 'G18';
    if (gs.includes('19')) state.plane = 'G19';
    if (gs.includes('90')) state.distance = 'G90';
    if (gs.includes('91')) state.distance = 'G91';
    gs.filter((g) => WCS_CODES.has(g)).forEach((g) => {
        state.wcs = `G${g}`;
    });

    const f = get('F');
    if (f) state.feed = f.value;
    const s = get('S');
    if (s) state.speed = s.value;
    const t = get('T');
    if (t) state.nextTool = String(Math.trunc(t.value));
    if (ms.includes(6)) {
        state.tool = state.nextTool;
        effect.toolChange = true;
    }
    if (ms.includes(3)) state.spindle = 'M3';
    if (ms.includes(4)) state.spindle = 'M4';
    if (ms.includes(5)) state.spindle = 'M5';
    if (ms.includes(7)) state.mist = true;
    if (ms.includes(8)) state.flood = true;
    if (ms.includes(9)) {
        state.mist = false;
        state.flood = false;
    }
    if (ms.includes(2) || ms.includes(30)) {
        effect.programEnd = true;
    }

    const motionWord = gs.filter((g) => MOTION_CODES.has(g)).pop();
    if (motionWord !== undefined) {
        state.motion = `G${motionWord}`;
        effect.explicitMotion = true;
    }
    const axes = (['X', 'Y', 'Z'] as const).filter((l) => get(l));
    if (get('A') || get('B') || get('C')) {
        state.usesA = true;
    }
    if (gs.includes('90.1')) {
        state.absoluteArcs = true;
    }
    // tool length offset: its Z word is the offset, not a move
    if (gs.includes('49')) {
        state.tlo = null;
    }
    if (gs.includes('43.1')) {
        state.tlo = get('Z')?.value ?? 0;
        return effect;
    }
    if (gs.includes('10') || gs.includes('92') || gs.some((g) => g.startsWith('92.'))) {
        effect.offsets = true;
        return effect;
    }
    const machine = gs.includes('53') || gs.includes('28') || gs.includes('30') || state.motion.startsWith('G38');
    if (gs.includes('28') || gs.includes('30')) {
        // intermediate point, then the stored position: the named axes (all
        // when none is named) end somewhere not known in work coordinates
        effect.machineMove = true;
        const named = axes.length > 0 ? axes : (['X', 'Y', 'Z'] as const);
        const to = { ...state.pos };
        named.forEach((l) => {
            to[l.toLowerCase() as 'x' | 'y' | 'z'] = null;
        });
        state.pos = to;
        effect.to = to;
        return effect;
    }
    if (axes.length === 0 || gs.includes('4')) {
        return effect;
    }
    if (machine) {
        effect.machineMove = true;
        const to = { ...state.pos };
        axes.forEach((l) => {
            to[l.toLowerCase() as 'x' | 'y' | 'z'] = null;
        });
        state.pos = to;
        effect.to = to;
        effect.motion = state.motion;
        return effect;
    }
    if (state.motion === 'G80') {
        return effect;
    }
    const to = { ...state.pos };
    axes.forEach((l) => {
        const k = l.toLowerCase() as 'x' | 'y' | 'z';
        const v = (get(l) as Word).value;
        if (state.distance === 'G90') {
            to[k] = v;
        } else {
            to[k] = to[k] === null ? null : (to[k] as number) + v;
        }
    });
    if ((state.motion === 'G2' || state.motion === 'G3') && from.x !== null && from.y !== null && from.z !== null) {
        const i = get('I')?.value ?? 0;
        const j = get('J')?.value ?? 0;
        const kk = get('K')?.value ?? 0;
        if (!get('R')) {
            effect.arc = {
                cx: from.x + (state.plane === 'G19' ? 0 : i),
                cy: from.y + (state.plane === 'G18' ? 0 : j),
                cz: from.z + (state.plane === 'G17' ? 0 : kk),
                plane: state.plane,
                cw: state.motion === 'G2',
            };
        }
    }
    state.pos = to;
    effect.to = to;
    effect.moved = true;
    effect.motion = state.motion;
    return effect;
};

// ---------------------------------------------------------------------------
// Finding the line

export interface LineIndex {
    lines: string[]; // file lines (split on "\n")
    seqOf: number[]; // sender index of each file line (-1 for blank lines)
    total: number; // non-blank lines
}

export const indexLines = (content: string): LineIndex => {
    const lines = content.split('\n');
    const seqOf: number[] = new Array(lines.length);
    let seq = 0;
    lines.forEach((l, i) => {
        if (l.trim().length === 0) {
            seqOf[i] = -1;
        } else {
            seqOf[i] = seq;
            seq++;
        }
    });
    return { lines, seqOf, total: seq };
};

const N_RE = /^\s*N0*(\d+)(?![0-9])/i;

export const nWordOf = (raw: string): string | null => {
    const m = N_RE.exec(String(raw));
    return m ? `N${m[1]}` : null;
};

export const hasNWords = (content: string, sample = 200): boolean => {
    const lines = content.split('\n');
    let n = 0;
    let code = 0;
    for (let i = 0; i < lines.length && code < sample; i++) {
        if (codeOfLine(lines[i]).length === 0) continue;
        code++;
        if (N_RE.test(lines[i])) n++;
    }
    return code > 0 && n / code > 0.5;
};

/** File lines (0-based) whose N word is `n`. */
export const findN = (content: string, n: number): number[] => {
    const out: number[] = [];
    const lines = content.split('\n');
    lines.forEach((l, i) => {
        const m = N_RE.exec(l);
        if (m && Number(m[1]) === n) out.push(i);
    });
    return out;
};

/**
 * What the owner typed: "N60005" or "60005" (an N number when the program has
 * them), or "L1234" / a number when it has none (a 1-based file line).
 */
export interface ResolvedLine {
    line: number | null;
    how: 'n' | 'line';
    matches: number[];
    error?: string;
}

export const resolveQuery = (content: string, query: string): ResolvedLine => {
    const q = String(query).trim().toUpperCase().replace(/\s+/g, '');
    const lineCount = content.split('\n').length;
    const asLine = (n: number): ResolvedLine =>
        n >= 1 && n <= lineCount
            ? { line: n - 1, how: 'line', matches: [n - 1] }
            : { line: null, how: 'line', matches: [], error: `The file has ${lineCount} lines.` };
    let m = /^L(\d+)$/.exec(q);
    if (m) return asLine(Number(m[1]));
    m = /^N?(\d+)$/.exec(q);
    if (!m) return { line: null, how: 'n', matches: [], error: 'Type an N number (N60005) or a file line (L1234).' };
    const n = Number(m[1]);
    if (q.startsWith('N') || hasNWords(content)) {
        const matches = findN(content, n);
        if (matches.length === 0) {
            return { line: null, how: 'n', matches, error: `No line N${n} in the file.` };
        }
        return { line: matches[0], how: 'n', matches };
    }
    return asLine(n);
};

// ---------------------------------------------------------------------------
// Where the job stopped: the move the tool was on

const distToSegment = (p: number[], a: number[], b: number[]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = len2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
    const d = [a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]];
    return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
};

/** Points along a move (a few for arcs), in x, y, z. */
const movePoints = (e: LineEffect): number[][] => {
    const a = [e.from.x as number, e.from.y as number, e.from.z as number];
    const b = [e.to.x as number, e.to.y as number, e.to.z as number];
    if (!e.arc) return [a, b];
    // the two coordinates of the arc's plane, and the third (helix)
    const idx = e.arc.plane === 'G17' ? [0, 1, 2] : e.arc.plane === 'G18' ? [2, 0, 1] : [1, 2, 0];
    const c = [e.arc.cx, e.arc.cy, e.arc.cz];
    const a0 = Math.atan2(a[idx[1]] - c[idx[1]], a[idx[0]] - c[idx[0]]);
    let a1 = Math.atan2(b[idx[1]] - c[idx[1]], b[idx[0]] - c[idx[0]]);
    const r = Math.hypot(a[idx[0]] - c[idx[0]], a[idx[1]] - c[idx[1]]);
    // G2 is clockwise looking down the third axis (for G18 the sense flips)
    const cw = e.arc.plane === 'G18' ? !e.arc.cw : e.arc.cw;
    if (cw) {
        while (a1 >= a0) a1 -= 2 * Math.PI;
    } else {
        while (a1 <= a0) a1 += 2 * Math.PI;
    }
    const steps = 24;
    const pts: number[][] = [];
    for (let k = 0; k <= steps; k++) {
        const ang = a0 + ((a1 - a0) * k) / steps;
        const p = [0, 0, 0];
        p[idx[0]] = c[idx[0]] + r * Math.cos(ang);
        p[idx[1]] = c[idx[1]] + r * Math.sin(ang);
        p[idx[2]] = a[idx[2]] + ((b[idx[2]] - a[idx[2]]) * k) / steps;
        pts.push(p);
    }
    return pts;
};

export interface NearestMove {
    line: number; // 0-based file line of the move
    seq: number;
    distance: number; // program units
}

/**
 * The move, among the lines with sender index in [fromSeq, toSeq], that
 * passes closest to `pos` (work coordinates, program units). When several
 * pass within `tolerance` of the closest, the latest of them: the job had
 * got furthest along there.
 */
export const nearestMove = (
    content: string,
    pos: { x: number; y: number; z: number },
    fromSeq: number,
    toSeq: number,
    tolerance = 0.05,
): NearestMove | null => {
    const idx = indexLines(content);
    const state = initialState();
    const found: NearestMove[] = [];
    const p = [pos.x, pos.y, pos.z];
    for (let i = 0; i < idx.lines.length; i++) {
        const seq = idx.seqOf[i];
        if (seq < 0) continue;
        if (seq > toSeq) break;
        const e = applyLine(state, idx.lines[i]);
        if (seq < fromSeq || !e.moved) continue;
        if ([e.from.x, e.from.y, e.from.z, e.to.x, e.to.y, e.to.z].some((v) => v === null)) continue;
        const pts = movePoints(e);
        let d = Infinity;
        for (let k = 1; k < pts.length; k++) {
            d = Math.min(d, distToSegment(p, pts[k - 1], pts[k]));
        }
        found.push({ line: i, seq, distance: d });
    }
    if (found.length === 0) return null;
    const best = Math.min(...found.map((f) => f.distance));
    const near = found.filter((f) => f.distance <= best + tolerance);
    return near[near.length - 1];
};

// ---------------------------------------------------------------------------
// The plan

export interface ResumeOptions {
    safeZ: number; // machine Z, mm (tool change safe height)
    measureTool: boolean; // run the tool change before resuming
    spinupSeconds: number;
    rapidDownTo?: number | null; // work Z, program units; null/undefined = from the operation
    plungeFeed?: number | null; // program units/min; null/undefined = from the operation
}

export interface ResumePlan {
    ok: boolean;
    problems: string[]; // the resume cannot be done
    warnings: string[];
    line: number; // 0-based file line the program resumes at
    seq: number;
    text: string;
    nWord: string | null;
    operation: JobOperation | null;
    state: ModalState; // at the start of the line
    start: Position; // where the line starts from (work coordinates)
    rapidDownTo: number | null;
    rapidDownFromOperation: boolean;
    plungeFeed: number | null;
    plungeFromOperation: boolean;
    preamble: string[]; // the entry lines
    target: string | null; // the chosen line rewritten (modal arc), else null
    spliceSeq: number; // sender index of the first entry line
}

const fmt = (v: number, units: Units) => {
    const d = units === 'G20' ? 4 : 3;
    const s = Number(v.toFixed(d));
    return String(Object.is(s, -0) ? 0 : s);
};

/** The operation a file line belongs to. */
export const operationAt = (info: JobInfo | null, seq: number): JobOperation | null => {
    if (!info) return null;
    let found: JobOperation | null = null;
    for (const op of info.operations) {
        if (op.seq <= seq) found = op;
    }
    return found;
};

/**
 * The operation's retract height (its highest rapid Z, in work coordinates)
 * and its plunge feed (the feed of its first straight-down G1), over the
 * whole operation. `startState` is the state at the operation's first line.
 */
const operationHeights = (
    idx: LineIndex,
    op: JobOperation | null,
    startState: ModalState,
): { retract: number | null; plunge: number | null } => {
    if (!op) return { retract: null, plunge: null };
    const state = startState;
    let retract: number | null = null;
    let plunge: number | null = null;
    for (let i = op.line; i < idx.lines.length; i++) {
        const seq = idx.seqOf[i];
        if (seq < 0) continue;
        if (seq >= op.endSeq) break;
        const e = applyLine(state, idx.lines[i]);
        if (!e.moved) continue;
        if (e.motion === 'G0' && e.to.z !== null && (e.from.z === null || e.to.z !== e.from.z)) {
            retract = retract === null ? e.to.z : Math.max(retract, e.to.z);
        }
        const xyStill = e.to.x === e.from.x && e.to.y === e.from.y;
        if (plunge === null && e.motion === 'G1' && xyStill && e.from.z !== null && e.to.z !== null && e.to.z < e.from.z) {
            const f = wordsOf(idx.lines[i]).find((w) => w.letter === 'F');
            if (f) plunge = f.value;
        }
    }
    return { retract, plunge };
};

export const planResume = (
    content: string,
    info: JobInfo | null,
    line: number,
    options: ResumeOptions,
): ResumePlan => {
    const idx = indexLines(content);
    const problems: string[] = [];
    const warnings: string[] = [];

    // the line to resume at: the first line with code from `line` on
    let target = Math.max(0, Math.floor(line));
    while (target < idx.lines.length && codeOfLine(idx.lines[target]).length === 0) {
        target++;
    }
    const state = initialState();
    const empty: ResumePlan = {
        ok: false,
        problems,
        warnings,
        line: target,
        seq: -1,
        text: '',
        nWord: null,
        operation: null,
        state,
        start: { x: null, y: null, z: null },
        rapidDownTo: null,
        rapidDownFromOperation: false,
        plungeFeed: null,
        plungeFromOperation: false,
        preamble: [],
        target: null,
        spliceSeq: -1,
    };
    if (target >= idx.lines.length) {
        problems.push('There is no code from that line to the end of the file.');
        return empty;
    }

    // the program up to the line
    let firstMove = -1;
    let stateAtOpStart: ModalState | null = null;
    const seq = idx.seqOf[target];
    const op = operationAt(info, seq);
    let macros = false;
    for (let i = 0; i < target; i++) {
        if (op && i === op.line) {
            stateAtOpStart = JSON.parse(JSON.stringify(state));
        }
        const raw = idx.lines[i];
        const code = codeOfLine(raw);
        if (code.length === 0) continue;
        if (code.startsWith('%') || code.startsWith('$') || /\[/.test(code)) {
            macros = true;
            continue;
        }
        const e = applyLine(state, raw);
        if (e.offsets) {
            problems.push(`Line ${i + 1} changes the work offsets (G10/G92). Resume From cannot set these offsets again.`);
        }
        if (e.programEnd) {
            problems.push(`The program ends at line ${i + 1} (M2/M30), before this line.`);
        }
        if (e.moved && firstMove < 0) firstMove = i;
    }
    if (op && op.line === target) {
        stateAtOpStart = JSON.parse(JSON.stringify(state));
    }
    const text = idx.lines[target].trim();
    const plan: ResumePlan = {
        ...empty,
        line: target,
        seq,
        text,
        nWord: nWordOf(text),
        operation: op,
        state,
        start: { ...state.pos },
    };

    if (firstMove < 0) {
        problems.push('This line is at or before the first move of the program. Start the job with Start.');
    }
    if (wordsOf(text).some((w) => w.letter === 'M' && w.value === 6)) {
        problems.push(
            'This line is a tool change. Select the first move of the next operation. Then select tool option 2.',
        );
    }
    if (macros) {
        warnings.push('The program has gSender macros or expressions (% $ [ ]) before this line. Resume From does not run them.');
    }
    if (state.usesA || wordsOf(text).some((w) => ['A', 'B', 'C'].includes(w.letter))) {
        problems.push('Resume From cannot resume rotary programs (A axis).');
    }
    if (state.distance === 'G91') {
        problems.push('Incremental distance mode (G91) is on at this line. Resume From needs absolute coordinates (G90).');
    }
    if (state.feedMode !== 'G94') {
        problems.push(`Feed mode ${state.feedMode} is on at this line. Resume From can use only G94 (units per minute).`);
    }
    if (state.absoluteArcs) {
        problems.push('The program uses G90.1 (absolute arc centres). Grbl and FluidNC do not accept it.');
    }
    if (state.motion.startsWith('G38') || state.motion === 'G80') {
        problems.push(`Motion mode ${state.motion} is on at this line.`);
    }
    if (!state.unitsSeen) {
        warnings.push('The program does not set the units before this line. Resume From uses millimetres (G21).');
    }
    if (options.measureTool && state.tool === null && state.nextTool === null) {
        warnings.push('The program does not select a tool before this line. The tool change has no tool number.');
    }

    // where to come down
    const { units } = state;
    const start = plan.start;
    const heights = operationHeights(idx, op, stateAtOpStart ?? initialState());
    const rapidOption = options.rapidDownTo;
    const rapidDownTo =
        rapidOption !== undefined && rapidOption !== null && Number.isFinite(rapidOption) ? rapidOption : heights.retract;
    plan.rapidDownTo = rapidDownTo;
    plan.rapidDownFromOperation = !(rapidOption !== undefined && rapidOption !== null && Number.isFinite(rapidOption)) && heights.retract !== null;
    const plungeOption = options.plungeFeed;
    const plungeFeed =
        plungeOption !== undefined && plungeOption !== null && Number.isFinite(plungeOption) && plungeOption > 0
            ? plungeOption
            : heights.plunge ?? state.feed;
    plan.plungeFeed = plungeFeed;
    plan.plungeFromOperation = !(plungeOption !== undefined && plungeOption !== null && plungeOption > 0) && heights.plunge !== null;

    if (start.x === null || start.y === null) {
        warnings.push('X/Y at this line is not known, because a move in machine coordinates or a homing move comes before it. The machine stays at its X/Y position. The line moves it.');
    }
    if (start.z === null) {
        warnings.push('Z at this line is not known, because a move in machine coordinates or a homing move comes before it. The machine stays at the safe height. The program moves Z down.');
    } else if (rapidDownTo === null) {
        warnings.push('This operation has no retract height. The machine goes down from the safe height at the plunge feed.');
    }
    if (start.z !== null && plungeFeed === null) {
        problems.push('The feed for the move down is not known. Enter a plunge feed.');
    }

    // the entry lines
    const pre: string[] = [];
    const where = [`line ${target + 1}`, plan.nWord, op ? `"${op.name}"` : null].filter(Boolean).join(' ');
    pre.push(`(GGSender resume at ${where.replace(/[()]/g, '')})`);
    pre.push(`G21 G53 G0 Z${fmt(options.safeZ, 'G21')}`);
    const modes = `${units} G90 ${state.feedMode} ${state.plane} ${state.wcs}`;
    pre.push(modes);
    const tool = state.tool ?? state.nextTool;
    if (options.measureTool) {
        pre.push(tool !== null ? `T${tool} M6` : 'M6');
        // again after the tool change wizard, whatever it leaves set
        pre.push(modes);
    }
    if (state.tlo !== null) {
        pre.push(`G43.1 Z${fmt(state.tlo, units)}`);
    }
    if (state.spindle !== 'M5') {
        pre.push(state.speed !== null ? `S${fmt(state.speed, 'G21')} ${state.spindle}` : state.spindle);
        if (state.speed === null) {
            warnings.push('The spindle is on at this line, but the program sets no speed (S) before it.');
        }
        if (options.spinupSeconds > 0) {
            pre.push(`G4 P${fmt(options.spinupSeconds, 'G21')}`);
        }
    }
    if (state.flood) pre.push('M8');
    if (state.mist) pre.push('M7');
    const xy = [start.x !== null ? `X${fmt(start.x, units)}` : '', start.y !== null ? `Y${fmt(start.y, units)}` : '']
        .filter(Boolean)
        .join(' ');
    if (xy) pre.push(`G0 ${xy}`);
    if (start.z !== null) {
        if (rapidDownTo !== null && rapidDownTo > start.z) {
            pre.push(`G0 Z${fmt(rapidDownTo, units)}`);
            pre.push(`G1 Z${fmt(start.z, units)} F${fmt(plungeFeed ?? 0, units)}`);
        } else if (rapidDownTo !== null) {
            pre.push(`G0 Z${fmt(start.z, units)}`);
        } else {
            pre.push(`G1 Z${fmt(start.z, units)} F${fmt(plungeFeed ?? 0, units)}`);
        }
    }
    // the program's motion mode and feed, as the line expects them
    const lineWords = wordsOf(text);
    const lineHasMotion = lineWords.some((w) => w.letter === 'G' && MOTION_CODES.has(gCode(w)));
    const feed = state.feed !== null ? ` F${fmt(state.feed, units)}` : '';
    if (state.motion === 'G1') {
        pre.push(`G1${feed}`.trim());
    } else if (state.motion === 'G0') {
        pre.push(`G0${feed}`);
    } else if (state.motion === 'G2' || state.motion === 'G3') {
        if (feed) pre.push(feed.trim());
        if (!lineHasMotion) {
            // FluidNC and Grbl refuse G2/G3 without an arc: the motion word
            // goes on the line itself, after its N word
            const m = /^(N\d+)\s*(.*)$/i.exec(text);
            plan.target = m ? `${m[1]} ${state.motion} ${m[2]}` : `${state.motion} ${text}`;
        }
    }
    if (state.feed === null && state.motion !== 'G0') {
        warnings.push('The program sets no feed (F) before this line.');
    }

    plan.preamble = pre;
    const count = pre.length + (plan.target ? 1 : 0);
    const firstUntouched = plan.target ? seq + 1 : seq;
    plan.spliceSeq = firstUntouched - count;
    if (plan.spliceSeq < 0) {
        problems.push('This line is too near the start of the program. There is not sufficient space for the entry lines before it. Start the job with Start.');
    }
    plan.ok = problems.length === 0;
    return plan;
};

/**
 * What the server needs (see src/server/lib/gg/resumeSplice.js).
 * @param toolMode  what the tool change of the entry lines does
 *                  (lib/gg/resumeToolChoice.ts); 'keep' when there is none
 */
export const resumePayload = (plan: ResumePlan, total: number, toolMode: string | boolean) => {
    // a boolean is the 0.7.0 form: measure or keep
    const mode = typeof toolMode === 'string' ? toolMode : toolMode ? 'measure' : 'keep';
    return {
        seq: plan.seq,
        text: plan.text,
        total,
        preamble: plan.preamble,
        target: plan.target,
        toolMode: mode,
        measureTool: mode !== 'keep',
    };
};
