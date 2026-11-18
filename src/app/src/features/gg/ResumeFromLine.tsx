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
import { getLoadedTool, normalizeTool } from 'app/lib/gg/loadedTool';
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
    const [measureTool, setMeasureTool] = useState<boolean | null>(null); // null: the default
    const [rapidDownTo, setRapidDownTo] = useState('');
    const [plungeFeed, setPlungeFeed] = useState('');
    const [spinup, setSpinup] = useState(() => String(spinupSeconds((k, d) => store.get(k, d))));
    const [toolReference, setToolReference] = useState<boolean | null>(null);

    const suggestion = useMemo(
        () => (open ? suggestedLine(content, fileName, idx.total) : null),
        [open, content, fileName, idx.total],
    );

    // on opening: start from the stop point, ask the server about the tool reference
    useEffect(() => {
        if (!open) return undefined;
        setMeasureTool(null);
        setRapidDownTo('');
        setPlungeFeed('');
        setToolReference(null);
        if (suggestion) {
            const raw = idx.lines[suggestion.line];
            setQuery(usesN && nWordOf(raw) ? (nWordOf(raw) as string) : `L${suggestion.line + 1}`);
        }
        const onInfo = (data: { toolReference?: boolean }) => setToolReference(Boolean(data?.toolReference));
        const onError = (message: string) => toast.error(`Resume refused: ${message}`, { position: 'bottom-right' });
        controller.addListener('gg:resume:info', onInfo);
        controller.addListener('gg:resume:error', onError);
        controller.command('gg:resume:query');
        return () => {
            controller.removeListener('gg:resume:info', onInfo);
            controller.removeListener('gg:resume:error', onError);
        };
        // only on opening
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const resolved = useMemo(() => (query.trim() ? resolveQuery(content, query) : null), [content, query]);
    const loaded = normalizeTool(getLoadedTool().tool);

    const plan: ResumePlan | null = useMemo(() => {
        if (!resolved || resolved.line === null) return null;
        const opts = {
            safeZ: Number(getToolChangeSafeZ()),
            spinupSeconds: num(spinup) ?? 0,
            rapidDownTo: num(rapidDownTo),
            plungeFeed: num(plungeFeed),
        };
        const kept = planResume(content, info, resolved.line, { ...opts, measureTool: false });
        const tool = kept.state.tool ?? kept.state.nextTool;
        // by default, measure when the recorded tool is not the line's tool
        const measure = measureTool ?? (tool !== null && normalizeTool(tool) !== loaded);
        return measure ? planResume(content, info, resolved.line, { ...opts, measureTool: true }) : kept;
    }, [content, info, resolved, measureTool, loaded, spinup, rapidDownTo, plungeFeed]);

    const lineTool = plan ? plan.state.tool ?? plan.state.nextTool : null;
    const measuring = plan ? plan.preamble.some((l) => / M6$/.test(l)) : false;
    const spec = lineTool ? findToolSpec(info, lineTool) : null;
    const unit = plan?.state.units === 'G20' ? 'in' : 'mm';
    const fmt = (v: number | null) => (v === null ? '?' : String(Number(v.toFixed(4))));
    const beyondStop = plan && suggestion && plan.seq > suggestion.seq;

    const resume = () => {
        if (!plan || !plan.ok) return;
        controller.command('gg:resume:start', resumePayload(plan, idx.total, measuring));
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
                            onClick={() => {
                                const raw = idx.lines[suggestion.line];
                                setQuery(usesN && nWordOf(raw) ? (nWordOf(raw) as string) : `L${suggestion.line + 1}`);
                            }}
                            data-testid="gg-resume-where-stopped"
                        >
                            Where it stopped
                        </button>
                    )}
                    {info && info.operations.length > 0 && (
                        <select
                            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-dark"
                            value=""
                            onChange={(e) => {
                                const op = info.operations[Number(e.target.value)];
                                if (op?.firstMotionLine !== null && op?.firstMotionLine !== undefined) {
                                    const raw = idx.lines[op.firstMotionLine];
                                    setQuery(usesN && nWordOf(raw) ? (nWordOf(raw) as string) : `L${op.firstMotionLine + 1}`);
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

                        <Section title="Tool">
                            <label className="flex items-start gap-2 text-sm">
                                <input type="radio" checked={!measuring} onChange={() => setMeasureTool(false)} data-testid="gg-resume-tool-keep" />
                                <span>
                                    Keep the tool: T{lineTool ?? '?'} is in the spindle and did not change after the stop{' '}
                                    <span className="text-gray-500">
                                        (recorded tool: {loaded ? `T${loaded}` : 'not known'})
                                    </span>
                                </span>
                            </label>
                            <label className="flex items-start gap-2 text-sm">
                                <input type="radio" checked={measuring} onChange={() => setMeasureTool(true)} data-testid="gg-resume-tool-measure" />
                                <span>Change or measure it first: the tool change wizard runs before the spindle starts</span>
                            </label>
                            {measuring && (
                                <div
                                    className={cx('ml-6 text-xs', toolReference === false ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-gray-300')}
                                    data-testid="gg-resume-reference"
                                >
                                    {toolReference === null && 'gSender asks the server for the tool sensor reference…'}
                                    {toolReference === true &&
                                        'The tool sensor reference from the last tool change stays. The wizard goes directly to the new tool. Use this after a broken bit. This is correct only if nobody set the work Z zero again after the stop.'}
                                    {toolReference === false &&
                                        'There is no tool sensor reference after gSender connected. The wizard first measures the tool in the spindle as the reference. This is correct only if you set the work Z zero with this tool, and the tool is not broken. After a broken bit, set the work Z zero with the new tool. Then select "Keep the tool".'}
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
                        disabled={!plan || !plan.ok}
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
