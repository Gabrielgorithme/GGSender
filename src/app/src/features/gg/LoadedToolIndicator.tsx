/*
 * GGSender addition (not part of upstream gSender).
 *
 * Top-bar chip showing the tool gSender has recorded as loaded, and the state
 * of the tool sensor reference as a pictogram (correct, not correct, none).
 * Click it to correct the tool number or to mark the tool as unknown, and to
 * read the reference: which tool was probed, when, what a tool change will do
 * with it, and the history (features/gg/ReferenceStatus.tsx).
 */
import { useEffect, useRef, useState } from 'react';

import store from 'app/store';
import { formatSince, getLoadedTool, normalizeTool, setLoadedTool } from 'app/lib/gg/loadedTool';
import { useReference } from 'app/lib/gg/probeStore';
import { STATUS_LABEL, referenceHeadline } from 'app/lib/gg/referenceText';
import { ReferenceIcon, ReferenceStatus } from './ReferenceStatus';

export const LoadedToolIndicator = () => {
    const [loaded, setLoaded] = useState(getLoadedTool());
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const wrapperRef = useRef<HTMLDivElement>(null);
    const reference = useReference();
    const connected = reference.live; // the server sends the state while connected

    useEffect(() => {
        const onChange = () => setLoaded(getLoadedTool());
        store.on('change', onChange);
        return () => {
            store.removeListener('change', onChange);
        };
    }, []);

    // Close the editor when clicking elsewhere
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (!wrapperRef.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const known = loaded.tool !== null;
    const draftTool = normalizeTool(draft);
    const when = formatSince(loaded.since);

    const apply = () => {
        if (draftTool === null) {
            return;
        }
        setLoadedTool(draftTool);
        setOpen(false);
    };

    return (
        <div ref={wrapperRef} className="relative max-sm:hidden">
            <button
                type="button"
                onClick={() => {
                    setDraft(loaded.tool ?? '');
                    setOpen(!open);
                }}
                title={`${
                    known
                        ? `The recorded tool in the spindle${when ? ` (set ${when})` : ''}.`
                        : 'The tool in the spindle is not known.'
                }${connected ? ` Tool sensor: ${referenceHeadline(reference)}` : ''} Click for details.`}
                className={`px-3 h-8 rounded-md border text-sm font-bold font-mono whitespace-nowrap flex items-center gap-1.5 ${
                    known
                        ? 'border-blue-500 text-blue-500 bg-white dark:bg-dark'
                        : 'border-gray-400 text-gray-500 bg-white dark:bg-dark dark:text-gray-300'
                }`}
                data-testid="gg-loaded-tool"
            >
                {known ? `T${loaded.tool}` : 'T?'}
                {/* the tool sensor reference: correct, not correct, none */}
                {connected && <ReferenceIcon status={reference.status} className="text-base" />}
            </button>
            {open && (
                <div className="absolute top-10 left-0 z-[10000] w-[26rem] max-w-[90vw] p-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark shadow-lg text-sm text-gray-900 dark:text-gray-200 flex flex-col gap-2">
                    <div className="font-bold">Loaded tool</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                        {known
                            ? `Recorded as T${loaded.tool}${when ? `, set ${when}` : ''}.`
                            : 'The tool in the spindle is not known.'}
                    </div>
                    <div className="flex flex-row gap-2 items-center">
                        <span className="font-mono font-bold">T</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    apply();
                                }
                                if (e.key === 'Escape') {
                                    setOpen(false);
                                }
                            }}
                            className="flex-1 min-w-0 p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-darker font-mono"
                            data-testid="gg-loaded-tool-input"
                        />
                        <button
                            type="button"
                            onClick={apply}
                            disabled={draftTool === null}
                            className="px-2 py-1 rounded bg-blue-500 text-white disabled:opacity-40"
                        >
                            Set
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            setLoadedTool(null);
                            setOpen(false);
                        }}
                        className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600"
                    >
                        Mark as unknown
                    </button>
                    <div className="mt-1 border-t border-gray-200 pt-2 dark:border-gray-600" data-testid="gg-reference-panel">
                        <div className="mb-1 flex items-center gap-2 font-bold">
                            Tool sensor reference
                            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                                {connected ? STATUS_LABEL[reference.status] : 'Not connected'}
                            </span>
                        </div>
                        {connected ? (
                            <>
                                <ReferenceStatus snapshot={reference} effect history />
                                <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                                    The reference is the height of the tool sensor above Z zero. It is correct until Z zero
                                    changes. gSender does not keep it after a disconnection.
                                </div>
                            </>
                        ) : (
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                                gSender does not keep the reference after a disconnection.
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default LoadedToolIndicator;
