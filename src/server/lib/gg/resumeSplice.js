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
 * Tool: the interface says what to do with the tool (plan.toolMode):
 * - 'keep': nothing, the entry lines have no tool change;
 * - 'measure': the new tool is measured against the tool sensor reference;
 * - 'measure-old': the same, and the owner accepted a reference that is for
 *   an earlier Z zero (Z zero goes back to it);
 * - 'full': the tool in the spindle is measured first as the reference,
 *   then the new tool is fitted and measured;
 * - 'reference': the tool in the spindle is measured as the new reference
 *   and nothing else changes (Z zero was set by hand with it);
 * - 'reference-same': the same measurement, asked for another reason: the
 *   same tool is in the spindle with an unchanged Z zero, and gSender has no
 *   correct reference (0.7.3).
 * The mode is handed once to the tool change of the entry lines
 * (takeToolMode). A resumed job is marked as such until it stops, so that no
 * tool change in it is taken for "the first tool of a job, already in the
 * spindle" (upstream's First tool setting): that would measure the old tool
 * and carry on without asking for the new one. The interface decides the
 * wizard from this (app lib/gg/toolChangeDecision.ts).
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

export const TOOL_MODES = ['keep', 'measure', 'measure-old', 'full', 'reference', 'reference-same'];

/** The tool mode of a plan; a plan from before 0.7.1 only has measureTool. */
export const toolModeOf = (plan = {}) => {
    if (TOOL_MODES.includes(plan.toolMode)) {
        return plan.toolMode;
    }
    return plan.measureTool === true ? 'measure' : 'keep';
};

export class ResumeSession {
    constructor({ log = () => {} } = {}) {
        this.log = log;
        this.pending = null; // { from, toolMode }
        this.original = null; // the program lines as loaded
        this.spliced = null; // the array installed in the sender
        this.resumed = false; // the job running was started by a resume
        this.toolMode = null; // for the tool change of the entry lines, once
    }

    /** Install the entry lines; the next gcode:start resumes. */
    prepare(sender, plan) {
        this.restore(sender);
        const toolMode = toolModeOf(plan);
        const hasChange = Array.isArray(plan?.preamble) && plan.preamble.some((l) => /\bM0*6\b/i.test(String(l).replace(/\([^)]*\)/g, ' ')));
        if (hasChange !== (toolMode !== 'keep')) {
            const error = hasChange
                ? 'The entry lines have a tool change, but the plan keeps the tool.'
                : 'The plan measures the tool, but the entry lines have no tool change.';
            this.log(`refused: ${error}`);
            return { error };
        }
        const result = spliceResume(sender?.state?.lines, plan);
        if (result.error) {
            this.log(`refused: ${result.error}`);
            return result;
        }
        this.original = sender.state.lines;
        this.spliced = result.lines;
        sender.state.lines = result.lines;
        this.pending = { from: result.from, toolMode };
        this.log(
            `line ${plan.seq} "${plan.text}", tool: ${toolMode}, entry lines from ${result.from}: ${[...plan.preamble, plan.target]
                .filter(Boolean)
                .join(' | ')}`,
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
        this.resumed = true;
        this.toolMode = pending.toolMode === 'keep' ? null : pending.toolMode;
        sender.setStartLine(pending.from);
        sender.next({ startFromLine: true });
    }

    /**
     * For a tool change of the job running: was the job resumed, and what the
     * resume asked for this change (only the first one after the resume).
     */
    takeToolMode() {
        const mode = this.toolMode;
        this.toolMode = null;
        return { resumed: this.resumed, mode: this.resumed ? mode : null };
    }

    /** Put the program back as loaded, if it is still the one spliced. */
    restore(sender) {
        this.pending = null;
        this.resumed = false;
        this.toolMode = null;
        if (this.spliced && sender?.state && sender.state.lines === this.spliced) {
            sender.state.lines = this.original;
            this.log('program lines restored');
        }
        this.original = null;
        this.spliced = null;
    }
}
