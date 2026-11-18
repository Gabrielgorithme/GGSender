// GGSender: the tool sensor reference and its history (lib/gg/probeHistory.js)
import { MAX_HISTORY, ProbeHistory, REF_NONE, REF_STALE, REF_VALID, isReferenceLine } from '../probeHistory';

/*
 * A small machine to check the signs against: the sensor triggers at machine
 * Z = S + L for a tool of length L; the part's surface is reached at machine
 * Z = P + L. Work Z = machine Z - WCO.
 */
class Machine {
    constructor({ S = -60, P = -45 } = {}) {
        this.S = S;
        this.P = P;
        this.L = 0; // tool in the spindle
        this.wco = 0;
    }

    report(state = 'Idle') {
        return `<${state}|MPos:0.000,0.000,-1.000|FS:0,0|WCO:10.000,20.000,${this.wco.toFixed(3)}>`;
    }

    /** Work Z the tool in the spindle reads on the sensor. */
    onSensor() {
        return this.S + this.L - this.wco;
    }

    /** Z zero set by hand: tool tip on a surface at height `surface`. */
    zeroByHand(surface = this.P) {
        this.wco = surface + this.L;
    }

    /** The wizard's G10 L20 P0 Z[reference], tool on the sensor. */
    g10(reference) {
        this.wco = this.S + this.L - reference;
    }

    /** Machine height of work Z 0 for the tool in the spindle, less its length: the Z zero of the part. */
    zeroPlane() {
        return this.wco - this.L;
    }
}

const WIZARD_G10 = 'G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]';
const REFERENCE_LINE = '%global.toolchange.TOOL_OFFSET=posz';

const setup = () => {
    const clock = { t: 1_000_000 };
    const changes = [];
    const h = new ProbeHistory({ now: () => clock.t, onChange: (s) => changes.push(s) });
    const m = new Machine();
    const tick = (ms = 250, opts) => {
        clock.t += ms;
        h.onStatus(m.report(), opts);
    };
    /** What the wizard does: probe the tool in the spindle as the reference. */
    const probeReference = () => {
        expect(isReferenceLine(REFERENCE_LINE)).toBe(true);
        h.onFeederLine(REFERENCE_LINE);
        h.onReferenceSet(m.onSensor().toFixed(3));
        tick();
    };
    /** What the wizard does for a new tool of length L. */
    const measureNewTool = (L) => {
        m.L = L;
        h.onFeederLine(WIZARD_G10);
        m.g10(h.snapshot().reference.value);
        tick();
        h.onFeederLine('%toolchange_complete');
    };
    return { clock, changes, h, m, tick, probeReference, measureNewTool };
};

describe('GGSender: tool sensor reference', () => {
    it('starts with no reference; reports alone change nothing', () => {
        const { h, changes, tick } = setup();
        tick();
        tick();
        expect(h.snapshot()).toMatchObject({ status: REF_NONE, reference: null, lastProbe: null, stale: null, watching: true, history: [] });
        expect(changes).toHaveLength(0);
    });

    it('a probed tool is the reference: valid, with the loaded tool and the time', () => {
        const { h, m, clock, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        h.setLoadedTool('T45');
        probeReference();
        const s = h.snapshot();
        expect(s.status).toBe(REF_VALID);
        // the sensor's height above the Z zero of the part, whatever the tool
        expect(s.reference.value).toBeCloseTo(m.S - m.P, 3);
        expect(s.reference).toMatchObject({ tool: '45', wcoZ: m.wco });
        expect(s.reference.at).toBeLessThanOrEqual(clock.t);
        expect(s.lastProbe).toMatchObject({ kind: 'reference', tool: '45' });
        expect(s.history.map((e) => e.kind)).toEqual(['reference']);
        expect(s.history[0].zeroShift).toBeUndefined(); // no reference before it
    });

    it('the "measure only" wizard names the tool of the change, not the recorded one', () => {
        const { h, probeReference } = setup();
        h.setLoadedTool(null);
        h.setWizard({ variant: 'reference', target: 'T20' });
        probeReference();
        expect(h.snapshot().reference.tool).toBe('20');
        // the full wizard measures the old tool first
        h.setLoadedTool('45');
        h.setWizard({ variant: 'full', target: 'T7' });
        probeReference();
        expect(h.snapshot().reference.tool).toBe('45');
    });

    it("the wizard's own G10 for a new tool keeps the reference valid and the Z zero of the part in place", () => {
        const { h, m, tick, probeReference, measureNewTool } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        h.setLoadedTool('45');
        probeReference();
        const plane = m.zeroPlane();
        h.setWizard({ variant: 'measure', target: 'T20' });
        measureNewTool(42.5);
        const s = h.snapshot();
        expect(s.status).toBe(REF_VALID);
        expect(m.zeroPlane()).toBeCloseTo(plane, 6);
        expect(s.reference.tool).toBe('45'); // the reference stays the tool it was probed with
        expect(s.lastProbe).toMatchObject({ kind: 'measured', tool: '20' });
        const last = s.history[s.history.length - 1];
        // a longer tool: its work Z went down by the difference of length
        expect(last).toMatchObject({ kind: 'measured', tool: '20', deltaZ: -12.5 });
        expect(last.oldReference).toBeUndefined();
        // and a third tool
        h.setWizard({ variant: 'measure', target: 'T7' });
        measureNewTool(25);
        expect(h.snapshot().status).toBe(REF_VALID);
        expect(m.zeroPlane()).toBeCloseTo(plane, 6);
    });

    it('a Z zero set from the pendant (no line through gSender) makes it stale within one report', () => {
        const { h, m, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        h.setLoadedTool('45');
        probeReference();
        // broken bit: a new tool of another length, Z zero set by hand again
        m.L = 38;
        m.zeroByHand(m.P + 0.12);
        tick();
        const s = h.snapshot();
        expect(s.status).toBe(REF_STALE);
        expect(s.stale).toMatchObject({ kind: 'zero' });
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'zero', tool: '45' });
        expect(s.reference.tool).toBe('45'); // still shown, as the old one
    });

    it('measuring the hand-zeroed tool as the new reference: valid again, Z zero not moved, and the shift is reported', () => {
        const { h, m, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        h.setLoadedTool('45');
        probeReference();
        m.L = 38;
        m.zeroByHand(m.P + 0.12); // touched off 0.12 mm higher than the first time
        tick();
        const wco = m.wco;
        h.setWizard({ variant: 'reference', target: 'T45' });
        probeReference();
        const s = h.snapshot();
        expect(s.status).toBe(REF_VALID);
        expect(m.wco).toBe(wco); // nothing wrote the offset
        const last = s.history[s.history.length - 1];
        expect(last).toMatchObject({ kind: 'reference', tool: '45' });
        expect(last.zeroShift).toBeCloseTo(0.12, 3); // Z zero is 0.12 higher than the old reference has it
        // the next tool is set against the new reference: the hand-set plane is kept
        const plane = m.zeroPlane();
        h.setWizard({ variant: 'measure', target: 'T20' });
        m.L = 50;
        h.onFeederLine(WIZARD_G10);
        m.g10(s.reference.value);
        tick();
        expect(m.zeroPlane()).toBeCloseTo(plane, 6);
        expect(h.snapshot().status).toBe(REF_VALID);
    });

    it('what went wrong in 0.7.0: the old reference used after a hand zero puts Z zero back where it was', () => {
        const { h, m, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        probeReference();
        const oldPlane = m.zeroPlane();
        m.L = 38;
        m.zeroByHand(m.P + 0.12);
        tick();
        expect(h.snapshot().status).toBe(REF_STALE);
        // "use the old reference"
        h.setWizard({ variant: 'measure', target: 'T45' });
        h.onFeederLine(WIZARD_G10);
        m.g10(h.snapshot().reference.value);
        tick();
        const s = h.snapshot();
        expect(m.zeroPlane()).toBeCloseTo(oldPlane, 6); // the hand-set zero is gone
        expect(s.status).toBe(REF_VALID); // and the reference goes with the offset again
        const last = s.history[s.history.length - 1];
        expect(last).toMatchObject({ kind: 'measured', tool: '45', oldReference: true });
        expect(last.deltaZ).toBeCloseTo(0.12, 3);
    });

    it('putting the same offset back makes the reference valid again', () => {
        const { h, m, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        probeReference();
        const wco = m.wco;
        m.wco = wco + 5;
        tick();
        expect(h.snapshot().status).toBe(REF_STALE);
        m.wco = wco;
        tick();
        const s = h.snapshot();
        expect(s.status).toBe(REF_VALID);
        expect(s.stale).toBeNull();
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'zero', restored: true });
    });

    it('a second change while stale: the latest is the one shown', () => {
        const { h, m, clock, tick, probeReference } = setup();
        tick();
        probeReference();
        m.wco += 1;
        tick();
        const first = h.snapshot().stale.at;
        m.wco += 1;
        tick(60000);
        expect(h.snapshot().stale.at).toBe(clock.t);
        expect(h.snapshot().stale.at).toBeGreaterThan(first);
    });

    it('a new tool of the same length: no change of offset, recorded when the wizard ends', () => {
        const { h, m, tick, probeReference } = setup();
        m.L = 30;
        m.zeroByHand();
        tick();
        probeReference();
        h.setWizard({ variant: 'measure', target: 'T20' });
        h.onFeederLine(WIZARD_G10);
        m.g10(h.snapshot().reference.value); // same length: the offset is the same
        tick();
        tick();
        expect(h.snapshot().history.filter((e) => e.kind === 'measured')).toHaveLength(0);
        h.onFeederLine('%toolchange_complete');
        const s = h.snapshot();
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'measured', tool: '20', deltaZ: 0 });
        expect(s.lastProbe).toMatchObject({ kind: 'measured', tool: '20' });
        // a change after the wizard has ended is not the wizard's
        m.wco += 2;
        tick();
        expect(h.snapshot().status).toBe(REF_STALE);
    });

    it("a change long after the wizard's G10 is not taken for the wizard's", () => {
        const { h, m, tick, probeReference } = setup();
        tick();
        probeReference();
        h.setWizard({ variant: 'measure', target: 'T20' });
        h.onFeederLine(WIZARD_G10);
        tick(9000); // no change within the window: settled as "same length"
        expect(h.snapshot().lastProbe).toMatchObject({ kind: 'measured', tool: '20' });
        m.wco += 3;
        tick();
        const s = h.snapshot();
        expect(s.status).toBe(REF_STALE);
        expect(s.history[s.history.length - 1].kind).toBe('zero');
    });

    it('other G10 lines through the feeder (Zero button, touch plate) are a Z zero by hand', () => {
        const { h, m, tick, probeReference } = setup();
        tick();
        probeReference();
        h.onFeederLine('G10 L20 P0 Z0');
        m.wco -= 7.5;
        tick();
        const s = h.snapshot();
        expect(s.status).toBe(REF_STALE);
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'zero', deltaZ: 7.5 });
    });

    it('the Flexible Re-zero wizard writes the same G10 with a units word before it', () => {
        const { h, m, tick, probeReference } = setup();
        tick();
        probeReference();
        h.onFeederLine('[global.toolchange.UNITS] G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]');
        m.wco += 4;
        tick();
        expect(h.snapshot().status).toBe(REF_VALID);
    });

    it('a change of work coordinate system: stale, named as such, in either order of arrival', () => {
        const a = setup();
        a.h.onWcs('G54');
        a.tick();
        a.probeReference();
        expect(a.h.snapshot().reference.wcs).toBe('G54');
        // the offset first, the parser state after
        a.m.wco -= 20;
        a.tick();
        a.h.onWcs('G55');
        let s = a.h.snapshot();
        expect(s.status).toBe(REF_STALE);
        expect(s.stale).toMatchObject({ kind: 'wcs', from: 'G54', to: 'G55' });
        expect(s.history.filter((e) => e.kind === 'wcs')).toHaveLength(1);
        expect(s.history.filter((e) => e.kind === 'zero')).toHaveLength(0);
        // back to G54: valid again
        a.m.wco += 20;
        a.h.onWcs('G54');
        a.tick();
        s = a.h.snapshot();
        expect(s.status).toBe(REF_VALID);
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'wcs', from: 'G55', to: 'G54', deltaZ: -20, restored: true });

        // the parser state first, the offset after
        const b = setup();
        b.h.onWcs('G54');
        b.tick();
        b.probeReference();
        b.h.onWcs('G56');
        b.m.wco += 3;
        b.tick();
        s = b.h.snapshot();
        expect(s.stale).toMatchObject({ kind: 'wcs', from: 'G54', to: 'G56' });
        expect(s.history.filter((e) => e.kind === 'wcs')).toHaveLength(1);
    });

    it('a work coordinate system with the same Z offset leaves the reference valid', () => {
        const { h, tick, probeReference } = setup();
        h.onWcs('G54');
        tick();
        probeReference();
        h.onWcs('G55');
        tick();
        expect(h.snapshot().status).toBe(REF_VALID);
    });

    it('a change while program lines are sent is the program\'s', () => {
        const { h, m, tick, probeReference } = setup();
        tick();
        probeReference();
        m.wco += 1.5; // G43.1 or G10 in the program
        tick(250, { jobRunning: true });
        const s = h.snapshot();
        expect(s.status).toBe(REF_STALE);
        expect(s.stale.kind).toBe('program');
    });

    it('reports in inches are read in millimetres', () => {
        const { h, clock } = setup();
        const report = (z) => `<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.0000,0.0000,${z.toFixed(4)}>`;
        h.onStatus(report(-1), { inches: true });
        h.onReferenceSet('-10.000');
        clock.t += 250;
        h.onStatus(report(-1.5), { inches: true });
        const s = h.snapshot();
        expect(s.history[s.history.length - 1]).toMatchObject({ kind: 'zero', deltaZ: 12.7 });
    });

    it('rounding noise in the reports is not a change', () => {
        const { h, m, tick, probeReference } = setup();
        tick();
        probeReference();
        m.wco += 0.001;
        tick();
        expect(h.snapshot().status).toBe(REF_VALID);
        m.wco += 0.002;
        tick();
        expect(h.snapshot().status).toBe(REF_STALE);
    });

    it('a controller that does not report its work offset: the reference counts as valid, marked as not watched', () => {
        const h = new ProbeHistory();
        h.onStatus('<Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>');
        h.onReferenceSet(-12.5);
        expect(h.snapshot()).toMatchObject({ status: REF_VALID, watching: false });
    });

    it('ignores a reference that is not a number, and keeps the history short', () => {
        const { h, m, tick } = setup();
        h.onReferenceSet(undefined);
        h.onReferenceSet('');
        h.onReferenceSet('abc');
        expect(h.snapshot().status).toBe(REF_NONE);
        tick();
        for (let i = 0; i < MAX_HISTORY + 12; i++) {
            m.wco += 1;
            tick();
        }
        expect(h.snapshot().history).toHaveLength(MAX_HISTORY);
    });

    it('tells every change to the listener, with a copy', () => {
        const { h, changes, tick, probeReference } = setup();
        tick();
        probeReference();
        expect(changes).toHaveLength(1);
        changes[0].history.push('x');
        changes[0].reference.value = 999;
        expect(h.snapshot().history).toHaveLength(1);
        expect(h.snapshot().reference.value).not.toBe(999);
    });
});
