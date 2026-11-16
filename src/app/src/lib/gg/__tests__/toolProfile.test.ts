// GGSender: geometry of the tool side view
import { R_DRAW as R, ToolProfile, outlinePoints, toolProfile } from '../toolProfile';
import { ToolKind } from '../toolSpec';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const spec = (kind: ToolKind, diameter: number | null, cornerRadius: number | null, taperDeg: number | null = null) => ({
    kind,
    diameter,
    cornerRadius,
    taperDeg,
});
const dim = (p: ToolProfile, kind: string) => p.dims.filter((d) => d.kind === kind);

describe('GGSender tool profile', () => {
    it('every kind starts on the axis at the bottom and ends at the top', () => {
        const kinds: ToolKind[] = ['flat', 'bullnose', 'ball', 'chamfer', 'tapered', 'lollipop', 'thread', 'drill', 'other'];
        for (const kind of kinds) {
            const p = toolProfile(spec(kind, 6, kind === 'bullnose' ? 1 : kind === 'ball' || kind === 'lollipop' ? 3 : 0, kind === 'chamfer' || kind === 'tapered' ? 10 : null));
            close(p.points[0].x, 0);
            close(p.points[0].y, 0);
            close(p.points[p.points.length - 1].y, p.height);
            expect(p.points.every((pt) => pt.x >= -1e-9)).toBe(true);
            expect(p.fluteTop).toBeGreaterThan(0);
            expect(p.fluteTop).toBeLessThanOrEqual(p.height);
        }
    });

    it('ball: a quarter circle of the tool radius', () => {
        const p = toolProfile(spec('ball', 3, 1.5));
        const arc = p.points.slice(0, -1);
        arc.forEach((pt) => close(Math.hypot(pt.x, pt.y - R), R));
        close(arc[arc.length - 1].x, R);
        close(arc[arc.length - 1].y, R);
        expect(dim(p, 'radius')).toEqual([]); // R = D/2 is implied
        expect(dim(p, 'diameter')[0]).toMatchObject({ label: '⌀3' });
    });

    it('bull nose: corner radius to scale, labelled in file units', () => {
        const p = toolProfile(spec('bullnose', 4, 0.5));
        const cr = R * (0.5 / 2);
        const arc = p.points.slice(1, -1);
        arc.forEach((pt) => close(Math.hypot(pt.x - (R - cr), pt.y - cr), cr));
        close(arc[0].y, 0);
        close(arc[arc.length - 1].x, R);
        expect(dim(p, 'radius')[0]).toMatchObject({ label: 'R0.5', r: cr });
    });

    it('chamfer: cone height from the half angle, D at the top of the cone', () => {
        const p45 = toolProfile(spec('chamfer', 4, 0, 45));
        close(p45.points[1].x, R);
        close(p45.points[1].y, R);
        expect(dim(p45, 'diameter')[0]).toMatchObject({ y: p45.points[1].y, label: '⌀4' });
        expect(dim(p45, 'angle')[0]).toMatchObject({ deg: 45, label: '45°' });
        const p30 = toolProfile(spec('chamfer', 6, 0, 30));
        close(p30.points[1].y, R / Math.tan(Math.PI / 6));
        // no taper in the file: drawn as 90 degrees
        close(toolProfile(spec('chamfer', 6, 0, null)).points[1].y, R);
    });

    it('tapered: corner arc centred at D/2 - CR, flank tangent to it at the taper angle', () => {
        const p = toolProfile(spec('tapered', 12, 2.5, 10));
        const cr = R * (2.5 / 6);
        const cx = R - cr;
        // the arc
        const arc = p.points.filter((pt, i) => i > 0 && pt.y <= cr + 1e-9 && i < p.points.length - 2);
        arc.forEach((pt) => close(Math.hypot(pt.x - cx, pt.y - cr), cr));
        // tangent point and flank direction
        const t = arc[arc.length - 1];
        const top = p.points[p.points.length - 2];
        const flank = { x: top.x - t.x, y: top.y - t.y };
        const normal = { x: t.x - cx, y: t.y - cr };
        close((flank.x * normal.x + flank.y * normal.y) / Math.hypot(flank.x, flank.y) / cr, 0, 1e-9);
        close(Math.atan2(flank.x, flank.y) * (180 / Math.PI), 10, 1e-9);
        // D measured at the tip
        expect(dim(p, 'diameter')[0]).toMatchObject({ x: R, y: cr, label: '⌀12' });
        expect(dim(p, 'radius')[0]).toMatchObject({ label: 'R2.5' });
        expect(dim(p, 'angle')[0]).toMatchObject({ deg: 10 });
        // wider at the top than at the tip
        expect(top.x).toBeGreaterThan(R);
    });

    it('tapered ball (CR = D/2) and sharp tapered (CR = 0)', () => {
        const ball = toolProfile(spec('tapered', 1, 0.5, 5));
        ball.points.slice(0, 5).forEach((pt) => close(Math.hypot(pt.x, pt.y - R), R));
        expect(dim(ball, 'radius')).toEqual([]);
        const sharp = toolProfile(spec('tapered', 6, 0, 5));
        expect(sharp.points[1]).toEqual({ x: R, y: 0 });
        expect(dim(sharp, 'radius')).toEqual([]);
    });

    it('lollipop: a full ball on a narrower neck', () => {
        const p = toolProfile(spec('lollipop', 12, 6));
        const ballPts = p.points.slice(0, 25);
        ballPts.forEach((pt) => close(Math.hypot(pt.x, pt.y - R), R));
        expect(ballPts[ballPts.length - 1].y).toBeGreaterThan(R); // goes past the equator
        expect(p.points[25].x).toBeLessThan(R); // neck
        expect(p.halfWidth).toBeCloseTo(R, 6);
    });

    it('unknown diameter still draws, labelled ⌀?', () => {
        const p = toolProfile(spec('flat', null, null));
        expect(dim(p, 'diameter')[0]).toMatchObject({ label: '⌀?' });
    });

    it('outline is the right half and its mirror', () => {
        const p = toolProfile(spec('bullnose', 6, 1));
        const o = outlinePoints(p);
        expect(o).toHaveLength(p.points.length * 2);
        o.forEach((pt, i) => {
            const m = o[o.length - 1 - i];
            close(pt.x, -m.x);
            close(pt.y, m.y);
        });
    });
});
