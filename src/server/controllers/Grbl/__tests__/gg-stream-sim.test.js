/**
 * @jest-environment node
 */
/*
 * GGSender: runs the real Grbl controller against a simulated controller
 * board, to check that a job streams to completion with the fork's changes
 * (tool-word handling, diagnostics hooks) in place.
 *
 * The simulated board answers like Grbl/FluidNC: "ok" per line, a status
 * report per "?", "[GC:...]" then "ok" for "$G".
 */
import events from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.setTimeout(120000);

// The shared jest config maps config/settings to the interface's mock, which
// has no logger settings; the server logger is not what is under test here.
jest.mock('../../../lib/logger', () => {
    const quiet = { error() {}, warn() {}, info() {}, verbose() {}, debug() {}, silly() {} };
    const factory = () => quiet;
    factory.getLevel = () => 'error';
    factory.setLevel = () => {};
    return { __esModule: true, default: factory, getLevel: factory.getLevel, setLevel: factory.setLevel, levels: [] };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeBoard extends events.EventEmitter {
    isOpen = true;
    queue = [];
    busy = false;
    received = [];
    sockets = {};

    setWriteFilter() {}
    emitToSockets() {}
    getSockets() { return this.sockets; }

    reply(line) {
        this.emit('data', line);
    }

    status() {
        const state = this.queue.length > 0 || this.busy ? 'Run' : 'Idle';
        return `<${state}|MPos:1.000,2.000,-3.000|FS:1000,12000|WCO:0.000,0.000,0.000>`;
    }

    write(data) {
        const text = String(data);
        if (text === '?') {
            this.reply(this.status());
            return;
        }
        if (text === '\x18') {
            this.queue = [];
            setTimeout(() => this.reply("Grbl 1.1f ['$' for help]"), 5);
            return;
        }
        if (text.length === 1 && text !== '\n') {
            return; // other realtime bytes
        }
        text.split('\n').filter((l) => l.length > 0).forEach((l) => this.queue.push(l));
        this.pump();
    }

    writeImmediate(data) {
        this.write(data);
    }

    pump() {
        if (this.busy) return;
        const step = () => {
            const line = this.queue.shift();
            if (line === undefined || !this.isOpen) {
                this.busy = false;
                return;
            }
            this.received.push(line);
            if (line === '$G') {
                this.reply('[GC:G1 G54 G17 G21 G90 G94 M3 M9 T0 F1000 S12000]');
            }
            if (/T\s*(\d+)/i.test(line) && Number(/T\s*(\d+)/i.exec(line)[1]) > 255) {
                this.reply('error:38');
            } else {
                this.reply('ok');
            }
            // answer in small irregular bursts, like a real serial link
            if (Math.random() < 0.3) {
                setTimeout(step, 1);
            } else {
                setImmediate(step);
            }
        };
        this.busy = true;
        setImmediate(step);
    }
}

/*
 * A board that holds like FluidNC: "!" stops it at once (Hold:1, then Hold:0
 * once "stopped"), "~" is ignored until the hold is complete, 0x9E stops or
 * starts the spindle only while held, and a "~" with the spindle stopped
 * starts it itself (FluidNC's restore, without any spin-up wait unless its
 * config sets one). Status reports carry Ov: and A:S while the spindle turns.
 */
class HoldBoard extends FakeBoard {
    held = false;
    holdSub = 0;
    spindle = false;
    ovrStopped = false;
    restoredByCycleStart = false;
    log = []; // lines and realtime bytes in the order the board handled them

    status() {
        let state = this.queue.length > 0 || this.busy ? 'Run' : 'Idle';
        if (this.held) {
            state = `Hold:${this.holdSub}`;
        }
        return `<${state}|MPos:1.000,2.000,-3.000|FS:1000,12000|Ov:100,100,100${this.spindle ? '|A:S' : ''}>`;
    }

    write(data) {
        const text = String(data);
        if (text === '!') {
            this.log.push('RT:!');
            if (!this.held) {
                this.held = true;
                this.holdSub = 1;
                setTimeout(() => {
                    this.holdSub = 0;
                }, 80);
            }
            return;
        }
        if (text === '~') {
            this.log.push(this.held && this.holdSub === 1 ? 'RT:~ignored' : 'RT:~');
            if (this.held && this.holdSub === 0) {
                if (this.ovrStopped) {
                    this.ovrStopped = false;
                    this.spindle = true;
                    this.restoredByCycleStart = true;
                }
                this.held = false;
                this.pump();
            }
            return;
        }
        if (text === '\u009e') {
            this.log.push('RT:9E');
            if (this.held) {
                if (this.ovrStopped) {
                    this.ovrStopped = false;
                    this.spindle = true;
                } else if (this.spindle) {
                    this.ovrStopped = true;
                    this.spindle = false;
                }
            }
            return;
        }
        super.write(data);
    }

    pump() {
        if (this.busy || this.held) return;
        const step = () => {
            if (this.held || !this.isOpen) {
                this.busy = false;
                return;
            }
            const line = this.queue.shift();
            if (line === undefined) {
                this.busy = false;
                return;
            }
            this.received.push(line);
            this.log.push(`L:${line}`);
            if (/M3/.test(line)) this.spindle = true;
            if (/M5/.test(line)) this.spindle = false;
            if (line === '$G') {
                this.reply('[GC:G1 G54 G17 G21 G90 G94 M3 M9 T0 F1000 S12000]');
            }
            this.reply('ok');
            setTimeout(step, 1); // about a line per millisecond: a job takes a few seconds
        };
        this.busy = true;
        setImmediate(step);
    }
}

const makeJob = (lines) => {
    const out = ['G21', 'G90', 'T405 M6', 'M3 S12000', 'G0 Z5'];
    for (let i = 0; i < lines; i++) {
        const x = (i % 97) * 0.731;
        const y = (i % 53) * 1.137;
        out.push(i % 7 === 0 ? `G2 X${x.toFixed(3)} Y${y.toFixed(3)} I1.5 J-0.75` : `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F1800`);
    }
    out.push('G0 Z15', 'M5');
    return out.join('\n');
};

describe('GGSender: job streaming against a simulated board', () => {
    let GrblController;
    let trafficLog;
    let dir;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-sim-'));
        process.env.GG_TRAFFIC_LOG_DIR = dir;
        // eslint-disable-next-line global-require
        trafficLog = require('../../../lib/gg/trafficLog');
        trafficLog.resetTrafficLog();
        // eslint-disable-next-line global-require
        GrblController = require('../GrblController').default;
    });

    afterAll(() => {
        trafficLog.resetTrafficLog();
        delete process.env.GG_TRAFFIC_LOG_DIR;
    });

    const start = async (toolChangeContext, Board = FakeBoard) => {
        const board = new Board();
        const engine = { unload() {} };
        const controller = new GrblController(engine, board, { port: 'SIM', baudrate: 115200 });
        controller.toolChangeContext = toolChangeContext;
        controller.open('SIM', 115200, false, () => {});
        for (let i = 0; i < 100 && !controller.ready; i++) {
            await sleep(50);
        }
        expect(controller.ready).toBe(true);
        await sleep(300);
        return { board, controller };
    };

    const runJob = async (controller, gcode, during, until) => {
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'sim.nc' }, gcode, {}, (err) => (err ? reject(err) : resolve()));
        });
        const total = controller.sender.state.total;
        controller.command('gcode:start');
        const deadline = Date.now() + 60000;
        let injected = false;
        while (Date.now() < deadline) {
            await sleep(20);
            const { sent, received } = controller.sender.state;
            if (during && !injected && sent > total / 2) {
                injected = true;
                during();
            }
            if (received >= total || controller.workflow.state === 'idle') {
                break;
            }
            if (until && until()) {
                break;
            }
        }
        return { total, ...controller.sender.state };
    };

    const stop = async (controller, board) => {
        // unplug the board first so no late reply reaches a destroyed controller
        board.isOpen = false;
        board.queue = [];
        board.removeAllListeners();
        controller.workflow.stop();
        controller.sender.stopCountdown();
        clearInterval(controller.sender.checkIntervalID);
        clearInterval(controller.sender.countDownID);
        clearInterval(controller.queryTimer);
        controller.toolChanger.clearInterval();
        // let the controller's throttled status queries run out; destroy()
        // would null the objects they still reference
        await sleep(700);
    };

    it('streams a job to the end with tool words withheld, and never sends a T word', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' });
        const result = await runJob(controller, makeJob(3000));
        const finished = result.received >= result.total || controller.sender.state.finishTime > 0;
        expect(finished).toBe(true);
        expect(board.received.some((l) => /T\s*\d/i.test(l) && !l.startsWith('$'))).toBe(false);
        expect(board.received.filter((l) => /^G[12] /.test(l)).length).toBe(3000);
        await stop(controller, board);
    });

    it('sends T words when the setting asks for it', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore', sendToolNumber: true });
        // The simulated board rejects T405 like Grbl does (error:38), which
        // pauses the job; stop waiting as soon as the T word has gone out.
        await runJob(controller, makeJob(200), null, () => board.received.some((l) => /T405/.test(l)));
        expect(board.received.some((l) => /T405/.test(l))).toBe(true);
        await stop(controller, board);
    });

    it('reports what a stray G54 during a job does', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' });
        const result = await runJob(controller, makeJob(3000), () => {
            controller.command('gcode', 'G54');
        });
        await sleep(200);
        const log = fs.readFileSync(trafficLog.getTrafficLogFile(), 'utf8');
        // eslint-disable-next-line no-console
        console.log('stray G54 run:', JSON.stringify({
            total: result.total,
            sent: result.sent,
            received: result.received,
            workflow: controller.workflow.state,
            g54SeenByBoard: board.received.filter((l) => l === 'G54').length,
            motionLinesSeen: board.received.filter((l) => /^G[12] /.test(l)).length,
            stallLogged: /# STALL/.test(log),
            commandDuringJobLogged: /COMMAND DURING JOB: gcode "G54"/.test(log),
        }));
        expect(/COMMAND DURING JOB: gcode "G54"/.test(log)).toBe(true);
        // With a board that answers every line, the job still completes
        expect(result.received).toBe(result.total);
        expect(board.received.filter((l) => /^G[12] /.test(l)).length).toBe(3000);
        await stop(controller, board);
    });

    // ---- GGSender 0.3.0 ---------------------------------------------------

    const motionFeeds = (board) => board.received
        .filter((l) => /^G1 /.test(l))
        .map((l) => /F([\d.]+)/.exec(l)?.[1]);

    it('rewrites feeds for the tool named in a rule', async () => {
        const { board, controller } = await start({
            toolChangeOption: 'Ignore',
            feedRules: 'T405 F1800 -> F450',
        });
        const result = await runJob(controller, makeJob(300));
        expect(result.received).toBe(result.total);
        const feeds = motionFeeds(board);
        expect(feeds.length).toBeGreaterThan(200);
        expect(new Set(feeds)).toEqual(new Set(['450']));
        // arcs and everything else are untouched
        expect(board.received.filter((l) => /^G2 /.test(l)).length).toBeGreaterThan(0);
        expect(board.received).toContain('M3 S12000');
        await stop(controller, board);
    });

    it('leaves feeds alone when the rule is for another tool', async () => {
        const { board, controller } = await start({
            toolChangeOption: 'Ignore',
            feedRules: 'T5 F1800 -> F450',
        });
        await runJob(controller, makeJob(300));
        expect(new Set(motionFeeds(board))).toEqual(new Set(['1800']));
        await stop(controller, board);
    });

    it('picks up a rule added while the job runs', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' });
        const result = await runJob(controller, makeJob(3000), () => {
            controller.command('toolchange:context', {
                toolChangeOption: 'Ignore',
                feedRules: 'T405 F* -> 50%',
            });
        });
        expect(result.received).toBe(result.total);
        const feeds = motionFeeds(board);
        const firstSlow = feeds.indexOf('900');
        expect(feeds[0]).toBe('1800');
        expect(firstSlow).toBeGreaterThan(0);
        // once the rule is in, every later feed follows it
        expect(new Set(feeds.slice(firstSlow))).toEqual(new Set(['900']));
        expect(new Set(feeds.slice(0, firstSlow))).toEqual(new Set(['1800']));
        await stop(controller, board);
    });

    it('sends one realtime step per 1% spindle override request', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' });
        const bytes = [];
        const original = board.writeImmediate.bind(board);
        board.writeImmediate = (data) => {
            const text = String(data);
            if (text.length === 1 && text.charCodeAt(0) >= 0x99 && text.charCodeAt(0) <= 0x9d) {
                bytes.push(text.charCodeAt(0));
            }
            original(data);
        };
        // The simulated board reports no override, so the controller starts
        // from 100%. Two quick requests, before any report could catch up:
        controller.command('spindleOverride', 101);
        controller.command('spindleOverride', 102);
        await sleep(300);
        expect(bytes).toEqual([0x9c, 0x9c]);
        // and back down by 3
        controller.command('spindleOverride', 99);
        await sleep(300);
        expect(bytes.slice(2)).toEqual([0x9d, 0x9d, 0x9d]);
        await stop(controller, board);
    });

    // ---- GGSender 0.6.0: pause as a feed hold -----------------------------

    const waitFor = async (cond, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (cond()) return true;
            await sleep(20);
        }
        return false;
    };

    // pretend the owner has Program Pause / Resume events set up, and record them
    const fakeEvents = (controller) => {
        const triggered = [];
        controller.event.hasEnabledEvent = (type) => type === 'gcode:pause' || type === 'gcode:resume';
        const original = controller.event.trigger.bind(controller.event);
        controller.event.trigger = (key, ...rest) => {
            if (key === 'gcode:pause' || key === 'gcode:resume') {
                triggered.push(key);
                return undefined;
            }
            return original(key, ...rest);
        };
        return triggered;
    };

    const startJob = async (controller, lines = 3000) => {
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'sim.nc' }, makeJob(lines), {}, (err) => (err ? reject(err) : resolve()));
        });
        const total = controller.sender.state.total;
        controller.command('gcode:start');
        await waitFor(() => controller.sender.state.received > total / 3);
        return total;
    };

    const realtime = (board) => board.log.filter((e) => e.startsWith('RT:'));

    // a controller on a holding board, always cleaned up
    const onHoldBoard = async (settings, body) => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, HoldBoard);
        try {
            controller.command('settings:updated', settings);
            await body(board, controller);
        } finally {
            await stop(controller, board);
        }
    };

    it('hold mode: pause holds at once, the spindle stops and restarts, resume waits for spin-up', async () => {
        await onHoldBoard({ ggPauseMode: 'hold', ggHoldStopsSpindle: false, ggResumeSpinupSeconds: 0.5 }, async (board, controller) => {
            const triggered = fakeEvents(controller);
            const total = await startJob(controller);
            expect(board.spindle).toBe(true);

            controller.command('gcode:pause');
            expect(board.log[board.log.length - 1]).toBe('RT:!'); // nothing in between
            expect(controller.workflow.state).toBe('paused');
            await sleep(300);
            const linesAtHold = board.received.length;
            await sleep(300);
            expect(board.received.length).toBe(linesAtHold); // the machine stays put
            expect(linesAtHold).toBeLessThan(total);
            expect(triggered).toEqual([]); // the Program Pause event is not run

            controller.command('gg:hold:spindle');
            expect(await waitFor(() => board.spindle === false, 2000)).toBe(true);

            const t0 = Date.now();
            controller.command('gcode:resume');
            expect(await waitFor(() => realtime(board).includes('RT:~'), 5000)).toBe(true);
            const waited = Date.now() - t0;
            // spindle started while still held, cycle start only after the wait
            expect(realtime(board)).toEqual(['RT:!', 'RT:9E', 'RT:9E', 'RT:~']);
            expect(waited).toBeGreaterThanOrEqual(450);
            expect(board.restoredByCycleStart).toBe(false);
            expect(board.spindle).toBe(true);

            expect(await waitFor(() => controller.sender.state.received >= total, 20000)).toBe(true);
            expect(board.received.filter((l) => /^G[12] /.test(l)).length).toBe(3000);
            expect(triggered).toEqual([]); // nor the Program Resume event
        });
    });

    it('hold mode, "stop the spindle when pausing": stops it once the hold is reported', async () => {
        await onHoldBoard({ ggPauseMode: 'hold', ggHoldStopsSpindle: true, ggResumeSpinupSeconds: 0.2 }, async (board, controller) => {
            const total = await startJob(controller);
            controller.command('gcode:pause');
            expect(await waitFor(() => board.spindle === false, 2000)).toBe(true);
            controller.command('gcode:resume');
            expect(await waitFor(() => controller.sender.state.received >= total, 20000)).toBe(true);
            expect(realtime(board)).toEqual(['RT:!', 'RT:9E', 'RT:9E', 'RT:~']);
            expect(board.restoredByCycleStart).toBe(false);
        });
    });

    it('hold mode: a cycle start from the pendant resumes the job', async () => {
        await onHoldBoard({ ggPauseMode: 'hold', ggHoldStopsSpindle: false }, async (board, controller) => {
            const total = await startJob(controller);
            controller.command('gcode:pause');
            await sleep(400);
            expect(controller.workflow.state).toBe('paused');
            board.write('~'); // the pendant's button
            expect(await waitFor(() => controller.workflow.state === 'running', 3000)).toBe(true);
            expect(await waitFor(() => controller.sender.state.received >= total, 20000)).toBe(true);
        });
    });

    it('upstream mode: the Program Pause event runs, no feed hold', async () => {
        await onHoldBoard({ ggPauseMode: 'upstream' }, async (board, controller) => {
            const triggered = fakeEvents(controller);
            await startJob(controller);
            controller.command('gcode:pause');
            await sleep(300);
            expect(triggered).toEqual(['gcode:pause']);
            expect(realtime(board)).toEqual([]);
            expect(controller.workflow.state).toBe('paused');
        });
    });
});
