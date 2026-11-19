/*
 * GGSender addition (not part of upstream gSender).
 *
 * The tool sensor reference, whether it can be trusted, and a history of
 * what changed it.
 *
 * What the reference is. gSender's tool sensor change keeps one number
 * (global.toolchange.TOOL_OFFSET): the work Z that a tool tip reads on the
 * sensor. With S the height at which the sensor triggers and P the height of
 * the work Z zero (both for a tool of length 0, in machine coordinates), a
 * tool of length L whose Z zero is correct reads (S + L) - (P + L) = S - P.
 * The length drops out: the reference is the height of the sensor above the
 * Z zero of the part, and any correctly zeroed tool gives the same number.
 * A new tool is "measured against it" by writing the work offset so that it
 * reads the same on the sensor (G10 L20 P0 Z[TOOL_OFFSET]); its tip is then
 * at Z0 where the old one was.
 *
 * So the number is correct exactly as long as the Z zero of the part is
 * where it was when the reference was probed. Setting Z zero again (by hand,
 * from a pendant, with a touch plate, by another work coordinate system)
 * moves P and leaves the number behind.
 *
 * How that is seen. The controller puts the work coordinate offset ("WCO:",
 * machine minus work) in some of its status reports. Grbl 1.1 does so right
 * after a change and every 10 to 30 reports. FluidNC 4.1 (the owner's
 * machine, seen in its traffic log) does so ONLY every 10th report when idle
 * and every 30th when moving, not after a change. gSender asks for a report
 * about 4 times a second, so a change made anywhere, the pendant included,
 * is seen 0 to 2.5 s later when idle and up to 7.5 s later when moving. The
 * state is a comparison, not a count of events:
 *
 * - valid: the WCO Z now is the WCO Z the reference goes with (as it was at
 *   the probe, or as the wizard's own G10 for the last new tool left it).
 * - stale: a reference exists and the WCO Z is another one. Putting the old
 *   offset back makes it valid again.
 * - none: no reference since gSender connected (it is not kept across a
 *   reconnection, by the owner's choice).
 *
 * The wizard's own G10 passes through gSender's feeder, so its change of the
 * WCO is told apart and becomes the new expected value. Because the report
 * that shows it can come seconds later, after the wizard has ended and the
 * program runs again, the G10 is not matched by time: it stays open until the
 * first report with a WCO that comes after the controller accepted the G10.
 * That report gives the offset the reference now goes with, changed or not.
 * (0.7.1 to 0.7.3 closed it at the end of the wizard or after 8 s; a later
 * report was then taken for a change made by the program, and a correct
 * reference was called not correct.)
 *
 * It only observes; nothing here sends anything to the controller.
 */

export const REF_VALID = 'valid';
export const REF_STALE = 'stale';
export const REF_NONE = 'none';

export const MAX_HISTORY = 30;
// the wizard's G10 was accepted and no report carried a WCO for this long:
// this controller has stopped reporting it, close the G10 as "no change"
const EXPECT_GIVE_UP_MS = 60000;
const MERGE_MS = 3000; // a WCS change and its WCO change belong together
const SAME = 0.0015; // mm: reports carry 3 decimals

const WIZARD_G10_RE = /G10\s*L20\s*P0\s*Z\s*\[\s*global\.toolchange\.TOOL_OFFSET\s*\]/i;
const WIZARD_REFERENCE_RE = /^%\s*global\.toolchange\.TOOL_OFFSET\s*=/i;
const WIZARD_DONE_RE = /^%toolchange_complete\b/i;
const WCO_RE = /WCO:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/;

const round3 = (n) => {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
};

const toolText = (tool) => {
    if (tool === null || tool === undefined || tool === '') {
        return null;
    }
    const m = /^t?\s*(\d+)$/i.exec(String(tool).trim());
    return m ? String(Number(m[1])) : null;
};

export const isReferenceLine = (line) => WIZARD_REFERENCE_RE.test(String(line || '').trim());

export class ProbeHistory {
    constructor({ onChange = () => {}, now = Date.now } = {}) {
        this.onChange = onChange;
        this.now = now;
        // { value, tool, at, wcs, wcoZ }: wcoZ is the WCO Z the value goes with
        this.reference = null;
        // the last tool probed, as the reference or against it
        this.lastProbe = null; // { kind: 'reference' | 'measured', tool, at }
        this.staleSince = null; // { kind, at, deltaZ }: the change that made it stale
        this.history = [];
        this.wcoZ = null;
        this.wcs = null;
        this.loadedTool = null;
        this.wizard = null; // { variant: 'reference' | 'full' | 'measure', target }
        // the wizard's G10 for a new tool, until a report shows its result:
        // { tool, ackedAt }: ackedAt is null until the controller accepted the line
        this.expect = null;
    }

    status() {
        if (!this.reference) {
            return REF_NONE;
        }
        if (this.wcoZ === null || this.reference.wcoZ === null) {
            return REF_VALID; // this controller does not report its work offset
        }
        return Math.abs(this.wcoZ - this.reference.wcoZ) < SAME ? REF_VALID : REF_STALE;
    }

    snapshot() {
        const status = this.status();
        return {
            status,
            reference: this.reference ? { ...this.reference } : null,
            lastProbe: this.lastProbe ? { ...this.lastProbe } : null,
            stale: status === REF_STALE && this.staleSince ? { ...this.staleSince } : null,
            // false: the controller does not report WCO, changes cannot be seen
            watching: this.wcoZ !== null,
            wcs: this.wcs,
            history: this.history.map((h) => ({ ...h })),
        };
    }

    changed() {
        this.onChange(this.snapshot());
    }

    add(entry) {
        const full = { at: this.now(), ...entry };
        this.history.push(full);
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }
        return full;
    }

    /** The tool gSender records as loaded (from the interface). */
    setLoadedTool(tool) {
        this.loadedTool = toolText(tool);
    }

    /**
     * The tool change wizard the interface is about to run (null: none).
     * 'reference': only measures the tool in the spindle, which is the tool
     * of the change; 'full': measures the tool in the spindle (the old one),
     * then the new one; 'measure': the new one against the reference.
     */
    setWizard(wizard) {
        if (!wizard || !['reference', 'full', 'measure'].includes(wizard.variant)) {
            this.wizard = null;
            return;
        }
        this.wizard = { variant: wizard.variant, target: toolText(wizard.target) };
    }

    /** Every line of the feeder, before expressions are replaced. */
    onFeederLine(raw) {
        const line = String(raw || '').trim();
        if (WIZARD_G10_RE.test(line)) {
            this.expect = { tool: this.wizard ? this.wizard.target : null, ackedAt: null };
            return;
        }
        // the feeder sends one line for each "ok": a line after the G10
        // means that the controller accepted the G10
        if (this.expect && this.expect.ackedAt === null) {
            this.expect.ackedAt = this.now();
        }
        if (WIZARD_DONE_RE.test(line)) {
            // the result of the G10 can still be on its way: only a
            // controller that reports no WCO at all is closed here
            if (this.wcoZ === null) {
                this.settleExpected();
            }
            this.wizard = null;
        }
    }

    /**
     * The wizard's G10 was accepted and the WCO is as before: the new tool
     * has the length of the old one, or the offset was already the right one.
     * After that G10 the reference goes with the WCO as it is now.
     */
    settleExpected() {
        if (!this.expect) {
            return;
        }
        const { tool } = this.expect;
        this.expect = null;
        this.measured(tool, 0);
    }

    measured(tool, deltaZ, wasStale = this.status() === REF_STALE) {
        if (this.reference) {
            this.reference.wcoZ = this.wcoZ;
        }
        this.staleSince = null;
        const entry = this.add({ kind: 'measured', tool, deltaZ });
        if (wasStale) {
            entry.oldReference = true; // measured against a reference that was stale
        }
        this.lastProbe = { kind: 'measured', tool, at: entry.at };
        this.changed();
    }

    /**
     * After "%global.toolchange.TOOL_OFFSET=posz" was evaluated: the tool in
     * the spindle was probed and is the reference now.
     * @param value  the work Z it reads on the sensor (mm)
     */
    onReferenceSet(value) {
        if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) {
            return;
        }
        const v = round3(Number(value));
        const tool = this.wizard && this.wizard.variant === 'reference' && this.wizard.target !== null
            ? this.wizard.target
            : this.loadedTool;
        const previous = this.reference;
        const at = this.now();
        this.reference = { value: v, tool, at, wcs: this.wcs, wcoZ: this.wcoZ };
        this.staleSince = null;
        this.expect = null;
        const entry = { kind: 'reference', at, tool, value: v };
        if (previous) {
            // the reference is the sensor's height above Z zero: when it gets
            // smaller, Z zero went up by the difference
            entry.zeroShift = round3(previous.value - v);
        }
        this.add(entry);
        this.lastProbe = { kind: 'reference', tool, at };
        this.changed();
    }

    /** The work coordinate system in use (parser state). */
    onWcs(wcs) {
        const w = String(Array.isArray(wcs) ? wcs[0] : wcs || '').toUpperCase();
        if (!/^G5[4-9](\.\d)?$/.test(w)) {
            return;
        }
        const from = this.wcs;
        this.wcs = w;
        if (from === null || from === w) {
            return;
        }
        // its change of WCO may have been seen already
        const last = this.history[this.history.length - 1];
        if (last && (last.kind === 'zero' || last.kind === 'program') && this.now() - last.at <= MERGE_MS) {
            last.kind = 'wcs';
            last.from = from;
            last.to = w;
            if (this.staleSince && this.staleSince.at === last.at) {
                this.staleSince.kind = 'wcs';
                this.staleSince.from = from;
                this.staleSince.to = w;
            }
        } else {
            this.add({ kind: 'wcs', tool: this.loadedTool, from, to: w, deltaZ: null });
        }
        this.changed();
    }

    /**
     * Every status report, as received.
     * @param inches      the controller reports in inches ($13=1)
     * @param jobRunning  program lines are being sent (the change is the program's)
     */
    onStatus(raw, { inches = false, jobRunning = false } = {}) {
        const m = WCO_RE.exec(String(raw || ''));
        if (!m) {
            if (this.expect && this.expect.ackedAt !== null && this.now() - this.expect.ackedAt > EXPECT_GIVE_UP_MS) {
                this.settleExpected();
            }
            return;
        }
        let z = Number(m[3]);
        if (!Number.isFinite(z)) {
            return;
        }
        if (inches) {
            z *= 25.4;
        }
        if (this.wcoZ === null) {
            this.wcoZ = z;
            if (this.reference && this.reference.wcoZ === null) {
                this.reference.wcoZ = z;
            }
            return;
        }
        const delta = z - this.wcoZ;
        if (Math.abs(delta) < SAME) {
            // the first WCO after the controller accepted the wizard's G10,
            // and it is the same: that is the result of the G10. (A report
            // before the "ok" can be from before the G10: it says nothing.)
            if (this.expect && this.expect.ackedAt !== null) {
                this.settleExpected();
            }
            return;
        }
        const before = this.status();
        this.wcoZ = z;
        // WCO is machine minus work: the work Z of a fixed point moves by -delta
        const deltaZ = round3(-delta);
        if (this.expect) {
            // the result of the wizard's G10, however late the report comes
            // and whatever runs by then
            const { tool } = this.expect;
            this.expect = null;
            this.measured(tool, deltaZ, before === REF_STALE);
            return;
        }
        const last = this.history[this.history.length - 1];
        let entry;
        if (last && last.kind === 'wcs' && last.deltaZ === null && this.now() - last.at <= MERGE_MS) {
            last.deltaZ = deltaZ;
            entry = last;
        } else {
            entry = this.add({ kind: jobRunning ? 'program' : 'zero', tool: this.loadedTool, deltaZ });
        }
        const now = this.status();
        if (now === REF_STALE) {
            // the latest change is the one shown
            this.staleSince = { kind: entry.kind, at: entry.at, deltaZ };
            if (entry.kind === 'wcs') {
                this.staleSince.from = entry.from;
                this.staleSince.to = entry.to;
            }
        } else if (now === REF_VALID) {
            this.staleSince = null;
            if (before === REF_STALE) {
                entry.restored = true; // the offset the reference goes with is back
            }
        }
        this.changed();
    }
}
