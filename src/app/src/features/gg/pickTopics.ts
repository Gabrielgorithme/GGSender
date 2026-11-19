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
 *
 * and for one part of the toolpath shown alone (an operation):
 *   gg:isolate:request  { key, label, firstLine, endLine } | { clear: true }
 *                       anyone asks the 3D view to show only the moves of
 *                       these file lines (0-based, endLine not included,
 *                       null: to the end of the file)
 *   gg:isolate:changed  { key, label, firstLine, endLine } | null
 *                       the 3D view says what it now shows alone; null: all
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

export const ISOLATE_REQUEST = 'gg:isolate:request';
export const ISOLATE_CHANGED = 'gg:isolate:changed';

export interface IsolationState {
    key: string; // who is shown, for example "op:3"
    label: string; // its name, for the screen
    firstLine: number; // 0-based file line
    endLine: number | null; // not included; null: to the end of the file
}

let isolation: IsolationState | null = null;

export const getCurrentIsolation = (): IsolationState | null => isolation;

// at once: a part of the toolpath is hidden, the screen must say so without delay
export const publishIsolation = (state: IsolationState | null) => {
    isolation = state;
    pubsub.publishSync(ISOLATE_CHANGED, state);
};

export const requestIsolate = (state: IsolationState) => pubsub.publishSync(ISOLATE_REQUEST, state);
export const requestIsolateClear = () => pubsub.publishSync(ISOLATE_REQUEST, { clear: true });
