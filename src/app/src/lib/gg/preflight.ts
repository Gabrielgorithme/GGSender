/*
 * GGSender addition (not part of upstream gSender).
 *
 * Pre-flight analysis of a G-code program: what the file itself says, before
 * anything about the machine is known. Runs in the visualize worker on every
 * file load; preflightContext.ts adds the checks that need the machine's
 * state and settings.
 *
 * All lengths are reported in mm and feeds in mm/min, whatever units the
 * file uses. Line numbers are 1-based, as shown in the editor.
 *
 * Limits of the analysis, on purpose:
 * - Arcs outside the XY plane (G18, G19) count only their end points.
 * - After G53, G28 or G30 the position is unknown until each axis is set
 *   again by an absolute move; moves from an unknown position are not counted.
 * - Probing moves (G38.x) are not counted.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface PreflightIssue {
    severity: Severity;
    code: string;
    message: string;
    line?: number; // first line concerned
    count?: number; // how many lines are concerned
}

export interface Range3 {
    min: { x: number | null; y: number | null; z: number | null };
    max: { x: number | null; y: number | null; z: number | null };
}

export interface ToolSection {
    tool: string | null; // null: before the first M6, or M6 without a tool number
    changeLine: number | null; // line of the M6; null for the part before it
    comment: string;
    firstLine: number;
    lastLine: number;
    cutMoves: number;
    rapidMoves: number;
    cutZMin: number | null; // deepest feed move end point
    cutZMax: number | null;
    zMax: number | null; // highest point reached, rapids included
    maxFeed: number | null; // mm/min
    spindleSpeeds: number[];
    bounds: Range3;
}

export interface PreflightReport {
    version: 1;
    lines: number;
    units: 'mm' | 'inch' | 'mixed' | 'unknown';
    sections: ToolSection[];
    toolChanges: number;
    bounds: Range3; // all moves, work coordinates
    cutBounds: Range3; // feed moves only
    maxSpindle: number | null;
    usesA: boolean;
    issues: PreflightIssue[];
}

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

const emptyRange = (): Range3 => ({
    min: { x: null, y: null, z: null },
    max: { x: null, y: null, z: null },
});

const extend = (range: Range3, axis: Axis, value: number) => {
    if (range.min[axis] === null || value < range.min[axis]) {
        range.min[axis] = value;
    }
    if (range.max[axis] === null || value > range.max[axis]) {
        range.max[axis] = value;
    }
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const roundRange = (r: Range3): Range3 => {
    const out = emptyRange();
    AXES.forEach((a) => {
        out.min[a] = r.min[a] === null ? null : round3(r.min[a]);
        out.max[a] = r.max[a] === null ? null : round3(r.max[a]);
    });
    return out;
};

const WORD = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
const COMMENT = /\(([^)]*)\)|;(.*)$/g;

interface Counter {
    count: number;
    line: number;
}

const note = (counters: Map<string, Counter>, code: string, line: number) => {
    const c = counters.get(code);
    if (c) {
        c.count++;
    } else {
        counters.set(code, { count: 1, line });
    }
};

/**
 * Points on a circle (centre cx,cy, radius r) where it reaches its extremes
 * in X or Y, if they lie on the arc from angle a0 to a1 in the given
 * direction (cw for G2).
 */
const arcExtremes = (
    cx: number,
    cy: number,
    r: number,
    a0: number,
    a1: number,
    cw: boolean,
    full: boolean,
): Array<[number, number]> => {
    const TWO_PI = Math.PI * 2;
    const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
    const points: Array<[number, number]> = [];
    // sweep measured counter-clockwise from the start
    const sweep = full ? TWO_PI : cw ? norm(a0 - a1) : norm(a1 - a0);
    [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].forEach((angle) => {
        const along = cw ? norm(a0 - angle) : norm(angle - a0);
        if (full || (along > 1e-12 && along < sweep - 1e-12)) {
            points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
        }
    });
    return points;
};

export const analyzeProgram = (content: string): PreflightReport => {
    const text = typeof content === 'string' ? content : '';
    const lines = text.split('\n');

    // modal state
    let motion = 'G0';
    let absolute = true;
    let arcAbsolute = false; // G90.1
    let plane = 17;
    let scale = 1; // 25.4 when G20
    let inverseTime = false;
    let feedDefined = false;
    let feed: number | null = null;
    let spindleOn = false;
    let selectedTool: string | null = null;
    let sawG20 = false;
    let sawG21 = false;
    let usesA = false;
    let maxSpindle: number | null = null;
    const pos: Record<Axis, number | null> = { x: null, y: null, z: null };

    let lastComment = '';
    let lastCommentLine = -10;

    const counters = new Map<string, Counter>();
    const bounds = emptyRange();
    const cutBounds = emptyRange();
    const sections: ToolSection[] = [];
    let toolChanges = 0;

    const newSection = (
        tool: string | null,
        changeLine: number | null,
        comment: string,
        firstLine: number,
    ): ToolSection => ({
        tool,
        changeLine,
        comment,
        firstLine,
        lastLine: firstLine,
        cutMoves: 0,
        rapidMoves: 0,
        cutZMin: null,
        cutZMax: null,
        zMax: null,
        maxFeed: null,
        spindleSpeeds: [],
        bounds: emptyRange(),
    });
    let section = newSection(null, null, '', 1);
    sections.push(section);

    const addPoint = (x: number | null, y: number | null, z: number | null, cut: boolean) => {
        const p = { x, y, z };
        AXES.forEach((a) => {
            if (p[a] === null) {
                return;
            }
            extend(bounds, a, p[a]);
            extend(section.bounds, a, p[a]);
            if (cut) {
                extend(cutBounds, a, p[a]);
            }
        });
        if (z !== null) {
            if (section.zMax === null || z > section.zMax) {
                section.zMax = z;
            }
            if (cut) {
                if (section.cutZMin === null || z < section.cutZMin) {
                    section.cutZMin = z;
                }
                if (section.cutZMax === null || z > section.cutZMax) {
                    section.cutZMax = z;
                }
            }
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i];

        // comments
        let comment = '';
        const bare = raw.replace(COMMENT, (_m, a, b) => {
            const c = (a ?? b ?? '').trim();
            if (c) {
                comment = comment ? `${comment} ${c}` : c;
            }
            return ' ';
        });
        if (comment) {
            lastComment = comment;
            lastCommentLine = lineNo;
        }

        const trimmed = bare.trim();
        if (trimmed === '' || trimmed[0] === '%' || trimmed[0] === '$') {
            continue;
        }

        // words
        const gCodes: number[] = [];
        const mCodes: number[] = [];
        const words: Record<string, number> = {};
        let tWord: string | null = null;
        WORD.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WORD.exec(trimmed)) !== null) {
            const letter = m[1].toUpperCase();
            const value = Number(m[2]);
            if (letter === 'G') {
                gCodes.push(Math.round(value * 10) / 10);
            } else if (letter === 'M') {
                mCodes.push(Math.round(value));
            } else if (letter === 'T') {
                tWord = String(Math.round(value));
            } else if (letter !== 'N') {
                words[letter] = value;
            }
        }

        section.lastLine = lineNo;

        // modal and non-modal G codes
        let nonModal: number | null = null;
        let lineMotion: string | null = null;
        gCodes.forEach((g) => {
            if (g === 0 || g === 1 || g === 2 || g === 3) {
                lineMotion = `G${g}`;
            } else if (g >= 38 && g < 39) {
                lineMotion = 'G38';
            } else if (g === 80) {
                lineMotion = 'G80';
            } else if (g === 90) {
                absolute = true;
            } else if (g === 91) {
                absolute = false;
            } else if (g === 90.1) {
                arcAbsolute = true;
            } else if (g === 91.1) {
                arcAbsolute = false;
            } else if (g === 20) {
                scale = 25.4;
                sawG20 = true;
            } else if (g === 21) {
                scale = 1;
                sawG21 = true;
            } else if (g === 17 || g === 18 || g === 19) {
                plane = g;
            } else if (g === 93) {
                inverseTime = true;
            } else if (g === 94) {
                inverseTime = false;
            } else if ([4, 10, 28, 30, 53, 92, 28.1, 30.1, 92.1, 92.2, 92.3].includes(g)) {
                nonModal = g;
            }
        });
        if (lineMotion) {
            motion = lineMotion;
        }

        // feed and spindle
        if (words.F !== undefined) {
            feedDefined = true;
            feed = inverseTime ? null : words.F * scale;
        }
        if (words.S !== undefined) {
            if (!section.spindleSpeeds.includes(words.S)) {
                section.spindleSpeeds.push(words.S);
            }
            if (maxSpindle === null || words.S > maxSpindle) {
                maxSpindle = words.S;
            }
        }
        if (words.A !== undefined) {
            usesA = true;
        }

        // tool selection and change
        if (tWord !== null) {
            selectedTool = tWord;
        }
        if (mCodes.includes(3) || mCodes.includes(4)) {
            spindleOn = true;
        }
        if (mCodes.includes(5)) {
            spindleOn = false;
        }
        if (mCodes.includes(6)) {
            toolChanges++;
            const tool = selectedTool;
            if (tool === null) {
                note(counters, 'M6_NO_TOOL', lineNo);
            } else if (sections.length > 1 && section.tool === tool) {
                note(counters, 'SAME_TOOL_TWICE', lineNo);
            }
            if (tool !== null && Number(tool) > 255) {
                note(counters, 'TOOL_OVER_255', lineNo);
            }
            const desc = comment || (lineNo - lastCommentLine <= 3 ? lastComment : '');
            section = newSection(tool, lineNo, desc, lineNo);
            sections.push(section);
            // a tool change stops the spindle in gSender's wizards
            spindleOn = false;
        }

        // non-modal codes that move or redefine the position
        if (nonModal === 53) {
            note(counters, 'G53_IN_PROGRAM', lineNo);
            AXES.forEach((a) => {
                if (words[a.toUpperCase()] !== undefined) {
                    pos[a] = null;
                }
            });
            continue;
        }
        if (nonModal === 28 || nonModal === 30) {
            note(counters, 'G28_G30', lineNo);
            AXES.forEach((a) => {
                pos[a] = null;
            });
            continue;
        }
        if (nonModal === 92) {
            note(counters, 'G92', lineNo);
            AXES.forEach((a) => {
                const w = words[a.toUpperCase()];
                if (w !== undefined) {
                    pos[a] = w * scale;
                }
            });
            continue;
        }
        if (nonModal !== null) {
            continue; // G4, G10, ...
        }

        // motion
        const hasAxis =
            words.X !== undefined || words.Y !== undefined || words.Z !== undefined ||
            words.A !== undefined;
        if (!hasAxis || motion === 'G80') {
            continue;
        }
        if (motion === 'G38') {
            AXES.forEach((a) => {
                if (words[a.toUpperCase()] !== undefined) {
                    pos[a] = null; // probing stops wherever it touches
                }
            });
            continue;
        }

        const start = { ...pos };
        const target: Record<Axis, number | null> = { ...pos };
        AXES.forEach((a) => {
            const w = words[a.toUpperCase()];
            if (w === undefined) {
                return;
            }
            if (absolute) {
                target[a] = w * scale;
            } else {
                target[a] = pos[a] === null ? null : pos[a] + w * scale;
            }
        });

        const isCut = motion !== 'G0';
        if (isCut) {
            section.cutMoves++;
            if (!feedDefined && !inverseTime) {
                note(counters, 'FEED_UNDEFINED', lineNo);
            }
            if (feed !== null && (section.maxFeed === null || feed > section.maxFeed)) {
                section.maxFeed = feed;
            }
            if (target.z !== null && target.z < -1e-6 && !spindleOn) {
                note(counters, 'CUT_SPINDLE_OFF', lineNo);
            }
            if (section.changeLine === null && toolChanges === 0) {
                note(counters, 'CUT_BEFORE_M6', lineNo);
            }
        } else {
            section.rapidMoves++;
            if (target.z !== null && target.z < -1e-6) {
                note(counters, 'RAPID_BELOW_ZERO', lineNo);
            }
        }

        addPoint(target.x, target.y, target.z, isCut);

        // arc extremes in the XY plane
        if (
            (motion === 'G2' || motion === 'G3') &&
            plane === 17 &&
            start.x !== null && start.y !== null &&
            target.x !== null && target.y !== null
        ) {
            let cx: number | null = null;
            let cy: number | null = null;
            if (words.R !== undefined) {
                const r = words.R * scale;
                const dx = target.x - start.x;
                const dy = target.y - start.y;
                const d = Math.hypot(dx, dy);
                if (d > 0 && Math.abs(r) >= d / 2 - 1e-9) {
                    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
                    const mx = (start.x + target.x) / 2;
                    const my = (start.y + target.y) / 2;
                    // centre to the right of the chord for G2 (positive R)
                    let sign = motion === 'G2' ? 1 : -1;
                    if (r < 0) {
                        sign = -sign;
                    }
                    cx = mx + (sign * h * dy) / d;
                    cy = my - (sign * h * dx) / d;
                }
            } else if (words.I !== undefined || words.J !== undefined) {
                const ii = (words.I ?? 0) * scale;
                const jj = (words.J ?? 0) * scale;
                cx = arcAbsolute ? ii : start.x + ii;
                cy = arcAbsolute ? jj : start.y + jj;
            }
            if (cx !== null && cy !== null) {
                const radius = Math.hypot(start.x - cx, start.y - cy);
                const a0 = Math.atan2(start.y - cy, start.x - cx);
                const a1 = Math.atan2(target.y - cy, target.x - cx);
                const full =
                    words.R === undefined &&
                    Math.abs(start.x - target.x) < 1e-9 &&
                    Math.abs(start.y - target.y) < 1e-9;
                arcExtremes(cx, cy, radius, a0, a1, motion === 'G2', full).forEach(([x, y]) => {
                    addPoint(x, y, null, true);
                });
            }
        }

        AXES.forEach((a) => {
            pos[a] = target[a];
        });
    }

    // ---- issues -------------------------------------------------------------
    const issues: PreflightIssue[] = [];
    const add = (code: string, severity: Severity, message: (c: Counter) => string) => {
        const c = counters.get(code);
        if (c) {
            issues.push({ severity, code, message: message(c), line: c.line, count: c.count });
        }
    };
    const times = (c: Counter) => (c.count > 1 ? ` (${c.count} lines)` : '');

    add('FEED_UNDEFINED', 'error', (c) =>
        `A feed move comes before the first F word${times(c)}. The controller does not accept it (error:22).`);
    add('CUT_SPINDLE_OFF', 'warning', (c) =>
        `A feed move goes below Z0 when the spindle is off${times(c)}.`);
    add('RAPID_BELOW_ZERO', 'warning', (c) =>
        `A rapid move ends below Z0${times(c)}.`);
    if (toolChanges > 0) {
        add('CUT_BEFORE_M6', 'warning', (c) =>
            `The cut starts before the first tool change${times(c)}. These moves use the tool that is in the spindle.`);
    }
    add('M6_NO_TOOL', 'warning', (c) =>
        `A tool change has no tool number${times(c)}. gSender cannot know which tool to use.`);
    add('SAME_TOOL_TWICE', 'info', (c) =>
        `A tool change selects the tool that is already in use${times(c)}.`);
    add('TOOL_OVER_255', 'info', (c) =>
        `A tool number is above 255${times(c)}. This is not a problem if gSender does not send tool numbers to the controller.`);
    add('G53_IN_PROGRAM', 'info', (c) =>
        `A move uses machine coordinates (G53)${times(c)}. The work extents do not include it.`);
    add('G28_G30', 'info', (c) =>
        `A move goes to a stored machine position (G28/G30)${times(c)}. The work extents do not include it.`);
    add('G92', 'warning', (c) =>
        `G92 in the program changes the work offset${times(c)}.`);
    if (sawG20 && sawG21) {
        issues.push({
            severity: 'warning',
            code: 'MIXED_UNITS',
            message: 'The program uses inches (G20) and millimetres (G21).',
        });
    }

    // drop the part before the first M6 unless it cuts (a retract or a move
    // to the start is normal there); its moves still count in the extents
    const cleaned = sections
        .filter((s, idx) => idx > 0 || s.cutMoves > 0 || sections.length === 1)
        .map((s) => ({
            ...s,
            cutZMin: s.cutZMin === null ? null : round3(s.cutZMin),
            cutZMax: s.cutZMax === null ? null : round3(s.cutZMax),
            zMax: s.zMax === null ? null : round3(s.zMax),
            maxFeed: s.maxFeed === null ? null : round3(s.maxFeed),
            spindleSpeeds: [...s.spindleSpeeds].sort((a, b) => a - b),
            bounds: roundRange(s.bounds),
        }));

    let units: PreflightReport['units'] = 'unknown';
    if (sawG20 && sawG21) {
        units = 'mixed';
    } else if (sawG20) {
        units = 'inch';
    } else if (sawG21) {
        units = 'mm';
    }

    return {
        version: 1,
        lines: lines.length,
        units,
        sections: cleaned,
        toolChanges,
        bounds: roundRange(bounds),
        cutBounds: roundRange(cutBounds),
        maxSpindle,
        usesA,
        issues,
    };
};
