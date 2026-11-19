/*
 * GGSender addition (not part of upstream gSender).
 *
 * "Resume From": the button and dialog that replace upstream's "Start From"
 * (setting "Resume from a line", workspace.gg.resumeFromLine). The plan is
 * made in lib/gg/resumePlan.ts and shown in full before anything moves: the
 * line, its operation and tool, where the tool will come down, and every
 * entry line that will be sent. The server swaps the entry lines in and
 * starts the job (src/server/lib/gg/resumeSplice.js).
 */
import { JSX, useEffect, useMemo, useState } from 'react';
import cx from 'classnames';
import pubsub from 'pubsub-js';
import { MdFormatListNumbered } from 'react-icons/md';

import { Button as ShadButton } from 'app/components/shadcn/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'app/components/shadcn/Dialog';
import controller from 'app/lib/controller';
import { toast } from 'app/lib/toaster';
import { useTypedSelector } from 'app/hooks/useTypedSelector';
import { findToolSpec } from 'app/lib/gg/jobOperations';
import { toolSummary } from 'app/lib/gg/toolSpec';
import { getLoadedTool, normalizeTool, setLoadedTool } from 'app/lib/gg/loadedTool';
import { useReference } from 'app/lib/gg/probeStore';
import { clock, referenceId, toolName } from 'app/lib/gg/referenceText';
import {
    DEFAULT_SAME_TOOL_PROBE,
    ReferenceSource,
    SameToolProbe,
    ToolChoice,
    defaultChoice,
    sameToolAsks,
    sourcesFor,
    toolModeFor,
} from 'app/lib/gg/resumeToolChoice';
import { spinupSeconds } from 'app/lib/gg/holdSettings';
import { getToolChangeSafeZ } from 'app/lib/gg/toolChangeMoves';
import {
    ResumePlan,
    hasNWords,
    indexLines,
    nearestMove,
    nWordOf,
    planResume,
    resolveQuery,
    resumePayload,
} from 'app/lib/gg/resumePlan';
import { getStopRecord, stopFor, stopPosition } from 'app/lib/gg/stopPoint';
import store from 'app/store';
import { useJobInfo } from './JobOperations';
import { getCurrentPick } from './pickTopics';
import { ReferenceStatus } from './ReferenceStatus';

export const RESUME_SETTING_KEY = 'workspace.gg.resumeFromLine';

type AtcValidator = () => [boolean, { type: string; title: string; body: JSX.Element }];

interface Props {
    disabled: boolean;
    atcValidator?: AtcValidator;
}

// a stop position further than this from the matched move is suspect
const FAR_FROM_PATH = { mm: 0.5, in: 0.02 };

const num = (s: string): number | null => {
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

/** The move the tool was on when the job last stopped, for this program. */
export const suggestedLine = (content: string, fileName: string, programLines: number) => {
    const record = stopFor(getStopRecord(), fileName, programLines);
    if (!record || !content) return null;
    const inches = /G20(?![0-9])/.test(content.slice(0, 20000)) && !/G21(?![0-9])/.test(content.slice(0, 20000));
    const pos = stopPosition(record, inches);
    const near = nearestMove(content, pos, Math.max(0, record.received - 300), record.received + 1);
    return near ? { ...near, record } : null;
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</div>
        {children}
    </div>
);

export const ResumeDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const content = useTypedSelector((s) => (s as any).file?.content ?? '') as string;
    const fileName = useTypedSelector((s) => (s as any).file?.name ?? '') as string;
    const entry = useJobInfo();
    const info = entry?.info ?? null;
    const idx = useMemo(() => indexLines(content), [content]);
    const usesN = useMemo(() => hasNWords(content), [content]);

    const [query, setQuery] = useState('');
    const [toolChoice, setToolChoice] = useState<ToolChoice | null>(null); // null: the default
    const [source, setSource] = useState<ReferenceSource | null>(null);
    const [sameToolProbe, setSameToolProbe] = useState<SameToolProbe>(DEFAULT_SAME_TOOL_PROBE);
    const reference = useReference();
    const [rapidDownTo, setRapidDownTo] = useState('');
    const [plungeFeed, setPlungeFeed] = useState('');
    const [spinup, setSpinup] = useState(() => String(spinupSeconds((k, d) => store.get(k, d))));

    const suggestion = useMemo(
        () => (open ? suggestedLine(content, fileName, idx.total) : null),
        [open, content, fileName, idx.total],
    );

    // the line selected in the 3D view when the dialog opens (0-based), or null
    const selectedLine = useMemo(() => {
        const pick = open ? getCurrentPick() : null;
        return pick && pick.line >= 0 && pick.line < idx.lines.length ? pick.line : null;
    }, [open, idx]);
    /** What goes in the line field for a file line: its N number, or L + line. */
    const queryFor = (line: number) => {
        const raw = idx.lines[line];
        return usesN && nWordOf(raw) ? (nWordOf(raw) as string) : `L${line + 1}`;
    };

    // on opening: start from the stop point (without one: from the line
    // selected in the 3D view), ask the server for the tool sensor reference
    useEffect(() => {
        if (!open) return undefined;
        setToolChoice(null);
        setSource(null);
        setSameToolProbe(DEFAULT_SAME_TOOL_PROBE);
        setRapidDownTo('');
        setPlungeFeed('');
        if (suggestion) {
            setQuery(queryFor(suggestion.line));
        } else if (selectedLine !== null) {
            setQuery(queryFor(selectedLine));
        }
        const onError = (message: string) => toast.error(`Resume refused: ${message}`, { position: 'bottom-right' });
        controller.addListener('gg:resume:error', onError);
        controller.command('gg:probe:query');
        return () => {
            controller.removeListener('gg:resume:error', onError);
        };
        // only on opening
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const resolved = useMemo(() => (query.trim() ? resolveQuery(content, query) : null), [content, query]);
    const loaded = normalizeTool(getLoadedTool().tool);

    // the tool of the line, then the tool choice: the default follows the
    // reference and the recorded tool until the owner selects one
    const kept: ResumePlan | null = useMemo(() => {
        if (!resolved || resolved.line === null) return null;
        return planResume(content, info, resolved.line, {
            safeZ: Number(getToolChangeSafeZ()),
            spinupSeconds: num(spinup) ?? 0,
            rapidDownTo: num(rapidDownTo),
            plungeFeed: num(plungeFeed),
            measureTool: false,
        });
    }, [content, info, resolved, spinup, rapidDownTo, plungeFeed]);
    const lineTool = kept ? kept.state.tool ?? kept.state.nextTool : null;
    const choice = toolChoice ?? defaultChoice(reference.status, loaded, normalizeTool(lineTool));
    const sources = sourcesFor(reference.status);
    const toolMode = toolModeFor(choice, sources.includes(source as ReferenceSource) ? source : null, reference.status, sameToolProbe);
    // choice 1 with no correct reference: measure the tool first, or not
    const asksSameTool = choice === 1 && sameToolAsks(reference.status);
    // the entry lines have a tool change (it starts the measurement)
    const measuring = choice === 2 || choice === 3 || toolMode === 'reference-same';

    const plan: ResumePlan | null = useMemo(() => {
        if (!kept || !measuring || !resolved || resolved.line === null) return kept;
        return planResume(content, info, resolved.line, {
            safeZ: Number(getToolChangeSafeZ()),
            spinupSeconds: num(spinup) ?? 0,
            rapidDownTo: num(rapidDownTo),
            plungeFeed: num(plungeFeed),
            measureTool: true,
        });
    }, [kept, measuring, content, info, resolved, spinup, rapidDownTo, plungeFeed]);
    const spec = lineTool ? findToolSpec(info, lineTool) : null;
    const unit = plan?.state.units === 'G20' ? 'in' : 'mm';
    const fmt = (v: number | null) => (v === null ? '?' : String(Number(v.toFixed(4))));
    const beyondStop = plan && suggestion && plan.seq > suggestion.seq;

    // "T45", or words when the program selects no tool before the line
    const lineT = lineTool !== null ? toolName(lineTool) : 'the tool of this line';
    const LineT = lineTool !== null ? lineT : 'The tool of this line';
    const refId = referenceId(reference);
    const refTime = clock(reference.reference?.at);
    const staleTime = clock(reference.stale?.at);

    const resume = () => {
        if (!plan || !plan.ok || toolMode === null) return;
        if (choice === 1 && normalizeTool(lineTool) !== null && normalizeTool(lineTool) !== loaded) {
            // choice 1 says that the line's tool is in the spindle
            setLoadedTool(lineTool);
        }
        controller.command('gg:resume:start', resumePayload(plan, idx.total, toolMode));
        toast.info(`Resume from ${plan.nWord ?? `line ${plan.line + 1}`}`, { position: 'bottom-right' });
        onClose();
    };

    const context = plan
        ? [-2, -1, 0, 1, 2]
              .map((d) => plan.line + d)
              .filter((i) => i >= 0 && i < idx.lines.length)
              .map((i) => ({ i, text: idx.lines[i].replace(/\r$/, ''), here: i === plan.line }))
        : [];

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="bg-white w-[44rem] max-w-[95vw] max-h-[92vh] overflow-y-auto gap-3" data-testid="gg-resume-dialog">
                <DialogHeader>
                    <DialogTitle>Resume from a line</DialogTitle>
                </DialogHeader>

                <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{usesN ? 'N number (or L + file line)' : 'File line'}</span>
                        <input
                            className="w-44 rounded border border-gray-300 px-2 py-1 font-mono text-base dark:border-gray-600 dark:bg-dark"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={usesN ? 'N60005' : '1234'}
                            data-testid="gg-resume-query"
                            autoFocus
                        />
                    </label>
                    {suggestion && (
                        <button
                            type="button"
                            className="rounded border border-blue-400 px-2 py-1 text-sm text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-white/5"
                            onClick={() => setQuery(queryFor(suggestion.line))}
                            data-testid="gg-resume-where-stopped"
                        >
                            Where it stopped
                        </button>
                    )}
                    {selectedLine !== null && (
                        <button
                            type="button"
                            className="rounded border border-pink-400 px-2 py-1 text-sm text-pink-700 hover:bg-pink-50 dark:text-pink-300 dark:hover:bg-white/5"
                            onClick={() => setQuery(queryFor(selectedLine))}
                            title="The line that you selected in the 3D view"
                            data-testid="gg-resume-selected-line"
                        >
                            Selected line ({nWordOf(idx.lines[selectedLine]) ?? `line ${selectedLine + 1}`})
                        </button>
                    )}
                    {info && info.operations.length > 0 && (
                        <select
                            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-dark"
                            value=""
                            onChange={(e) => {
                                const op = info.operations[Number(e.target.value)];
                                if (op?.firstMotionLine !== null && op?.firstMotionLine !== undefined) {
                                    setQuery(queryFor(op.firstMotionLine));
                                }
                            }}
                            data-testid="gg-resume-operation"
                        >
                            <option value="">Start of an operation…</option>
                            {info.operations.map((op) => (
                                <option key={op.index} value={op.index} disabled={op.firstMotionLine === null}>
                                    {op.name}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
                {suggestion && (
                    <div className="text-xs text-gray-600 dark:text-gray-300" data-testid="gg-resume-stop-note">
                        The last job stopped with the tool {fmt(suggestion.distance)} {unit} from{' '}
                        {nWordOf(idx.lines[suggestion.line]) ?? `line ${suggestion.line + 1}`}. A resume at this line does
                        that move again. The machine is always behind the line count of gSender
                        ({suggestion.record.received} lines).
                        {suggestion.distance > FAR_FROM_PATH[unit] && (
                            <span className="block font-semibold text-amber-600 dark:text-amber-400" data-testid="gg-resume-stop-far">
                                This distance is large. The machine possibly moved after the stop, or its position is lost.
                                Make sure that the line is correct before you resume.
                            </span>
                        )}
                    </div>
                )}
                {resolved?.error && <div className="text-sm text-red-600">{resolved.error}</div>}
                {resolved && resolved.matches.length > 1 && (
                    <div className="text-sm text-amber-600">This N number is on {resolved.matches.length} lines. Resume From uses the first line.</div>
                )}

                {plan && (
                    <>
                        <Section title="Line">
                            <pre className="m-0 rounded bg-gray-100 p-2 text-xs leading-5 dark:bg-black/30" data-testid="gg-resume-context">
                                {context.map((c) => (
                                    <div key={c.i} className={cx({ 'font-bold text-blue-700 dark:text-blue-300': c.here })}>
                                        {c.here ? '▶ ' : '  '}
                                        {c.text}
                                    </div>
                                ))}
                            </pre>
                            <div className="text-sm">
                                {plan.operation ? (
                                    <>
                                        In <b>{plan.operation.name}</b>
                                    </>
                                ) : (
                                    'Not in a named operation'
                                )}
                                {lineTool && (
                                    <>
                                        {' '}
                                        · tool <b>T{lineTool}</b>
                                        {spec ? ` (${toolSummary(spec)})` : ''}
                                    </>
                                )}
                                {' '}· starts from X{fmt(plan.start.x)} Y{fmt(plan.start.y)} Z{fmt(plan.start.z)}
                            </div>
                        </Section>

                        <Section title="Tool and Z zero">
                            <div
                                className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-white/10 dark:bg-black/20"
                                data-testid="gg-resume-reference"
                            >
                                <ReferenceStatus snapshot={reference} />
                            </div>
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    className="mt-1"
                                    checked={choice === 1}
                                    onChange={() => setToolChoice(1)}
                                    data-testid="gg-resume-tool-keep"
                                />
                                <span>
                                    <b>1. Same tool. Z zero did not change.</b>
                                    <span className="block text-xs text-gray-600 dark:text-gray-300">
                                        {LineT} is in the spindle.
                                        {reference.status === 'valid' && ' gSender measures nothing. The reference stays correct.'}
                                        {loaded !== normalizeTool(lineTool) && lineTool !== null && (
                                            <span className="text-amber-700 dark:text-amber-400">
                                                {' '}
                                                gSender recorded {toolName(loaded)} in the spindle. Make sure that {lineT} is in the
                                                spindle.
                                            </span>
                                        )}
                                        {reference.status === 'none' && ' gSender has no reference.'}
                                        {reference.status === 'stale' && (
                                            <span className="text-amber-700 dark:text-amber-400">
                                                {' '}
                                                gSender saw a change of Z zero at {staleTime}. The reference is not correct now.
                                            </span>
                                        )}
                                    </span>
                                </span>
                            </label>
                            {asksSameTool && (
                                <div
                                    className="ml-6 flex flex-col gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1.5 text-sm dark:border-sky-800 dark:bg-sky-950/30"
                                    data-testid="gg-resume-same-tool"
                                >
                                    <label className="flex items-start gap-2">
                                        <input
                                            type="radio"
                                            className="mt-1"
                                            checked={sameToolProbe === 'measure'}
                                            onChange={() => setSameToolProbe('measure')}
                                            data-testid="gg-resume-same-tool-measure"
                                        />
                                        <span>
                                            <b>Measure {lineT} first.</b> gSender measures it on the tool sensor before the job
                                            continues. It becomes the reference. Z zero does not change. If this tool breaks later,
                                            gSender can measure the new tool against the reference.
                                        </span>
                                    </label>
                                    <label className="flex items-start gap-2">
                                        <input
                                            type="radio"
                                            className="mt-1"
                                            checked={sameToolProbe === 'skip'}
                                            onChange={() => setSameToolProbe('skip')}
                                            data-testid="gg-resume-same-tool-skip"
                                        />
                                        <span>
                                            <b>Do not measure.</b> The job continues at once. At the next tool change, gSender first
                                            measures the tool in the spindle. If this tool breaks before that, you must set Z zero by
                                            hand.
                                        </span>
                                    </label>
                                </div>
                            )}
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    className="mt-1"
                                    checked={choice === 2}
                                    onChange={() => setToolChoice(2)}
                                    data-testid="gg-resume-tool-measure"
                                />
                                <span>
                                    <b>2. New or refitted tool. Z zero did not change.</b>
                                    <span className="block text-xs text-gray-600 dark:text-gray-300">
                                        {reference.status === 'valid' &&
                                            `You fit ${lineT}. gSender measures it against the reference (${refId}). Z zero stays at the same position on the part.`}
                                        {reference.status === 'stale' && (
                                            <span className="text-amber-700 dark:text-amber-400">
                                                The reference is not correct now: Z zero changed at {staleTime}. gSender cannot measure
                                                the new tool against it.
                                            </span>
                                        )}
                                        {reference.status === 'none' && (
                                            <span className="text-amber-700 dark:text-amber-400">
                                                There is no reference. gSender cannot measure the new tool against it.
                                            </span>
                                        )}
                                    </span>
                                </span>
                            </label>
                            {choice === 2 && sources.length > 0 && (
                                <div className="ml-6 flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm dark:border-amber-700 dark:bg-amber-950/30" data-testid="gg-resume-source">
                                    <div className="text-xs font-semibold">Select how gSender gets a reference:</div>
                                    <label className="flex items-start gap-2">
                                        <input
                                            type="radio"
                                            className="mt-1"
                                            checked={source === 'old-tool'}
                                            onChange={() => setSource('old-tool')}
                                            data-testid="gg-resume-source-old-tool"
                                        />
                                        <span>
                                            The old tool is in the spindle. It is not broken, and Z zero is correct for it. gSender
                                            measures it first as the new reference. Then you fit {lineT}.
                                        </span>
                                    </label>
                                    {sources.includes('old-reference') && (
                                        <label className="flex items-start gap-2">
                                            <input
                                                type="radio"
                                                className="mt-1"
                                                checked={source === 'old-reference'}
                                                onChange={() => setSource('old-reference')}
                                                data-testid="gg-resume-source-old-reference"
                                            />
                                            <span>
                                                Use the old reference ({refId}).{' '}
                                                <b>
                                                    WARNING: Z zero goes back to its position of {refTime}. The Z zero of {staleTime} is
                                                    lost.
                                                </b>
                                            </span>
                                        </label>
                                    )}
                                    <div className="text-xs text-gray-600 dark:text-gray-300">
                                        If the old tool is broken or removed: set Z zero by hand with the new tool. Then use option 3.
                                    </div>
                                </div>
                            )}
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    className="mt-1"
                                    checked={choice === 3}
                                    onChange={() => setToolChoice(3)}
                                    data-testid="gg-resume-tool-reference"
                                />
                                <span>
                                    <b>3. I set Z zero again by hand, with this tool in the spindle.</b>
                                    <span className="block text-xs text-gray-600 dark:text-gray-300">
                                        gSender measures {lineT} on the tool sensor. It becomes the new reference. Z zero does not
                                        change.
                                    </span>
                                </span>
                            </label>
                            {toolMode === null && (
                                <div className="text-sm font-semibold text-amber-700 dark:text-amber-400" data-testid="gg-resume-tool-needed">
                                    {choice === null
                                        ? `gSender recorded ${toolName(loaded)} in the spindle. This line uses ${lineT}. Select option 1, 2 or 3.`
                                        : 'Select how gSender gets a reference.'}
                                </div>
                            )}
                        </Section>

                        <Section title="Coming down">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span>Rapid to Z</span>
                                <input
                                    className="w-20 rounded border border-gray-300 px-1 py-0.5 font-mono dark:border-gray-600 dark:bg-dark"
                                    value={rapidDownTo}
                                    placeholder={plan.rapidDownTo === null ? 'none' : fmt(plan.rapidDownTo)}
                                    onChange={(e) => setRapidDownTo(e.target.value)}
                                    data-testid="gg-resume-rapid"
                                />
                                <span>then feed to Z{fmt(plan.start.z)} at F</span>
                                <input
                                    className="w-20 rounded border border-gray-300 px-1 py-0.5 font-mono dark:border-gray-600 dark:bg-dark"
                                    value={plungeFeed}
                                    placeholder={plan.plungeFeed === null ? '?' : fmt(plan.plungeFeed)}
                                    onChange={(e) => setPlungeFeed(e.target.value)}
                                    data-testid="gg-resume-plunge"
                                />
                                <span>· spin-up wait</span>
                                <input
                                    className="w-14 rounded border border-gray-300 px-1 py-0.5 font-mono dark:border-gray-600 dark:bg-dark"
                                    value={spinup}
                                    onChange={(e) => setSpinup(e.target.value)}
                                    data-testid="gg-resume-spinup"
                                />
                                <span>s</span>
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                                {plan.rapidDownFromOperation ? 'Rapid height: the highest rapid of the operation. ' : ''}
                                {plan.plungeFromOperation ? 'Feed: the plunge feed of the operation. ' : ''}
                                No material is above the start point, because the tool was at that point. This is true only for
                                lines at or before the stop line.
                            </div>
                        </Section>

                        <Section title="Sent before the line">
                            <pre className="m-0 rounded bg-gray-100 p-2 text-xs leading-5 dark:bg-black/30" data-testid="gg-resume-preamble">
                                {[...plan.preamble, ...(plan.target ? [`${plan.target}   (the line, with its arc mode)`] : [])].join('\n')}
                            </pre>
                        </Section>

                        {(plan.problems.length > 0 || plan.warnings.length > 0 || beyondStop) && (
                            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm" data-testid="gg-resume-issues">
                                {plan.problems.map((p) => (
                                    <li key={p} className="text-red-600 dark:text-red-400">
                                        {p}
                                    </li>
                                ))}
                                {beyondStop && (
                                    <li className="text-amber-600 dark:text-amber-400">
                                        This line is after the stop line. The job does not do the moves between the two lines. The
                                        tool can touch material when it goes down.
                                    </li>
                                )}
                                {plan.warnings.map((w) => (
                                    <li key={w} className="text-amber-600 dark:text-amber-400">
                                        {w}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}

                <div className="flex justify-end gap-2">
                    <button type="button" className="rounded border border-gray-300 px-4 py-2 text-sm dark:border-gray-600" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="rounded bg-blue-600 px-5 py-2 text-base font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!plan || !plan.ok || toolMode === null}
                        onClick={resume}
                        data-testid="gg-resume-start"
                    >
                        Resume at {plan ? plan.nWord ?? `line ${plan.line + 1}` : '…'}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    );
};

/** The button, in the place of upstream's "Start From". */
export const ResumeFromLine = ({ disabled, atcValidator }: Props) => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <ShadButton
                disabled={disabled}
                className={cx('rounded-[0.2rem] border-solid border-2 text-base px-2', {
                    'border-blue-400 bg-white dark:bg-dark dark:text-gray-300 [box-shadow:_2px_2px_5px_0px_var(--tw-shadow-color)] shadow-gray-400':
                        !disabled,
                    'border-gray-500 bg-gray-400 dark:bg-dark dark:text-gray-400': disabled,
                })}
                onClick={() => {
                    const [invalid, payload] = atcValidator ? atcValidator() ?? [false, null] : [false, null];
                    if (invalid && payload?.type === 'error') {
                        pubsub.publish('atc_validator', payload);
                        return;
                    }
                    setOpen(true);
                }}
                data-testid="gg-resume-button"
            >
                <MdFormatListNumbered className="text-2xl mr-1" /> Resume From
            </ShadButton>
            <ResumeDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
};

export default ResumeFromLine;
