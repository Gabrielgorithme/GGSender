/*
 * GGSender addition (not part of upstream gSender).
 *
 * Lines that the controller refused because the machine was jogging, and
 * sending them again.
 *
 * What happens. Grbl and FluidNC refuse a G-code line while the machine jogs
 * ("error:9", G-code lock). At a tool change the program ends its operation
 * with lines such as "M5", "G28 G91 Z0", "G90", "M6". FluidNC waits in "M5"
 * until the spindle has stopped (several seconds) and reports "Idle" all that
 * time, with the lines after it still in its buffer. The pendant takes a jog
 * in "Idle". FluidNC runs that jog when the wait ends, and refuses the lines
 * that were waiting, gSender's own first tool change line ("G4 P0.5", the
 * %wait) included. The same happens in the spin-up wait after "M3".
 *
 * Upstream then answers the error as if a job line had failed and never
 * acknowledges the feeder, which sends the tool change lines: the tool change
 * window is dead and the job must be stopped. The owner had this at tool
 * change after tool change (22 Nov).
 *
 * What this does, for a job that is paused (a tool change, M0, M1):
 * - It keeps the refused lines, in the order they were sent, with where they
 *   came from (the job or the feeder). No error is shown.
 * - It holds the feeder back, so that no tool change line runs before the
 *   refused ones.
 * - When the machine is idle again the lines are sent again, one at a time,
 *   and then the feeder goes on. Lines that only wait ("G4") go by
 *   themselves. Lines that can move the machine wait for the owner
 *   ("Send again" in the interface): the owner has just jogged, and is
 *   possibly near the spindle.
 * - If the controller accepted a line after it refused one, the sequence is
 *   broken (the accepted line ran without the refused ones before it).
 *   Nothing is sent again then: the owner is told to stop the job.
 *
 * A job that runs (the spin-up wait) is not handled here: errorHold.js holds
 * the machine at the first error, as before.
 */

export const GCODE_LOCK = 9;

export const jogRecoveryPreference = (prefs = {}) => prefs?.ggJogRecovery !== false;

/** The line without comments and without its N word, in upper case. */
export const codeOf = (text) =>
    String(text || '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/;.*$/, '')
        .replace(/^\s*N\d+\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

/** A line that the controller only waits on, or that has no code: safe to send again at any time. */
export const isWaitOnly = (text) => {
    const code = codeOf(text);
    return code === '' || /^G0*4 ?P[\d.]+$/.test(code);
};

export class RefusedLines {
    constructor({ onChange = () => {}, log = () => {} } = {}) {
        this.onChange = onChange;
        this.log = log;
        this.reset(false);
    }

    reset(tell = true) {
        const had = this.lines && (this.lines.length > 0 || this.broken);
        this.lines = []; // { source: 'job' | 'feeder', text }
        this.broken = null; // why nothing can be sent again, or null
        this.replaying = false;
        this.current = null; // the line sent again and not yet answered
        this.feederWaits = false; // a feeder line is among them: the feeder is not acknowledged
        if (tell && had) {
            this.onChange(this.snapshot());
        }
    }

    get pending() {
        return this.lines.length > 0 || this.current !== null;
    }

    snapshot() {
        const lines = [...(this.current ? [this.current] : []), ...this.lines];
        return {
            lines: lines.map((l) => ({ source: l.source, text: l.text })),
            // only lines with code are sent again; a comment alone is dropped
            moves: lines.some((l) => !isWaitOnly(l.text)),
            broken: this.broken,
            replaying: this.replaying,
        };
    }

    /** The controller refused a line. text null: gSender has no record of the line. */
    add(source, text) {
        if (text === null || text === undefined) {
            this.broken = this.broken || 'unknown-line';
        }
        this.lines.push({ source, text: text === null || text === undefined ? '' : String(text) });
        if (source === 'feeder') {
            this.feederWaits = true;
        }
        this.log(`refused (${source}): "${text}"${this.broken ? `, cannot send again: ${this.broken}` : ''}`);
        this.onChange(this.snapshot());
    }

    /**
     * The controller accepted a line while refused lines wait. A line that
     * only waits changes nothing; any other ran without the lines before it.
     */
    accepted(text) {
        if (!this.pending || this.replaying || isWaitOnly(text)) {
            return;
        }
        if (!this.broken) {
            this.broken = 'accepted-after-refused';
            this.log(`accepted after a refused line: "${text}". The sequence is broken, nothing is sent again`);
            this.onChange(this.snapshot());
        }
    }

    /** Lines wait, none can move the machine, and nothing is broken: they can go by themselves. */
    get waitOnly() {
        return this.lines.length > 0 && !this.broken && !this.replaying && this.lines.every((l) => isWaitOnly(l.text));
    }

    canReplay() {
        return this.lines.length > 0 && !this.broken && !this.replaying;
    }

    /** Start to send again. Returns the first line to write, or null when there is none with code. */
    start() {
        if (!this.canReplay()) {
            return null;
        }
        this.replaying = true;
        const text = this.next();
        if (text === null) {
            this.replaying = false; // only comments: nothing to send
        }
        this.onChange(this.snapshot());
        return text;
    }

    /** The next line to write, or null when all are done. Lines without code are dropped. */
    next() {
        this.current = null;
        while (this.lines.length > 0) {
            const line = this.lines.shift();
            if (codeOf(line.text) !== '') {
                this.current = line;
                return line.text;
            }
        }
        return null;
    }

    /** The line sent again was accepted. Returns the next line to write, or null when all are done. */
    ok() {
        const text = this.next();
        if (text === null) {
            this.replaying = false;
            this.log('all refused lines were sent again');
        }
        this.onChange(this.snapshot());
        return text;
    }

    /** All done: does the feeder wait for its acknowledgement? (asked once) */
    takeFeederWait() {
        const waits = this.feederWaits;
        this.feederWaits = false;
        return waits;
    }

    /** The line sent again was refused too (a new jog): it waits again, first in line. */
    refusedAgain() {
        if (this.current) {
            this.lines.unshift(this.current);
            this.current = null;
        }
        this.replaying = false;
        this.log('refused again: the machine is not idle');
        this.onChange(this.snapshot());
    }

    /** Another error for a line sent again: give up. */
    failed(code) {
        this.broken = `error:${code}`;
        if (this.current) {
            this.lines.unshift(this.current);
            this.current = null;
        }
        this.replaying = false;
        this.log(`error:${code} for a line sent again: nothing more is sent`);
        this.onChange(this.snapshot());
    }
}
