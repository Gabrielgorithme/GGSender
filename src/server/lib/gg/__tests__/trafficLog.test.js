import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    getTrafficLogFile,
    logEvent,
    logRx,
    logTx,
    printable,
    resetTrafficLog,
    shouldLogStatus,
} from '../trafficLog';
import { looksStalled } from '../streamDiagnostics';

const flush = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('GGSender: traffic log', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-traffic-'));
        process.env.GG_TRAFFIC_LOG_DIR = dir;
        resetTrafficLog();
    });

    afterEach(() => {
        resetTrafficLog();
        delete process.env.GG_TRAFFIC_LOG_DIR;
    });

    const read = async () => {
        await flush();
        return fs.readFileSync(getTrafficLogFile(), 'utf8');
    };

    it('shows control bytes and drops the line end', () => {
        expect(printable('G1 X10\n')).toBe('G1 X10');
        expect(printable('\x18')).toBe('\\x18');
        expect(printable('$G\r\n')).toBe('$G');
    });

    it('records sent and received lines with their source', async () => {
        logTx('G1 X10 Y5\n', 'sender');
        logTx('G54\n', 'feeder');
        logTx('$G\n', 'immediate');
        logRx('ok');
        logRx('[GC:G1 G54 G17 G21 G90 G94 M3 M9 T0 F1000 S12000]');
        logRx('error:38');
        const text = await read();
        expect(text).toMatch(/> G1 X10 Y5 {3}\[sender\]/);
        expect(text).toMatch(/> G54 {3}\[feeder\]/);
        expect(text).toMatch(/> \$G {3}\[immediate\]/);
        expect(text).toMatch(/< ok\n/);
        expect(text).toMatch(/< \[GC:G1 G54/);
        expect(text).toMatch(/< error:38/);
        // every line carries a time of day
        text.trim().split('\n').forEach((l) => expect(l).toMatch(/^\d\d:\d\d:\d\d\.\d{3} [<>#] /));
    });

    it('leaves status polls out and keeps only state changes', async () => {
        logTx('?', 'immediate');
        logRx('<Run|MPos:1.000,2.000,-3.000|FS:1000,12000>');
        logRx('<Run|MPos:1.100,2.000,-3.000|FS:1000,12000>');
        logRx('<Run|MPos:1.200,2.000,-3.000|FS:1000,12000>');
        logRx('<Idle|MPos:1.200,2.000,-3.000|FS:0,0>');
        const text = await read();
        expect(text).not.toMatch(/> \?/);
        expect((text.match(/<Run/g) || []).length).toBe(1);
        expect((text.match(/<Idle/g) || []).length).toBe(1);
    });

    it('logs a status report again after the interval', () => {
        const memory = { lastStatusState: null, lastStatusTime: 0 };
        expect(shouldLogStatus('<Run|MPos:0,0,0>', 10000, memory)).toBe(true);
        expect(shouldLogStatus('<Run|MPos:1,0,0>', 12000, memory)).toBe(false);
        expect(shouldLogStatus('<Run|MPos:2,0,0>', 15000, memory)).toBe(true);
        expect(shouldLogStatus('<Hold:0|MPos:2,0,0>', 15100, memory)).toBe(true);
    });

    it('records events, including multi-line ones', async () => {
        logEvent('workflow', 'pause -> paused');
        logEvent('COMMAND DURING JOB', 'gcode "G54"\nat a (x.js:1:1)\nat b (y.js:2:2)');
        logEvent('accounting', { sent: 10, received: 8 });
        const text = await read();
        expect(text).toMatch(/# workflow: pause -> paused/);
        expect(text).toMatch(/# COMMAND DURING JOB: gcode "G54"/);
        expect(text).toMatch(/# {5}at a \(x\.js:1:1\)/);
        expect(text).toMatch(/# accounting: \{"sent":10,"received":8\}/);
    });

    it('never throws, whatever it is given or wherever it cannot write', () => {
        expect(() => {
            logTx(undefined);
            logRx(null);
            logRx('');
            logEvent('x', { toJSON() { throw new Error('boom'); } });
        }).not.toThrow();

        resetTrafficLog();
        process.env.GG_TRAFFIC_LOG_DIR = path.join(dir, 'a-file');
        fs.writeFileSync(path.join(dir, 'a-file'), 'not a folder');
        expect(() => {
            logTx('G1 X1', 'sender');
            logRx('ok');
        }).not.toThrow();
    });

    it('stays off when there is nowhere to write', () => {
        resetTrafficLog();
        delete process.env.GG_TRAFFIC_LOG_DIR;
        expect(() => logTx('G1 X1', 'sender')).not.toThrow();
        expect(getTrafficLogFile()).toBeNull();
    });
});

describe('GGSender: stall detection', () => {
    const base = {
        workflow: 'running',
        machine: 'Idle',
        hold: false,
        sent: 500,
        received: 497,
        total: 9000,
    };

    it('flags a running job that is idle with no replies', () => {
        expect(looksStalled(base, 3500)).toBe(true);
    });

    it('does not flag a job that is moving, holding, paused or finished', () => {
        expect(looksStalled({ ...base, machine: 'Run' }, 60000)).toBe(false);
        expect(looksStalled({ ...base, hold: true }, 60000)).toBe(false);
        expect(looksStalled({ ...base, workflow: 'paused' }, 60000)).toBe(false);
        expect(looksStalled({ ...base, workflow: 'idle' }, 60000)).toBe(false);
        expect(looksStalled({ ...base, sent: 9000, received: 9000 }, 60000)).toBe(false);
    });

    it('waits before flagging', () => {
        expect(looksStalled(base, 500)).toBe(false);
    });
});
