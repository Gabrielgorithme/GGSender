/*
 * GGSender addition (not part of upstream gSender).
 *
 * Feed and spindle overrides back to 100% when the job moves on to the next
 * operation of the program (the operations the interface lists, read from
 * Fusion's comments in lib/gg/jobOperations.ts).
 *
 * When: gSender sends lines well ahead of the machine. The controller holds a
 * planner queue of moves, so the moment an operation's first line is SENT
 * (or acknowledged with "ok"), the machine is still cutting the end of the
 * previous operation. A realtime override reset then would apply to those
 * last cuts.
 *
 * So the operation's first move gets "G4 P0" added to it, a dwell of zero.
 * Grbl and FluidNC run a dwell only once every earlier move is finished
 * (protocol_buffer_synchronize), and they run it before the motion of the
 * same block (NIST order: dwell is step 10, motion step 20). The "ok" of that
 * line therefore arrives when the previous operation is completely done and
 * the operation's first move (a rapid, in Fusion's programs: retract, then
 * G0 X Y) has just been queued. The resets (0x90 feed, 0x99 spindle) go out
 * on that "ok". The feed override does not act on rapids, so the reset is
 * invisible until the operation's first cut, which runs at 100%.
 *
 * The cost is a stop of the machine at the top of the retract, where it
 * almost stops anyway (a corner between a vertical and a horizontal rapid).
 *
 * The dwell is added only to a line that is a plain move: axis words, no P
 * word (G2/G3 use P for turns), no other dwell, machine-coordinate, home,
 * offset or probing command, no M code. Otherwise that operation gets no
 * reset (logged).
 *
 * Which lines: the interface sends the sender index (seq) and the text of the
 * first move of each operation, for the program it analysed. A boundary is
 * used only when the loaded program has the same number of lines and the
 * line at that index has the same text.
 *
 * Which "ok" belongs to which line: the controller answers the lines in the
 * order they were written. Each line the sender writes pushes one entry here,
 * each reply to a sender line takes one off. gSender's own `received` count
 * cannot be used for this: comment-only lines are counted as acknowledged
 * when they are skipped, ahead of the replies to earlier lines.
 */

export const SYNC_WORDS = 'G4 P0';

const AXIS_RE = /[XYZABC]\s*[-+.\d]/i;
const P_WORD_RE = /P\s*[-+.\d]/i;
// modal group 0 (dwell, G10, home, G53, G92) and probing
const GROUP0_RE = /G\s*0*(?:4|10|28|30|53|92)(?:\.\d+)?(?![0-9])|G\s*0*38/i;
const M_WORD_RE = /M\s*\d/i;

/**
 * Can "G4 P0" be added to this line (as it goes to the controller, comments
 * already removed) without changing what the block does?
 */
export const qualifiesForSync = (line) => {
    const s = String(line || '').trim();
    if (s.length === 0 || /[%$[\]();]/.test(s)) {
        return false;
    }
    return AXIS_RE.test(s) && !P_WORD_RE.test(s) && !GROUP0_RE.test(s) && !M_WORD_RE.test(s);
};

/** The setting, as the interface stores it in the server's preferences. */
export const resetPreference = (prefs = {}) => prefs?.ggResetOverridesPerOp !== false;

/**
 * Which overrides to reset, from the last reported ones ([feed, rapid,
 * spindle]) and the values last asked for (see overrideBase).
 */
export const overridesToReset = (feedNow, spindleNow) => ({
    feed: Number.isFinite(Number(feedNow)) && Number(feedNow) !== 100,
    spindle: Number.isFinite(Number(spindleNow)) && Number(spindleNow) !== 100,
});

/**
 * Lines of the program as the interface counts them: gcode:load appends a
 * "%wait" line to every program.
 */
export const programLength = (lines) => {
    if (!Array.isArray(lines)) {
        return 0;
    }
    const last = lines.length > 0 ? String(lines[lines.length - 1]).trim() : '';
    return last.startsWith('%wait') ? lines.length - 1 : lines.length;
};

const cleanBoundaries = (list) => {
    const map = new Map();
    if (!Array.isArray(list)) {
        return map;
    }
    list.forEach((b) => {
        const seq = Number(b?.seq);
        const text = typeof b?.text === 'string' ? b.text.trim() : '';
        if (Number.isInteger(seq) && seq >= 0 && text) {
            map.set(seq, { seq, text, name: String(b?.name || '') });
        }
    });
    return map;
};

export class OperationResets {
    constructor({ onReset = () => {}, log = () => {} } = {}) {
        this.onReset = onReset;
        this.log = log;
        this.program = null; // { name, total }
        this.boundaries = new Map();
        this.inFlight = []; // one entry per line written by the sender
        this.pendingTag = null; // set by filter() for the line about to be written
    }

    /** From the interface: { name, total, boundaries: [{ seq, text, name }] }. */
    setProgram(payload = {}) {
        const total = Number(payload.total);
        this.program = {
            name: String(payload.name || ''),
            total: Number.isInteger(total) ? total : null,
        };
        this.boundaries = cleanBoundaries(payload.boundaries);
    }

    /** A job starts or stops: nothing is in flight. */
    reset() {
        this.inFlight = [];
        this.pendingTag = null;
    }

    /**
     * Called by the sender's data filter, last, for the line at index `seq`
     * of the sender's `lines`.
     * @param line  the line as it will be written
     * @returns the line to write
     */
    filter(line, { seq, lines, enabled = true }) {
        this.pendingTag = null;
        if (!enabled || this.boundaries.size === 0) {
            return line;
        }
        const b = this.boundaries.get(seq);
        if (!b) {
            return line;
        }
        const total = programLength(lines);
        const original = Array.isArray(lines) ? lines[seq] : undefined;
        if (this.program?.total !== null && this.program?.total !== total) {
            this.log(`no reset at "${b.name}": the loaded program has ${total} lines, the analysed one ${this.program?.total}`);
            return line;
        }
        if (String(original || '').trim() !== b.text) {
            this.log(`no reset at "${b.name}": line ${seq} is not the operation's first move`);
            return line;
        }
        if (!qualifiesForSync(line)) {
            this.log(`no reset at "${b.name}": "${line}" cannot take a dwell`);
            return line;
        }
        this.pendingTag = b;
        return `${line} ${SYNC_WORDS}`;
    }

    /** The sender wrote a line (every line it writes, in order). */
    onWritten() {
        this.inFlight.push(this.pendingTag);
        this.pendingTag = null;
    }

    /** The controller replied (ok or error) to the oldest sender line. */
    onReply() {
        const tag = this.inFlight.shift();
        if (tag) {
            this.onReset(tag);
        }
        return tag || null;
    }
}
