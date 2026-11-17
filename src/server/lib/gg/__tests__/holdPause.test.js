/**
 * @jest-environment node
 */
// GGSender: pause as a feed hold, spindle stop/start during the hold
import {
    CYCLE_START,
    DEFAULT_SPINUP_SECONDS,
    FEED_HOLD,
    HoldPause,
    PAUSE_MODE_HOLD,
    PAUSE_MODE_UPSTREAM,
    SPINDLE_STOP_TOGGLE,
    TOGGLE_SETTLE_MS,
    holdPreferences,
} from '../holdPause';

const STOP = SPINDLE_STOP_TOGGLE;

const make = () => {
    let t = 1000;
    const timers = [];
    const out = [];
    const states = [];
    const hold = new HoldPause({
        write: (d) => out.push(d),
        writeByte: (d) => out.push(d),
        onChange: (s) => states.push(s),
        now: () => t,
        setTimer: (fn, ms) => {
            const timer = { fn, at: t + ms, done: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            timer.done = true;
        },
    });
    const advance = (ms) => {
        t += ms;
        timers
            .filter((x) => !x.done && x.at <= t)
            .forEach((x) => {
                x.done = true;
                x.fn();
            });
    };
    return { hold, out, states, advance, last: () => states[states.length - 1] };
};

// status payloads as GrblLineParserResultStatus makes them
const run = (spindle = true) => ({ activeState: 'Run', subState: NaN, ov: [100, 100, 100], accessoryState: spindle ? 'S' : '' });
const holding = (spindle = true) => ({ activeState: 'Hold', subState: 1, ov: [100, 100, 100], accessoryState: spindle ? 'S' : '' });
const held = (spindle = true) => ({ activeState: 'Hold', subState: 0, ov: [100, 100, 100], accessoryState: spindle ? 'S' : '' });
const heldNoOv = () => ({ activeState: 'Hold', subState: 0 });

describe('GGSender hold: settings', () => {
    it('defaults to an immediate hold and a 5 s spin-up wait', () => {
        expect(holdPreferences({})).toEqual({ mode: PAUSE_MODE_HOLD, stopSpindle: false, spinupMs: DEFAULT_SPINUP_SECONDS * 1000 });
        expect(holdPreferences(undefined).mode).toBe(PAUSE_MODE_HOLD);
    });
    it('reads what the interface sends', () => {
        expect(holdPreferences({ ggPauseMode: 'upstream', ggHoldStopsSpindle: true, ggResumeSpinupSeconds: 8 })).toEqual({
            mode: PAUSE_MODE_UPSTREAM,
            stopSpindle: true,
            spinupMs: 8000,
        });
        expect(holdPreferences({ ggResumeSpinupSeconds: 0 }).spinupMs).toBe(0);
        expect(holdPreferences({ ggResumeSpinupSeconds: '2.5' }).spinupMs).toBe(2500);
        expect(holdPreferences({ ggResumeSpinupSeconds: 600 }).spinupMs).toBe(60000);
        expect(holdPreferences({ ggResumeSpinupSeconds: -1 }).spinupMs).toBe(5000);
        expect(holdPreferences({ ggResumeSpinupSeconds: 'abc' }).spinupMs).toBe(5000);
    });
});

describe('GGSender hold: the bytes', () => {
    it('spindle stop is the string 0x9E, which the serial port sends as UTF-8 C2 9E (what FluidNC decodes)', () => {
        expect(SPINDLE_STOP_TOGGLE).toBe('\u009e');
        expect([...Buffer.from(SPINDLE_STOP_TOGGLE)]).toEqual([0xc2, 0x9e]);
        expect(FEED_HOLD).toBe('!');
        expect(CYCLE_START).toBe('~');
    });
});

describe('GGSender hold: pause and resume', () => {
    it('pause sends the feed hold at once', () => {
        const { hold, out, last } = make();
        hold.onStatus(run());
        hold.hold();
        expect(out).toEqual([FEED_HOLD]);
        expect(last()).toMatchObject({ active: true, holding: false, canToggle: false });
    });

    it('resume without touching the spindle: cycle start as soon as the hold is complete', () => {
        const { hold, out, advance } = make();
        const done = jest.fn();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        hold.resume(5000, done);
        expect(out).toEqual([FEED_HOLD, CYCLE_START]);
        expect(done).toHaveBeenCalledTimes(1);
        expect(hold.active).toBe(false);
        advance(10000);
        expect(out).toEqual([FEED_HOLD, CYCLE_START]);
    });

    it('a resume asked while the machine is still slowing down waits for Hold:0', () => {
        const { hold, out } = make();
        const done = jest.fn();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(holding());
        hold.resume(5000, done);
        expect(out).toEqual([FEED_HOLD]); // FluidNC would ignore "~" now
        hold.onStatus(holding());
        expect(out).toEqual([FEED_HOLD]);
        hold.onStatus(held());
        expect(out).toEqual([FEED_HOLD, CYCLE_START]);
        expect(done).toHaveBeenCalled();
    });

    it('a second resume click sends it anyway', () => {
        const { hold, out } = make();
        hold.onStatus(run());
        hold.hold();
        hold.resume(5000);
        expect(out).toEqual([FEED_HOLD]);
        hold.resume(5000);
        expect(out).toEqual([FEED_HOLD, CYCLE_START]);
    });

    it('stop the spindle, then resume: start it while held, wait, then cycle start', () => {
        const { hold, out, advance, last } = make();
        const done = jest.fn();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        expect(last()).toMatchObject({ canToggle: true, stopped: false, spindleWasOn: true });
        expect(hold.toggleSpindle()).toBe(true);
        expect(out).toEqual([FEED_HOLD, STOP]);
        expect(last()).toMatchObject({ stopped: true, pending: true, canToggle: false });
        hold.onStatus(held(false)); // FluidNC reports the spindle off
        expect(last()).toMatchObject({ stopped: true, pending: false, canToggle: true, spindleOn: false });

        hold.resume(5000, done);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]); // started again, still held
        expect(last()).toMatchObject({ resuming: true, resumeAt: hold.now() + 5000 });
        advance(4999);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        expect(done).not.toHaveBeenCalled();
        advance(1);
        expect(out).toEqual([FEED_HOLD, STOP, STOP, CYCLE_START]);
        expect(done).toHaveBeenCalledTimes(1);
        expect(last()).toMatchObject({ active: false, resuming: false });
    });

    it('spindle started by hand during the hold: resume waits only what is left of the spin-up', () => {
        const { hold, out, advance } = make();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        hold.toggleSpindle();
        hold.onStatus(held(false));
        hold.toggleSpindle(); // start it again
        hold.onStatus(held(true));
        advance(3000);
        hold.resume(5000);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        advance(1999);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        advance(1);
        expect(out).toEqual([FEED_HOLD, STOP, STOP, CYCLE_START]);
    });

    it('a resume right after stopping the spindle waits for the stop to be confirmed', () => {
        const { hold, out, advance } = make();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        hold.toggleSpindle();
        hold.resume(5000); // before any report
        expect(out).toEqual([FEED_HOLD, STOP]);
        // a report made before the stop was handled changes nothing
        hold.onStatus(held(true));
        expect(out).toEqual([FEED_HOLD, STOP]);
        hold.onStatus(held(false));
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        advance(5000);
        expect(out).toEqual([FEED_HOLD, STOP, STOP, CYCLE_START]);
    });

    it('no report ever confirms the toggle: gives up waiting after a while', () => {
        const { hold, out, advance } = make();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(heldNoOv());
        hold.toggleSpindle();
        hold.resume(5000);
        advance(TOGGLE_SETTLE_MS);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        advance(5000);
        expect(out).toEqual([FEED_HOLD, STOP, STOP, CYCLE_START]);
    });

    it('no toggles before the hold is reported, while one is pending, or during the spin-up wait', () => {
        const { hold, out } = make();
        hold.onStatus(run());
        hold.hold();
        expect(hold.toggleSpindle()).toBe(false);
        hold.onStatus(held());
        expect(hold.toggleSpindle()).toBe(true);
        expect(hold.toggleSpindle()).toBe(false); // still pending
        hold.onStatus(held(false));
        hold.resume(5000);
        expect(hold.toggleSpindle()).toBe(false); // spinning up
        expect(out.filter((b) => b === STOP)).toHaveLength(2);
    });

    it('spindle already off at the pause: nothing to stop or start, no wait', () => {
        const { hold, out, last } = make();
        hold.onStatus(run(false));
        hold.hold();
        hold.onStatus(held(false));
        expect(last()).toMatchObject({ spindleWasOn: false, canToggle: false });
        expect(hold.toggleSpindle()).toBe(false);
        hold.resume(5000);
        expect(out).toEqual([FEED_HOLD, CYCLE_START]);
    });

    it('spindle stopped from the pendant during the hold: the report says so, resume starts it and waits', () => {
        const { hold, out, advance, last } = make();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        hold.onStatus(held(false));
        expect(last()).toMatchObject({ stopped: true });
        hold.resume(4000);
        expect(out).toEqual([FEED_HOLD, STOP]);
        advance(4000);
        expect(out).toEqual([FEED_HOLD, STOP, CYCLE_START]);
    });

    it('stop the spindle on pause (setting): sent once the hold is reported', () => {
        const { hold, out } = make();
        hold.onStatus(run());
        hold.hold({ stopSpindle: true });
        expect(out).toEqual([FEED_HOLD]);
        hold.onStatus(holding());
        expect(out).toEqual([FEED_HOLD, STOP]);
        hold.onStatus(held(false));
        hold.onStatus(held(false));
        expect(out).toEqual([FEED_HOLD, STOP]); // only once
        hold.resume(5000);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
    });

    it('resumed from the pendant: reported so the job feeds again', () => {
        const { hold, out } = make();
        hold.onStatus(run());
        hold.hold();
        // a report made before the hold took effect is not a resume
        expect(hold.onStatus(run())).toBeNull();
        hold.onStatus(held());
        expect(hold.onStatus(run())).toBe('resumed-elsewhere');
        expect(hold.active).toBe(false);
        expect(out).toEqual([FEED_HOLD]);
    });

    it('resume when gSender did not make the hold (pendant hold): plain cycle start', () => {
        const { hold, out } = make();
        const done = jest.fn();
        hold.resume(5000, done);
        expect(out).toEqual([CYCLE_START]);
        expect(done).toHaveBeenCalled();
    });

    it('a stop during the spin-up wait cancels the cycle start', () => {
        const { hold, out, advance } = make();
        hold.onStatus(run());
        hold.hold();
        hold.onStatus(held());
        hold.toggleSpindle();
        hold.onStatus(held(false));
        hold.resume(5000);
        hold.reset();
        advance(10000);
        expect(out).toEqual([FEED_HOLD, STOP, STOP]);
        expect(hold.active).toBe(false);
    });
});
