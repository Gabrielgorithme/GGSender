// GGSender: homed or not, from the controller's reports (lib/gg/homedState.js)
import { HOMED_BEFORE_CONNECT, HOMED_SEEN, HomedState } from '../homedState';

const tracker = () => {
    const changes = [];
    const h = new HomedState({ onChange: (s) => changes.push(s) });
    return { h, changes };
};

describe('GGSender: homed state', () => {
    it('out of alarm at connection: homed before (or unlocked)', () => {
        const { h, changes } = tracker();
        h.onStatus('Idle');
        expect(h.snapshot()).toEqual({ homed: true, how: HOMED_BEFORE_CONNECT, axes: '' });
        h.onStatus('Idle');
        h.onStatus('Run');
        expect(changes).toHaveLength(1);
    });

    it('in alarm at connection: not homed, until a homing ends out of alarm', () => {
        const { h, changes } = tracker();
        h.onStatus('Alarm');
        expect(h.snapshot().homed).toBe(false);
        h.onStatus('Home');
        h.onStatus('Home');
        expect(h.snapshot().homed).toBe(false);
        h.onMessage('[MSG:Homed:Z]');
        h.onMessage('[MSG:Homed:XY]');
        h.onStatus('Idle');
        expect(h.snapshot()).toEqual({ homed: true, how: HOMED_SEEN, axes: 'XYZ' });
        expect(changes.map((c) => c.how)).toEqual([HOMED_SEEN]);
    });

    it('a homing that leaves other axes unhomed goes back to alarm: not homed', () => {
        const { h } = tracker();
        h.onStatus('Alarm');
        h.onStatus('Home');
        h.onMessage('[MSG:Homed:Z]');
        h.onStatus('Alarm');
        expect(h.snapshot().homed).toBe(false);
    });

    it('the homed message alone is enough, if the status report missed the Home state', () => {
        const { h } = tracker();
        h.onStatus('Alarm');
        h.onMessage('[MSG:INFO: Homed:XYZ]'); // older FluidNC wording
        h.onStatus('Idle');
        expect(h.snapshot().how).toBe(HOMED_SEEN);
    });

    it('homing from the pendant while connected, after connecting out of alarm', () => {
        const { h } = tracker();
        h.onStatus('Idle');
        h.onStatus('Home');
        h.onStatus('Idle');
        expect(h.snapshot().how).toBe(HOMED_SEEN);
    });

    it('connected during a homing: settled when it ends', () => {
        const { h } = tracker();
        h.onStatus('Home');
        expect(h.snapshot().homed).toBe(false);
        h.onStatus('Idle');
        expect(h.snapshot().how).toBe(HOMED_SEEN);
    });

    it('alarms that lose the position', () => {
        [1, 6, 7, 8, 9, 12, 13, 14].forEach((code) => {
            const { h } = tracker();
            h.onStatus('Idle');
            h.onAlarm(code);
            expect(h.snapshot()).toEqual({ homed: false, how: null, axes: '' });
        });
        // soft limit, abort cycle, probe failures: FluidNC keeps the homed state
        [2, 3, 4, 5].forEach((code) => {
            const { h } = tracker();
            h.onStatus('Idle');
            h.onAlarm(code);
            expect(h.snapshot().homed).toBe(true);
        });
    });

    it('ignores other messages and empty states', () => {
        const { h, changes } = tracker();
        h.onMessage('[MSG:INFO: Connected]');
        h.onStatus('');
        h.onStatus(undefined);
        expect(changes).toEqual([]);
        expect(h.seenStatus).toBe(false);
    });
});
