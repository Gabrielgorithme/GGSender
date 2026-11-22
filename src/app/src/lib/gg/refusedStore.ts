/*
 * GGSender addition (not part of upstream gSender).
 *
 * What the server says about two things at a tool change
 * (src/server/lib/gg/refusedLines.js):
 * - the lines that the controller refused because the machine jogged, which
 *   wait to be sent again ("gg:refused:state");
 * - whether the machine is ready: idle, with no line of the job or of the
 *   tool change still waiting for a reply ("gg:settled"). FluidNC reports
 *   "Idle" while it waits for the spindle to stop with lines in its buffer,
 *   so "Idle" alone does not mean that a jog is safe.
 */
import { useEffect, useState } from 'react';
import pubsub from 'pubsub-js';

export const JOG_RECOVERY_KEY = 'workspace.gg.jogRecovery';
export const REFUSED_TOPIC = 'gg:refused:state';
export const SETTLED_TOPIC = 'gg:settled';

export interface RefusedLine {
    source: 'job' | 'feeder';
    text: string;
}

export interface RefusedState {
    lines: RefusedLine[];
    moves: boolean; // a line can move the machine: the owner must ask for it
    broken: string | null; // why nothing can be sent again
    replaying: boolean;
}

export const NO_REFUSED: RefusedState = { lines: [], moves: false, broken: null, replaying: false };

let refused: RefusedState = NO_REFUSED;
let settled = true;

export const normalizeRefused = (s: unknown): RefusedState => {
    const v = (s ?? {}) as Record<string, any>;
    const lines: RefusedLine[] = Array.isArray(v.lines)
        ? v.lines
              .filter((l: any) => l && typeof l.text === 'string')
              .map((l: any) => ({ source: l.source === 'feeder' ? 'feeder' : 'job', text: l.text }))
        : [];
    return {
        lines,
        moves: v.moves !== false && lines.length > 0 ? Boolean(v.moves) : false,
        broken: typeof v.broken === 'string' && v.broken ? v.broken : null,
        replaying: v.replaying === true,
    };
};

export const getRefused = (): RefusedState => refused;

export const setRefused = (s: unknown) => {
    refused = s === null ? NO_REFUSED : normalizeRefused(s);
    pubsub.publishSync(REFUSED_TOPIC, refused);
};

export const useRefused = (): RefusedState => {
    const [value, setValue] = useState<RefusedState>(refused);
    useEffect(() => {
        setValue(refused);
        const token = pubsub.subscribe(REFUSED_TOPIC, (_msg: string, s: RefusedState) => setValue(s));
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);
    return value;
};

export const isSettled = (): boolean => settled;

/** null: not connected, nothing is known: no "wait" is shown. */
export const setSettled = (value: unknown) => {
    settled = value !== false;
    pubsub.publishSync(SETTLED_TOPIC, settled);
};

export const useSettled = (): boolean => {
    const [value, setValue] = useState<boolean>(settled);
    useEffect(() => {
        setValue(settled);
        const token = pubsub.subscribe(SETTLED_TOPIC, (_msg: string, s: boolean) => setValue(s));
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);
    return value;
};
