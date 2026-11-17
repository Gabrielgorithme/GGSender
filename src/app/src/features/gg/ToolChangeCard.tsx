/*
 * GGSender addition (not part of upstream gSender).
 *
 * Next to the "Install New Tool" banner of the tool change wizard: a drawing
 * of the tool to fit, from the tool table Fusion writes at the top of the
 * program, its numbers, how deep it cuts, and the operations it is for.
 * Shown when the setting "Tool drawing at tool change" is on and the file
 * describes the tool; otherwise only the upstream banner is shown.
 */
import { ReactNode } from 'react';
import { JobInfo, findToolSpec } from 'app/lib/gg/jobOperations';
import { formatDuration, groupForToolChange } from 'app/lib/gg/jobProgress';
import { ToolSpec } from 'app/lib/gg/toolSpec';
import { ToolDrawing } from './ToolDrawing';
import { useJobInfo } from './JobOperations';
import { useStoreSetting } from './useStoreSetting';

export const TOOL_DRAWING_KEY = 'workspace.gg.toolDrawing';

const fmt = (v: number) => String(Number(v.toFixed(3)));

interface CardProps {
    info: JobInfo;
    spec: ToolSpec;
    m6Seq: number | null;
}

export const ToolChangeCard = ({ info, spec, m6Seq }: CardProps) => {
    const unit = info.units === 'inch' ? 'in' : 'mm';
    const group = groupForToolChange(info, spec.number, m6Seq);
    const ops = group ? group.operations.map((i) => info.operations[i].name) : [];
    const r = spec.diameter !== null ? spec.diameter / 2 : null;
    const showR = spec.cornerRadius !== null && spec.cornerRadius > 0 && (r === null || spec.cornerRadius < r * 0.999);
    return (
        <div
            className="flex items-center gap-3 rounded-[8px] border border-gray-200 bg-gray-50 px-3 py-2 dark:border-white/10 dark:bg-black/20"
            data-testid="gg-toolchange-card"
        >
            <ToolDrawing spec={spec} height={124} className="flex-shrink-0 text-gray-700 dark:text-gray-200" />
            <div className="flex min-w-0 flex-col gap-0.5 text-xs text-gray-600 dark:text-gray-300 max-w-[12rem]">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{spec.type || 'tool'}</div>
                {(spec.diameter !== null || showR) && (
                    <div data-testid="gg-toolchange-size">
                        {spec.diameter !== null && (
                            <>
                                ⌀ <b className="font-mono">{fmt(spec.diameter)} {unit}</b>
                            </>
                        )}
                        {spec.diameter !== null && showR && ' · '}
                        {showR && (
                            <>
                                R <b className="font-mono">{fmt(spec.cornerRadius as number)} {unit}</b>
                            </>
                        )}
                    </div>
                )}
                {spec.taperDeg !== null && (
                    <div>
                        Taper <b className="font-mono">{fmt(spec.taperDeg)}°</b>
                        {spec.kind === 'chamfer' ? ` (${fmt(spec.taperDeg * 2)}° tool)` : ' per side'}
                    </div>
                )}
                {spec.zMin !== null && (
                    <div title="Deepest Z this tool reaches in the program (Fusion's ZMIN, work coordinates)">
                        Cuts down to <b className="font-mono">Z{fmt(spec.zMin)}</b>
                    </div>
                )}
                {spec.description && <div className="italic line-clamp-1" title={spec.description}>{spec.description}</div>}
                {group?.comment && <div className="italic line-clamp-1" title={group.comment}>{group.comment}</div>}
                {ops.length > 0 && (
                    // two lines at most, so the window's Run button stays in view
                    <div className="mt-1 line-clamp-2" title={ops.join('\n')} data-testid="gg-toolchange-ops">
                        <b className="text-gray-700 dark:text-gray-200">
                            For {ops.length === 1 ? 'operation' : `${ops.length} operations`}
                            {group?.seconds ? ` (~${formatDuration(group.seconds)})` : ''}:
                        </b>{' '}
                        {ops.join(', ')}
                    </div>
                )}
            </div>
        </div>
    );
};

interface WithProps {
    toolLabel: string | null;
    toolchangeContext?: Record<string, unknown> | null;
    children: ReactNode; // the upstream banner
}

/** The upstream banner, with the tool card beside it when there is one. */
export const WithToolDrawing = ({ toolLabel, toolchangeContext, children }: WithProps) => {
    const enabled = useStoreSetting<boolean>(TOOL_DRAWING_KEY, true);
    const entry = useJobInfo();
    const spec = enabled && entry ? findToolSpec(entry.info, toolLabel) : null;
    if (!spec || !entry) {
        return <>{children}</>;
    }
    const line = Number(toolchangeContext?.line);
    const m6Seq = Number.isFinite(line) && line > 0 ? line - 1 : null;
    return (
        <div className="flex items-center justify-center gap-3 self-center" data-testid="gg-toolchange-row">
            <div className="flex w-[13rem] flex-shrink-0">{children}</div>
            <ToolChangeCard info={entry.info} spec={spec} m6Seq={m6Seq} />
        </div>
    );
};

export default WithToolDrawing;
