/*
 * GGSender addition (not part of upstream gSender).
 *
 * The words for the tool sensor reference: its state, what a tool change
 * will do with it, the history, and why the tool change wizard was chosen.
 * One place, so that the top bar, the resume dialog and the tool change
 * window say the same thing in the same words.
 *
 * Style: ASD-STE100. Short sentences, active voice, one topic each, the same
 * word for the same thing ("reference", "Z zero", "probe", "measure").
 */
import { HistoryEntry, ReferenceSnapshot } from './probeStore';
import { ToolChangeDecision, WizardVariant } from './toolChangeDecision';

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:32" today, "17 Nov 14:32" on another day. */
export const clock = (at: number | null | undefined, now = Date.now()): string => {
    if (!at) {
        return '?';
    }
    const d = new Date(at);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === new Date(now).toDateString()) {
        return time;
    }
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return `${d.getDate()} ${month} ${time}`;
};

/** "T45", or "T?" when gSender has no record of the tool. */
export const toolName = (tool: unknown): string => {
    if (tool === null || tool === undefined || tool === '') {
        return 'T?';
    }
    const t = String(tool).trim();
    return /^t/i.test(t) ? `T${t.slice(1)}` : `T${t}`;
};

const mm = (v: number) => `${Math.abs(v).toFixed(3)} mm`;

/** "T45, 14:32": the tool the reference was probed with, and when. */
export const referenceId = (s: ReferenceSnapshot, now = Date.now()): string =>
    s.reference ? `${toolName(s.reference.tool)}, ${clock(s.reference.at, now)}` : '';

export const STATUS_LABEL = {
    valid: 'Reference correct',
    stale: 'Reference not correct',
    none: 'No reference',
} as const;

/** The state in one or two sentences: which tool, when, can it be trusted. */
export const referenceHeadline = (s: ReferenceSnapshot, now = Date.now()): string => {
    if (s.status === 'none' || !s.reference) {
        return 'No reference. gSender did not probe a tool after it connected.';
    }
    const id = referenceId(s, now);
    if (s.status === 'stale') {
        const at = clock(s.stale?.at, now);
        if (s.stale?.kind === 'wcs') {
            const change = s.stale.from && s.stale.to ? ` (${s.stale.from} to ${s.stale.to})` : '';
            return `The work coordinate system changed at ${at}${change}, after the last probe (${id}). The reference is not correct now.`;
        }
        if (s.stale?.kind === 'program') {
            return `The program changed the work Z offset at ${at}, after the last probe (${id}). The reference is not correct now.`;
        }
        return `Z zero changed at ${at}, after the last probe (${id}). The reference is not correct now.`;
    }
    const last = s.lastProbe;
    const first = last && last.kind === 'measured'
        ? `Last probe: ${toolName(last.tool)} at ${clock(last.at, now)}, against the reference (${id}).`
        : `Reference: ${toolName(s.reference.tool)}, probed at ${clock(s.reference.at, now)}.`;
    if (!s.watching) {
        return `${first} This controller does not report its work offset. gSender cannot see a change of Z zero.`;
    }
    return `${first} Z zero did not change after that.`;
};

/** What a tool change will do with the reference as it is. */
export const referenceEffect = (s: ReferenceSnapshot, now = Date.now()): string => {
    if (s.status === 'valid') {
        return 'At a tool change, gSender measures the new tool against this reference. Z zero stays at the same position on the part.';
    }
    if (s.status === 'stale') {
        return `At a tool change, gSender first measures the tool in the spindle as the new reference. If you use the old reference, Z zero goes back to its position of ${clock(s.reference?.at, now)}.`;
    }
    return 'At a tool change, gSender first measures the tool in the spindle. That tool becomes the reference.';
};

/** One line of the history. */
export const historyLine = (e: HistoryEntry): string => {
    const tool = toolName(e.tool);
    switch (e.kind) {
        case 'reference': {
            let shift = '';
            if (typeof e.zeroShift === 'number') {
                if (Math.abs(e.zeroShift) < 0.02) {
                    shift = ` Same Z zero as the old reference (difference ${mm(e.zeroShift)}).`;
                } else {
                    shift = ` Z zero is ${mm(e.zeroShift)} ${e.zeroShift > 0 ? 'higher' : 'lower'} than with the old reference.`;
                }
            }
            return `${tool} probed as the reference.${shift}`;
        }
        case 'measured':
            return e.oldReference
                ? `${tool} measured against the old reference. Z zero went back to the position of that reference.`
                : `${tool} measured against the reference. Z zero stays on the part.`;
        case 'wcs':
            return `Work coordinate system changed: ${e.from ?? '?'} to ${e.to ?? '?'}.${e.restored ? ' The reference is correct again.' : ''}`;
        case 'program':
            return `The program changed the work Z offset.${e.restored ? ' The reference is correct again.' : ''}`;
        case 'zero':
        default:
            return e.restored
                ? 'Z zero changed back to the value of the reference. The reference is correct again.'
                : 'Z zero changed (by hand, pendant, probe or command).';
    }
};

// ---- the tool change window -----------------------------------------------------

export type ZeroEffect = 'unchanged' | 'stays' | 'goes-back';

export interface DecisionText {
    headline: string; // what gSender will do
    why: string; // why, with the tool and the time
    zero: { effect: ZeroEffect; label: string }; // what happens to Z zero
    warning: boolean;
    overruleLabel: string | null; // the button that switches to the other wizard
}

/**
 * @param decision  what toolChangeDecision chose
 * @param active    the wizard loaded now (differs from the choice when overruled)
 * @param target    the tool of the tool change
 */
export const decisionText = (
    decision: ToolChangeDecision,
    active: WizardVariant,
    s: ReferenceSnapshot,
    target: unknown,
    now = Date.now(),
): DecisionText => {
    const t = toolName(target);
    const id = referenceId(s, now);
    const refTime = clock(s.reference?.at, now);
    const isOverruled = decision.variant !== 'first-tool' && decision.variant !== active;
    const stays = { effect: 'stays' as ZeroEffect, label: 'Z zero stays on the part' };
    const unchanged = { effect: 'unchanged' as ZeroEffect, label: 'Z zero does not change' };
    const goesBack = { effect: 'goes-back' as ZeroEffect, label: `Z zero goes back to ${refTime}` };

    if (active === 'reference') {
        if (decision.reason === 'resume-reference') {
            return {
                headline: `gSender measures ${t} as the new reference.`,
                why: 'You set Z zero with this tool.',
                zero: unchanged,
                warning: false,
                overruleLabel: null,
            };
        }
        return {
            headline: 'gSender measures the tool in the spindle as the reference. You do not fit a tool.',
            why: 'First tool change of the job.',
            zero: unchanged,
            warning: false,
            overruleLabel: null,
        };
    }

    if (active === 'measure') {
        const staleReference = s.status === 'stale';
        if (isOverruled || decision.reason === 'resume-old-reference' || staleReference) {
            return {
                headline: `gSender measures ${t} against the old reference (${id}).`,
                why:
                    decision.reason === 'count'
                        ? `WARNING: Z zero changed after the last probe. The setting "Tool change follows the reference" is off. Z zero goes back to its position of ${refTime}.`
                        : `You selected the old reference. Z zero goes back to its position of ${refTime}.`,
                zero: goesBack,
                warning: true,
                overruleLabel: isOverruled ? 'Back to the default: measure the tool in the spindle first' : null,
            };
        }
        return {
            headline: `gSender measures ${t} against the reference (${id}).`,
            why: s.watching
                ? 'Z zero did not change after the last probe.'
                : 'This controller does not report its work offset. gSender cannot see a change of Z zero.',
            zero: stays,
            warning: false,
            overruleLabel: decision.overrule === 'full' ? 'Measure the tool in the spindle first' : null,
        };
    }

    // active === 'full'
    const headline = `gSender first measures the tool in the spindle as the new reference. Then you fit ${t}.`;
    if (isOverruled) {
        return {
            headline,
            why: 'You selected this. The tool in the spindle must have the correct Z zero.',
            zero: stays,
            warning: false,
            overruleLabel: 'Back to the default: use the reference',
        };
    }
    switch (decision.reason) {
        case 'stale':
            return {
                headline,
                why: `${referenceHeadline(s, now)} The tool in the spindle must have the correct Z zero.`,
                zero: stays,
                warning: true,
                overruleLabel: 'Use the old reference',
            };
        case 'resume-changed':
            return {
                headline,
                why:
                    s.status === 'stale'
                        ? 'WARNING: Z zero changed after you selected the tool option. If the tool in the spindle is broken, stop the job.'
                        : 'WARNING: There is no reference now. If the tool in the spindle is broken, stop the job.',
                zero: stays,
                warning: true,
                overruleLabel: decision.overrule === 'measure' ? 'Use the old reference' : null,
            };
        case 'resume-full':
            return {
                headline,
                why: 'You selected this: the old tool is in the spindle and is not broken.',
                zero: stays,
                warning: false,
                overruleLabel: null,
            };
        case 'first-tool':
            return {
                headline: `gSender first measures the tool in the spindle as the reference. Then you fit ${t}.`,
                why: 'First tool change of the job.',
                zero: stays,
                warning: false,
                overruleLabel: null,
            };
        case 'none':
        default:
            return {
                headline,
                why: 'There is no reference. The tool in the spindle must have the correct Z zero.',
                zero: stays,
                warning: false,
                overruleLabel: null,
            };
    }
};
