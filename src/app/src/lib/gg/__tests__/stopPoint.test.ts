// GGSender: where the last job stopped (lib/gg/stopPoint.ts)
import { LAST_STOP_KEY, noteJobOver, noteSenderStatus, resetLiveJob, stopFor, stopPosition } from '../stopPoint';

const where = (x = 1, y = 2, z = -3, inches = false) => () => ({
    wpos: { x: String(x), y: String(y), z: String(z) },
    inches,
    fileName: 'job.nc',
});

describe('GGSender: stop point', () => {
    beforeEach(() => resetLiveJob());

    it('a job stopped early is kept, with the tool position', () => {
        const saved: Record<string, unknown> = {};
        noteSenderStatus({ name: 'job.nc', sent: 400, received: 380, total: 1001 });
        const r = noteJobOver(where(10.5, 20, -4.25), (k, v) => (saved[k] = v), () => 1234);
        expect(r).toEqual({ fileName: 'job.nc', total: 1001, received: 380, wpos: { x: 10.5, y: 20, z: -4.25 }, inches: false, at: 1234 });
        expect(saved[LAST_STOP_KEY]).toEqual(r);
    });

    it('a job that ran to its end clears it', () => {
        const saved: Record<string, unknown> = { [LAST_STOP_KEY]: { old: true } };
        noteSenderStatus({ name: 'job.nc', sent: 1001, received: 1000, total: 1001 }); // all but the %wait line
        expect(noteJobOver(where(), (k, v) => (saved[k] = v))).toBeNull();
        expect(saved[LAST_STOP_KEY]).toBeNull();
    });

    it('nothing ran (sender idle, or already noted): nothing changes', () => {
        const set = jest.fn();
        noteSenderStatus({ sent: 0, received: 0, total: 100 });
        expect(noteJobOver(where(), set)).toBeNull();
        noteSenderStatus({ name: 'a', sent: 10, received: 5, total: 100 });
        noteJobOver(where(), set);
        noteJobOver(where(), set); // a second idle
        expect(set).toHaveBeenCalledTimes(1);
    });

    it('matches the record to the loaded program, and converts units', () => {
        const r = { fileName: 'job.nc', total: 1001, received: 380, wpos: { x: 25.4, y: 0, z: -2.54 }, inches: false, at: 0 };
        expect(stopFor(r, 'job.nc', 1000)).toBe(r);
        expect(stopFor(r, 'other.nc', 1000)).toBeNull();
        expect(stopFor(r, 'job.nc', 900)).toBeNull();
        expect(stopFor({ ...r, fileName: '' }, 'job.nc', 1000)).toBeNull();
        expect(stopPosition(r, false)).toEqual({ x: 25.4, y: 0, z: -2.54 });
        const inch = stopPosition(r, true);
        expect(inch.x).toBeCloseTo(1);
        expect(inch.z).toBeCloseTo(-0.1);
    });
});
