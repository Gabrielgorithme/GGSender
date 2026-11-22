// GGSender e2e: a fake FluidNC on TCP, for driving the built app end to end
// (connect with Ethernet to 127.0.0.1 and this port). Not FluidNC: a small
// simulation of what the fork depends on.
// usage: node fake-fluidnc.js [port=2323] [log file] [ms per move=25]
// Lines are "ok"ed once queued (planner of 16), executed one by one; G4
// waits for the planner to empty; realtime bytes are taken out of the
// stream (UTF-8); "!" holds, "~" resumes, 0x18 resets; an arc with I/K and no
// J in the G17 plane gets error:33; status reports carry Ov: and A:S.
// Everything is logged to the log file as JSON lines.
//
// Work offset and tool sensor (0.7.1): positions are machine coordinates;
// status reports carry WCO every 10th report when idle and every 30th when
// busy, and NOT right after a change (WCO_ON_CHANGE=1 for that, as Grbl 1.1): as
// FluidNC does. G10 L20 P0 Z<v> writes the Z offset (from any source). G38.2
// ends with the tool tip on the sensor: machine Z = SENSOR + tool length.
// G4 P<s> dwells for real, after the planner has emptied.
// A second port (port + 1) plays the pendant and the owner's hands, one
// command per line, answered with the state as JSON:
//   zero [offset]   Z zero by hand: tool tip on the part's surface (+ offset mm)
//   tool <length>   another tool is in the spindle
//   wco <z>         write the Z offset directly
//   state           only report
//   jog <ms>        a jog from the pendant that lasts <ms>
//
// The spindle and the jog (0.7.5), as FluidNC 4.1 does them: with SPINDOWN_MS
// set, "M5" waits that long for the spindle to stop and the status says Idle
// all that time, with the lines after it still in the buffer. A jog is taken
// in Idle, so also in that wait; it runs when the wait ends. While the
// machine jogs the status says Jog and every G-code line is refused with
// error:9 and "[MSG:ERR: GCode cannot be executed in lock or alarm state]".
const net = require('net');
const fs = require('fs');
const PORT = Number(process.argv[2] || 2323);
const LOG = process.argv[3] || '/tmp/fake-fluidnc.log';
const MS = Number(process.argv[4] || 25);
fs.writeFileSync(LOG, '');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');

// the machine, shared by the connections: machine Z of the sensor trigger and
// of the part's surface for a tool of length 0, the tool in the spindle
const SENSOR = -70;
const SURFACE = -55;
const SPINDOWN_MS = Number(process.env.SPINDOWN_MS || 0);
const machine = {
    toolLength: 30, wcoZ: 0, wcoCounter: 0, pos: { x: 0, y: 0, z: 0 }, planned: { x: 0, y: 0, z: 0 },
    delaying: false, // in the wait of "M5"
    jogQueued: 0, // a jog taken during that wait (ms)
    jogUntil: 0, // the machine jogs until this time
};
const jogging = () => Date.now() < machine.jogUntil;
const startJog = (ms) => {
    machine.jogUntil = Date.now() + ms;
    log({ ev: 'jog', ms });
};
const setWco = (z, why) => {
    machine.wcoZ = z;
    // FluidNC 4.1 does not force a report: the change shows when the counter
    // comes round, up to 2.5 s later when idle and 7.5 s when busy
    if (process.env.WCO_ON_CHANGE === '1') machine.wcoCounter = 0;
    log({ ev: 'wco', z, why });
};
const machineState = () => ({
    toolLength: machine.toolLength,
    wcoZ: machine.wcoZ,
    mposZ: machine.pos.z,
    // machine height of the Z zero of the part, tool length taken out
    zeroPlane: Number((machine.wcoZ - machine.toolLength).toFixed(3)),
    sensorReads: Number((SENSOR + machine.toolLength - machine.wcoZ).toFixed(3)),
});

net.createServer((sock) => {
    log({ ev: 'connect' });
    let buf = '';
    const rx = [];
    const planner = [];
    let executing = null;
    let held = false;
    const ov = { feed: 100, spindle: 100 };
    const { pos, planned } = machine; // machine coordinates; planned: end of the last move queued
    let state = 'Idle';
    let plane = 'G17';
    let spindle = false;
    let incremental = false; // G91
    let syncing = false; // a probe or dwell is under way
    const send = (s) => { if (!sock.destroyed) sock.write(s + '\r\n'); };
    const status = () => {
        const busy = rx.some((l) => l && !l.startsWith('$')) || planner.length || executing || syncing;
        let st = held ? 'Hold:0' : busy ? 'Run' : state;
        if (machine.delaying) st = 'Idle'; // FluidNC shows Idle while it waits for the spindle
        if (jogging()) st = 'Jog';
        let wco = '';
        if (machine.wcoCounter <= 0) {
            wco = `|WCO:0.000,0.000,${machine.wcoZ.toFixed(3)}`;
            // FluidNC 4.1: 10 reports when idle, 30 when in a cycle, hold or jog
            machine.wcoCounter = (st === 'Idle' ? 10 : 30) - 1;
        } else {
            machine.wcoCounter--;
        }
        return `<${st}|MPos:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}|FS:1000,24000|Ov:${ov.feed},100,${ov.spindle}${spindle ? '|A:S' : ''}${wco}>`;
    };
    const codeOf = (line) => line.replace(/\([^)]*\)/g, ' ');
    const target = (line) => {
        const t = { ...planned };
        const code = codeOf(line);
        if (/G28|G30/.test(code)) return t;
        const inMachine = /G53/.test(code);
        for (const a of ['X', 'Y', 'Z']) {
            const m = new RegExp(a + '(-?[\\d.]+)').exec(code);
            if (!m) continue;
            const k = a.toLowerCase();
            const v = Number(m[1]);
            if (inMachine) t[k] = v;
            else if (incremental) t[k] += v;
            else t[k] = v + (k === 'z' ? machine.wcoZ : 0);
        }
        return t;
    };
    const isMove = (l) => /[XYZ]-?[\d.]/.test(codeOf(l)) && !l.startsWith('$') && !/G10|G38|G92|G43/.test(codeOf(l));
    const execute = () => {
        if (executing || held || planner.length === 0) return;
        executing = planner.shift();
        log({ ev: 'exec', line: executing.line });
        setTimeout(() => {
            Object.assign(pos, executing.to);
            executing = null;
            parse();
            execute();
        }, /G0|^N\d+ Z/.test(executing.line) ? MS * 2 : MS);
    };
    const reply = (line) => {
        if (line === '$I') { send('[VER:3.9 FluidNC v3.9.1:]'); send('[OPT:PHSW]'); send('ok'); return; }
        if (line === '$$') {
            ['$0=10', '$1=255', '$10=1', '$13=0', '$20=1', '$21=1', '$22=1', '$23=3', '$30=24000', '$31=0', '$32=0', '$110=4000', '$111=4000', '$112=2000', '$130=300', '$131=300', '$132=80'].forEach(send);
            send('ok'); return;
        }
        if (line === '$G') { send('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]'); send('ok'); return; }
        if (line === '$#') { ['[G54:0.000,0.000,0.000]', '[G55:0.000,0.000,0.000]', '[G28:0.000,0.000,0.000]', '[G30:0.000,0.000,0.000]', '[G92:0.000,0.000,0.000]', '[TLO:0.000]', '[PRB:0.000,0.000,0.000:0]'].forEach(send); send('ok'); return; }
        send('ok');
    };
    const parse = () => {
        while (rx.length) {
            if (syncing) return;
            const line = rx[0];
            // no G-code during a jog, an empty line included
            if (jogging() && !line.startsWith('$')) {
                rx.shift();
                log({ ev: 'refused', line });
                send('error:9');
                send('[MSG:ERR: GCode cannot be executed in lock or alarm state]');
                continue;
            }
            if (line === '') {
                rx.shift();
                send('ok');
                continue;
            }
            const code = codeOf(line);
            // the spindle stops: wait for the moves before it, then for the spindle
            const spindleStop = SPINDOWN_MS > 0 && spindle && /M0*5(?![0-9])/.test(code);
            if (spindleStop) {
                if (planner.length || executing) return;
                rx.shift();
                log({ ev: 'line', line });
                syncing = true;
                machine.delaying = true;
                setTimeout(() => {
                    syncing = false;
                    machine.delaying = false;
                    spindle = false;
                    // the jog taken during the wait runs now, before the lines that waited
                    if (machine.jogQueued) {
                        startJog(machine.jogQueued);
                        machine.jogQueued = 0;
                    }
                    send('ok');
                    parse();
                }, SPINDOWN_MS);
                return;
            }
            const dwell = /G0*4(?![0-9])\s*P([\d.]+)/.exec(code);
            const probe = /G38\.2/.test(code);
            const g10 = /G10\s*L20\s*P0/.test(code);
            // these wait for every earlier move to have run
            if ((/G0*4(?![0-9])/.test(code) || probe || g10) && (planner.length || executing)) return;
            if (isMove(line) && planner.length >= 16) return;
            rx.shift();
            log({ ev: 'line', line });
            if (/G91(?![0-9.])/.test(code)) incremental = true;
            if (/G90(?![0-9.])/.test(code)) incremental = false;
            if (probe || (dwell && Number(dwell[1]) > 0)) {
                // a probe ends on the sensor; a dwell lasts its time
                syncing = true;
                setTimeout(() => {
                    syncing = false;
                    if (probe) {
                        pos.z = SENSOR + machine.toolLength;
                        planned.z = pos.z;
                        log({ ev: 'probe', mposZ: pos.z });
                        send(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:1]`);
                    }
                    send('ok');
                    parse();
                }, probe ? MS * 4 : Number(dwell[1]) * 1000);
                return;
            }
            if (g10) {
                const z = /Z(-?[\d.]+)/.exec(code);
                if (z) setWco(pos.z - Number(z[1]), line);
            }
            if (/M0*3(?![0-9])/.test(line)) spindle = true;
            if (/M0*5(?![0-9])/.test(line)) spindle = false;
            if (/G1[789](?![0-9])/.test(line)) plane = /G1[789]/.exec(line)[0];
            if (/G[23](?![0-9])/.test(line) && /K/.test(line) && !/J/.test(line) && plane === 'G17') {
                log({ ev: 'error', line });
                send('error:33');
                continue;
            }
            if (isMove(line)) {
                const to = target(line);
                Object.assign(planned, to);
                planner.push({ line, to });
                execute();
            }
            reply(line);
        }
    };
    const realtime = (c) => {
        const code = c.codePointAt(0);
        if (c === '?') { send(status()); return; }
        log({ ev: 'rt', code: code.toString(16) });
        if (c === '!') held = true;
        if (c === '~') { held = false; execute(); }
        if (c === '\x18') {
            rx.length = 0; planner.length = 0; executing = null; held = false; incremental = false;
            Object.assign(planned, pos);
            setTimeout(() => send("Grbl 3.9 [FluidNC v3.9.1 (noradio) '$' for help]"), 20);
        }
        const steps = { 0x91: 10, 0x92: -10, 0x93: 1, 0x94: -1 };
        const sSteps = { 0x9a: 10, 0x9b: -10, 0x9c: 1, 0x9d: -1 };
        if (code === 0x90) ov.feed = 100;
        if (steps[code]) ov.feed += steps[code];
        if (code === 0x99) ov.spindle = 100;
        if (sSteps[code]) ov.spindle += sSteps[code];
    };
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
        for (const c of d) {
            const code = c.codePointAt(0);
            if (c === '?' || c === '!' || c === '~' || c === '\x18' || (code >= 0x80 && code <= 0xa4)) { realtime(c); continue; }
            if (c === '\n') {
                const line = buf.trim();
                buf = '';
                // an empty line is answered too: gSender takes comments out
                // before it writes, so a comment line arrives empty
                rx.push(line);
                parse();
                continue;
            }
            if (c !== '\r') buf += c;
        }
    });
    sock.on('close', () => log({ ev: 'close' }));
    sock.on('error', () => {});
    setTimeout(() => send("Grbl 3.9 [FluidNC v3.9.1 (noradio) '$' for help]"), 50);
}).listen(PORT, '127.0.0.1', () => console.log('fake FluidNC on', PORT));

// the pendant and the owner's hands
net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const [cmd, arg] = buf.slice(0, i).trim().split(/\s+/);
            buf = buf.slice(i + 1);
            if (cmd === 'tool') machine.toolLength = Number(arg);
            if (cmd === 'zero') {
                // the tool tip on the part's surface, and Z zero set there
                machine.pos.z = SURFACE + (Number(arg) || 0) + machine.toolLength;
                machine.planned.z = machine.pos.z;
                setWco(machine.pos.z, 'pendant zero');
            }
            if (cmd === 'wco') setWco(Number(arg), 'pendant');
            if (cmd === 'jog') {
                if (machine.delaying) machine.jogQueued = Number(arg) || 500;
                else startJog(Number(arg) || 500);
            }
            log({ ev: 'pendant', cmd, arg, ...machineState() });
            sock.write(JSON.stringify(machineState()) + '\n');
        }
    });
    sock.on('error', () => {});
}).listen(PORT + 1, '127.0.0.1', () => console.log('fake pendant on', PORT + 1));
