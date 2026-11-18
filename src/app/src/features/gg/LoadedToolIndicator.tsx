/*
 * GGSender addition (not part of upstream gSender).
 *
 * Top-bar chip showing the tool gSender has recorded as loaded. Click it to
 * correct the number or to mark the tool as unknown.
 */
import { useEffect, useRef, useState } from 'react';

import store from 'app/store';
import { formatSince, getLoadedTool, normalizeTool, setLoadedTool } from 'app/lib/gg/loadedTool';

export const LoadedToolIndicator = () => {
    const [loaded, setLoaded] = useState(getLoadedTool());
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const wrapperRef = useRef<HTMLDivElement>(null);

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
                title={
                    known
                        ? `The recorded tool in the spindle${when ? ` (set ${when})` : ''}. Click to change it.`
                        : 'The tool in the spindle is not known. Click to set it.'
                }
                className={`px-3 h-8 rounded-md border text-sm font-bold font-mono whitespace-nowrap ${
                    known
                        ? 'border-blue-500 text-blue-500 bg-white dark:bg-dark'
                        : 'border-gray-400 text-gray-500 bg-white dark:bg-dark dark:text-gray-300'
                }`}
                data-testid="gg-loaded-tool"
            >
                {known ? `T${loaded.tool}` : 'T?'}
            </button>
            {open && (
                <div className="absolute top-10 left-0 z-[10000] w-64 p-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark shadow-lg text-sm text-gray-900 dark:text-gray-200 flex flex-col gap-2">
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
                </div>
            )}
        </div>
    );
};

export default LoadedToolIndicator;
