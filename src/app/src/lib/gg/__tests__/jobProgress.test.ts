// GGSender: where a running job is among its operations
import fs from 'fs';
import path from 'path';
import { analyzeJob } from '../jobOperations';
import {
    currentOperation,
    formatDuration,
    groupForToolChange,
    operationFraction,
    operationStates,
    runningSeq,
    secondsToNextToolChange,
} from '../jobProgress';

describe('GGSender job progress: runningSeq', () => {
    it('no job: null', () => {
        expect(runningSeq(null, true)).toBeNull();
        expect(runningSeq({ sent: 10, received: 8, total: 100 }, false)).toBeNull();
        // rewound after a stop or the end of a job
        expect(runningSeq({ sent: 0, received: 0, total: 100, currentLineRunning: 0 }, true)).toBeNull();
    });

    it('follows gSender\'s estimated running line, never ahead of the acknowledged lines', () => {
        expect(runningSeq({ sent: 50, received: 40, total: 100, currentLineRunning: 31 }, true)).toBe(30);
        expect(runningSeq({ sent: 50, received: 40, total: 100, currentLineRunning: 41 }, true)).toBe(39);
    });

    it('falls back to the acknowledged lines without an estimate', () => {
        expect(runningSeq({ sent: 50, received: 40, total: 100, currentLineRunning: 0 }, true)).toBe(39);
        expect(runningSeq({ sent: 1, received: 0, total: 100 }, true)).toBe(0);
    });

    it('everything acknowledged: past the end', () => {
        expect(runningSeq({ sent: 100, received: 100, total: 100, currentLineRunning: 90 }, true)).toBe(100);
    });
});

const PROGRAM = [
    '(job)', // seq 0: header comments count for the Sender too
    'G21', // 1
    '(A)', // 2    op 0, group T1
    'T1 M6', // 3
    'G0 X0', // 4
    'G1 X1 F100', // 5
    '(B)', // 6    op 1, group T1
    'G1 X2', // 7
    'G1 X3', // 8
    '(C)', // 9    op 2, group T2
    'T2 M6', // 10
    'G1 X4', // 11
    '(D)', // 12   op 3, group T1 again
    'T1 M6', // 13
    'G1 X5', // 14
].join('\n');
// estimates: one per line with code (G21, T1 M6, G0, G1, G1, G1, T2 M6, G1, T1 M6, G1)
const EST = [0, 0, 1, 9, 10, 10, 0, 30, 0, 50];
const info = analyzeJob(PROGRAM, EST);

describe('GGSender job progress: operations', () => {
    it('the fixture is what the tests think', () => {
        expect(info.operations.map((o) => [o.name, o.seq, o.endSeq, o.seconds])).toEqual([
            ['A', 2, 6, 10],
            ['B', 6, 9, 20],
            ['C', 9, 12, 30],
            ['D', 12, 15, 50],
        ]);
        expect(info.groups.map((g) => [g.tool, g.changeSeq, g.operations])).toEqual([
            ['1', 3, [0, 1]],
            ['2', 10, [2]],
            ['1', 13, [3]],
        ]);
    });

    it('current operation and states', () => {
        expect(currentOperation(info.operations, null)).toBe(-1);
        expect(currentOperation(info.operations, 1)).toBe(-1); // before the first name
        expect(currentOperation(info.operations, 2)).toBe(0);
        expect(currentOperation(info.operations, 7)).toBe(1);
        expect(currentOperation(info.operations, 14)).toBe(3);
        expect(currentOperation(info.operations, 15)).toBe(4); // past the end
        expect(operationStates(info.operations, null)).toBeNull();
        expect(operationStates(info.operations, 10)).toEqual(['done', 'done', 'current', 'upcoming']);
        expect(operationStates(info.operations, 15)).toEqual(['done', 'done', 'done', 'done']);
        expect(operationStates(info.operations, 1)).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
    });

    it('a tool change belongs to the operation named before it', () => {
        // held at the M6 of C (seq 10): C is current, B is done
        expect(operationStates(info.operations, 10)?.[2]).toBe('current');
    });

    it('fraction of an operation', () => {
        expect(operationFraction(info.operations[1], 6)).toBe(0);
        expect(operationFraction(info.operations[1], 7)).toBeCloseTo(1 / 3);
        expect(operationFraction(info.operations[1], 20)).toBe(1);
    });

    it('time to the next tool change: rest of this operation, then the rest of the group', () => {
        // in A, at its start: all of A and B
        expect(secondsToNextToolChange(info, 2)).toBeCloseTo(30);
        // a third of the way through B
        expect(secondsToNextToolChange(info, 7)).toBeCloseTo(20 * (2 / 3));
        // feed override 200%: half the time
        expect(secondsToNextToolChange(info, 2, 200)).toBeCloseTo(15);
        // in the last group: no next change
        expect(secondsToNextToolChange(info, 14)).toBeNull();
        expect(secondsToNextToolChange(info, null)).toBeNull();
        expect(secondsToNextToolChange(analyzeJob(PROGRAM), 2)).toBeNull(); // no estimate
    });
});

describe('GGSender job progress: which group a tool change is for', () => {
    it('the exact M6 line wins, so the same tool used twice is told apart', () => {
        expect(groupForToolChange(info, 'T1', 3)?.operations).toEqual([0, 1]);
        expect(groupForToolChange(info, 'T1', 13)?.operations).toEqual([3]);
        expect(groupForToolChange(info, 2, 10)?.operations).toEqual([2]);
    });

    it('without the exact line: latest change of that tool before it, else the first', () => {
        expect(groupForToolChange(info, '1', 14)?.changeSeq).toBe(13);
        expect(groupForToolChange(info, '1', 6)?.changeSeq).toBe(3);
        expect(groupForToolChange(info, '1', null)?.changeSeq).toBe(3);
        expect(groupForToolChange(info, '2', 0)?.changeSeq).toBe(10);
    });

    it('a line whose M6 is for another tool falls back to the tool', () => {
        expect(groupForToolChange(info, '1', 10)?.changeSeq).toBe(3);
        expect(groupForToolChange(info, '7', 10)).toBeNull();
    });

    it('the owner\'s file: T40 and T45 are each changed to twice', () => {
        const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'fusion-job-trimmed.nc'), 'utf8');
        const job = analyzeJob(content);
        const t40 = job.groups.filter((g) => g.tool === '40');
        expect(t40).toHaveLength(2);
        const names = (seq: number | null) =>
            groupForToolChange(job, 'T40', seq)?.operations.map((i) => job.operations[i].name);
        expect(names(t40[0].changeSeq)).toEqual(['2D Contour2', 'Bore1']);
        expect(names(t40[1].changeSeq)).toEqual(['2D Contour3']);
    });
});

describe('GGSender job progress: durations', () => {
    it.each([
        [null, ''],
        [0.4, '0 s'],
        [45, '45 s'],
        [59.6, '1 min'],
        [600, '10 min'],
        [3725, '1 h 02'],
    ])('%s s -> "%s"', (s, text) => {
        expect(formatDuration(s as number | null)).toBe(text);
    });
});
