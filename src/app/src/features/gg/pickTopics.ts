/*
 * GGSender addition (not part of upstream gSender).
 *
 * Messages between the 3D view, the pick card and the G-code editor:
 *   gg:pick:request  { line } | { step: 1 | -1 } | { clear: true }
 *                    anyone asks the 3D view to show a line (0-based)
 *   gg:pick:changed  { line, drew } | null
 *                    the 3D view says what it now shows; drew is false when
 *                    the line has no motion and a nearby move is shown
 *                    instead (shownLine)
 */
import pubsub from 'pubsub-js';

export const PICK_REQUEST = 'gg:pick:request';
export const PICK_CHANGED = 'gg:pick:changed';

export interface PickState {
    line: number; // 0-based file line
    drew: boolean;
    shownLine: number | null; // line whose motion is highlighted
}

let current: PickState | null = null;

export const getCurrentPick = (): PickState | null => current;

export const publishPick = (state: PickState | null) => {
    current = state;
    pubsub.publish(PICK_CHANGED, state);
};

export const requestPickLine = (line: number) =>
    pubsub.publish(PICK_REQUEST, { line });
export const requestPickStep = (step: 1 | -1) =>
    pubsub.publish(PICK_REQUEST, { step });
export const requestPickClear = () => pubsub.publish(PICK_REQUEST, { clear: true });
