/*
 * GGSender addition (not part of upstream gSender).
 *
 * A persistent record of everything exchanged with the controller, written to
 * disk as it happens. The in-app console is lost on a disconnect or a crash;
 * this file is not.
 *
 * Location: the "logs" folder of the Electron user-data directory, next to
 * gSender's own server.log. One file per app start (traffic-<date>-<time>.log),
 * split into parts when a file gets large; the oldest files are removed.
 *
 * Line format:   HH:MM:SS.mmm  <marker> text
 *   >  sent to the controller      (followed by the source: sender, feeder, ...)
 *   <  received from the controller
 *   #  an event inside gSender     (workflow, hold, command, stall, ...)
 *
 * Hard rule: logging must never disturb the stream. Every entry point
 * swallows its own errors, and writes are buffered and asynchronous.
 */
import fs from 'fs';
import path from 'path';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 30;
const STATUS_INTERVAL_MS = 5000;
const FILE_PREFIX = 'traffic-';

const state = {
    resolved: false,
    directory: null,
    stream: null,
    file: null,
    bytes: 0,
    part: 0,
    stamp: null,
    failed: false,
    lastStatusState: null,
    lastStatusTime: 0,
};

const pad = (n, width = 2) => String(n).padStart(width, '0');

const fileStamp = (d) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const lineStamp = (d) =>
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

// Where to write. GG_TRAFFIC_LOG_DIR wins (used by tests); otherwise the
// Electron user-data folder; otherwise logging stays off (tests, CLI server).
const resolveDirectory = () => {
    if (process.env.GG_TRAFFIC_LOG_DIR) {
        return process.env.GG_TRAFFIC_LOG_DIR;
    }
    try {
        // eslint-disable-next-line global-require
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            return path.join(app.getPath('userData'), 'logs');
        }
    } catch (err) {
        // not running inside Electron
    }
    return null;
};

const pruneOldFiles = (directory) => {
    const files = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith('.log'))
        .map((name) => {
            const full = path.join(directory, name);
            return { full, time: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.time - a.time);

    files.slice(MAX_FILES).forEach(({ full }) => {
        try {
            fs.unlinkSync(full);
        } catch (err) {
            // leave it
        }
    });
};

const openStream = () => {
    if (!state.resolved) {
        state.resolved = true;
        state.directory = resolveDirectory();
        state.stamp = fileStamp(new Date());
    }
    if (!state.directory) {
        return false;
    }

    fs.mkdirSync(state.directory, { recursive: true });
    const suffix = state.part > 0 ? `-part${state.part + 1}` : '';
    state.file = path.join(
        state.directory,
        `${FILE_PREFIX}${state.stamp}${suffix}.log`,
    );
    state.stream = fs.createWriteStream(state.file, { flags: 'a' });
    state.stream.on('error', () => {
        // Disk full, folder removed, ...: stop logging, never throw
        state.failed = true;
        state.stream = null;
    });
    state.bytes = 0;
    pruneOldFiles(state.directory);
    return true;
};

const writeLine = (marker, text) => {
    if (state.failed) {
        return;
    }
    try {
        if (!state.stream && !openStream()) {
            state.failed = true; // nowhere to write; do not retry on every line
            return;
        }
        if (state.bytes > MAX_FILE_BYTES) {
            state.stream.end();
            state.stream = null;
            state.part += 1;
            if (!openStream()) {
                state.failed = true;
                return;
            }
        }
        const line = `${lineStamp(new Date())} ${marker} ${text}\n`;
        state.bytes += line.length;
        state.stream.write(line);
    } catch (err) {
        state.failed = true;
    }
};

// Make control bytes and line ends visible: "\x18", "\n" at the end dropped
export const printable = (data) => {
    const text = String(data).replace(/\r?\n$/, '');
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) {
            out += `\\x${pad(code.toString(16), 2)}`;
        } else {
            out += text[i];
        }
    }
    return out;
};

/**
 * Decide whether a status poll or status report is worth a line.
 * Status is polled several times a second; logging each one would bury the
 * rest. Kept: every change of machine state, and one report every few seconds
 * so the last known position survives a disconnect.
 *
 * @returns {boolean} true to log this status report
 */
export const shouldLogStatus = (report, now, memory) => {
    const match = /^<([A-Za-z]+)/.exec(report);
    const machineState = match ? match[1] : report;
    const changed = machineState !== memory.lastStatusState;
    const due = now - memory.lastStatusTime >= STATUS_INTERVAL_MS;
    if (changed || due) {
        memory.lastStatusState = machineState;
        memory.lastStatusTime = now;
        return true;
    }
    return false;
};

/** Something written to the controller. */
export const logTx = (data, source = '') => {
    try {
        const text = String(data);
        if (text === '?') {
            return; // status poll, see shouldLogStatus for the replies
        }
        writeLine('>', source ? `${printable(text)}   [${source}]` : printable(text));
    } catch (err) {
        // never disturb the stream
    }
};

/** A line received from the controller. */
export const logRx = (data) => {
    try {
        const text = String(data).replace(/\s+$/, '');
        if (!text) {
            return;
        }
        if (text[0] === '<') {
            if (!shouldLogStatus(text, Date.now(), state)) {
                return;
            }
        }
        writeLine('<', printable(text));
    } catch (err) {
        // never disturb the stream
    }
};

/** An event inside gSender. `detail` may be a string or a plain object. */
export const logEvent = (tag, detail = '') => {
    try {
        let text = detail;
        if (detail && typeof detail === 'object') {
            try {
                text = JSON.stringify(detail);
            } catch (err) {
                text = String(detail);
            }
        }
        // keep multi-line details (stack traces) readable and attributable
        const lines = String(text).split('\n');
        writeLine('#', `${tag}: ${lines[0]}`);
        lines.slice(1).forEach((l) => writeLine('#', `    ${l.trim()}`));
    } catch (err) {
        // never disturb the stream
    }
};

/** A short stack trace of the caller, for "who sent this?" questions. */
export const callerStack = (skip = 2, depth = 6) => {
    try {
        return (new Error().stack || '')
            .split('\n')
            .slice(skip, skip + depth)
            .map((l) => l.trim())
            .join('\n');
    } catch (err) {
        return '';
    }
};

export const getTrafficLogFile = () => state.file;

// For tests
export const resetTrafficLog = () => {
    try {
        state.stream?.end();
    } catch (err) {
        // ignore
    }
    Object.assign(state, {
        resolved: false,
        directory: null,
        stream: null,
        file: null,
        bytes: 0,
        part: 0,
        stamp: null,
        failed: false,
        lastStatusState: null,
        lastStatusTime: 0,
    });
};
