/*
 * GGSender addition (not part of upstream gSender).
 *
 * The words for the lines that the controller refused during a jog, and for
 * "the machine is ready". Style: ASD-STE100.
 */
import { RefusedState } from './refusedStore';

const SHOWN = 5;

/** The line as the owner knows it: no comment-only lines, comments kept short. */
const shown = (text: string): string => text.trim();

export interface RefusedText {
    title: string;
    cause: string;
    lines: string[]; // the lines, the first ones
    more: string | null; // "and 3 more lines"
    action: string; // what happens next, or what to do
    button: string | null; // "Send again", or null
    buttonEnabled: boolean;
    severe: boolean; // nothing can be sent again: stop the job
    hint: string | null;
}

/**
 * @param idle  the controller reports Idle now
 */
export const refusedText = (state: RefusedState, idle: boolean): RefusedText | null => {
    const withCode = state.lines.filter((l) => l.text.replace(/\([^)]*\)/g, '').replace(/^\s*N\d+\s*/i, '').trim() !== '');
    if (state.lines.length === 0) {
        return null;
    }
    const n = withCode.length;
    const lines = withCode.slice(0, SHOWN).map((l) => shown(l.text));
    const rest = withCode.length - lines.length;
    const base = {
        title: n === 1 ? 'The controller refused 1 line' : `The controller refused ${n} lines`,
        cause: 'The machine was in a jog when gSender sent these lines. The controller accepts no program line during a jog.',
        lines,
        more: rest > 0 ? `and ${rest} more ${rest === 1 ? 'line' : 'lines'}` : null,
        hint: 'To prevent this: jog only when the tool change window shows that the machine is ready.',
    };
    if (state.broken) {
        return {
            ...base,
            action:
                state.broken === 'accepted-after-refused'
                    ? 'The controller then accepted a line that comes after these lines. The sequence is not correct now. Stop the job. Then use Resume From.'
                    : 'gSender cannot send these lines again. Stop the job. Then use Resume From.',
            button: null,
            buttonEnabled: false,
            severe: true,
            hint: null,
        };
    }
    if (state.replaying) {
        return { ...base, action: 'gSender sends the lines again.', button: null, buttonEnabled: false, severe: false };
    }
    if (!state.moves) {
        return {
            ...base,
            action: 'These lines move nothing. gSender sends them again when the machine is idle.',
            button: null,
            buttonEnabled: false,
            severe: false,
        };
    }
    return {
        ...base,
        action: idle
            ? 'Press Send again to send these lines now. The machine can move. Then the tool change continues.'
            : 'Wait until the machine is idle. Then press Send again.',
        button: 'Send again',
        buttonEnabled: idle,
        severe: false,
    };
};

export const READY_TEXT = {
    wait: 'WAIT. The machine is not ready. Do not jog.',
    ready: 'The machine is ready. You can jog.',
};
