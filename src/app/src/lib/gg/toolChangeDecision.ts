/*
 * GGSender addition (not part of upstream gSender).
 *
 * Which tool change wizard runs at an M6, with the Fixed Tool Sensor.
 *
 * Upstream decides by counting the tool changes of the job: the first one
 * follows the "First tool" setting (full wizard, or only measure the tool in
 * the spindle), every later one measures the new tool against the reference.
 * Two things go wrong with a count:
 *
 * - A job resumed from a line looks like a new job. Its first M6 is taken for
 *   "the first tool, already in the spindle": the old tool is measured and the
 *   job carries on without asking for the new one.
 * - The count knows nothing of the reference. After Z zero was set by hand,
 *   the reference is for another Z zero; a new tool measured against it gets
 *   the old Z zero back.
 *
 * Here the decision follows the state of the reference
 * (src/server/lib/gg/probeHistory.js) and what the resume dialog asked for.
 * It is a pure function; features/gg/toolChangeFlow.ts builds the wizard.
 *
 * The three wizards:
 * - 'reference': measure the tool in the spindle as the reference. Nothing
 *   is fitted, the work Z zero is not written (wizards/probeToolLength).
 * - 'full': measure the tool in the spindle as the reference, then fit the
 *   new tool and measure it against that (wizards/automaticToolchange, 1).
 * - 'measure': fit the new tool and measure it against the reference that
 *   exists (wizards/automaticToolchange, 2). Writes the work Z zero.
 */
import { ReferenceSnapshot } from './probeStore';

export type WizardVariant = 'reference' | 'full' | 'measure';

/** What the resume dialog can ask for the tool change of its entry lines. */
export type ResumeToolMode = 'keep' | 'measure' | 'measure-old' | 'full' | 'reference' | 'reference-same';

export type DecisionReason =
    | 'first-tool' // first M6 of a job started from the top: upstream's "First tool" setting
    | 'count' // setting off: upstream's count
    | 'valid'
    | 'stale'
    | 'none'
    | 'resume-reference' // dialog choice 3
    | 'resume-same-reference' // dialog choice 1, the tool measured as the reference first
    | 'resume-measure' // dialog choice 2, reference valid
    | 'resume-old-reference' // dialog choice 2, the old reference accepted
    | 'resume-full' // dialog choice 2, the old tool measured first
    | 'resume-changed'; // the reference is not what the dialog saw

export interface ToolChangeDecision {
    /** 'first-tool': ask upstream's setting, which gives 'full' or 'reference' */
    variant: WizardVariant | 'first-tool';
    reason: DecisionReason;
    /** the wizard the owner can switch to, before any step has run */
    overrule: WizardVariant | null;
}

export interface DecisionInput {
    count: number; // tool changes of this job so far, this one included
    reference: Pick<ReferenceSnapshot, 'status'>;
    resumed: boolean; // the job was started by Resume From
    resumeMode: ResumeToolMode | null; // only for the M6 of the resume's entry lines
    guard: boolean; // setting "Tool change follows the tool sensor reference"
}

export const decideFixedSensor = ({ count, reference, resumed, resumeMode, guard }: DecisionInput): ToolChangeDecision => {
    const status = reference?.status ?? 'none';

    // what the owner chose in the resume dialog, seconds ago
    if (resumeMode === 'reference') {
        return { variant: 'reference', reason: 'resume-reference', overrule: null };
    }
    if (resumeMode === 'reference-same') {
        // the same measurement as choice 3, for another reason
        return { variant: 'reference', reason: 'resume-same-reference', overrule: null };
    }
    if (resumeMode === 'full') {
        return { variant: 'full', reason: 'resume-full', overrule: null };
    }
    if (resumeMode === 'measure' || resumeMode === 'measure-old') {
        if (status === 'valid') {
            return { variant: 'measure', reason: 'resume-measure', overrule: null };
        }
        if (status === 'stale' && resumeMode === 'measure-old') {
            return { variant: 'measure', reason: 'resume-old-reference', overrule: null };
        }
        // the reference went stale or was lost after the dialog: nothing can
        // be measured against it. Say so; the owner decides.
        return { variant: 'full', reason: 'resume-changed', overrule: status === 'stale' ? 'measure' : null };
    }

    // a job started from the top
    if (!resumed) {
        if (count <= 1) {
            return { variant: 'first-tool', reason: 'first-tool', overrule: null };
        }
        if (!guard) {
            return { variant: 'measure', reason: 'count', overrule: null };
        }
    }

    // a later tool change, or any tool change of a resumed job: never the
    // "first tool" shortcut, the new tool is always asked for
    if (status === 'valid') {
        return { variant: 'measure', reason: 'valid', overrule: 'full' };
    }
    if (status === 'stale') {
        return { variant: 'full', reason: 'stale', overrule: 'measure' };
    }
    return { variant: 'full', reason: 'none', overrule: null };
};

/** The other wizard of a decision that can be overruled. */
export const overruled = (decision: ToolChangeDecision, active: WizardVariant): WizardVariant | null => {
    if (decision.overrule === null || decision.variant === 'first-tool') {
        return null;
    }
    return active === decision.variant ? decision.overrule : decision.variant;
};
