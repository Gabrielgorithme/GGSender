/*
 * GGSender addition (not part of upstream gSender).
 *
 * Whether the machine is homed, from what the controller reports, for the
 * pre-flight check. Upstream only counts a homing that gSender itself sent
 * ($H from its Home button), so a machine homed from a pendant before the
 * computer was connected shows as "not homed".
 *
 * What FluidNC tells (checked in its source, Machine/Homing.cpp, Protocol.cpp,
 * ProcessSettings.cpp):
 * - With start/must_home (its default), it starts in alarm ("Unhomed") and
 *   refuses moves until every axis with homing is homed. It leaves that alarm
 *   only by homing or by $X, and $X also marks every axis as homed. So a
 *   FluidNC that is not in alarm when gSender connects was homed or unlocked
 *   earlier; which of the two cannot be told.
 * - During homing its state is "Home"; at the end of each homing cycle it
 *   sends "[MSG:Homed:XYZ]" to every channel (USB included, whoever started
 *   the homing). When a single-axis homing leaves other axes unhomed, it goes
 *   back to alarm, otherwise to Idle.
 * - A hard limit (ALARM:1) or a hard stop (ALARM:13) marks every axis
 *   unhomed; ALARM:14 is "Unhomed". A failed homing (6-9, 12) leaves the
 *   position unknown.
 *
 * So:
 * - "seen": a homing reported while connected ended out of alarm.
 * - "before-connect": the first status after connecting was not an alarm.
 *   The pre-flight says this is "homed, or unlocked with $X".
 * - not homed: an alarm at connection or one of the alarms above.
 *
 * It only observes; nothing here sends anything to the controller.
 */

export const HOMED_SEEN = 'seen';
export const HOMED_BEFORE_CONNECT = 'before-connect';

// alarms after which the position is not known
export const UNHOMING_ALARMS = [1, 6, 7, 8, 9, 12, 13, 14];

const HOMED_MSG_RE = /^\[MSG:(?:INFO:\s*)?Homed:\s*([A-Z]*)\s*\]/i;

export class HomedState {
    constructor({ onChange = () => {} } = {}) {
        this.onChange = onChange;
        this.homed = false;
        this.how = null; // HOMED_SEEN | HOMED_BEFORE_CONNECT | null
        this.axes = '';
        this.seenStatus = false;
        this.homing = false;
    }

    snapshot() {
        return { homed: this.homed, how: this.how, axes: this.axes };
    }

    set(homed, how, axes = this.axes) {
        if (homed === this.homed && how === this.how && axes === this.axes) {
            return;
        }
        this.homed = homed;
        this.how = how;
        this.axes = axes;
        this.onChange(this.snapshot());
    }

    /** Every status report: its activeState ("Idle", "Alarm", "Home", ...). */
    onStatus(activeState) {
        const state = String(activeState || '');
        if (!state) {
            return;
        }
        if (!this.seenStatus) {
            this.seenStatus = true;
            if (state === 'Home') {
                this.homing = true;
            } else if (state === 'Alarm') {
                this.set(false, null);
            } else {
                this.set(true, HOMED_BEFORE_CONNECT);
            }
            return;
        }
        if (state === 'Home') {
            this.homing = true;
            return;
        }
        if (this.homing) {
            this.homing = false;
            if (state === 'Alarm') {
                this.set(false, null);
            } else {
                this.set(true, HOMED_SEEN);
            }
        }
    }

    /** Every [MSG:...] line. */
    onMessage(line) {
        const m = HOMED_MSG_RE.exec(String(line || '').trim());
        if (m) {
            this.homing = true; // the next status that is not "Home" settles it
            const axes = m[1].toUpperCase();
            this.axes = Array.from(new Set((this.axes + axes).split(''))).sort().join('');
        }
    }

    onAlarm(code) {
        if (UNHOMING_ALARMS.includes(Number(code))) {
            this.homing = false;
            this.set(false, null, '');
        }
    }
}
