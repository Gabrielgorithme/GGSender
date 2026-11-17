/*
 * GGSender addition (not part of upstream gSender).
 *
 * Pause as an immediate feed hold, like the hold button of a FluidDial
 * pendant, with the spindle stoppable during the hold.
 *
 * Upstream's pause, when a "Program Pause" event is set up, only stops
 * feeding the program and sends the event's G-code behind it: the machine
 * first runs everything already in the controller's buffer. Here:
 * - pause: "!" (feed hold) at once, then the program stops feeding.
 * - during the hold: 0x9E, the Grbl/FluidNC "spindle stop" override, stops
 *   the spindle; sent again it starts it. The controller accepts it only in
 *   Hold.
 * - resume: once the hold is complete (the controller ignores "~" while it is
 *   still slowing down), start a stopped spindle (0x9E) while still held,
 *   wait the spin-up time, then "~" (cycle start). FluidNC also starts a
 *   stopped spindle by itself on "~", but then waits only its spindle's
 *   spinup_ms (0 unless set in its config) before moving.
 * - the Program Pause and Resume events are not run: G-code cannot run
 *   during a hold (an M3 waits for the held moves to finish), so a resume
 *   event would never let the "~" go out.
 * - resumed elsewhere (the pendant's cycle start): when the controller
 *   reports Run after a Hold, the program goes on feeding.
 *
 * The spindle state comes from the status reports: "A:S" or "A:C" while it
 * turns. FluidNC puts that field only in reports that carry "Ov:", which it
 * sends right after a spindle stop and every few seconds otherwise.
 * "Hold:1" is a hold still slowing down, "Hold:0" (or "Hold") a complete one.
 *
 * FluidNC reads realtime bytes from 0x80 up as UTF-8: 0x9E has to go out as
 * the two bytes C2 9E, which is what writing the one-character string does
 * (the serial port encodes strings as UTF-8). A single raw 0x9E byte is a
 * decoding error there and is ignored.
 */

export const FEED_HOLD = '!';
export const CYCLE_START = '~';
export const SPINDLE_STOP_TOGGLE = String.fromCharCode(0x9e);

export const PAUSE_MODE_HOLD = 'hold';
export const PAUSE_MODE_UPSTREAM = 'upstream';

export const DEFAULT_SPINUP_SECONDS = 5;
const MAX_SPINUP_SECONDS = 60;
// How long to wait for a status report to confirm a spindle stop or start
export const TOGGLE_SETTLE_MS = 2500;

/** The settings, as the interface stores them in the server's preferences. */
export const holdPreferences = (prefs = {}) => {
    const raw = prefs.ggResumeSpinupSeconds;
    const seconds = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    return {
        mode: prefs.ggPauseMode === PAUSE_MODE_UPSTREAM ? PAUSE_MODE_UPSTREAM : PAUSE_MODE_HOLD,
        stopSpindle: prefs.ggHoldStopsSpindle === true,
        spinupMs:
            Number.isFinite(seconds) && seconds >= 0
                ? Math.min(seconds, MAX_SPINUP_SECONDS) * 1000
                : DEFAULT_SPINUP_SECONDS * 1000,
    };
};

export class HoldPause {
    /**
     * @param write      sends feed hold / cycle start ("!", "~")
     * @param writeByte  sends the spindle stop toggle (as a string, see above)
     * @param onChange   called with snapshot() whenever something changes
     */
    constructor({
        write,
        writeByte = write,
        onChange = () => {},
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    }) {
        this.write = write;
        this.writeByte = writeByte;
        this.onChange = onChange;
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.spindleOn = null; // from the last report with Ov:, null = not known yet
        this.timer = null;
        this.settleTimer = null;
        this.clear();
    }

    clear() {
        this.active = false; // a gSender hold is in force
        this.sawHold = false; // the controller has reported Hold since
        this.holdComplete = false; // ... and the machine has stopped
        this.spindleOnAtHold = null;
        this.stopped = false; // the spindle stop override is in force
        this.pending = null; // { expectOn }: a toggle not yet seen in a report
        this.restoredAt = null; // when the spindle was last started in this hold
        this.autoStop = false;
        this.resumeRequest = null; // { spinupMs, done }: waiting to start the resume
        this.resumeAt = null; // spin-up wait under way: when "~" goes out
        if (this.timer) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        this.clearSettle();
    }

    clearSettle() {
        if (this.settleTimer) {
            this.clearTimer(this.settleTimer);
            this.settleTimer = null;
        }
    }

    /** The job stopped, or the controller was reset. */
    reset() {
        const was = this.active;
        this.clear();
        if (was) {
            this.changed();
        }
    }

    snapshot() {
        return {
            active: this.active,
            holding: this.sawHold,
            holdComplete: this.holdComplete,
            spindleOn: this.spindleOn,
            spindleWasOn: this.spindleOnAtHold,
            stopped: this.stopped,
            pending: this.pending !== null,
            resuming: this.resumeRequest !== null || this.resumeAt !== null,
            resumeAt: this.resumeAt,
            // time left before "~", for a display on another computer's clock
            resumeInMs: this.resumeAt === null ? null : Math.max(0, this.resumeAt - this.now()),
            canToggle: this.canToggle(),
        };
    }

    changed() {
        this.onChange(this.snapshot());
    }

    canToggle() {
        return (
            this.active &&
            this.sawHold &&
            this.pending === null &&
            this.resumeRequest === null &&
            this.resumeAt === null &&
            this.spindleOnAtHold !== false
        );
    }

    /** Pause: feed hold now. */
    hold({ stopSpindle = false } = {}) {
        if (!this.active) {
            this.clear();
            this.active = true;
            this.spindleOnAtHold = this.spindleOn;
            this.autoStop = stopSpindle;
        }
        this.write(FEED_HOLD);
        this.changed();
    }

    /**
     * A status report from the controller (the parsed payload).
     * @returns 'resumed-elsewhere' when the controller left the hold without
     *          gSender (a pendant's cycle start)
     */
    onStatus(status = {}) {
        const { activeState, subState, ov, accessoryState } = status;
        let changed = false;

        if (Array.isArray(ov)) {
            const on = /[SC]/i.test(accessoryState || '');
            if (on !== this.spindleOn) {
                this.spindleOn = on;
                changed = true;
            }
            if (this.active) {
                if (this.spindleOnAtHold === null && on) {
                    this.spindleOnAtHold = true;
                    changed = true;
                }
                if (this.pending) {
                    // a report made before the toggle was handled says nothing
                    if (this.pending.expectOn === on) {
                        this.pending = null;
                        this.clearSettle();
                        changed = true;
                    }
                } else if (this.spindleOnAtHold === true && this.resumeAt === null && this.stopped === on) {
                    // the report wins over what gSender believes: the pendant
                    // may have stopped or started it too
                    this.stopped = !on;
                    changed = true;
                }
            }
        }

        if (this.active) {
            if (activeState === 'Hold') {
                if (!this.sawHold) {
                    this.sawHold = true;
                    changed = true;
                }
                if (subState !== 1 && !this.holdComplete) {
                    this.holdComplete = true;
                    changed = true;
                }
                if (this.autoStop && this.spindleOnAtHold !== false && this.canToggle()) {
                    this.autoStop = false;
                    this.toggleSpindle({ quiet: true });
                    changed = true;
                }
            } else if (activeState === 'Run' && this.sawHold && this.resumeAt === null) {
                this.clear();
                this.changed();
                return 'resumed-elsewhere';
            }
        }

        if (this.readyToResume()) {
            this.startResume(); // reports the change itself
            return null;
        }
        if (changed) {
            this.changed();
        }
        return null;
    }

    /** Stop or start the spindle during the hold. */
    toggleSpindle({ quiet = false } = {}) {
        if (!this.canToggle()) {
            return false;
        }
        const expectOn = this.stopped;
        this.writeByte(SPINDLE_STOP_TOGGLE);
        this.stopped = !expectOn;
        if (expectOn) {
            this.restoredAt = this.now();
        }
        this.pending = { expectOn };
        // no report confirmed it: stop waiting after a while
        this.settleTimer = this.setTimer(() => {
            this.settleTimer = null;
            if (this.pending) {
                this.pending = null;
                if (this.readyToResume()) {
                    this.startResume();
                } else {
                    this.changed();
                }
            }
        }, TOGGLE_SETTLE_MS);
        if (!quiet) {
            this.changed();
        }
        return true;
    }

    readyToResume() {
        return this.resumeRequest !== null && this.pending === null && this.holdComplete;
    }

    /**
     * Resume: once the hold is complete, start a stopped spindle, wait for it,
     * then cycle start. done() is called once "~" has gone out.
     * A second call while still waiting for the hold to complete sends the
     * resume anyway.
     */
    resume(spinupMs, done = () => {}) {
        if (!this.active) {
            // a hold gSender did not make (the pendant): plain cycle start
            this.write(CYCLE_START);
            done();
            return;
        }
        if (this.resumeAt !== null) {
            return; // spin-up wait already under way
        }
        if (this.resumeRequest) {
            this.startResume();
            return;
        }
        this.resumeRequest = { spinupMs, done };
        if (this.readyToResume()) {
            this.startResume();
        } else {
            this.changed();
        }
    }

    startResume() {
        const { spinupMs, done } = this.resumeRequest;
        this.resumeRequest = null;
        this.pending = null;
        this.clearSettle();
        let wait = 0;
        if (this.stopped) {
            this.writeByte(SPINDLE_STOP_TOGGLE);
            this.stopped = false;
            this.restoredAt = this.now();
            wait = spinupMs;
        } else if (this.restoredAt !== null) {
            // started by hand during the hold: wait what is left of the spin-up
            wait = Math.max(0, spinupMs - (this.now() - this.restoredAt));
        }
        const go = () => {
            this.timer = null;
            this.write(CYCLE_START);
            this.clear();
            this.changed();
            done();
        };
        if (wait > 0) {
            this.resumeAt = this.now() + wait;
            this.timer = this.setTimer(go, wait);
            this.changed();
        } else {
            go();
        }
    }
}
