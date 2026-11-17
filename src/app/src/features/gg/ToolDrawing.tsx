/*
 * GGSender addition (not part of upstream gSender).
 *
 * Side view of a tool from Fusion's tool table, with its diameter, corner
 * radius and taper angle. Geometry in lib/gg/toolProfile.ts. `compact` draws
 * the outline only, for lists.
 */
import { ReactElement, useRef } from 'react';
import { ToolSpec } from 'app/lib/gg/toolSpec';
import { Dimension, Pt, R_DRAW, outlinePoints, toolProfile } from 'app/lib/gg/toolProfile';

let instances = 0;

interface Props {
    spec: Pick<ToolSpec, 'kind' | 'diameter' | 'cornerRadius' | 'taperDeg'>;
    height?: number; // px
    compact?: boolean;
    className?: string;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export const ToolDrawing = ({ spec, height = 150, compact = false, className = '' }: Props) => {
    const idRef = useRef<string>('');
    if (!idRef.current) {
        instances += 1;
        idRef.current = `gg-tool-${instances}`;
    }
    const clipId = `${idRef.current}-clip`;
    const profile = toolProfile(spec);
    const R = R_DRAW;

    // Text, arrows and lines keep the same size on screen whatever height the
    // drawing is shown at (text about 12 px): one k unit is the same number
    // of pixels at any height. The margins hold the labels, so they grow with
    // k; the bottom one is solved for, since k depends on the total height.
    const c = 150 / 230 / height; // k per drawing unit of total height
    const top = compact ? 2 : 8;
    const labelDepth = 46; // diameter label below the tool, in k units
    const bottom = compact
        ? 2
        : labelDepth * c < 0.9
          ? Math.max(40, (labelDepth * c * (top + profile.height)) / (1 - labelDepth * c))
          : 50;
    const vbH = top + profile.height + bottom;
    const k = vbH * c;
    // room on the right only for the radius and angle labels
    const sideLabels = profile.dims.some((d) => d.kind !== 'diameter');
    const m = compact
        ? { left: 4, right: 4, top, bottom }
        : { left: 16, right: sideLabels ? Math.max(60, 74 * k) : 16, top, bottom };
    const half = Math.max(profile.halfWidth, R);
    const vbW = m.left + 2 * half + m.right;
    const ox = m.left + half; // svg x of the axis
    const oy = m.top + profile.height; // svg y of the tool's lowest point
    const font = 18 * k;
    const sx = (x: number) => ox + x;
    const sy = (y: number) => oy - y;
    const ptsAttr = (pts: Pt[]) => pts.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' ');
    const outline = outlinePoints(profile);

    const arrow = (x: number, y: number, dirX: number, dirY: number, key: string) => {
        const len = 7 * k;
        const w = 3 * k;
        const nx = -dirY;
        const ny = dirX;
        const bx = x - dirX * len;
        const by = y - dirY * len;
        return (
            <polygon
                key={key}
                points={`${x},${y} ${bx + nx * w},${by + ny * w} ${bx - nx * w},${by - ny * w}`}
                fill="currentColor"
                stroke="none"
            />
        );
    };

    const renderDim = (d: Dimension, i: number) => {
        if (d.kind === 'diameter') {
            const yLine = oy + 16 * k;
            const xl = sx(-d.x);
            const xr = sx(d.x);
            const yFrom = sy(d.y) + 2 * k;
            return (
                <g key={`d${i}`} data-testid="gg-tool-dim-diameter">
                    <line x1={xl} y1={yFrom} x2={xl} y2={yLine + 5 * k} />
                    <line x1={xr} y1={yFrom} x2={xr} y2={yLine + 5 * k} />
                    <line x1={xl} y1={yLine} x2={xr} y2={yLine} />
                    {arrow(xl, yLine, -1, 0, 'al')}
                    {arrow(xr, yLine, 1, 0, 'ar')}
                    <text x={ox} y={yLine + 6 * k + font} textAnchor="middle" fontSize={font * 1.1} fontWeight="bold" stroke="none" fill="currentColor">
                        {d.label}
                    </text>
                </g>
            );
        }
        if (d.kind === 'radius') {
            const a = rad(d.angle);
            const px = sx(d.cx + d.r * Math.cos(a));
            const py = sy(d.cy + d.r * Math.sin(a));
            const ux = Math.cos(a);
            const uy = -Math.sin(a);
            const ex = px + ux * 26 * k;
            const ey = py + uy * 26 * k;
            const tx = Math.max(ex, sx(half) + 4 * k);
            return (
                <g key={`r${i}`} data-testid="gg-tool-dim-radius">
                    <polyline points={`${px},${py} ${ex},${ey} ${tx + 6 * k},${ey}`} fill="none" />
                    {arrow(px, py, -ux, -uy, 'a')}
                    <text x={tx + 8 * k} y={ey + font * 0.35} fontSize={font} stroke="none" fill="currentColor">
                        {d.label}
                    </text>
                </g>
            );
        }
        // angle between the vertical through the vertex and the flank
        const vx = sx(d.x);
        const vy = sy(d.y);
        const r = d.r;
        const endX = vx + r * Math.sin(rad(d.deg));
        const endY = vy - r * Math.cos(rad(d.deg));
        return (
            <g key={`a${i}`} data-testid="gg-tool-dim-angle">
                <line x1={vx} y1={vy} x2={vx} y2={vy - r * 1.08} strokeDasharray={`${3 * k} ${3 * k}`} />
                <path d={`M ${vx} ${vy - r} A ${r} ${r} 0 0 1 ${endX} ${endY}`} fill="none" />
                <text x={endX + 7 * k} y={endY + font * 0.9} fontSize={font} stroke="none" fill="currentColor">
                    {d.label}
                </text>
            </g>
        );
    };

    // flute marks: slanted lines across the cutting part
    const flutes: ReactElement[] = [];
    if (!compact && profile.kind !== 'thread') {
        const slope = Math.tan(rad(30));
        const step = 0.7 * R;
        for (let x0 = -half - profile.fluteTop * slope; x0 < half; x0 += step) {
            flutes.push(
                <line
                    key={x0}
                    x1={sx(x0)}
                    y1={sy(0)}
                    x2={sx(x0 + profile.fluteTop * slope)}
                    y2={sy(profile.fluteTop)}
                    strokeOpacity={0.35}
                />,
            );
        }
    }

    return (
        <svg
            viewBox={`0 0 ${vbW.toFixed(2)} ${vbH.toFixed(2)}`}
            height={height}
            width={(height * vbW) / vbH}
            className={className}
            role="img"
            aria-label={`${spec.kind} tool`}
            data-testid="gg-tool-drawing"
            data-kind={profile.kind}
        >
            <defs>
                <clipPath id={clipId}>
                    <polygon points={ptsAttr(outline)} />
                </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`} stroke="currentColor" strokeWidth={1.2 * k}>
                <rect x={0} y={sy(profile.height)} width={vbW} height={profile.height - profile.fluteTop} fill="currentColor" fillOpacity={0.1} stroke="none" />
                <rect x={0} y={sy(profile.fluteTop)} width={vbW} height={profile.fluteTop} fill="currentColor" fillOpacity={0.28} stroke="none" />
                {flutes}
            </g>
            <polygon
                points={ptsAttr(outline)}
                fill="none"
                stroke="currentColor"
                strokeWidth={(compact ? 2.5 : 1.6) * k}
                strokeLinejoin="round"
                data-testid="gg-tool-outline"
            />
            {!compact && (
                <g className="text-sky-600 dark:text-sky-400" stroke="currentColor" strokeWidth={1 * k}>
                    {profile.dims.map(renderDim)}
                </g>
            )}
        </svg>
    );
};

export default ToolDrawing;
