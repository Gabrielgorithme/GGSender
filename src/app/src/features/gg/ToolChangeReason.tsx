/*
 * GGSender addition (not part of upstream gSender).
 *
 * In the tool change window (Fixed Tool Sensor): what gSender will do with
 * the tool sensor reference at this tool change, why, what happens to Z zero,
 * and a button to do the other thing instead. The decision is made in
 * lib/gg/toolChangeDecision.ts; the words are in lib/gg/referenceText.ts.
 *
 * The button is there only before the first step has run: after that the
 * machine has measured something and the choice is made.
 *
 * The window follows the reference while it is open. Before the first step
 * has run, a change (Z zero set from the pendant with the window on screen)
 * makes it decide again. After that, it warns when the probe still to come
 * would write an older Z zero over the new one.
 */
import { useEffect } from 'react';
import cx from 'classnames';
import { MdCheckCircle, MdSwapVert, MdWarning } from 'react-icons/md';

import { useWizardContext } from 'app/features/Helper/context';
import { useReference } from 'app/lib/gg/probeStore';
import { clock, decisionText } from 'app/lib/gg/referenceText';
import { WizardDecision, overruleWizard, redecideWizard } from './toolChangeFlow';

export const ToolChangeReason = () => {
    const { toolchangeContext, toolchangeComment, activeStep, activeSubstep, steps, isLoading } = useWizardContext() as any;
    const gg = toolchangeContext?.ggDecision as WizardDecision | undefined;
    const live = useReference();
    const first = activeStep === 0 && activeSubstep === 0;
    const untouched = first && !isLoading && steps?.[0]?.substeps?.[0]?.actionTaken !== true;

    // Z zero changed with the window open and nothing run: decide again
    useEffect(() => {
        if (gg && untouched) {
            redecideWizard(toolchangeContext, toolchangeComment, live);
        }
        // only when the state of the reference changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live.status, untouched]);

    if (!gg) {
        return null;
    }
    const text = decisionText(gg.decision, gg.active, gg.reference, toolchangeContext?.tool);
    // later steps: the probe that writes Z zero from the reference is still to
    // come, and Z zero changed after this tool change began
    const probeToCome = (steps ?? []).some((st: any) =>
        (st.substeps ?? []).some(
            (ss: any) => ss.actionTaken !== true && (ss.actions ?? []).some((a: any) => (a.gcodeLines ?? []).some((l: string) => /G10\s*L20/i.test(l))),
        ),
    );
    const lateChange = !untouched && live.live && live.status === 'stale' && gg.active !== 'reference' && probeToCome && text.zero.effect !== 'goes-back';
    const Icon = text.warning ? MdWarning : MdCheckCircle;
    const goesBack = text.zero.effect === 'goes-back';

    return (
        <div
            className={cx(
                'flex flex-col gap-1 rounded-md border px-3 py-2 text-sm',
                text.warning
                    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                    : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
            )}
            data-testid="gg-toolchange-reason"
            data-variant={gg.active}
            data-reason={gg.decision.reason}
        >
            <div className="flex items-start gap-2">
                <Icon className="mt-0.5 shrink-0 text-lg" aria-hidden />
                <span className="min-w-0 flex-1 font-semibold" data-testid="gg-toolchange-reason-headline">
                    {text.headline}
                </span>
                <span
                    className={cx(
                        'shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold',
                        goesBack
                            ? 'border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100'
                            : 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
                    )}
                    data-testid="gg-toolchange-zero"
                    data-effect={text.zero.effect}
                >
                    {text.zero.label}
                </span>
            </div>
            {lateChange && (
                <div className="ml-7 text-xs font-semibold text-red-700 dark:text-red-300" data-testid="gg-toolchange-late-change">
                    WARNING: Z zero changed at {clock(live.stale?.at)}, after this tool change started. The next probe puts Z zero
                    back to its position of {clock(live.reference?.at)}. To keep the new Z zero, stop the job.
                </div>
            )}
            {first && (
                <div className="ml-7 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 basis-64 text-xs" data-testid="gg-toolchange-reason-why">
                        {text.why}
                    </span>
                    {text.overruleLabel && untouched && (
                        <button
                            type="button"
                            className="flex shrink-0 items-center gap-1 rounded border border-current px-2 py-0.5 text-xs font-medium hover:bg-white/60 dark:hover:bg-white/10"
                            onClick={() => overruleWizard(toolchangeContext, toolchangeComment)}
                            data-testid="gg-toolchange-overrule"
                        >
                            <MdSwapVert aria-hidden /> {text.overruleLabel}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default ToolChangeReason;
