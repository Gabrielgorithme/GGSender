/*
 * GGSender addition (not part of upstream gSender).
 *
 * Server half of "Resume from line" (the interface plans it:
 * src/app/src/lib/gg/resumePlan.ts).
 *
 * The entry lines (retract, modes, tool change, spindle, coolant, the moves
 * down to the start point) take the place of the program lines just before
 * the chosen one, in the sender's copy of the program, and the job starts
 * from the first of them. Every program line from the chosen one on keeps its
 * index, so the progress, the operations list, the tool change wizard and
 * the override resets see the same line numbers as in a normal run. The lines
 * replaced were going to be skipped anyway.
 *
 * Checks before anything is changed: the job is idle, the program loaded has
 * the number of lines the interface planned with, and the chosen line has the
 * text it saw. The entry lines must be plain G-code lines (no gSender macro,
 * no system command).
 *
 * The program as loaded is put back when the job stops or ends, and before
 * any normal start. Only the array this module installed is ever replaced: a
 * program loaded in between is left alone.
 *
 * Tool reference: gSender's tool sensor change measures, at the first change
 * of a job, the tool already in the spindle and keeps the work Z it reads at
 * the sensor (global.toolchange.TOOL_OFFSET); every later change sets the new
 * tool to read the same. After a broken tool, re-measuring the broken one
 * as that reference would put every following Z off by what it lost. So when
 * the resume measures the tool and a reference from this connection exists,
 * the job's change count starts at 1 and the wizard goes straight to the new
 * tool.
 */
import { programLength } from './opResets';

export const MAX_ENTRY_LINES = 40;

const plainLine = (l) =>
    typeof l === 'string' &&
    l.length <= 200 &&
    !/[\r\n]/.test(l) &&
    !/^\s*[%$]/.test(l) &&
    !/\[/.test(l);

/**
 * @param lines  the sender's program lines
 * @param plan   { seq, text, total, preamble: string[], target: string|null }
 * @returns { lines, from } or { error }
 */
export const spliceResume = (lines, plan = {}) => {
    if (!Array.isArray(lines) || lines.length === 0) {
        return { error: 'No program is loaded.' };
    }
    const seq = Number(plan.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq >= lines.length) {
        return { error: `Line index ${plan.seq} is outside the program.` };
    }
    if (Number(plan.total) !== programLength(lines)) {
        return { error: `The loaded program has ${programLength(lines)} lines. The plan is for ${plan.total} lines. Load the file again.` };
    }
    if (String(lines[seq]).trim() !== String(plan.text || '').trim()) {
        return { error: 'The selected line is different in the loaded program. Load the file again.' };
    }
    const preamble = Array.isArray(plan.preamble) ? plan.preamble : [];
    if (preamble.length === 0 || preamble.length > MAX_ENTRY_LINES || !preamble.every(plainLine)) {
        return { error: 'The entry lines are not plain G-code.' };
    }
    const target = plan.target === null || plan.target === undefined ? null : plan.target;
    if (target !== null && !plainLine(target)) {
        return { error: 'The rewritten line is not plain G-code.' };
    }
    const entry = target !== null ? [...preamble, target] : preamble;
    const firstUntouched = target !== null ? seq + 1 : seq;
    const from = firstUntouched - entry.length;
    if (from < 0) {
        return { error: 'The line is too near the start of the program.' };
    }
    const out = lines.slice();
    entry.forEach((l, k) => {
        out[from + k] = l;
    });
    return { lines: out, from };
};

/** Is there a tool sensor reference from an earlier tool change of this connection? */
export const hasToolReference = (sharedContext) => {
    const v = sharedContext?.toolchange?.TOOL_OFFSET;
    return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
};

export class ResumeSession {
    constructor({ log = () => {} } = {}) {
        this.log = log;
        this.pending = null; // { from, skipInitialProbe }
        this.original = null; // the program lines as loaded
        this.spliced = null; // the array installed in the sender
    }

    /** Install the entry lines; the next gcode:start resumes. */
    prepare(sender, plan, { toolReference = false } = {}) {
        this.restore(sender);
        const result = spliceResume(sender?.state?.lines, plan);
        if (result.error) {
            this.log(`refused: ${result.error}`);
            return result;
        }
        this.original = sender.state.lines;
        this.spliced = result.lines;
        sender.state.lines = result.lines;
        const skipInitialProbe = plan.measureTool === true && toolReference;
        this.pending = { from: result.from, skipInitialProbe };
        this.log(
            `line ${plan.seq} "${plan.text}", entry lines from ${result.from}: ${[...plan.preamble, plan.target]
                .filter(Boolean)
                .join(' | ')}${plan.measureTool ? `, tool change ${skipInitialProbe ? 'against the reference of this connection' : 'with a new reference'}` : ''}`,
        );
        return result;
    }

    /** For gcode:start: the resume to run now, or null for a normal start. */
    take() {
        const p = this.pending;
        this.pending = null;
        return p;
    }

    /** Start streaming from the entry lines (after workflow.start()). */
    begin(sender, pending) {
        sender.setStartLine(pending.from);
        if (pending.skipInitialProbe) {
            sender.state.toolChanges = 1;
        }
        sender.next({ startFromLine: true });
    }

    /** Put the program back as loaded, if it is still the one spliced. */
    restore(sender) {
        this.pending = null;
        if (this.spliced && sender?.state && sender.state.lines === this.spliced) {
            sender.state.lines = this.original;
            this.log('program lines restored');
        }
        this.original = null;
        this.spliced = null;
    }
}
