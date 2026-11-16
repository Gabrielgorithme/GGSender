/*
 * GGSender: the visualize worker's line table must match the editor's line
 * numbers (one line per "\n"), whatever the file contains.
 */
import { lineForVertex, vertexRangeForLine } from 'app/lib/gg/toolpathPick';

const posted: any[] = [];
(global as any).postMessage = (msg: any) => posted.push(msg);

// eslint-disable-next-line import/first
import '../Visualize.worker';

const run = (content: string) => {
    posted.length = 0;
    (self as any).onmessage({
        data: {
            content,
            jobId: 1,
            visualizer: 'default',
            needsVisualization: true,
            isSecondary: false,
            accelerations: { x: 500, y: 500, z: 500 },
            maxFeedrates: { x: 4000, y: 4000, z: 1000 },
        },
    });
    const geometry = posted.find((m) => m.type === 'geometryReady');
    return {
        geometry,
        frames: new Uint32Array(geometry.frames, 0, geometry.framesLen),
        frameLines: new Uint32Array(geometry.frameLines, 0, geometry.frameLinesLen),
        vertices: new Float32Array(geometry.vertices, 0, geometry.verticesLen),
    };
};

describe('GGSender: visualize worker line table', () => {
    const lines = [
        '(header comment)', // 0
        'G21 G90', // 1
        '', // 2
        'G0 X10 Y0 Z5', // 3
        '; another comment', // 4
        'G1 Z-1 F100', // 5
        'G1 X20 Y10', // 6
        'M5', // 7
        'G0 Z5', // 8
    ];

    const check = (content: string) => {
        const { frames, frameLines, vertices } = run(content);
        expect(frames.length).toBe(frameLines.length);
        // the moves: each line's vertices end where the editor says
        const endOf = (line: number) => {
            const r = vertexRangeForLine(frames, frameLines, line);
            const i = (r.end - 1) * 3;
            return [vertices[i], vertices[i + 1], vertices[i + 2]].map((n) => Math.round(n * 1000) / 1000);
        };
        expect(endOf(3)).toEqual([10, 0, 5]);
        expect(endOf(5)).toEqual([10, 0, -1]);
        expect(endOf(6)).toEqual([20, 10, -1]);
        expect(endOf(8)).toEqual([20, 10, 5]);
        // lines without motion draw nothing
        [0, 1, 2, 4, 7].forEach((l) => expect(vertexRangeForLine(frames, frameLines, l)).toBeNull());
        // and every vertex maps back to a moving line
        for (let v = 0; v < vertices.length / 3; v++) {
            expect([3, 5, 6, 8]).toContain(lineForVertex(frames, frameLines, v));
        }
    };

    it('numbers lines like the editor with \\n line endings', () => {
        check(lines.join('\n'));
    });

    it('numbers lines like the editor with \\r\\n line endings', () => {
        check(lines.join('\r\n'));
    });

    it('sends a pre-flight report with the geometry', () => {
        const { geometry } = run('T2 M6\nM3 S1000\nG1 X5 Z-1 F100');
        expect(geometry.ggPreflight.sections[0]).toMatchObject({ tool: '2', changeLine: 1, cutZMin: -1 });
    });
});
