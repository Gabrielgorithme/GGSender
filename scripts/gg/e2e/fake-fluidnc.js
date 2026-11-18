// GGSender e2e: a fake FluidNC on TCP, for driving the built app end to end
// (connect with Ethernet to 127.0.0.1 and this port). Not FluidNC: a small
// simulation of what the fork depends on.
// usage: node fake-fluidnc.js [port=2323] [log file] [ms per move=25]
// Lines are "ok"ed once queued (planner of 16), executed one by one; G4
// waits for the planner to empty; realtime bytes are taken out of the
// stream (UTF-8); "!" holds, "~" resumes, 0x18 resets; an arc with I/K and no
// J in the G17 plane gets error:33; status reports carry Ov: and A:S.
// Everything is logged to the log file as JSON lines.
const net = require('net');
const fs = require('fs');
const PORT = Number(process.argv[2] || 2323);
const LOG = process.argv[3] || '/tmp/fake-fluidnc.log';
const MS = Number(process.argv[4] || 25);
fs.writeFileSync(LOG, '');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');

net.createServer((sock) => {
    log({ ev: 'connect' });
    let buf = '';
    const rx = [];
    const planner = [];
    let executing = null;
    let held = false;
    const ov = { feed: 100, spindle: 100 };
    const pos = { x: 0, y: 0, z: 0 };
    const planned = { x: 0, y: 0, z: 0 }; // end of the last move queued
    let state = 'Idle';
    let plane = 'G17';
    let spindle = false;
    const send = (s) => { if (!sock.destroyed) sock.write(s + '\r\n'); };
    const status = () => {
        const busy = rx.length || planner.length || executing;
        const st = held ? 'Hold:0' : busy ? 'Run' : state;
        return `<${st}|MPos:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}|FS:1000,24000|Ov:${ov.feed},100,${ov.spindle}${spindle ? '|A:S' : ''}>`;
    };
    const target = (line) => {
        const t = { ...planned };
        if (/G53|G28|G30/.test(line)) return t;
        for (const a of ['X', 'Y', 'Z']) {
            const m = new RegExp(a + '(-?[\\d.]+)').exec(line);
            if (m) t[a.toLowerCase()] = Number(m[1]);
        }
        return t;
    };
    const isMove = (l) => /[XYZ]-?[\d.]/.test(l) && !l.startsWith('$');
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
            const line = rx[0];
            if (/G0*4(?![0-9])/.test(line) && (planner.length || executing)) return;
            if (isMove(line) && planner.length >= 16) return;
            rx.shift();
            log({ ev: 'line', line });
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
            rx.length = 0; planner.length = 0; executing = null; held = false;
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
                if (line) { rx.push(line); parse(); }
                continue;
            }
            if (c !== '\r') buf += c;
        }
    });
    sock.on('close', () => log({ ev: 'close' }));
    sock.on('error', () => {});
    setTimeout(() => send("Grbl 3.9 [FluidNC v3.9.1 (noradio) '$' for help]"), 50);
}).listen(PORT, '127.0.0.1', () => console.log('fake FluidNC on', PORT));
