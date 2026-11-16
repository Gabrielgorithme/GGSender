/*
 * GGSender addition (not part of upstream gSender).
 *
 * Reads the tool descriptions Fusion's posts write at the top of a program:
 *
 *   (T43 D=4 CR=0 TAPER=45deg - ZMIN=-0.35 - chamfer mill)
 *
 * T number, then KEY=VALUE pairs, then " - " separated parts: more pairs
 * (ZMIN) and the tool type as Fusion names it ("flat end mill", "ball end
 * mill", "bullnose end mill", "chamfer mill", "tapered mill", "lollipop mill",
 * "thread mill", ...). Lengths are in the program's units. TAPER is the half
 * angle, measured from the tool axis (Fusion's definition: 45deg is a 90 degree
 * chamfer tool).
 */

export type ToolKind =
    | 'flat'
    | 'bullnose'
    | 'ball'
    | 'chamfer'
    | 'tapered'
    | 'lollipop'
    | 'thread'
    | 'drill'
    | 'other';

export interface ToolSpec {
    number: string; // "43"
    diameter: number | null;
    cornerRadius: number | null;
    taperDeg: number | null; // half angle from the axis
    zMin: number | null; // deepest Z this tool reaches in the program
    type: string; // as written, e.g. "chamfer mill"; '' when absent
    description: string; // any other text part, e.g. a tool description
    kind: ToolKind;
    text: string; // the whole comment, without parentheses
}

// A comment is a tool table entry when it starts with a T number and has a D=
const TOOL_ENTRY_RE = /^T\s*(\d+)\b(.*\bD\s*=.*)$/i;
const PAIR_RE = /^([A-Za-z]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(deg|°)?$/i;
const PAIRS_RE = /([A-Za-z]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(?:deg|°)?/gi;

const KIND_RULES: Array<[RegExp, ToolKind]> = [
    [/lollipop/i, 'lollipop'],
    [/thread/i, 'thread'],
    [/taper/i, 'tapered'],
    [/chamfer|engrav|counter\s*sink|spot\s*drill|center\s*drill|v-?\s*bit|deburr/i, 'chamfer'],
    [/ball/i, 'ball'],
    [/bull/i, 'bullnose'],
    [/drill/i, 'drill'],
    [/flat|end\s*mill|slot|face/i, 'flat'],
];

const looksLikeType = (text: string) => KIND_RULES.some(([re]) => re.test(text)) || /mill|drill|tap|ream|bor/i.test(text);

/**
 * Kind of drawing for a type name, refined by the numbers: a "flat" tool with
 * a corner radius is drawn with it, a bull nose with CR = D/2 is a ball.
 */
export const classifyTool = (
    type: string,
    diameter: number | null,
    cornerRadius: number | null,
): ToolKind => {
    let kind: ToolKind = 'other';
    for (const [re, k] of KIND_RULES) {
        if (re.test(type)) {
            kind = k;
            break;
        }
    }
    const r = diameter && diameter > 0 ? diameter / 2 : null;
    const cr = cornerRadius ?? 0;
    if ((kind === 'flat' || kind === 'bullnose') && r !== null && cr > 0) {
        kind = cr >= r * 0.999 ? 'ball' : 'bullnose';
    }
    if (kind === 'bullnose' && cr <= 0) {
        kind = 'flat';
    }
    return kind;
};

const toNumber = (text: string): number | null => {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
};

/** Text of a comment without its parentheses or semicolon, trimmed. */
export const commentText = (comment: string) =>
    comment.replace(/^\s*\(/, '').replace(/\)\s*$/, '').replace(/^\s*;/, '').trim();

/** Parse one tool table comment (with or without parentheses). */
export const parseToolSpec = (comment: string): ToolSpec | null => {
    const text = commentText(comment);
    const m = TOOL_ENTRY_RE.exec(text);
    if (!m) {
        return null;
    }
    const pairs: Record<string, number> = {};
    const words: string[] = [];
    for (const part of m[2].split(/\s+-\s+/)) {
        const piece = part.trim();
        if (!piece) {
            continue;
        }
        // a part made only of KEY=VALUE pairs
        const tokens = piece.split(/\s+(?=[A-Za-z]+\s*=)/);
        if (tokens.every((t) => PAIR_RE.test(t.trim()))) {
            PAIRS_RE.lastIndex = 0;
            let pm: RegExpExecArray | null;
            while ((pm = PAIRS_RE.exec(piece)) !== null) {
                const v = toNumber(pm[2]);
                if (v !== null) {
                    pairs[pm[1].toUpperCase()] = v;
                }
            }
        } else {
            words.push(piece);
        }
    }
    const typeIndex = words.findIndex(looksLikeType);
    const type = typeIndex >= 0 ? words[typeIndex] : words.length > 0 ? words[words.length - 1] : '';
    const description = words.filter((w) => w !== type).join(' - ');
    const diameter = pairs.D ?? null;
    const cornerRadius = pairs.CR ?? null;
    const taperRaw = pairs.TAPER ?? null;
    const taperDeg = taperRaw !== null && taperRaw > 0 && taperRaw < 90 ? taperRaw : null;
    return {
        number: String(Number(m[1])),
        diameter: diameter !== null && diameter > 0 ? diameter : null,
        cornerRadius: cornerRadius !== null && cornerRadius >= 0 ? cornerRadius : null,
        taperDeg,
        zMin: pairs.ZMIN ?? null,
        type,
        description,
        kind: classifyTool(type, diameter, cornerRadius),
        text,
    };
};

const num = (v: number) => String(Number(v.toFixed(3)));

/** "⌀4 R0.5 bullnose end mill" — short line for lists. */
export const toolSummary = (spec: ToolSpec): string => {
    const parts: string[] = [];
    if (spec.diameter !== null) {
        parts.push(`⌀${num(spec.diameter)}`);
    }
    const r = spec.diameter !== null ? spec.diameter / 2 : null;
    if (spec.cornerRadius && (r === null || spec.cornerRadius < r * 0.999)) {
        parts.push(`R${num(spec.cornerRadius)}`);
    }
    if (spec.taperDeg !== null) {
        parts.push(`${num(spec.taperDeg)}°`);
    }
    if (spec.type) {
        parts.push(spec.type);
    }
    return parts.join(' ');
};
