/*
 * GGSender addition (not part of upstream gSender).
 *
 * The Fixed Tool Sensor tool change, from the decision to the wizard on
 * screen: lib/gg/toolChangeDecision.ts chooses from the state of the tool
 * sensor reference, this builds the wizard, tells the server which one runs
 * (for the history), and lets the owner switch to the other one before any
 * step has run.
 *
 * Switching reloads the wizard at its first step. The wizard's start code
 * (spindle off, the saved position, up to the safe height) has run already
 * and is the same for both: the two wizards that can be switched are the
 * same upstream wizard, with and without its first step.
 */
import pubsub from 'pubsub-js';

import controller from 'app/lib/controller';
import store from 'app/store';
import automaticToolChange from 'app/wizards/automaticToolchange';
import probeToolLength from 'app/wizards/probeToolLength';
import { showFirstToolchangePrompt } from 'app/wizards/firstToolchangePrompt';
import { REFERENCE_GUARD_KEY, ReferenceSnapshot, getReference, normalizeReference, setReference } from 'app/lib/gg/probeStore';
import {
    ResumeToolMode,
    ToolChangeDecision,
    WizardVariant,
    decideFixedSensor,
    overruled,
} from 'app/lib/gg/toolChangeDecision';

export const FIXED_SENSOR_TITLE = 'Fixed Tool Sensor Tool Change';

/** What the wizard window is given, in the tool change context (ggDecision). */
export interface WizardDecision {
    decision: ToolChangeDecision;
    active: WizardVariant; // the wizard loaded now
    reference: ReferenceSnapshot; // the reference when the tool change began
}

export const wizardFor = (variant: WizardVariant) => {
    if (variant === 'reference') {
        return probeToolLength();
    }
    // upstream's wizard: with a count of 1 it starts with "Probe Initial Tool"
    return automaticToolChange(variant === 'full' ? 1 : 2);
};

/** Upstream's "First tool" setting, for the first M6 of a job started from the top. */
const firstToolVariant = async (comment: string): Promise<WizardVariant> => {
    const behaviour = store.get('workspace.toolChange.firstToolBehaviour', 'Always run full wizard');
    if (behaviour === 'Always run full wizard') {
        return 'full';
    }
    if (behaviour === 'Always probe length only') {
        return 'reference';
    }
    return (await showFirstToolchangePrompt({ comment })) ? 'full' : 'reference';
};

const RESUME_MODES = ['keep', 'measure', 'measure-old', 'full', 'reference', 'reference-same'];

const decide = (context: Record<string, any>, reference: ReferenceSnapshot) => {
    const mode = context?.ggResume?.mode;
    return decideFixedSensor({
        count: Number(context?.count) || 1,
        reference,
        resumed: context?.ggResume?.resumed === true,
        resumeMode: RESUME_MODES.includes(mode) ? (mode as ResumeToolMode) : null,
        guard: store.get(REFERENCE_GUARD_KEY, true) !== false,
    });
};

/**
 * @param context  the server's tool change context (count, tool, ggReference, ggResume)
 * @returns the wizard, and the context to load it with
 */
export const chooseFixedSensorWizard = async (context: Record<string, any>, comment = '') => {
    const reference = context?.ggReference ? normalizeReference(context.ggReference) : getReference();
    if (context?.ggReference) {
        setReference(context.ggReference);
    }
    const decision = decide(context, reference);
    const active = decision.variant === 'first-tool' ? await firstToolVariant(comment) : decision.variant;
    controller.command('gg:probe:wizard', { variant: active, target: context?.tool ?? null });
    const ggDecision: WizardDecision = { decision, active, reference };
    return { instructions: wizardFor(active), context: { ...context, ggDecision } };
};

/** Switch to the other wizard of the decision. Only before any step has run. */
export const overruleWizard = (toolchangeContext: Record<string, any> | null, comment = ''): boolean => {
    const gg = toolchangeContext?.ggDecision as WizardDecision | undefined;
    if (!gg) {
        return false;
    }
    const next = overruled(gg.decision, gg.active);
    if (next === null) {
        return false;
    }
    controller.command('gg:probe:wizard', { variant: next, target: toolchangeContext?.tool ?? null });
    pubsub.publishSync('wizard:load', {
        context: { ...toolchangeContext, ggDecision: { ...gg, active: next } },
        comment,
        title: FIXED_SENSOR_TITLE,
        instructions: wizardFor(next),
    });
    return true;
};

/**
 * The reference changed while the window was open and nothing has run yet
 * (Z zero set from the pendant with the window on screen): decide again, so
 * that the window never runs on a state that is no longer true.
 * @returns true when the wizard was reloaded
 */
export const redecideWizard = (toolchangeContext: Record<string, any> | null, comment: string, live: ReferenceSnapshot): boolean => {
    const gg = toolchangeContext?.ggDecision as WizardDecision | undefined;
    if (!gg || !live.live || live.status === gg.reference.status) {
        return false;
    }
    const decision = decide(toolchangeContext as Record<string, any>, live);
    // the first tool of a job, and a resume that only measures, do not depend on the reference
    const active = decision.variant === 'first-tool' ? gg.active : decision.variant;
    if (active !== gg.active) {
        controller.command('gg:probe:wizard', { variant: active, target: toolchangeContext?.tool ?? null });
    }
    pubsub.publishSync('wizard:load', {
        context: { ...toolchangeContext, ggDecision: { decision, active, reference: live } },
        comment,
        title: FIXED_SENSOR_TITLE,
        instructions: wizardFor(active),
    });
    return true;
};
