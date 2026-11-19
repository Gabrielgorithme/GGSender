/*
 * GGSender addition (not part of upstream gSender).
 *
 * The tool choices of the Resume From dialog, and what each one asks of the
 * tool change at the start of the resumed job.
 *
 *   1  Same tool. Z zero did not change.             -> no tool change.
 *      Without a correct reference (none after a reconnection, for example)
 *      this has a second answer: measure the tool as the reference before
 *      the job continues (the default), or do not measure. Without a
 *      reference a tool that breaks later cannot be replaced by measurement:
 *      Z zero must then be set by hand.
 *   2  New or refitted tool. Z zero did not change.  -> the tool is measured
 *      against the tool sensor reference. Without a correct reference this
 *      needs a second answer: measure the old tool first (it must still be
 *      in the spindle, not broken), or use the old reference (Z zero goes
 *      back to where it was at that probe).
 *   3  Z zero was set again by hand with the tool in the spindle. -> that
 *      tool is measured as the new reference; Z zero is not written.
 *
 * 0.7.0 had two choices, "untouched" and "change or measure it first". The
 * case of 3 fitted neither: with the first the new tool was never measured,
 * with the second it was set against the old reference and the hand-set Z
 * zero was lost.
 */
import { ReferenceStatus } from './probeStore';
import { ResumeToolMode } from './toolChangeDecision';

export type ToolChoice = 1 | 2 | 3;
/** The second answer of choice 2 when the reference is not correct. */
export type ReferenceSource = 'old-tool' | 'old-reference';
/** The second answer of choice 1 when the reference is not correct. */
export type SameToolProbe = 'measure' | 'skip';

/** Choice 1 asks whether to measure the tool when there is no correct reference. */
export const sameToolAsks = (status: ReferenceStatus): boolean => status !== 'valid';
/** Measure, unless the owner says no: a reference is what makes a broken tool replaceable. */
export const DEFAULT_SAME_TOOL_PROBE: SameToolProbe = 'measure';

/**
 * The choice selected when the dialog opens. null: gSender cannot tell, the
 * owner must select one.
 * @param loaded    the tool recorded as loaded (normalized), null = not known
 * @param lineTool  the tool of the line (normalized), null = the program has none
 */
export const defaultChoice = (status: ReferenceStatus, loaded: string | null, lineTool: string | null): ToolChoice | null => {
    if (status === 'stale') {
        // Z zero changed after the last probe: most likely set by hand
        return 3;
    }
    if (lineTool !== null && lineTool !== loaded) {
        return status === 'valid' ? 2 : null;
    }
    return 1;
};

/** The sources that choice 2 can use for the reference. */
export const sourcesFor = (status: ReferenceStatus): ReferenceSource[] => {
    if (status === 'valid') {
        return [];
    }
    return status === 'stale' ? ['old-tool', 'old-reference'] : ['old-tool'];
};

/**
 * What the server and the tool change wizard are told.
 * null: the selection is not complete, the resume cannot start.
 */
export const toolModeFor = (
    choice: ToolChoice | null,
    source: ReferenceSource | null,
    status: ReferenceStatus,
    sameToolProbe: SameToolProbe = DEFAULT_SAME_TOOL_PROBE,
): ResumeToolMode | null => {
    if (choice === 1) {
        // a correct reference exists: nothing to measure
        return sameToolAsks(status) && sameToolProbe === 'measure' ? 'reference-same' : 'keep';
    }
    if (choice === 3) {
        return 'reference';
    }
    if (choice === 2) {
        if (status === 'valid') {
            return 'measure';
        }
        if (source === 'old-tool') {
            return 'full';
        }
        if (source === 'old-reference' && status === 'stale') {
            return 'measure-old';
        }
    }
    return null;
};
