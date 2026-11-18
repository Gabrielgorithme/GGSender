/*
 * GGSender addition (not part of upstream gSender).
 *
 * Pre-flight checks that need more than the file: the machine's position and
 * settings, and gSender's tool change settings. Pure functions; the panel
 * feeds them the current values, so the result follows the machine (setting
 * a new zero updates the travel check at once).
 */
import { PreflightIssue, PreflightReport } from './preflight';
import { normalizeTool } from './loadedTool';
// Shared with the server, which applies the rules
import { parseFeedRules } from '../../../../server/lib/gg/feedRules.js';

type Axis = 'x' | 'y' | 'z';
const AXES: Axis[] = ['x', 'y', 'z'];

export interface TravelInput {
    hasHomed: boolean;
    maxTravel: { x: number | null; y: number | null; z: number | null }; // $130-$132, mm
    mpos: { x: number; y: number; z: number }; // mm
    wpos: { x: number; y: number; z: number }; // mm
}

export interface AxisTravel {
    axis: Axis;
    jobMin: number; // machine coordinates, mm
    jobMax: number;
    rangeMin: number;
    rangeMax: number;
    over: number; // mm beyond the range (0 when it fits)
    // The machine sits at 0 on this axis, so which side of 0 its travel is
    // on cannot be told from the position; true when the job is outside the
    // assumed side but would fit on the other one.
    ambiguous: boolean;
}

export interface TravelResult {
    status: 'ok' | 'outside' | 'unchecked';
    reason?: string; // when unchecked
    axes: AxisTravel[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Where the job will go in machine coordinates with the current work zero,
 * compared with the machine's travel.
 *
 * Machine range per axis: Grbl and a positively homed FluidNC axis use
 * [-travel, 0]. When the machine reports a clearly positive position on an
 * axis, that axis evidently runs [0, travel] instead. FluidNC homing an axis
 * to its low end also gives [0, travel], but right after homing the position
 * is 0 and says nothing; an excess there that would vanish with [0, travel]
 * is reported as ambiguous rather than as an error.
 */
export const checkTravel = (
    report: PreflightReport,
    input: TravelInput | null,
): TravelResult => {
    if (!input) {
        return { status: 'unchecked', reason: 'Not connected.', axes: [] };
    }
    if (!input.hasHomed) {
        return {
            status: 'unchecked',
            reason: 'The machine is not homed. The machine coordinates do not show where the limits are.',
            axes: [],
        };
    }
    if (report.usesA) {
        return { status: 'unchecked', reason: 'Rotary program.', axes: [] };
    }

    const axes: AxisTravel[] = [];
    let outside = false;
    let checked = 0;
    AXES.forEach((axis) => {
        const travel = input.maxTravel[axis];
        const min = report.bounds.min[axis];
        const max = report.bounds.max[axis];
        const mpos = Number(input.mpos[axis]);
        const wpos = Number(input.wpos[axis]);
        if (!finite(travel) || travel <= 0 || min === null || max === null || !finite(mpos) || !finite(wpos)) {
            return;
        }
        const offset = mpos - wpos;
        const positive = mpos > 0.5;
        const rangeMin = positive ? 0 : -travel;
        const rangeMax = positive ? travel : 0;
        const jobMin = min + offset;
        const jobMax = max + offset;
        const over = Math.max(0, rangeMin - jobMin, jobMax - rangeMax);
        let ambiguous = false;
        if (over > 0.0005) {
            const atZero = Math.abs(mpos) <= 0.5;
            const overOtherSide = Math.max(0, 0 - jobMin, jobMax - travel);
            if (atZero && !positive && overOtherSide <= 0.0005) {
                ambiguous = true;
            } else {
                outside = true;
            }
        }
        checked++;
        axes.push({
            axis,
            jobMin: round3(jobMin),
            jobMax: round3(jobMax),
            rangeMin: round3(rangeMin),
            rangeMax: round3(rangeMax),
            over: round3(over),
            ambiguous,
        });
    });

    if (checked === 0) {
        return {
            status: 'unchecked',
            reason: 'The controller did not report its travel ($130-$132).',
            axes,
        };
    }
    return { status: outside ? 'outside' : 'ok', axes };
};

export interface ContextInput {
    strategy: string; // workspace.toolChangeOption
    loadedTool: string | null;
    sendsToolNumbers: boolean; // passthrough or "send tool numbers" on
    spindleMax: number | null; // $30
    feedRules: string;
    travel: TravelResult;
    // homed state known only from the controller being out of alarm when
    // gSender connected (homed or unlocked with $X before)
    homedBeforeConnect?: boolean;
}

export const contextIssues = (
    report: PreflightReport,
    ctx: ContextInput,
): PreflightIssue[] => {
    const issues: PreflightIssue[] = [];
    const changes = report.sections.filter((s) => s.changeLine !== null);
    const firstChange = changes[0];

    // travel
    if (ctx.homedBeforeConnect && ctx.travel.status !== 'unchecked') {
        issues.push({
            severity: 'info',
            code: 'HOMED_BEFORE_CONNECT',
            message:
                'The controller was not in alarm when gSender connected. A homing cycle or $X removed the alarm before. The travel check is correct only after a homing cycle.',
        });
    }
    ctx.travel.axes
        .filter((a) => a.ambiguous)
        .forEach((a) => {
            const A = a.axis.toUpperCase();
            issues.push({
                severity: 'warning',
                code: `TRAVEL_${A}_AMBIGUOUS`,
                message: `The machine is at ${A}0. The check cannot know the direction of the ${A} travel from this position. If the travel is negative, the job goes ${a.over} mm past the limit. If the travel is positive, the job is in the travel.`,
            });
        });
    if (ctx.travel.status === 'outside') {
        ctx.travel.axes
            .filter((a) => a.over > 0 && !a.ambiguous)
            .forEach((a) => {
                const side = a.jobMax > a.rangeMax ? 'above' : 'below';
                const edge = side === 'above' ? a.rangeMax : a.rangeMin;
                issues.push({
                    severity: 'error',
                    code: `TRAVEL_${a.axis.toUpperCase()}`,
                    message: `With the current zero, ${a.axis.toUpperCase()} goes ${a.over} mm ${side} the travel of the machine (machine ${a.axis.toUpperCase()} ${side === 'above' ? a.jobMax : a.jobMin}, limit ${edge}).`,
                });
            });
    }

    // spindle
    if (finite(ctx.spindleMax) && ctx.spindleMax > 0 && finite(report.maxSpindle) && report.maxSpindle > ctx.spindleMax) {
        issues.push({
            severity: 'warning',
            code: 'SPINDLE_ABOVE_MAX',
            message: `The program uses S${report.maxSpindle}. The maximum of the controller ($30) is ${ctx.spindleMax}. The spindle turns at ${ctx.spindleMax}.`,
        });
    }

    // tool change handling
    if (report.toolChanges > 0) {
        if (ctx.strategy === 'Ignore') {
            issues.push({
                severity: 'warning',
                code: 'STRATEGY_IGNORE',
                message: `The program has ${report.toolChanges} tool change(s). The tool change strategy is "Ignore". gSender does not do these tool changes.`,
                line: firstChange?.changeLine ?? undefined,
            });
        }
        if (ctx.sendsToolNumbers) {
            const over = changes.find((s) => s.tool !== null && Number(s.tool) > 255);
            if (over) {
                issues.push({
                    severity: 'warning',
                    code: 'TOOL_NUMBER_SENT',
                    message: `T${over.tool} is above 255, and gSender sends tool numbers to the controller. Grbl-type firmware does not accept it (error:38).`,
                    line: over.changeLine ?? undefined,
                });
            }
        }
    }

    // loaded tool
    const loaded = normalizeTool(ctx.loadedTool);
    const cutsBefore = report.sections.find((s) => s.changeLine === null && s.cutMoves > 0);
    if (firstChange && firstChange.tool !== null && ctx.strategy !== 'Ignore') {
        if (loaded === null) {
            issues.push({
                severity: 'info',
                code: 'LOADED_UNKNOWN',
                message: `The program starts with a change to T${firstChange.tool}. The tool in the spindle is not known.`,
                line: firstChange.changeLine ?? undefined,
            });
        } else if (normalizeTool(firstChange.tool) === loaded) {
            issues.push({
                severity: 'info',
                code: 'LOADED_MATCHES',
                message: `The program starts with T${firstChange.tool}. The recorded tool in the spindle is also T${firstChange.tool}.`,
                line: firstChange.changeLine ?? undefined,
            });
        } else {
            issues.push({
                severity: 'info',
                code: 'LOADED_DIFFERS',
                message: `The recorded tool in the spindle is T${loaded}. The program changes to T${firstChange.tool} first.`,
                line: firstChange.changeLine ?? undefined,
            });
        }
    }
    if (cutsBefore && report.toolChanges > 0) {
        issues.push({
            severity: 'info',
            code: 'CUTS_WITH_LOADED',
            message: loaded === null
                ? 'The moves before the first tool change use the tool in the spindle. This tool is not known.'
                : `The moves before the first tool change use the tool in the spindle. The recorded tool is T${loaded}.`,
            line: cutsBefore.firstLine,
        });
    }

    // feed rules
    const { rules } = parseFeedRules(ctx.feedRules || '');
    if (rules.length > 0) {
        const fileTools = new Set(
            report.sections.map((s) => normalizeTool(s.tool)).filter((t) => t !== null),
        );
        const applies = rules.filter((r) => r.tool === '*' || fileTools.has(r.tool));
        const unused = rules.filter((r) => r.tool !== '*' && !fileTools.has(r.tool));
        if (applies.length > 0) {
            const tools = Array.from(new Set(applies.map((r) => (r.tool === '*' ? 'all tools' : `T${r.tool}`))));
            issues.push({
                severity: 'warning',
                code: 'FEED_RULES_ACTIVE',
                message: `${applies.length} feed/speed rule(s) change this program (${tools.join(', ')}).`,
            });
        }
        if (unused.length > 0) {
            issues.push({
                severity: 'info',
                code: 'FEED_RULES_UNUSED',
                message: `Feed/speed rules for tools that are not in this program: ${Array.from(new Set(unused.map((r) => `T${r.tool}`))).join(', ')}.`,
            });
        }
    }

    return issues;
};

const ORDER = { error: 0, warning: 1, info: 2 };

/** File issues and context issues together, most serious first. */
export const allIssues = (
    report: PreflightReport,
    ctx: ContextInput,
): PreflightIssue[] =>
    [...contextIssues(report, ctx), ...report.issues].sort(
        (a, b) => ORDER[a.severity] - ORDER[b.severity],
    );

export const countSerious = (issues: PreflightIssue[]) =>
    issues.filter((i) => i.severity !== 'info').length;
