/*
 * GGSender addition (not part of upstream gSender).
 *
 * The tool sensor reference, its state, and a history of what changed it.
 *
 * gSender's fixed-sensor tool change keeps one number: the work Z that a
 * tool tip reads on the sensor (global.toolchange.TOOL_OFFSET). The first
 * change of a job probes the tool in the spindle to get it; each later change
 * probes the new tool and writes the work Z zero so that it reads the same
 * (G10 L20 P0 Z[TOOL_OFFSET]). The number is correct only while the work Z
 * zero is the one it was probed with.
 *
 * States:
 * - valid: a reference exists and the work offset has not changed since,
 *   except by the wizard's own G10 L20 for a new tool.
 * - stale: a reference exists, but the work Z zero (or the work coordinate
 *   system) changed after it: set by hand, from a pendant, a touch plate,
 *   the console. Measuring a new tool against it would move Z wrongly.
 * - none: no reference since gSender connected (it is not kept across a
 *   reconnection, by the owner's choice).
 *
 * How a change of work offset is seen: FluidNC puts "WCO:" in a status report
 * after every change of a work offset (gc_wco_changed) and every 10 to 30
 * reports. gSender asks for a report about 4 times a second, so a change made
 * anywhere, the pendant included, is seen within about a second while
 * connected. The wizard's own G10 passes through gSender's feeder, so it is
 * told apart.
 *
 * It only observes; nothing here sends anything to the controller.
 */

export const REF_VALID = 'valid';
export const REF_STALE = 'stale';
export const REF_NONE = 'none';

const MAX_HISTORY = 40;
const EXPECT_MS = 8000; // the wizard's G10 shows in a report within this time
const SAME = 0.0005; // mm

const WIZARD_G10_RE = /G10\s*L20\s*P0\s*Z\s*\[\s*global\.toolchange\.TOOL_OFFSET\s*\]/i;
const WIZARD_REFERENCE_RE = /^%\s*global\.toolchange\.TOOL_OFFSET\s*=/i;
const WCO_RE = /WCO:\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)/;

const round3 = (n) => Math.round(n * 1000) / 1000;

export class ProbeHistory {
    constructor({ onChange = () => {}, now = Date.now } = {}) {
        this.onChange = onChange;
        this.now = now;
        this.reference = null; // { value, tool, at }
        this.status = REF_NONE;
        this.stale = null; // { kind: 'zero' | 'wcs', at, deltaZ }
        this.history = [];
        this.lastWcoZ = null;
        this.lastWcs = null;
        this.loadedTool = null;
        this.expect = null; // { until, tool }: the wizard's G10 for a new tool
        this.referencePending = false;
    }

    snapshot() {
        return {
            status: this.status,
            reference: this.reference ? { ...this.reference } : null,
            stale: this.stale ? { ...this.stale } : null,
            history: this.history.map((h) => ({ ...h })),
        };
    }

    changed() {
        this.onChange(this.snapshot());
    }

    add(entry) {
        this.history.push({ at: this.now(), ...entry });
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }
    }

    /** The tool gSender records as loaded (from the interface). */
    setLoadedTool(tool) {
        this.loadedTool = tool === null || tool === undefined || tool === '' ? null : String(tool);
    }

    /**
     * Every line of the feeder, before expressions are replaced.
     * @param target  the tool of the tool change in progress, if any
     */
    onFeederLine(raw, target = null) {
        const line = String(raw || '').trim();
        if (WIZARD_REFERENCE_RE.test(line)) {
            this.referencePending = true;
        }
        if (WIZARD_G10_RE.test(line)) {
            this.expect = { until: this.now() + EXPECT_MS, tool: target === null || target === undefined ? null : String(target) };
        }
    }

    /** The reference value, read after each line or report (sharedContext). */
    checkReference(value) {
        if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) {
            return;
        }
        const v = Number(value);
        if (!this.referencePending && this.reference && Math.abs(this.reference.value - v) < SAME) {
            return;
        }
        this.referencePending = false;
        this.reference = { value: round3(v), tool: this.loadedTool, at: this.now() };
        this.status = REF_VALID;
        this.stale = null;
        this.add({ kind: 'reference', tool: this.loadedTool, value: round3(v) });
        this.changed();
    }

    /** The work coordinate system in use (parser state). */
    onWcs(wcs) {
        const w = String(wcs || '');
        if (!w) {
            return;
        }
        if (this.lastWcs !== null && w !== this.lastWcs) {
            this.add({ kind: 'wcs', tool: this.loadedTool, from: this.lastWcs, to: w });
            if (this.reference) {
                this.status = REF_STALE;
                this.stale = { kind: 'wcs', at: this.now(), deltaZ: null };
            }
            this.changed();
        }
        this.lastWcs = w;
    }

    /** Every status report, as received. */
    onStatus(raw) {
        const m = WCO_RE.exec(String(raw || ''));
        if (!m) {
            return;
        }
        const z = Number(m[3]);
        if (!Number.isFinite(z)) {
            return;
        }
        if (this.lastWcoZ === null) {
            this.lastWcoZ = z;
            return;
        }
        const delta = z - this.lastWcoZ;
        this.lastWcoZ = z;
        if (Math.abs(delta) < SAME) {
            return;
        }
        // WCO is machine minus work: the work Z of a fixed point moves by -delta
        const deltaZ = round3(-delta);
        if (this.expect && this.now() <= this.expect.until) {
            this.add({ kind: 'measured', tool: this.expect.tool, deltaZ });
            this.expect = null;
            this.changed();
            return;
        }
        this.expect = null;
        this.add({ kind: 'zero', tool: this.loadedTool, deltaZ });
        if (this.reference) {
            this.status = REF_STALE;
            this.stale = { kind: 'zero', at: this.now(), deltaZ };
        }
        this.changed();
    }
}
