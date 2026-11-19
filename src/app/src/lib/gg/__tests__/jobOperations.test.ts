// GGSender: operations and tool table read from the program's comments
import fs from 'fs';
import path from 'path';
import { analyzeJob, findToolSpec, groupOperationNames, operationLineSpan } from '../jobOperations';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const nonBlankIndex = (content: string, line: number) =>
    content.split('\n').slice(0, line).filter((l) => l.trim().length > 0).length;

describe('GGSender job operations: the owner\'s Fusion file (trimmed)', () => {
    const content = fixture('fusion-job-trimmed.nc');
    const info = analyzeJob(content);
    const lines = content.split('\n').map((l) => l.trimEnd());

    it('reads the program name and the tool table', () => {
        expect(info.programName).toBe('1');
        expect(info.units).toBe('mm');
        expect(Object.keys(info.tools).sort()).toEqual(['20', '31', '40', '43', '45']);
        expect(info.tools['43']).toMatchObject({ diameter: 4, cornerRadius: 0, taperDeg: 45, zMin: -0.35, kind: 'chamfer' });
        expect(info.tools['45']).toMatchObject({ diameter: 4, cornerRadius: 0.5, kind: 'bullnose' });
    });

    it('finds every operation, in order, with no tool table entry among them', () => {
        expect(info.operations.map((o) => o.name)).toEqual([
            '3D Adaptive Roughing1',
            '2D Contour2',
            'Bore1',
            '3D Adaptive Roughing1 2',
            'Flat1',
            'Parallel1',
            'Parallel1 2',
            'Bore2',
            'Deburr1',
            '2D Contour3',
            'Trace1',
        ]);
        info.operations.forEach((op) => {
            expect(lines[op.line]).toBe(`(${op.name})`);
            expect(op.notes).toEqual([]);
        });
    });

    it('groups operations by tool change, same tool twice gives two groups', () => {
        expect(info.groups.map((g) => g.tool)).toEqual(['45', '40', '45', '20', '31', '40', '43']);
        expect(info.groups.map((g) => groupOperationNames(info, g))).toEqual([
            ['3D Adaptive Roughing1'],
            ['2D Contour2', 'Bore1'],
            ['3D Adaptive Roughing1 2', 'Flat1', 'Parallel1', 'Parallel1 2'],
            ['Bore2'],
            ['Deburr1'],
            ['2D Contour3'],
            ['Trace1'],
        ]);
        info.groups.forEach((g) => {
            expect(lines[g.changeLine as number]).toMatch(new RegExp(`T${g.tool} M6$`));
        });
    });

    it('numbers like the Sender: index among non-blank lines', () => {
        info.operations.forEach((op) => {
            expect(op.seq).toBe(nonBlankIndex(content, op.line));
        });
        info.groups.forEach((g) => {
            expect(g.changeSeq).toBe(nonBlankIndex(content, g.changeLine as number));
        });
        expect(info.totalSeq).toBe(lines.filter((l) => l.trim().length > 0).length);
        // ranges tile the job from the first operation to the end
        info.operations.forEach((op, i) => {
            const next = info.operations[i + 1];
            expect(op.endSeq).toBe(next ? next.seq : info.totalSeq);
        });
    });

    it('records the first move of each operation', () => {
        const contour2 = info.operations[1];
        expect(lines[contour2.firstMotionLine as number]).toBe('N43117 G0 X66.834 Y40.675');
        const bore1 = info.operations[2];
        expect(lines[bore1.firstMotionLine as number]).toBe('N43481 G0 X63.628 Y28.655');
    });

    it('has no durations without estimates', () => {
        expect(info.totalSeconds).toBeNull();
        expect(info.operations[0].seconds).toBeNull();
    });
});

describe('GGSender job operations: every tool type', () => {
    const info = analyzeJob(fixture('fusion-one-of-each.nc'));

    it('reads all seven tools with their kind', () => {
        const kinds = Object.fromEntries(Object.values(info.tools).map((t) => [t.number, t.kind]));
        expect(kinds).toEqual({
            1: 'ball',
            2: 'bullnose',
            3: 'flat',
            4: 'tapered',
            6: 'chamfer',
            9: 'lollipop',
            11: 'thread',
        });
        expect(info.tools['4']).toMatchObject({ diameter: 12, cornerRadius: 2.5, taperDeg: 10 });
        expect(info.programName).toBe('one of each');
    });

    it('one operation per tool change', () => {
        expect(info.operations.map((o) => o.name)).toEqual([
            'Trace1',
            'Trace1 9',
            'Trace1 8',
            'Trace1 7',
            'Trace1 6',
            'Trace1 5',
            'Trace1 4',
        ]);
        expect(info.groups.map((g) => g.tool)).toEqual(['1', '2', '3', '4', '6', '9', '11']);
        expect(info.groups.every((g) => g.operations.length === 1)).toBe(true);
    });
});

describe('GGSender job operations: durations from gSender\'s estimate', () => {
    const PROGRAM = [
        '(prog)', // header: no estimate
        'G21 G90', // tok 0
        '',
        '(Op A)',
        'T1 M6', // tok 1
        'G0 X0 Y0', // tok 2
        'G1 X10 F100', // tok 3
        '',
        '(Op B)',
        'G1 X20', // tok 4
        'T2 M6', // tok 5
        '(Op C)',
        'G1 X30', // tok 6
        'M30', // tok 7
    ].join('\n');
    const estimates = [0, 0, 1, 6, 6, 0, 6, 0];
    const info = analyzeJob(PROGRAM, estimates);

    it('sums the estimate of each operation', () => {
        expect(info.operations.map((o) => o.seconds)).toEqual([7, 6, 6]);
        expect(info.totalSeconds).toBe(19);
    });

    it('sums each tool group from its M6 to the next', () => {
        expect(info.groups.map((g) => g.seconds)).toEqual([13, 6]);
    });

    it('op B has no M6 of its own but a name: it stays with T1', () => {
        expect(info.groups.map((g) => groupOperationNames(info, g))).toEqual([['Op A', 'Op B'], ['Op C']]);
    });
});

describe('GGSender job operations: other layouts', () => {
    it('a comment right after a named M6 is the tool description', () => {
        const info = analyzeJob(['G21', '(Pocket)', 'T3 M6', '(6mm 2 flute upcut)', 'S10000 M3', 'G0 X1 Y1', 'G1 Z-1 F100'].join('\n'));
        expect(info.operations.map((o) => o.name)).toEqual(['Pocket']);
        expect(info.groups[0].comment).toBe('6mm 2 flute upcut');
        expect(info.operations[0].firstMotionLine).toBe(5);
    });

    it('a name after an unnamed M6 is the operation', () => {
        const info = analyzeJob(['G21', 'G0 X0', 'T3 M6', '(Pocket)', 'G0 X1 Y1'].join('\n'));
        expect(info.operations.map((o) => o.name)).toEqual(['Pocket']);
        expect(info.groups.map((g) => g.tool)).toEqual(['3']);
        expect(info.groups[0].comment).toBe('');
        expect(info.groups[0].operations).toEqual([0]);
    });

    it('a manual NC note before an operation is kept as its note, and the operation starts there', () => {
        const info = analyzeJob(['G21', '(Face)', 'G0 X0 Y0', '', '(Flip the part)', 'M0', '', '(Back side)', 'G0 X5'].join('\n'));
        expect(info.operations.map((o) => [o.name, o.notes])).toEqual([
            ['Face', []],
            ['Back side', ['Flip the part']],
        ]);
        expect(info.operations[1].line).toBe(4);
    });

    it('extra comments in a name run are notes', () => {
        const info = analyzeJob(['G21', '(Adaptive2)', '(leave 0.2 stock)', 'G0 X0'].join('\n'));
        expect(info.operations[0]).toMatchObject({ name: 'Adaptive2', notes: ['leave 0.2 stock'] });
    });

    it('comments after the last move are notes of the last operation', () => {
        const info = analyzeJob(['G21', '(Contour)', 'G0 X0', 'M5', '(done)', 'M30'].join('\n'));
        expect(info.operations.map((o) => o.name)).toEqual(['Contour']);
        expect(info.operations[0].notes).toEqual(['done']);
    });

    it('operations before any M6 get a group with no tool', () => {
        const info = analyzeJob(['G21', '(Engrave)', 'G0 X0', '(Cut)', 'T2 M6', 'G0 X1'].join('\n'));
        expect(info.groups.map((g) => [g.tool, groupOperationNames(info, g)])).toEqual([
            [null, ['Engrave']],
            ['2', ['Cut']],
        ]);
    });

    it('a file without comments has no operations', () => {
        const info = analyzeJob('G21\nG0 X0\nG1 X10 F100\nM30\n');
        expect(info.operations).toEqual([]);
        expect(info.groups).toEqual([]);
    });

    it('semicolon comments and inch programs', () => {
        const info = analyzeJob(['; Job', '(T1 D=0.25 CR=0 - flat end mill)', 'G20', '; Pocket 1', 'T1 M6', 'G0 X0'].join('\n'));
        expect(info.programName).toBe('Job');
        expect(info.units).toBe('inch');
        expect(info.operations.map((o) => o.name)).toEqual(['Pocket 1']);
        expect(info.tools['1'].diameter).toBe(0.25);
    });

    it('G28 and G53 moves do not count as the first move', () => {
        const info = analyzeJob(['G21', '(Op)', 'G28 G91 Z0', 'G53 G0 Z-1', 'G90', 'G0 X3'].join('\n'));
        expect(info.operations[0].firstMotionLine).toBe(5);
    });

    it('CRLF line ends', () => {
        const info = analyzeJob('(p)\r\nG21\r\n\r\n(Op)\r\nT1 M6\r\nG0 X0\r\n');
        expect(info.operations.map((o) => [o.name, o.seq])).toEqual([['Op', 2]]);
    });
});

describe('GGSender job operations: findToolSpec', () => {
    const info = analyzeJob('(T5 D=6 CR=0 - flat end mill)\nG21\n');
    it('accepts the forms the tool change uses', () => {
        expect(findToolSpec(info, 5)?.diameter).toBe(6);
        expect(findToolSpec(info, '5')?.diameter).toBe(6);
        expect(findToolSpec(info, 'T5')?.diameter).toBe(6);
        expect(findToolSpec(info, '005')?.diameter).toBe(6);
        expect(findToolSpec(info, 6)).toBeNull();
        expect(findToolSpec(info, null)).toBeNull();
        expect(findToolSpec(null, 5)).toBeNull();
    });
});

describe('GGSender job operations: operationLineSpan', () => {
    const program = ['(job)', 'G21', '', '(Adaptive1)', 'T1 M6', 'G0 X0 Y0', 'G1 Z-1 F100', '', '(Contour1)', 'G1 X10', '', '(Chamfer1)', 'T2 M6', 'G0 X5', 'M30'].join('\n');
    const info = analyzeJob(program);

    it('runs from the name of the operation to the name of the next one', () => {
        expect(info.operations.map((o) => o.name)).toEqual(['Adaptive1', 'Contour1', 'Chamfer1']);
        expect(operationLineSpan(info.operations, 0)).toEqual({ firstLine: 3, endLine: 8 });
        expect(operationLineSpan(info.operations, 1)).toEqual({ firstLine: 8, endLine: 11 });
    });

    it('the last operation runs to the end of the file', () => {
        expect(operationLineSpan(info.operations, 2)).toEqual({ firstLine: 11, endLine: null });
    });

    it('is null for an operation that does not exist', () => {
        expect(operationLineSpan(info.operations, 3)).toBeNull();
        expect(operationLineSpan([], 0)).toBeNull();
    });
});
