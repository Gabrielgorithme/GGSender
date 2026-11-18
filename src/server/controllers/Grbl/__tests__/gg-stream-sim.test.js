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

/*
 * A board with a planner, like Grbl/FluidNC: a line is answered "ok" as soon
 * as its move is queued (up to PLANNER moves), and the moves execute later,
 * one after the other (rapids slower than the short cuts). A line with G4
 * (dwell) is answered only once every earlier move has executed, and its own
 * move is queued after that, as the firmware does. Overrides follow the
 * realtime bytes. The log shows, in order, what was executed (EXEC:) and when
 * each realtime byte arrived (RT:).
 */
class PlannerBoard extends FakeBoard {
    static PLANNER = 8;
    held = false;
    plane = 'G17';
    events = [];
    rx = [];
    planner = [];
    executing = null;
    feedOv = 100;
    spindleOv = 100;
    log = [];
    waiting = false;

    status() {
        const state = this.rx.length > 0 || this.planner.length > 0 || this.executing ? 'Run' : 'Idle';
        return `<${state}|MPos:0.000,0.000,0.000|FS:1000,12000|Ov:${this.feedOv},100,${this.spindleOv}>`;
    }

    write(data) {
        const text = String(data);
        if (text === '?') {
            this.reply(this.status());
            return;
        }
        if (text === '\x18') {
            this.rx = [];
            this.planner = [];
            setTimeout(() => this.reply("Grbl 1.1f ['$' for help]"), 5);
            return;
        }
        if (text.length === 1 && text !== '\n') {
            const c = text.charCodeAt(0);
            if (text === '!') this.held = true;
            if (text === '~') {
                this.held = false;
                setImmediate(() => this.execute());
            }
            const steps = { 0x91: 10, 0x92: -10, 0x93: 1, 0x94: -1 };
            const sSteps = { 0x9a: 10, 0x9b: -10, 0x9c: 1, 0x9d: -1 };
            if (c === 0x90) this.feedOv = 100;
            if (steps[c]) this.feedOv += steps[c];
            if (c === 0x99) this.spindleOv = 100;
            if (sSteps[c]) this.spindleOv += sSteps[c];
            this.log.push(`RT:${c.toString(16)}`);
            return;
        }
        text.split('\n').filter((l) => l.length > 0).forEach((l) => this.rx.push(l));
        this.parse();
    }

    parse() {
        while (this.isOpen && this.rx.length > 0) {
            const line = this.rx[0];
            const isDwell = /G0*4(?![0-9])/.test(line);
            if (isDwell && (this.planner.length > 0 || this.executing)) {
                return; // synchronise: wait for the moves to run out
            }
            const isMove = /[XYZ]-?[\d.]/.test(line) && !line.startsWith('$');
            if (isMove && this.planner.length >= PlannerBoard.PLANNER) {
                return; // planner full
            }
            this.rx.shift();
            this.received.push(line);
            if (/G1[789]/.test(line)) this.plane = /G1[789]/.exec(line)[0];
            // like FluidNC: an arc with I/K but no J read in the XY plane has
            // a zero radius at its end point
            if (/G[23](?![0-9])/.test(line) && /K/.test(line) && !/J/.test(line) && this.plane === 'G17') {
                this.log.push(`ERR:${line}`);
                this.reply('error:33');
                continue;
            }
            if (line === '$G') {
                this.reply('[GC:G1 G54 G17 G21 G90 G94 M3 M9 T0 F1000 S12000]');
            }
            if (isMove) {
                this.planner.push(line);
                this.execute();
            }
            this.reply('ok');
        }
    }

    emitToSockets(eventName, ...args) {
        this.events.push([eventName, ...args]);
    }

    execute() {
        if (this.executing || this.held || this.planner.length === 0 || !this.isOpen) {
            return;
        }
        this.executing = this.planner.shift();
        this.log.push(`EXEC:${this.executing}`);
        const ms = /^G0 /.test(this.executing) || /G0 X/.test(this.executing) ? 12 : 2;
        setTimeout(() => {
            this.executing = null;
            this.parse();
            this.execute();
        }, ms);
    }
}

/*
 * A board that a pendant homes: it starts in Alarm (FluidNC with must_home)
 * or Idle (homed before the computer was connected); home() plays a homing
 * cycle as FluidNC reports it: state Home, then [MSG:Homed:...], then Idle.
 */
class HomingBoard extends FakeBoard {
    state = 'Alarm';
    events = [];

    status() {
        return `<${this.state}|MPos:0.000,0.000,0.000|FS:0,0>`;
    }

    emitToSockets(eventName, ...args) {
        this.events.push([eventName, ...args]);
    }

    async home() {
        this.state = 'Home';
        await sleep(600);
        this.reply('[MSG:Homed:Z]');
        this.reply('[MSG:Homed:XY]');
        this.state = 'Idle';
    }
}

/*
 * A board with a tool sensor and a work offset, like FluidNC: status reports
 * carry MPos, and WCO after each change of it and every 10th report. A probe
 * (G38.2) stops with the tool tip on the sensor: machine Z = S + L for a tool
 * of length L. G10 L20 P0 Z<v> writes the offset so that the present position
 * reads v. The part's surface is at machine Z = P + L (zeroByHand puts the Z
 * zero there, as a pendant does: no line goes through gSender). G4 dwells in
 * real time, as the wizard counts on it to get a report after the probe.
 */
class SensorBoard extends FakeBoard {
    S = -70; // sensor trigger height, for a tool of length 0
    P = -55; // part surface, for a tool of length 0
    L = 30; // length of the tool in the spindle
    mz = 0; // machine Z
    wcoZ = 0;
    wcs = 'G54';
    distance = 'G90';
    events = [];
    wcoCounter = 0;
    active = false; // a line other than a "$" query is being handled
    g10 = []; // G10 lines as received

    emitToSockets(eventName, ...args) {
        this.events.push([eventName, ...args]);
    }

    status() {
        // a "$" query does not make the machine run
        const state = this.active || this.queue.some((l) => !l.startsWith('$')) ? 'Run' : 'Idle';
        let wco = '';
        if (this.wcoCounter <= 0) {
            wco = `|WCO:0.000,0.000,${this.wcoZ.toFixed(3)}`;
            this.wcoCounter = 10;
        } else {
            this.wcoCounter--;
        }
        return `<${state}|MPos:1.000,2.000,${this.mz.toFixed(3)}|FS:0,0${wco}>`;
    }

    setWco(z) {
        this.wcoZ = z;
        this.wcoCounter = 0; // FluidNC reports WCO right after a change
    }

    /** From the pendant: Z zero with the tool tip on a surface (the part's by default). */
    zeroByHand(surface = this.P) {
        this.mz = surface + this.L;
        this.setWco(this.mz);
    }

    /** Machine height of the Z zero of the part (tool length taken out). */
    zeroPlane() {
        return this.wcoZ - this.L;
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
            this.active = !line.startsWith('$');
            let wait = 0;
            const code = line.replace(/\([^)]*\)/g, ' ');
            if (line === '$G') {
                this.reply(`[GC:G0 ${this.wcs} G17 G21 ${this.distance} G94 M5 M9 T0 F0 S0]`);
            } else if (!line.startsWith('$')) {
                if (/G91(?![0-9.])/.test(code)) this.distance = 'G91';
                if (/G90(?![0-9.])/.test(code)) this.distance = 'G90';
                const z = /Z(-?[\d.]+)/.exec(code);
                const dwell = /G0*4(?![0-9])\s*P([\d.]+)/.exec(code);
                if (dwell) {
                    wait = Number(dwell[1]) * 1000;
                } else if (/G38\.2/.test(code)) {
                    wait = 25;
                } else if (/G10\s*L20\s*P0/.test(code) && z) {
                    this.g10.push(line);
                    this.setWco(this.mz - Number(z[1]));
                } else if (/G28|G30/.test(code)) {
                    // home position: not modelled
                } else if (/G53/.test(code) && z) {
                    this.mz = Number(z[1]);
                } else if (z && /G0?[01](?![0-9.])|^N\d+\s+Z|^Z/.test(code)) {
                    this.mz = this.distance === 'G91' ? this.mz + Number(z[1]) : Number(z[1]) + this.wcoZ;
                }
                // a program move takes a moment: a job can be stopped part way
                if (wait === 0 && /^N\d+ /.test(line) && /[XYZ]-?[\d.]/.test(code)) {
                    wait = 2;
                }
            }
            const done = () => {
                if (!this.isOpen) {
                    this.busy = false;
                    return;
                }
                if (/G38\.2/.test(code)) {
                    this.mz = this.S + this.L; // the tip is on the sensor
                    this.reply(`[PRB:1.000,2.000,${this.mz.toFixed(3)}:1]`);
                }
                this.active = false;
                this.reply('ok');
                setImmediate(step);
            };
            if (wait > 0) {
                setTimeout(done, wait);
            } else {
                done();
            }
        };
        this.busy = true;
        setImmediate(step);
    }
}

/* A board that also records what the controller sends to the interface. */
class RecordingBoard extends FakeBoard {
    events = [];

    emitToSockets(eventName, ...args) {
        this.events.push([eventName, ...args]);
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

    // ---- GGSender 0.7.0: overrides back to 100% at each operation ---------

    const twoOperations = () => {
        const out = ['(program)', 'G21 G90', 'M3 S12000', '', '(First op)', 'G0 X0 Y0', 'G0 Z3', 'G1 Z-1 F300'];
        for (let i = 0; i < 300; i++) out.push(`G1 X${(i % 50) * 0.2} Y${(i % 7) * 0.3} F1000`);
        out.push('G0 Z5.5', '', '(Second op)', 'G0 X20 Y0', 'G0 Z4', 'G1 Z-1.5 F300');
        for (let i = 0; i < 300; i++) out.push(`G1 X${20 + (i % 50) * 0.2} Y${(i % 7) * 0.3} F1000`);
        out.push('G0 Z15', 'M5');
        return out.join('\n');
    };

    const runTwoOperations = async (board, controller) => {
        const gcode = twoOperations();
        const lines = gcode.split('\n').filter((l) => l.trim().length > 0);
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'ops.nc' }, gcode, {}, (err) => (err ? reject(err) : resolve()));
        });
        controller.command('gg:job:operations', {
            name: 'ops.nc',
            total: lines.length,
            boundaries: [{ seq: lines.indexOf('G0 X20 Y0'), text: 'G0 X20 Y0', name: 'Second op' }],
        });
        controller.command('gcode:start');
        // the owner slows the first operation down
        await waitFor(() => controller.sender.state.received > 20);
        controller.command('feedOverride', 80);
        controller.command('spindleOverride', 90);
        expect(await waitFor(() => controller.sender.state.received >= lines.length, 30000)).toBe(true);
        await waitFor(() => board.planner.length === 0 && !board.executing, 3000);
    };

    it('resets feed and spindle overrides between the operations, after the first one has run out', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, PlannerBoard);
        try {
            await runTwoOperations(board, controller);
            // the dwell went on the second operation's first move only
            expect(board.received).toContain('G0 X20 Y0 G4 P0');
            expect(board.received.filter((l) => /G4 P0$/.test(l))).toHaveLength(1);
            // overrides were 80% and 90% during the first operation...
            const firstOpEnd = board.log.indexOf('EXEC:G0 Z5.5');
            const secondOpCut = board.log.indexOf('EXEC:G1 Z-1.5 F300');
            expect(firstOpEnd).toBeGreaterThan(0);
            const feedReset = board.log.indexOf('RT:90');
            const spindleReset = board.log.indexOf('RT:99');
            // ...and went back to 100 after the last move of the first one ran,
            // before the first cut of the second one
            expect(feedReset).toBeGreaterThan(firstOpEnd);
            expect(feedReset).toBeLessThan(secondOpCut);
            expect(spindleReset).toBeGreaterThan(firstOpEnd);
            expect(spindleReset).toBeLessThan(secondOpCut);
            expect(board.log.slice(0, firstOpEnd).filter((e) => e === 'RT:92')).toHaveLength(2); // the owner's -20%
            expect(board.feedOv).toBe(100);
            expect(board.spindleOv).toBe(100);
            const log = fs.readFileSync(trafficLog.getTrafficLogFile(), 'utf8');
            expect(log).toMatch(/"Second op" begins, reset: feed spindle/);
        } finally {
            await stop(controller, board);
        }
    });

    it('setting off: no dwell added, overrides stay', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, PlannerBoard);
        try {
            controller.command('settings:updated', { ggResetOverridesPerOp: false });
            await runTwoOperations(board, controller);
            expect(board.received).toContain('G0 X20 Y0');
            expect(board.received.some((l) => /G4/.test(l))).toBe(false);
            expect(board.log).not.toContain('RT:90');
            expect(board.feedOv).toBe(80);
            expect(board.spindleOv).toBe(90);
        } finally {
            controller.command('settings:updated', { ggResetOverridesPerOp: true });
            await stop(controller, board);
        }
    });

    // ---- GGSender 0.7.0: homed state from the controller -------------------

    const homedEvents = (board) => board.events.filter(([e]) => e === 'gg:homed').map(([, s]) => s);

    it('a machine homed before connecting: reported as homed before the connection', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, class extends HomingBoard {
            state = 'Idle';
        });
        try {
            expect(homedEvents(board)).toEqual([{ homed: true, how: 'before-connect', axes: '' }]);
        } finally {
            await stop(controller, board);
        }
    });

    it('in alarm at connection, then homed from the pendant: reported as seen', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, HomingBoard);
        try {
            expect(homedEvents(board)).toEqual([]);
            await board.home();
            expect(await waitFor(() => homedEvents(board).length > 0, 3000)).toBe(true);
            expect(homedEvents(board)).toEqual([{ homed: true, how: 'seen', axes: 'XYZ' }]);
            // upstream's own flag is left alone
            expect(controller.hasHomedSet).toBe(false);
            board.reply('ALARM:1');
            expect(homedEvents(board).pop()).toEqual({ homed: false, how: null, axes: '' });
        } finally {
            await stop(controller, board);
        }
    });

    // ---- GGSender 0.7.0: resume from a line ---------------------------------

    // eslint-disable-next-line global-require
    const { planResume, resumePayload } = require('../../../../app/src/lib/gg/resumePlan');
    // eslint-disable-next-line global-require
    const { analyzeJob } = require('../../../../app/src/lib/gg/jobOperations');

    const fusionLike = () => {
        const out = [
            '(prog)',
            '(T5 D=6 CR=0 - ZMIN=-1 - flat end mill)',
            'N10 G90 G94',
            'N11 G17',
            'N12 G21',
            'N13 G28 G91 Z0',
            'N14 G90',
            '',
            '(Op A)',
            'N15 T5 M6',
            'N16 S12000 M3',
            'N17 G17 G90 G94',
            'N18 G54',
            'N19 M8',
            'N20 G0 X0 Y0',
            'N21 Z5',
            'N22 G0 Z3',
            'N23 G1 Z-1 F200',
            'N24 G1 X10 Y0 F800',
        ];
        let n = 25;
        for (let i = 0; i < 400; i++) out.push(`N${n++} X${(i % 40) * 0.25} Y${Math.floor(i / 40) * 0.5}`);
        out.push(`N${n++} G0 Z5`, '', '(Op B)', `N${n++} G0 X20 Y0`, `N${n++} Z3`, `N${n++} G1 Z-1 F200`);
        for (let i = 0; i < 100; i++) out.push(`N${n++} G1 X${20 + (i % 10)} Y${Math.floor(i / 10)} F800`);
        out.push(`N${n++} G0 Z5`, `N${n++} M9`, `N${n++} M5`, `N${n++} G28 G91 Z0`, `N${n++} M30`);
        return out.join('\n');
    };

    const loadProgram = async (controller, gcode) => {
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'resume.nc' }, gcode, {}, (err) => (err ? reject(err) : resolve()));
        });
        // the resume needs the machine reported Idle
        expect(await waitFor(() => controller.state.status.activeState === 'Idle', 5000)).toBe(true);
    };

    const planFor = (gcode, n, measureTool = false) => {
        const lines = gcode.split('\n');
        const line = lines.findIndex((l) => l.startsWith(`${n} `));
        const plan = planResume(gcode, analyzeJob(gcode), line, { safeZ: -0.1, measureTool, spinupSeconds: 0.2 });
        expect(plan.ok).toBe(true);
        const total = lines.filter((l) => l.trim().length > 0).length;
        return { plan, payload: resumePayload(plan, total, measureTool) };
    };

    it('resume from a line: entry moves first, then the program from that line to its end', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, RecordingBoard);
        try {
            const gcode = fusionLike();
            await loadProgram(controller, gcode);
            const original = controller.sender.state.lines;
            const { plan, payload } = planFor(gcode, 'N300');
            const before = board.received.length;
            controller.command('gg:resume:start', payload);
            expect(await waitFor(() => controller.sender.state.received >= controller.sender.state.total, 20000)).toBe(true);
            const sent = board.received.slice(before).filter((l) => l !== '$G' && l !== '$$');
            // the entry lines (the comment is not sent), then N300 onwards
            const entry = plan.preamble.filter((l) => !l.startsWith('('));
            expect(sent.slice(0, entry.length)).toEqual(entry);
            expect(entry[0]).toBe('G21 G53 G0 Z-0.1');
            expect(entry).toContain('S12000 M3');
            expect(entry).toContain('M8');
            expect(sent[entry.length]).toBe(plan.text);
            expect(sent[entry.length].startsWith('N300 ')).toBe(true);
            // nothing before N300 was sent, everything after it was
            const nums = sent.map((l) => /^N(\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
            expect(Math.min(...nums)).toBe(300);
            const lastLine = gcode.split('\n').pop();
            expect(lastLine).toMatch(/^N\d+ M30$/);
            expect(sent[sent.length - 1]).toBe(lastLine);
            expect(sent.some((l) => /^N(1\d\d|2\d\d) /.test(l))).toBe(false);
            // the come-down: rapid to the operation's highest rapid height, then fed
            const at = plan.start;
            expect(entry).toContain(`G0 X${at.x} Y${at.y}`);
            expect(entry).toContain('G0 Z5');
            expect(entry).toContain(`G1 Z${at.z} F200`);
            // stopped: the program is back as loaded
            controller.command('gcode:stop', { force: true });
            await sleep(200);
            expect(controller.sender.state.lines).toBe(original);
            const log = fs.readFileSync(trafficLog.getTrafficLogFile(), 'utf8');
            expect(log).toMatch(/# resume: line \d+ "N300 /);
        } finally {
            await stop(controller, board);
        }
    });

    it('resume refused when the loaded program is not the one planned: nothing sent, nothing changed', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, RecordingBoard);
        try {
            const gcode = fusionLike();
            await loadProgram(controller, gcode);
            const original = controller.sender.state.lines;
            const { payload } = planFor(gcode, 'N300');
            const before = board.received.length;
            controller.command('gg:resume:start', { ...payload, text: 'N300 X0 Y0' });
            controller.command('gg:resume:start', { ...payload, total: payload.total + 1 });
            controller.command('gg:resume:start', { ...payload, preamble: ['$H'] });
            await sleep(300);
            expect(board.events.filter(([e]) => e === 'gg:resume:error')).toHaveLength(3);
            expect(controller.workflow.state).toBe('idle');
            expect(controller.sender.state.lines).toBe(original);
            expect(board.received.slice(before).filter((l) => l !== '$G' && l !== '$$')).toEqual([]);
            // a normal start afterwards runs the program from its first line
            controller.command('gcode:start');
            expect(await waitFor(() => board.received.includes('N10 G90 G94'), 5000)).toBe(true);
        } finally {
            await stop(controller, board);
        }
    });

    it('resume with a tool change: the change count is not touched, and the tool mode reaches the request', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Fixed Tool Sensor' }, RecordingBoard);
        try {
            const gcode = fusionLike();
            await loadProgram(controller, gcode);
            // what an earlier tool change of this connection leaves
            controller.sharedContext.toolchange = { TOOL_OFFSET: -42.125 };
            const { plan } = planFor(gcode, 'N300', true);
            expect(plan.preamble).toContain('T5 M6');
            const total = gcode.split('\n').filter((l) => l.trim().length > 0).length;
            controller.command('gg:resume:start', resumePayload(plan, total, 'measure'));
            expect(await waitFor(() => board.events.some(([e]) => e === 'gcode:toolChange'), 10000)).toBe(true);
            const [, ctx] = board.events.find(([e]) => e === 'gcode:toolChange');
            expect(controller.workflow.state).toBe('paused'); // waiting for the wizard
            // 0.7.0 set the count to 2 here to skip the initial probe; now the
            // interface decides from the resume mode and the reference
            expect(ctx.count).toBe(1);
            expect(ctx.tool).toBe('T5');
            expect(ctx.ggResume).toEqual({ resumed: true, mode: 'measure' });
            expect(ctx.ggReference.status).toBe('none');
        } finally {
            await stop(controller, board);
        }
    });

    // ---- GGSender 0.7.1: the tool sensor reference, and resume tool choices ---

    // eslint-disable-next-line global-require
    const wizardLines = require('../../../lib/gg/__fixtures__/wizardLines');
    // eslint-disable-next-line global-require
    const { decideFixedSensor } = require('../../../../app/src/lib/gg/toolChangeDecision');

    const twoTools = () => {
        const out = [
            '(prog)',
            '(T5 D=6 CR=0 - ZMIN=-1 - flat end mill)',
            '(T7 D=3 CR=0 - ZMIN=-1 - flat end mill)',
            'N10 G90 G94',
            'N11 G17',
            'N12 G21',
            'N13 G28 G91 Z0',
            'N14 G90',
            '',
            '(Op A)',
            'N15 T5 M6',
            'N16 S12000 M3',
            'N17 G17 G90 G94',
            'N18 G54',
            'N20 G0 X0 Y0',
            'N21 Z5',
            'N22 G0 Z3',
            'N23 G1 Z-1 F200',
            'N24 G1 X10 Y0 F800',
        ];
        let n = 25;
        for (let i = 0; i < 150; i++) out.push(`N${n++} X${(i % 40) * 0.25} Y${Math.floor(i / 40) * 0.5}`);
        out.push(`N${n++} G0 Z5`, `N${n++} M5`, '', '(Op B)', `N${n++} T7 M6`, `N${n++} S12000 M3`, `N${n++} G0 X20 Y0`, `N${n++} Z5`, `N${n++} G1 Z-1 F200`);
        for (let i = 0; i < 60; i++) out.push(`N${n++} G1 X${20 + (i % 10)} Y${Math.floor(i / 10)} F800`);
        out.push(`N${n++} G0 Z5`, `N${n++} M9`, `N${n++} M5`, `N${n++} G28 G91 Z0`, `N${n++} M30`);
        return out.join('\n');
    };

    const probeState = (controller) => controller.ggProbes.snapshot();
    const toolChanges = (board) => board.events.filter(([e]) => e === 'gcode:toolChange').map(([, ctx]) => ctx);
    const feederDone = (controller, board) =>
        waitFor(() => controller.feeder.size() === 0 && !controller.feeder.isPending() && !board.busy && board.queue.length === 0, 15000);

    /** The tool change request number `n` (from 1), once the wizard would open. */
    const nextToolChange = async (board, n) => {
        expect(await waitFor(() => toolChanges(board).length >= n, 20000)).toBe(true);
        return toolChanges(board)[n - 1];
    };

    /** What the interface decides for a request (the real decision function). */
    const decide = (ctx, guard = true) =>
        decideFixedSensor({
            count: ctx.count,
            reference: ctx.ggReference,
            resumed: ctx.ggResume.resumed,
            resumeMode: ctx.ggResume.mode,
            guard,
        });

    /**
     * Play a wizard as the interface does: tell the server which one, send
     * its start code, then each step's code. `newLength`: the tool fitted
     * before "Probe Changed Tool".
     */
    const runWizard = async (controller, board, variant, { target, newLength } = {}) => {
        controller.command('gg:probe:wizard', { variant, target });
        controller.command('gcode', wizardLines.startLines());
        expect(await feederDone(controller, board)).toBe(true);
        if (variant === 'reference' || variant === 'full') {
            controller.command('wizard:step', 0, 0);
            controller.command('gcode', wizardLines.PROBE_AS_REFERENCE);
            expect(await feederDone(controller, board)).toBe(true);
        }
        if (variant === 'full' || variant === 'measure') {
            board.L = newLength; // the owner fits the new tool
            controller.command('wizard:step', 1, 0);
            controller.command('gcode', wizardLines.PROBE_AGAINST_REFERENCE);
            expect(await feederDone(controller, board)).toBe(true);
        }
        controller.command('gcode', wizardLines.RESUME);
    };

    const startSensor = async () => {
        const started = await start({ toolChangeOption: 'Fixed Tool Sensor' }, SensorBoard);
        // the owner set Z zero on the part with the tool in the spindle, before anything
        started.board.zeroByHand();
        await sleep(600);
        return started;
    };

    it('a job with two tools: the first tool is the reference, the second is set against it, Z zero stays on the part', async () => {
        const { board, controller } = await startSensor();
        try {
            controller.command('gg:probe:loaded', '5');
            const plane = board.zeroPlane();
            expect(probeState(controller).status).toBe('none');
            await new Promise((resolve, reject) => {
                controller.command('gcode:load', { name: 'two.nc' }, twoTools(), {}, (err) => (err ? reject(err) : resolve()));
            });
            controller.command('gcode:start');

            // first M6: the first tool of a job started from the top
            const first = await nextToolChange(board, 1);
            expect(first).toMatchObject({ count: 1, tool: 'T5', ggResume: { resumed: false, mode: null } });
            expect(first.ggReference.status).toBe('none');
            expect(decide(first).variant).toBe('first-tool');
            // "Always probe length only": T5 is in the spindle already
            await runWizard(controller, board, 'reference', { target: 'T5' });

            // second M6: a reference exists and Z zero did not change
            const second = await nextToolChange(board, 2);
            expect(second).toMatchObject({ count: 2, tool: 'T7', ggResume: { resumed: false, mode: null } });
            expect(second.ggReference.status).toBe('valid');
            expect(second.ggReference.reference.tool).toBe('5');
            // the sensor's height above the Z zero of the part
            expect(second.ggReference.reference.value).toBeCloseTo(board.S - board.P, 3);
            expect(decide(second)).toEqual({ variant: 'measure', reason: 'valid', overrule: 'full' });
            expect(board.g10).toEqual([]); // nothing wrote the offset so far
            await runWizard(controller, board, 'measure', { target: 'T7', newLength: 41.25 });
            expect(await waitFor(() => controller.sender.state.received >= controller.sender.state.total, 20000)).toBe(true);

            // the wizard's G10 carried the reference, and the part's Z zero is where it was
            expect(board.g10).toHaveLength(1);
            expect(board.g10[0]).toMatch(/^G10 L20 P0 Z-?[\d.]+$/);
            expect(Number(/Z(-?[\d.]+)/.exec(board.g10[0])[1])).toBeCloseTo(board.S - board.P, 3);
            expect(board.zeroPlane()).toBeCloseTo(plane, 3);
            const state = probeState(controller);
            expect(state.status).toBe('valid');
            expect(state.lastProbe).toMatchObject({ kind: 'measured', tool: '7' });
            // the Z zero set by hand before the job is in the history too
            expect(state.history.map((h) => h.kind)).toEqual(['zero', 'reference', 'measured']);
            expect(state.history[2].deltaZ).toBeCloseTo(-11.25, 3); // a tool 11.25 mm longer
            // the interface was told at each change
            const states = board.events.filter(([e]) => e === 'gg:probe:state').map(([, st]) => st.status);
            expect(states).toEqual(['none', 'valid', 'valid']);
            const log = fs.readFileSync(trafficLog.getTrafficLogFile(), 'utf8');
            expect(log).toMatch(/# probe: tool change to T7, count 2, resumed false, resume mode null, reference valid/);
        } finally {
            await stop(controller, board);
        }
    });

    it('Z zero set from the pendant after a probe: seen within a second, the reference is stale; setting it by gSender too', async () => {
        const { board, controller } = await startSensor();
        try {
            // a reference, as a tool change leaves it
            controller.command('gg:probe:wizard', { variant: 'reference', target: 'T5' });
            controller.command('gcode', [...wizardLines.startLines(), ...wizardLines.PROBE_AS_REFERENCE]);
            expect(await waitFor(() => probeState(controller).status === 'valid', 10000)).toBe(true);
            expect(await feederDone(controller, board)).toBe(true);
            board.events.length = 0;

            // the pendant: nothing passes through gSender
            const before = board.received.length;
            board.L = 38;
            board.zeroByHand(board.P + 0.12);
            const t0 = Date.now();
            expect(await waitFor(() => probeState(controller).status === 'stale', 3000)).toBe(true);
            expect(Date.now() - t0).toBeLessThan(1000);
            expect(board.received.slice(before).filter((l) => !l.startsWith('$'))).toEqual([]);
            const state = probeState(controller);
            expect(state.stale.kind).toBe('zero');
            expect(state.reference.tool).toBe('5');
            expect(board.events.filter(([e]) => e === 'gg:probe:state').pop()[1].status).toBe('stale');

            // putting the offset back by hand makes it valid again
            board.L = 30;
            board.zeroByHand();
            expect(await waitFor(() => probeState(controller).status === 'valid', 3000)).toBe(true);
            // the Zero button of gSender, with the tool 5 mm above the part
            controller.command('gcode', ['G90 G0 Z5', 'G10 L20 P0 Z0']);
            expect(await waitFor(() => probeState(controller).status === 'stale', 3000)).toBe(true);
            expect(probeState(controller).history.pop().kind).toBe('zero');
        } finally {
            await stop(controller, board);
        }
    });

    /** Run the two-tool job to the middle of its first operation, stop, as after a broken bit. */
    const runAndStop = async (controller, board) => {
        controller.command('gg:probe:loaded', '5');
        const gcode = twoTools();
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'two.nc' }, gcode, {}, (err) => (err ? reject(err) : resolve()));
        });
        controller.command('gcode:start');
        const first = await nextToolChange(board, 1);
        expect(decide(first).variant).toBe('first-tool');
        await runWizard(controller, board, 'reference', { target: 'T5' });
        expect(await waitFor(() => board.received.some((l) => l.startsWith('N60 ')), 20000)).toBe(true);
        controller.command('gcode:stop', { force: true });
        expect(await waitFor(() => controller.workflow.state === 'idle', 5000)).toBe(true);
        expect(await waitFor(() => controller.state.status.activeState === 'Idle', 5000)).toBe(true);
        await sleep(300);
        expect(probeState(controller).status).toBe('valid');
        return gcode;
    };

    const resumeAt = (controller, board, gcode, n, toolMode) => {
        const lines = gcode.split('\n');
        const line = lines.findIndex((l) => l.startsWith(`${n} `));
        const measureTool = toolMode !== 'keep';
        const plan = planResume(gcode, analyzeJob(gcode), line, { safeZ: -0.1, measureTool, spinupSeconds: 0.2 });
        expect(plan.ok).toBe(true);
        const total = lines.filter((l) => l.trim().length > 0).length;
        const errors = board.events.filter(([e]) => e === 'gg:resume:error').length;
        controller.command('gg:resume:start', resumePayload(plan, total, toolMode));
        expect(board.events.filter(([e]) => e === 'gg:resume:error').slice(errors)).toEqual([]);
        return plan;
    };

    it('the owner\'s case: bit broken, Z zero set by hand with the new one, resume with choice 3. The hand-set Z zero is kept, here and at the next tool', async () => {
        const { board, controller } = await startSensor();
        try {
            const gcode = await runAndStop(controller, board);
            const oldReference = probeState(controller).reference.value;

            // new bit of another length; Z zero by hand, 0.12 mm higher than the first time
            board.L = 36.4;
            board.zeroByHand(board.P + 0.12);
            expect(await waitFor(() => probeState(controller).status === 'stale', 3000)).toBe(true);
            const handPlane = board.zeroPlane();
            const handWco = board.wcoZ;
            const g10Before = board.g10.length;

            // Resume From, choice 3
            const plan = resumeAt(controller, board, gcode, 'N60', 'reference');
            expect(plan.preamble).toContain('T5 M6');
            const ctx = await nextToolChange(board, 2);
            expect(ctx).toMatchObject({ count: 1, tool: 'T5', ggResume: { resumed: true, mode: 'reference' } });
            expect(ctx.ggReference.status).toBe('stale');
            expect(decide(ctx)).toEqual({ variant: 'reference', reason: 'resume-reference', overrule: null });
            await runWizard(controller, board, 'reference', { target: 'T5' });

            // measured as the new reference: nothing wrote the work offset
            expect(await waitFor(() => probeState(controller).status === 'valid', 10000)).toBe(true);
            expect(board.g10.length).toBe(g10Before);
            expect(board.wcoZ).toBe(handWco);
            const state = probeState(controller);
            expect(state.reference.tool).toBe('5');
            expect(state.reference.value).toBeCloseTo(oldReference - 0.12, 3);
            expect(state.history[state.history.length - 1]).toMatchObject({ kind: 'reference', tool: '5' });
            expect(state.history[state.history.length - 1].zeroShift).toBeCloseTo(0.12, 3);

            // the job goes on to the program's tool change: T7 against the NEW reference
            const next = await nextToolChange(board, 3);
            expect(next).toMatchObject({ count: 2, tool: 'T7', ggResume: { resumed: true, mode: null } });
            expect(next.ggReference.status).toBe('valid');
            expect(decide(next)).toEqual({ variant: 'measure', reason: 'valid', overrule: 'full' });
            await runWizard(controller, board, 'measure', { target: 'T7', newLength: 22 });
            expect(await waitFor(() => controller.sender.state.received >= controller.sender.state.total, 20000)).toBe(true);
            // T7 cuts at the Z zero the owner set by hand
            expect(board.zeroPlane()).toBeCloseTo(handPlane, 3);
            expect(probeState(controller).status).toBe('valid');
        } finally {
            await stop(controller, board);
        }
    });

    it('what 0.7.0 did in that case ("change or measure" against the old reference): Z zero goes back, which is now refused by default', async () => {
        const { board, controller } = await startSensor();
        try {
            const gcode = await runAndStop(controller, board);
            const firstPlane = board.zeroPlane();
            board.L = 36.4;
            board.zeroByHand(board.P + 0.12);
            expect(await waitFor(() => probeState(controller).status === 'stale', 3000)).toBe(true);

            // choice 2 without accepting the old reference: the decision does not use it
            resumeAt(controller, board, gcode, 'N60', 'measure');
            const ctx = await nextToolChange(board, 2);
            expect(ctx.ggResume).toEqual({ resumed: true, mode: 'measure' });
            expect(ctx.ggReference.status).toBe('stale');
            const d = decide(ctx);
            expect(d.variant).toBe('full');
            expect(d.reason).toBe('resume-changed');

            // overruled to the old reference: this is the 0.7.0 behaviour, shown for what it is
            await runWizard(controller, board, 'measure', { target: 'T5', newLength: 36.4 });
            expect(await waitFor(() => probeState(controller).history.some((h) => h.kind === 'measured'), 10000)).toBe(true);
            expect(board.zeroPlane()).toBeCloseTo(firstPlane, 3); // the hand-set zero (0.12 higher) is gone
            const last = probeState(controller).history.filter((h) => h.kind === 'measured').pop();
            expect(last.oldReference).toBe(true);
            expect(last.deltaZ).toBeCloseTo(0.12, 3);
            expect(probeState(controller).status).toBe('valid');
        } finally {
            await stop(controller, board);
        }
    });

    it('resume keeping the tool, then the program\'s tool change: marked as a resumed job, so never "first tool"; stale after a pendant zero', async () => {
        const { board, controller } = await startSensor();
        try {
            const gcode = await runAndStop(controller, board);
            const plan = resumeAt(controller, board, gcode, 'N60', 'keep');
            expect(plan.preamble.some((l) => /M6/.test(l))).toBe(false);
            const ctx = await nextToolChange(board, 2);
            // count 1: upstream takes this for the first tool of a job
            expect(ctx).toMatchObject({ count: 1, tool: 'T7', ggResume: { resumed: true, mode: null } });
            expect(ctx.ggReference.status).toBe('valid');
            expect(decide(ctx)).toEqual({ variant: 'measure', reason: 'valid', overrule: 'full' });
            expect(decide(ctx, false).variant).toBe('measure'); // with the setting off too

            // stop, set Z zero from the pendant, resume again keeping the tool
            controller.command('gcode:stop', { force: true });
            expect(await waitFor(() => controller.workflow.state === 'idle', 5000)).toBe(true);
            expect(await waitFor(() => controller.state.status.activeState === 'Idle', 5000)).toBe(true);
            await sleep(300);
            board.zeroByHand(board.P - 1);
            expect(await waitFor(() => probeState(controller).status === 'stale', 3000)).toBe(true);
            const plane = board.zeroPlane();
            resumeAt(controller, board, gcode, 'N60', 'keep');
            const again = await nextToolChange(board, 3);
            expect(again).toMatchObject({ count: 1, tool: 'T7', ggResume: { resumed: true, mode: null } });
            expect(again.ggReference.status).toBe('stale');
            expect(decide(again)).toEqual({ variant: 'full', reason: 'stale', overrule: 'measure' });
            // the default: the tool in the spindle first, then T7; the pendant's Z zero is kept
            await runWizard(controller, board, 'full', { target: 'T7', newLength: 18 });
            expect(await waitFor(() => controller.sender.state.received >= controller.sender.state.total, 20000)).toBe(true);
            expect(board.zeroPlane()).toBeCloseTo(plane, 3);
            const kinds = probeState(controller).history.map((h) => h.kind);
            expect(kinds.slice(-2)).toEqual(['reference', 'measured']);
        } finally {
            await stop(controller, board);
        }
    });

    it('after a resumed job stops, a job started from the top is not a resumed job; a resume without the tool mode its entry lines need is refused', async () => {
        const { board, controller } = await startSensor();
        try {
            const gcode = await runAndStop(controller, board);
            resumeAt(controller, board, gcode, 'N60', 'keep');
            expect(await waitFor(() => controller.workflow.state === 'running', 5000)).toBe(true);
            controller.command('gcode:stop', { force: true });
            expect(await waitFor(() => controller.workflow.state === 'idle', 5000)).toBe(true);
            expect(await waitFor(() => controller.state.status.activeState === 'Idle', 5000)).toBe(true);
            await sleep(300);

            // entry lines with a tool change, but "keep": refused, nothing sent
            const lines = gcode.split('\n');
            const line = lines.findIndex((l) => l.startsWith('N60 '));
            const plan = planResume(gcode, analyzeJob(gcode), line, { safeZ: -0.1, measureTool: true, spinupSeconds: 0.2 });
            const total = lines.filter((l) => l.trim().length > 0).length;
            const before = board.events.filter(([e]) => e === 'gg:resume:error').length;
            controller.command('gg:resume:start', resumePayload(plan, total, 'keep'));
            await sleep(200);
            expect(board.events.filter(([e]) => e === 'gg:resume:error').length).toBe(before + 1);
            expect(controller.workflow.state).toBe('idle');

            const n = toolChanges(board).length;
            controller.command('gcode:start');
            const ctx = await nextToolChange(board, n + 1);
            expect(ctx).toMatchObject({ count: 1, tool: 'T5', ggResume: { resumed: false, mode: null } });
            expect(decide(ctx).variant).toBe('first-tool');
        } finally {
            await stop(controller, board);
        }
    });

    // ---- GGSender 0.7.0: hold the machine at a job error ---------------------

    const xzArcJob = () => {
        const out = ['G21 G90', 'M3 S12000', 'G0 X0 Y0', 'G0 Z3', 'G1 Z-1 F300'];
        for (let i = 0; i < 60; i++) out.push(`G1 X${(i * 0.25).toFixed(2)} Y${(i % 5) * 0.2} F1000`);
        out.push('G2 X16.529 Z-0.5 I0.4 K0'); // needs G18: error:33 in G17
        out.push('G1 X50 Y50 F1000'); // must not run after the refused arc
        for (let i = 0; i < 40; i++) out.push(`G1 X${50 + i} Y50`);
        out.push('G0 Z15', 'M5');
        return out.join('\n');
    };

    const runUntilError = async (board, controller) => {
        await new Promise((resolve, reject) => {
            controller.command('gcode:load', { name: 'xz.nc' }, xzArcJob(), {}, (err) => (err ? reject(err) : resolve()));
        });
        controller.command('gcode:start');
        expect(await waitFor(() => board.log.some((e) => e.startsWith('ERR:')), 10000)).toBe(true);
        await sleep(400);
    };

    it('an error during a job holds the machine at once: the lines after the refused one do not run', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, PlannerBoard);
        try {
            await runUntilError(board, controller);
            const err = board.log.findIndex((e) => e.startsWith('ERR:'));
            expect(board.log.slice(err).some((e) => e === 'RT:21')).toBe(true); // "!"
            expect(board.log).not.toContain('EXEC:G1 X50 Y50 F1000');
            expect(controller.workflow.state).toBe('paused');
            const [, report] = board.events.find(([e]) => e === 'gg:job:error');
            expect(report).toMatchObject({ code: 33, line: 'G2 X16.529 Z-0.5 I0.4 K0', held: true });
            const lines = xzArcJob().split('\n');
            expect(report.seq).toBe(lines.indexOf('G2 X16.529 Z-0.5 I0.4 K0'));
            const [, upstream] = board.events.find(([e]) => e === 'error');
            expect(upstream).toMatchObject({ line: 'G2 X16.529 Z-0.5 I0.4 K0', lineNumber: report.seq, ggHeld: true });
            // Stop throws the queued lines away
            controller.command('gcode:stop', { force: true });
            await sleep(300);
            expect(board.log).not.toContain('EXEC:G1 X50 Y50 F1000');
        } finally {
            await stop(controller, board);
        }
    });

    it('setting off: upstream behaviour, the lines already sent run on (the gouge)', async () => {
        const { board, controller } = await start({ toolChangeOption: 'Ignore' }, PlannerBoard);
        try {
            controller.command('settings:updated', { ggHoldOnError: false });
            await runUntilError(board, controller);
            expect(board.log).not.toContain('RT:21');
            expect(board.log).toContain('EXEC:G1 X50 Y50 F1000');
            const [, report] = board.events.find(([e]) => e === 'gg:job:error');
            expect(report.held).toBe(false);
        } finally {
            controller.command('settings:updated', { ggHoldOnError: true });
            await stop(controller, board);
        }
    });
});
