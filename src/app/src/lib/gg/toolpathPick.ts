/*
 * GGSender addition (not part of upstream gSender).
 *
 * Links points of the drawn toolpath to lines of the G-code file, both ways.
 *
 * The visualize worker puts every move into one long vertex list, drawn as a
 * single continuous line (THREE.Line): a straight move adds two vertices
 * (start, end), an arc adds one vertex per point along it (5 to 26). For
 * every line that the parser reports it records two numbers:
 *   frames[k]      how many vertices exist after that line was processed
 *   frameLines[k]  the 0-based line number of that line in the file
 * So the vertices drawn by the line frameLines[k] are
 *   [frames[k-1], frames[k])          (frames[-1] counts as 0)
 * Both arrays are in file order, so both lookups are binary searches.
 *
 * Lines that draw nothing (comments, blank lines, F or S alone, M3...) either
 * have no entry or an empty range.
 */

type NumArray = ArrayLike<number>;

/** First index k with array[k] > value, or array.length. */
export const upperBound = (array: NumArray, value: number): number => {
    let lo = 0;
    let hi = array.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (array[mid] > value) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
};

/** First index k with array[k] >= value, or array.length. */
export const lowerBound = (array: NumArray, value: number): number => {
    let lo = 0;
    let hi = array.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (array[mid] >= value) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
};

/** File line (0-based) that drew the vertex, or null. */
export const lineForVertex = (
    frames: NumArray,
    frameLines: NumArray,
    vertexIndex: number,
): number | null => {
    if (!frames || !frameLines || frames.length !== frameLines.length) {
        return null;
    }
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0) {
        return null;
    }
    const k = upperBound(frames, vertexIndex);
    return k < frames.length ? frameLines[k] : null;
};

export interface VertexRange {
    start: number; // first vertex drawn by the line
    end: number; // one past the last vertex
}

/**
 * Vertices drawn by a file line (0-based), or null when the line drew nothing.
 * When the parser reported the line more than once (it does not today), the
 * ranges are joined.
 */
export const vertexRangeForLine = (
    frames: NumArray,
    frameLines: NumArray,
    line: number,
): VertexRange | null => {
    if (!frames || !frameLines || frames.length !== frameLines.length) {
        return null;
    }
    const first = lowerBound(frameLines, line);
    if (first >= frameLines.length || frameLines[first] !== line) {
        return null;
    }
    let last = first;
    while (last + 1 < frameLines.length && frameLines[last + 1] === line) {
        last++;
    }
    const start = first > 0 ? frames[first - 1] : 0;
    const end = frames[last];
    return end > start ? { start, end } : null;
};

/**
 * Vertices drawn by the file lines firstLine to endLine (0-based, endLine not
 * included; null: to the end of the file), or null when they drew nothing.
 * Used to show one operation alone.
 *
 * The range starts at the start point of the first move, so the move that
 * brings the tool to the first position of these lines is part of it.
 */
export const vertexRangeForLineSpan = (
    frames: NumArray,
    frameLines: NumArray,
    firstLine: number,
    endLine: number | null,
): VertexRange | null => {
    if (!frames || !frameLines || frames.length !== frameLines.length) {
        return null;
    }
    if (!Number.isInteger(firstLine) || firstLine < 0) {
        return null;
    }
    if (endLine !== null && !(endLine > firstLine)) {
        return null;
    }
    const first = lowerBound(frameLines, firstLine);
    const stop = endLine === null ? frameLines.length : lowerBound(frameLines, endLine);
    if (stop <= first) {
        return null;
    }
    const start = first > 0 ? frames[first - 1] : 0;
    const end = frames[stop - 1];
    return end > start ? { start, end } : null;
};

/**
 * The nearest line before (dir -1) or after (dir 1) `line` that drew
 * something, or null when there is none.
 */
export const stepDrawnLine = (
    frames: NumArray,
    frameLines: NumArray,
    line: number,
    dir: 1 | -1,
): number | null => {
    if (!frames || !frameLines || frames.length !== frameLines.length) {
        return null;
    }
    const drew = (k: number) => frames[k] > (k > 0 ? frames[k - 1] : 0);
    if (dir > 0) {
        for (let k = upperBound(frameLines, line); k < frameLines.length; k++) {
            if (drew(k)) {
                return frameLines[k];
            }
        }
        return null;
    }
    for (let k = lowerBound(frameLines, line) - 1; k >= 0; k--) {
        if (drew(k)) {
            return frameLines[k];
        }
    }
    return null;
};

/**
 * The line that drew something closest to `line` (itself if it drew), used
 * when a line with no motion is chosen: show where the machine is then.
 */
export const nearestDrawnLine = (
    frames: NumArray,
    frameLines: NumArray,
    line: number,
): number | null => {
    if (vertexRangeForLine(frames, frameLines, line)) {
        return line;
    }
    return (
        stepDrawnLine(frames, frameLines, line, -1) ??
        stepDrawnLine(frames, frameLines, line, 1)
    );
};

export interface ScreenHit {
    vertexIndex: number; // first vertex of the nearest segment
    distance: number; // in pixels
}

/**
 * Nearest drawn segment to a point on screen.
 *
 * @param positions  vertex positions, x y z per vertex
 * @param matrix     16 numbers, column-major (THREE.Matrix4.elements) of
 *                   projection * view * model
 * @param width      canvas width in CSS pixels
 * @param height     canvas height in CSS pixels
 * @param px, py     click position in CSS pixels from the canvas' top left
 * @param maxDistance  ignore segments further than this many pixels
 * @param vertexCount  one past the last vertex to consider (defaults to all)
 * @param firstVertex  first vertex to consider (defaults to 0). With
 *                     vertexCount it limits the search to a part of the
 *                     toolpath, for example one operation shown alone.
 *
 * Every pair of consecutive vertices is tested, because that is what is
 * drawn. A straight move is one such pair; between two moves there is a
 * zero-length pair (end of one, start of the next), which can only tie with
 * the real segments it touches; an arc is a run of pairs. Do not step by two:
 * an arc has an arbitrary number of points, so the "start of a move" is not
 * always on an even vertex.
 */
export const nearestSegmentOnScreen = (
    positions: ArrayLike<number>,
    matrix: ArrayLike<number>,
    width: number,
    height: number,
    px: number,
    py: number,
    maxDistance = 8,
    vertexCount = Math.floor(positions.length / 3),
    firstVertex = 0,
): ScreenHit | null => {
    const m = matrix;
    const stop = Math.min(vertexCount, Math.floor(positions.length / 3));
    const first = Number.isInteger(firstVertex) && firstVertex > 0 ? firstVertex : 0;
    const count = stop - first;
    if (count < 2 || !(width > 0) || !(height > 0)) {
        return null;
    }

    // Project every vertex once. NaN marks a point behind the camera.
    const sx = new Float32Array(count);
    const sy = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const x = positions[(first + i) * 3];
        const y = positions[(first + i) * 3 + 1];
        const z = positions[(first + i) * 3 + 2];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(w > 1e-9)) {
            sx[i] = NaN;
            sy[i] = NaN;
            continue;
        }
        const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        sx[i] = ((cx + 1) / 2) * width;
        sy[i] = ((1 - cy) / 2) * height;
    }

    let best = -1;
    let bestDist2 = maxDistance * maxDistance;
    for (let i = 0; i + 1 < count; i++) {
        const ax = sx[i];
        const ay = sy[i];
        const bx = sx[i + 1];
        const by = sy[i + 1];
        if (Number.isNaN(ax) || Number.isNaN(bx)) {
            continue;
        }
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - px;
        const qy = ay + t * dy - py;
        const d2 = qx * qx + qy * qy;
        // "<=" so that, of overlapping moves, the later one wins
        if (d2 <= bestDist2) {
            bestDist2 = d2;
            best = i;
        }
    }

    return best >= 0
        ? { vertexIndex: first + best, distance: Math.sqrt(bestDist2) }
        : null;
};
