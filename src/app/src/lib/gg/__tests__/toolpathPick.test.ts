import {
    lineForVertex,
    nearestDrawnLine,
    nearestSegmentOnScreen,
    stepDrawnLine,
    vertexRangeForLine,
    vertexRangeForLineSpan,
} from '../toolpathPick';

/*
 * A small program, as the worker records it:
 *
 *   0  (header)            no entry (comment)
 *   1  G21                 draws nothing
 *   2  G0 X10              vertices 0,1
 *   3                      no entry (blank)
 *   4  G1 Y10 F100         vertices 2,3
 *   5  M3 S1000            draws nothing
 *   6  G2 X0 Y0 I-5 J-5    vertices 4..9 (arc in 3 pieces)
 *   7  G1 X5               vertices 10,11
 */
const frames = Uint32Array.from([0, 2, 4, 4, 10, 12]);
const frameLines = Uint32Array.from([1, 2, 4, 5, 6, 7]);

describe('GGSender: toolpath vertex to file line', () => {
    it('finds the line that drew each vertex', () => {
        expect(lineForVertex(frames, frameLines, 0)).toBe(2);
        expect(lineForVertex(frames, frameLines, 1)).toBe(2);
        expect(lineForVertex(frames, frameLines, 2)).toBe(4);
        expect(lineForVertex(frames, frameLines, 4)).toBe(6);
        expect(lineForVertex(frames, frameLines, 9)).toBe(6);
        expect(lineForVertex(frames, frameLines, 10)).toBe(7);
        expect(lineForVertex(frames, frameLines, 11)).toBe(7);
    });
    it('returns null outside the drawing or for bad input', () => {
        expect(lineForVertex(frames, frameLines, 12)).toBeNull();
        expect(lineForVertex(frames, frameLines, -1)).toBeNull();
        expect(lineForVertex(frames, frameLines, 1.5)).toBeNull();
        expect(lineForVertex(frames, Uint32Array.from([1]), 0)).toBeNull();
    });
});

describe('GGSender: file line to toolpath vertices', () => {
    it('gives the vertices a line drew', () => {
        expect(vertexRangeForLine(frames, frameLines, 2)).toEqual({ start: 0, end: 2 });
        expect(vertexRangeForLine(frames, frameLines, 4)).toEqual({ start: 2, end: 4 });
        expect(vertexRangeForLine(frames, frameLines, 6)).toEqual({ start: 4, end: 10 });
        expect(vertexRangeForLine(frames, frameLines, 7)).toEqual({ start: 10, end: 12 });
    });
    it('returns null for lines that drew nothing', () => {
        expect(vertexRangeForLine(frames, frameLines, 0)).toBeNull();
        expect(vertexRangeForLine(frames, frameLines, 1)).toBeNull();
        expect(vertexRangeForLine(frames, frameLines, 3)).toBeNull();
        expect(vertexRangeForLine(frames, frameLines, 5)).toBeNull();
        expect(vertexRangeForLine(frames, frameLines, 99)).toBeNull();
    });
    it('is the inverse of lineForVertex', () => {
        for (let v = 0; v < 12; v++) {
            const line = lineForVertex(frames, frameLines, v);
            const range = vertexRangeForLine(frames, frameLines, line);
            expect(v).toBeGreaterThanOrEqual(range.start);
            expect(v).toBeLessThan(range.end);
        }
    });
});

describe('GGSender: file lines to toolpath vertices (one operation alone)', () => {
    it('gives the vertices of all moves of the lines, end line not included', () => {
        // lines 2 to 4: G0 X10 and G1 Y10
        expect(vertexRangeForLineSpan(frames, frameLines, 2, 5)).toEqual({ start: 0, end: 4 });
        // lines 4 to 6: G1 Y10, M3, the arc
        expect(vertexRangeForLineSpan(frames, frameLines, 4, 7)).toEqual({ start: 2, end: 10 });
        // from the arc to the end of the file
        expect(vertexRangeForLineSpan(frames, frameLines, 6, null)).toEqual({ start: 4, end: 12 });
        // the whole file
        expect(vertexRangeForLineSpan(frames, frameLines, 0, null)).toEqual({ start: 0, end: 12 });
    });

    it('starts and ends on lines without an entry (comments, blank lines)', () => {
        // line 3 is blank, line 0 a comment: the moves between are found
        expect(vertexRangeForLineSpan(frames, frameLines, 3, 6)).toEqual({ start: 2, end: 4 });
        expect(vertexRangeForLineSpan(frames, frameLines, 0, 3)).toEqual({ start: 0, end: 2 });
    });

    it('the ranges of lines that follow each other join without a gap or an overlap', () => {
        const a = vertexRangeForLineSpan(frames, frameLines, 0, 5);
        const b = vertexRangeForLineSpan(frames, frameLines, 5, 7);
        const c = vertexRangeForLineSpan(frames, frameLines, 7, null);
        expect(a.end).toBe(b.start);
        expect(b.end).toBe(c.start);
        expect(c.end).toBe(frames[frames.length - 1]);
    });

    it('is null when the lines drew nothing, or for bad input', () => {
        expect(vertexRangeForLineSpan(frames, frameLines, 0, 2)).toBeNull(); // comment and G21
        expect(vertexRangeForLineSpan(frames, frameLines, 5, 6)).toBeNull(); // M3 alone
        expect(vertexRangeForLineSpan(frames, frameLines, 8, null)).toBeNull(); // after the file
        expect(vertexRangeForLineSpan(frames, frameLines, 4, 4)).toBeNull(); // no line
        expect(vertexRangeForLineSpan(frames, frameLines, 6, 2)).toBeNull();
        expect(vertexRangeForLineSpan(frames, frameLines, -1, 4)).toBeNull();
        expect(vertexRangeForLineSpan(frames, Uint32Array.from([1]), 0, null)).toBeNull();
    });
});

describe('GGSender: stepping through moves', () => {
    it('skips lines that drew nothing', () => {
        expect(stepDrawnLine(frames, frameLines, 2, 1)).toBe(4);
        expect(stepDrawnLine(frames, frameLines, 4, 1)).toBe(6);
        expect(stepDrawnLine(frames, frameLines, 6, -1)).toBe(4);
        expect(stepDrawnLine(frames, frameLines, 5, -1)).toBe(4);
        expect(stepDrawnLine(frames, frameLines, 0, 1)).toBe(2);
    });
    it('stops at the ends', () => {
        expect(stepDrawnLine(frames, frameLines, 7, 1)).toBeNull();
        expect(stepDrawnLine(frames, frameLines, 2, -1)).toBeNull();
    });
    it('finds the closest drawn line for a line without motion', () => {
        expect(nearestDrawnLine(frames, frameLines, 6)).toBe(6);
        expect(nearestDrawnLine(frames, frameLines, 5)).toBe(4);
        expect(nearestDrawnLine(frames, frameLines, 0)).toBe(2);
        expect(nearestDrawnLine(frames, frameLines, 50)).toBe(7);
    });
});

describe('GGSender: nearest segment on screen', () => {
    // A projection that maps x,y in [-1,1] straight to the screen
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const W = 200;
    const H = 200;
    // screen x = (x+1)*100, screen y = (1-y)*100
    const positions = Float32Array.from([
        -0.5, 0, 0, 0.5, 0, 0, // move 0: horizontal through the centre
        0.5, 0, 0, 0.5, 0.5, 0, // move 1: vertical, right side, going up
    ]);

    it('picks the segment under the cursor', () => {
        expect(nearestSegmentOnScreen(positions, identity, W, H, 100, 102)).toEqual({ vertexIndex: 0, distance: 2 });
        expect(nearestSegmentOnScreen(positions, identity, W, H, 153, 70)).toEqual({ vertexIndex: 2, distance: 3 });
    });

    it('returns nothing when the click is too far away', () => {
        expect(nearestSegmentOnScreen(positions, identity, W, H, 100, 140)).toBeNull();
        expect(nearestSegmentOnScreen(positions, identity, W, H, 100, 140, 50)).not.toBeNull();
    });

    it('finds every segment of an arc, whatever its number of points', () => {
        // an arc drawn with 3 points (2 segments), then a straight move:
        // the straight move starts on an odd vertex
        const withArc = Float32Array.from([
            -0.8, 0, 0, -0.6, 0.2, 0, -0.4, 0, 0, // arc: vertices 0, 1, 2
            -0.4, 0, 0, 0.4, 0, 0, // move: vertices 3, 4
        ]);
        // screen x = (x+1)/2*200, y = (1-y)/2*200
        // middle of the arc's second segment (-0.5, 0.1) -> (50, 90)
        expect(nearestSegmentOnScreen(withArc, identity, W, H, 50, 90).vertexIndex).toBe(1);
        // middle of its first segment (-0.7, 0.1) -> (30, 90)
        expect(nearestSegmentOnScreen(withArc, identity, W, H, 30, 90).vertexIndex).toBe(0);
        // middle of the straight move (0, 0) -> (100, 100)
        expect(nearestSegmentOnScreen(withArc, identity, W, H, 100, 100).vertexIndex).toBe(3);
    });

    it('a click on the point shared by two moves gives the later move', () => {
        // positions: move 0 = vertices 0-1, move 1 = vertices 2-3, sharing a point
        const hit = nearestSegmentOnScreen(positions, identity, W, H, 150, 100);
        expect(hit.vertexIndex).toBe(2);
    });

    it('prefers the later of two overlapping moves', () => {
        const overlap = Float32Array.from([
            -0.5, 0, 0, 0.5, 0, 0,
            -0.5, 0, 0, 0.5, 0, 0,
        ]);
        expect(nearestSegmentOnScreen(overlap, identity, W, H, 100, 100).vertexIndex).toBe(2);
    });

    it('searches only the vertices asked for', () => {
        // the click is on the first move; limited to the second move, that one is too far
        expect(nearestSegmentOnScreen(positions, identity, W, H, 100, 102, 8, 4, 2)).toBeNull();
        // with more distance allowed the hit is in the range, numbered in the whole list
        const hit = nearestSegmentOnScreen(positions, identity, W, H, 100, 102, 200, 4, 2);
        expect(hit.vertexIndex).toBe(2);
        // limited to the first move, a click on the second finds nothing
        expect(nearestSegmentOnScreen(positions, identity, W, H, 153, 70, 8, 2, 0)).toBeNull();
        // no limits: as before
        expect(nearestSegmentOnScreen(positions, identity, W, H, 153, 70, 8, 4, 0)).toEqual({ vertexIndex: 2, distance: 3 });
    });

    it('skips points behind the camera', () => {
        // w = -z + 1 -> points with z > 1 are behind
        const persp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 1];
        const behind = Float32Array.from([-0.5, 0, 2, 0.5, 0, 2]);
        expect(nearestSegmentOnScreen(behind, persp, W, H, 100, 100)).toBeNull();
    });

    it('handles empty or degenerate input', () => {
        expect(nearestSegmentOnScreen(new Float32Array(0), identity, W, H, 0, 0)).toBeNull();
        expect(nearestSegmentOnScreen(positions, identity, 0, H, 0, 0)).toBeNull();
    });

    it('is fast enough for a large file', () => {
        const n = 2_000_000; // vertices, about one million moves
        const big = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            big[i * 3] = Math.sin(i) * 0.9;
            big[i * 3 + 1] = Math.cos(i * 1.3) * 0.9;
        }
        const t0 = Date.now();
        nearestSegmentOnScreen(big, identity, 1000, 800, 500, 400);
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});
