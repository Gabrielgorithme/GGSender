/*
 * GGSender addition (not part of upstream gSender).
 *
 * Side view of a cutting tool, from the numbers in Fusion's tool table
 * (toolSpec.ts). Schematic: the tip and the cutting diameter are drawn to
 * the spec; flute length, neck and shank are not in the file and are drawn
 * at fixed proportions.
 *
 * Coordinates: x from the tool axis outwards, y up from the lowest point of
 * the tool, in drawing units where the cutting radius is R_DRAW. The profile
 * is the right half, from the axis at the bottom to the top of the shank;
 * the renderer mirrors it.
 *
 * Where each diameter is measured (Fusion's definitions):
 * - flat, bull nose, ball, lollipop, thread, drill: the largest diameter.
 * - chamfer mill: D at the top of the cone; the tip diameter is not in the
 *   file, so the tip is drawn pointed. Taper = half angle from the axis.
 * - tapered mill: D at the tip, as if the corner radius were not there (the
 *   corner arc is centred at D/2 - CR); the flank leaves the arc tangent and
 *   widens upwards by the taper angle.
 */
import { ToolKind, ToolSpec } from './toolSpec';

export const R_DRAW = 40;

export interface Pt {
    x: number;
    y: number;
}

export type Dimension =
    // horizontal, between -x and x, measured at height y
    | { kind: 'diameter'; x: number; y: number; label: string }
    // leader from the point at `angle` (degrees, maths convention) on the arc
    | { kind: 'radius'; cx: number; cy: number; r: number; angle: number; label: string }
    // angle between the vertical and the flank, at vertex (x, y), on the right
    | { kind: 'angle'; x: number; y: number; deg: number; r: number; label: string };

export interface ToolProfile {
    kind: ToolKind;
    points: Pt[]; // right half, (0, y0) ... (xTop, height)
    fluteTop: number; // the cutting part is below this height
    height: number;
    halfWidth: number; // largest x
    dims: Dimension[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Points on an arc, from a0 to a1 (degrees), both included. */
export const arcPoints = (cx: number, cy: number, r: number, a0: number, a1: number, steps = 16): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
        const a = rad(a0 + ((a1 - a0) * i) / steps);
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
};

const fmt = (v: number) => String(Number(v.toFixed(3)));

const DEFAULT_CHAMFER_DEG = 45;
const DRILL_HALF_ANGLE = 59; // 118 degree point

/** Profile for a tool spec. Missing numbers fall back to a plain shape. */
export const toolProfile = (spec: Pick<ToolSpec, 'kind' | 'diameter' | 'cornerRadius' | 'taperDeg'>): ToolProfile => {
    const R = R_DRAW;
    const D = spec.diameter;
    const realR = D !== null && D > 0 ? D / 2 : null;
    // corner radius in drawing units, limited to the radius
    const crReal = spec.cornerRadius ?? 0;
    const cr = realR ? Math.min(R, Math.max(0, (crReal / realR) * R)) : 0;
    const dLabel = D !== null ? `⌀${fmt(D)}` : '⌀?';
    const rLabel = `R${fmt(crReal)}`;
    const dims: Dimension[] = [];
    let pts: Pt[] = [];
    let fluteTop = 2.2 * R;
    let shankR = R;
    let height = 3.6 * R;

    switch (spec.kind) {
        case 'ball': {
            pts = arcPoints(0, R, R, -90, 0);
            dims.push({ kind: 'diameter', x: R, y: R, label: dLabel });
            pts.push({ x: R, y: height });
            break;
        }
        case 'bullnose': {
            pts = [{ x: 0, y: 0 }, ...arcPoints(R - cr, cr, cr, -90, 0)];
            dims.push({ kind: 'diameter', x: R, y: cr, label: dLabel });
            if (cr > 0) {
                dims.push({ kind: 'radius', cx: R - cr, cy: cr, r: cr, angle: -45, label: rLabel });
            }
            pts.push({ x: R, y: height });
            break;
        }
        case 'chamfer': {
            const a = spec.taperDeg ?? DEFAULT_CHAMFER_DEG;
            const h = R / Math.tan(rad(a));
            pts = [
                { x: 0, y: 0 },
                { x: R, y: h },
            ];
            fluteTop = h;
            height = h + 2 * R;
            pts.push({ x: R, y: height });
            dims.push({ kind: 'diameter', x: R, y: h, label: dLabel });
            dims.push({ kind: 'angle', x: 0, y: 0, deg: a, r: Math.min(h, R) * 0.9, label: `${fmt(a)}°` });
            break;
        }
        case 'tapered': {
            const a = spec.taperDeg ?? 0;
            const cx = Math.max(R - cr, 0);
            pts = cx > 0 ? [{ x: 0, y: 0 }] : [];
            let start: Pt;
            if (cr > 0) {
                const arc = arcPoints(cx, cr, cr, -90, -a);
                pts.push(...arc);
                start = arc[arc.length - 1];
            } else {
                start = { x: R, y: 0 };
                pts.push(start);
            }
            const xAt = (y: number) => start.x + (y - start.y) * Math.tan(rad(a));
            fluteTop = 2.4 * R;
            shankR = xAt(fluteTop);
            height = fluteTop + 1.2 * R;
            pts.push({ x: shankR, y: fluteTop }, { x: shankR, y: height });
            dims.push({ kind: 'diameter', x: R, y: cr, label: dLabel });
            if (cr > 0 && cr < R * 0.999) {
                dims.push({ kind: 'radius', cx, cy: cr, r: cr, angle: (-90 - a) / 2, label: rLabel });
            }
            if (a > 0) {
                dims.push({ kind: 'angle', x: start.x, y: start.y, deg: a, r: 1.6 * R, label: `${fmt(a)}°` });
            }
            break;
        }
        case 'lollipop': {
            const neck = 0.45 * R;
            const top = Math.acos(neck / R) * (180 / Math.PI); // angle where the ball meets the neck
            // split at the equator so the widest point is drawn exactly
            pts = [...arcPoints(0, R, R, -90, 0, 12), ...arcPoints(0, R, R, 0, top, 12).slice(1)];
            const neckTop = 3.4 * R;
            fluteTop = 2 * R;
            shankR = 0.8 * R;
            height = neckTop + 0.4 * R + 1.2 * R;
            pts.push({ x: neck, y: neckTop }, { x: shankR, y: neckTop + 0.4 * R }, { x: shankR, y: height });
            dims.push({ kind: 'diameter', x: R, y: R, label: dLabel });
            break;
        }
        case 'thread': {
            const root = 0.72 * R;
            const pitch = 0.32 * R;
            const teeth = 4;
            pts = [{ x: 0, y: 0 }, { x: root, y: 0 }];
            for (let k = 0; k < teeth; k++) {
                pts.push({ x: R, y: k * pitch + pitch / 2 }, { x: root, y: (k + 1) * pitch });
            }
            const neck = 0.6 * R;
            const neckTop = teeth * pitch + 1.2 * R;
            fluteTop = teeth * pitch;
            height = neckTop + 0.4 * R + 1.2 * R;
            pts.push({ x: neck, y: teeth * pitch }, { x: neck, y: neckTop }, { x: R, y: neckTop + 0.4 * R }, { x: R, y: height });
            dims.push({ kind: 'diameter', x: R, y: pitch / 2, label: dLabel });
            break;
        }
        case 'drill': {
            const h = R / Math.tan(rad(DRILL_HALF_ANGLE));
            pts = [
                { x: 0, y: 0 },
                { x: R, y: h },
                { x: R, y: height },
            ];
            fluteTop = 2.6 * R;
            dims.push({ kind: 'diameter', x: R, y: h, label: dLabel });
            break;
        }
        case 'flat':
        case 'other':
        default: {
            pts = [
                { x: 0, y: 0 },
                { x: R, y: 0 },
                { x: R, y: height },
            ];
            dims.push({ kind: 'diameter', x: R, y: 0, label: dLabel });
            break;
        }
    }

    const halfWidth = pts.reduce((m, p) => Math.max(m, p.x), 0);
    return { kind: spec.kind, points: pts, fluteTop, height, halfWidth, dims };
};

/** Closed outline: the right half then the mirrored left half. */
export const outlinePoints = (profile: ToolProfile): Pt[] => {
    const right = profile.points;
    const left = right
        .slice()
        .reverse()
        .map((p) => ({ x: -p.x, y: p.y }));
    return [...right, ...left];
};
