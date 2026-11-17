/*
 * GGSender addition (not part of upstream gSender).
 *
 * Tool change window: a large Run button that stays at the bottom of the
 * window, and Enter runs it, so a tool change needs no mouse.
 *
 * Enter runs the step's action only when
 * - the step has exactly one action (with several, Enter would have to
 *   guess) and it has not been run yet in this step,
 * - nothing is running, the success tick of the previous action is gone,
 *   and the machine is Idle (the button's own condition),
 * - the button has been ready for ARM_DELAY_MS: a second press meant for
 *   the step that just finished does not start the next one,
 * - it is a fresh press (key repeat is ignored) without Ctrl/Alt/Shift/Meta.
 * While the window is open (not minimised), every other Enter is swallowed:
 * the jog and rapid-position buttons react to Enter when they have focus, and
 * one of them may still have it from before the tool change. Typing in a text
 * field and dialogs opened on top of the window are left alone.
 */
import { RefObject, useEffect, useRef } from 'react';

export const TOOLCHANGE_ENTER_KEY = 'workspace.gg.toolChangeEnter';
export const ARM_DELAY_MS = 700;

const NOT_TEXT_INPUTS = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'];

/** Is this element one the user types into? */
export const isTextEntry = (el: Element | null | undefined): boolean => {
    if (!el || typeof (el as HTMLElement).tagName !== 'string') {
        return false;
    }
    const html = el as HTMLElement;
    if (html.isContentEditable || html.getAttribute?.('contenteditable') === 'true') {
        return true;
    }
    const tag = html.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    if (tag === 'INPUT') {
        return !NOT_TEXT_INPUTS.includes(((html as HTMLInputElement).type || 'text').toLowerCase());
    }
    return false;
};

/** A dialog (confirmation, etc.) open on top of everything. */
export const otherDialogOpen = (doc: Document): boolean =>
    Array.from(doc.querySelectorAll('[role="alertdialog"], [role="dialog"]')).some(
        (el) => (el as HTMLElement).getAttribute('data-state') !== 'closed',
    );

export type EnterDecision = 'run' | 'swallow' | 'ignore';

export interface EnterInput {
    key: string;
    repeat: boolean;
    modifier: boolean;
    textEntry: boolean;
    dialogOpen: boolean;
    armed: boolean;
    readyForMs: number;
}

export const decideEnter = (k: EnterInput): EnterDecision => {
    if (k.key !== 'Enter' || k.textEntry || k.dialogOpen) {
        return 'ignore';
    }
    if (k.repeat || k.modifier || !k.armed || k.readyForMs < ARM_DELAY_MS) {
        return 'swallow';
    }
    return 'run';
};

/**
 * Enter clicks `button` when `armed` (see the rules above). Active while
 * `enabled` (the setting is on and the window shows a step).
 */
export const useEnterToRun = (
    button: RefObject<HTMLButtonElement>,
    armed: boolean,
    enabled: boolean,
    now: () => number = Date.now,
) => {
    const armedAt = useRef<number | null>(null);
    const armedRef = useRef(armed);
    armedRef.current = armed;

    useEffect(() => {
        armedAt.current = armed ? now() : null;
        // now is a constant at every call site
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed]);

    useEffect(() => {
        if (!enabled) {
            return undefined;
        }
        const onKey = (e: KeyboardEvent) => {
            const decision = decideEnter({
                key: e.key,
                repeat: e.repeat,
                modifier: e.ctrlKey || e.altKey || e.metaKey || e.shiftKey,
                textEntry: isTextEntry(e.target as Element) || isTextEntry(document.activeElement),
                dialogOpen: otherDialogOpen(document),
                armed: armedRef.current && armedAt.current !== null,
                readyForMs: armedAt.current === null ? 0 : now() - armedAt.current,
            });
            if (decision === 'ignore') {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (decision === 'run') {
                const target = button.current;
                if (target && !target.disabled) {
                    armedAt.current = null; // one press, one step
                    target.click();
                }
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // now is a constant at every call site
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, button]);
};

// Classes for the large button (the upstream ones stay in Actions.tsx)
export const BIG_RUN_BUTTON =
    'ml-3 shrink-0 flex items-center gap-3 text-lg font-semibold px-7 h-12 min-w-[11rem] justify-center rounded-md bg-blue-600 dark:bg-blue-700 hover:bg-blue-700 dark:hover:bg-blue-600 text-white shadow disabled:opacity-35 disabled:pointer-events-none transition-colors';
export const ENTER_HINT = 'text-xs font-mono font-normal px-1.5 py-0.5 rounded border border-white/60 opacity-90';
