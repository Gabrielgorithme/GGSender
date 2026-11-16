/*
 * GGSender addition (not part of upstream gSender).
 *
 * Card at the bottom of the 3D view (the pre-flight panel uses the top) showing the G-code line picked on the
 * toolpath, with the lines around it. Step to the previous or next move,
 * jump to a line number, or open the editor at that line.
 */
import { useEffect, useMemo, useState } from 'react';
import pubsub from 'pubsub-js';

import { useTypedSelector } from 'app/hooks/useTypedSelector';
import {
    PICK_CHANGED,
    PickState,
    getCurrentPick,
    requestPickClear,
    requestPickLine,
    requestPickStep,
} from './pickTopics';

const CONTEXT = 2; // lines shown before and after

export const splitLines = (content: string): string[] =>
    content ? content.split('\n') : [];

/** Parse a typed line number (1-based) into a 0-based index, or null. */
export const parseLineInput = (text: string, total: number): number | null => {
    const n = Number(String(text).trim());
    if (!Number.isInteger(n) || n < 1 || (total > 0 && n > total)) {
        return null;
    }
    return n - 1;
};

export const PickCard = () => {
    const content = useTypedSelector((state) => state.file.content) as string;
    const lines = useMemo(() => splitLines(content || ''), [content]);
    const [pick, setPick] = useState<PickState | null>(getCurrentPick());
    const [goTo, setGoTo] = useState('');

    useEffect(() => {
        const token = pubsub.subscribe(PICK_CHANGED, (_msg, state) => {
            setPick(state);
        });
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);

    // Escape clears the pick, unless typing somewhere
    useEffect(() => {
        if (!pick) {
            return undefined;
        }
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const typing =
                target &&
                (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
            if (e.key === 'Escape' && !typing) {
                requestPickClear();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [pick]);

    if (!pick) {
        return null;
    }

    const from = Math.max(0, pick.line - CONTEXT);
    const to = Math.min(lines.length, pick.line + CONTEXT + 1);
    const shown = lines.slice(from, to);
    const goToIndex = parseLineInput(goTo, lines.length);

    const openEditor = () => {
        pubsub.publish('gcode-editor:toggle', true);
    };

    return (
        <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[34rem] max-w-[90%] rounded-md border border-gray-300 dark:border-gray-600 bg-white/95 dark:bg-dark/95 shadow-lg text-sm text-gray-900 dark:text-gray-100"
            data-testid="gg-pick-card"
        >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
                <span className="font-bold whitespace-nowrap" data-testid="gg-pick-line">
                    Line {pick.line + 1}
                </span>
                {!pick.drew && (
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {pick.shownLine === null
                            ? 'no motion'
                            : `no motion; tool position after line ${pick.shownLine + 1}`}
                    </span>
                )}
                <div className="flex-1" />
                <button
                    type="button"
                    className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600"
                    onClick={() => requestPickStep(-1)}
                    title="Previous move"
                    aria-label="Previous move"
                >
                    ◀
                </button>
                <button
                    type="button"
                    className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600"
                    onClick={() => requestPickStep(1)}
                    title="Next move"
                    aria-label="Next move"
                >
                    ▶
                </button>
                <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Go to line"
                    value={goTo}
                    onChange={(e) => setGoTo(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && goToIndex !== null) {
                            requestPickLine(goToIndex);
                            setGoTo('');
                        }
                        if (e.key === 'Escape') {
                            setGoTo('');
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className={`w-24 px-1 py-0.5 rounded border bg-white dark:bg-dark-darker ${
                        goTo && goToIndex === null
                            ? 'border-red-500'
                            : 'border-gray-300 dark:border-gray-600'
                    }`}
                    data-testid="gg-pick-goto"
                />
                <button
                    type="button"
                    className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 whitespace-nowrap"
                    onClick={openEditor}
                    title="Open the G-code editor at this line"
                >
                    Editor
                </button>
                <button
                    type="button"
                    className="px-2 py-0.5"
                    onClick={() => requestPickClear()}
                    title="Close (Esc)"
                    aria-label="Close"
                >
                    ✕
                </button>
            </div>
            <div className="font-mono text-xs py-1">
                {shown.map((text, i) => {
                    const index = from + i;
                    const isPick = index === pick.line;
                    return (
                        <div
                            key={index}
                            onClick={() => requestPickLine(index)}
                            className={`flex gap-3 px-3 py-0.5 cursor-pointer ${
                                isPick
                                    ? 'bg-pink-100 dark:bg-pink-900/40 font-bold'
                                    : 'hover:bg-gray-100 dark:hover:bg-dark-lighter'
                            }`}
                        >
                            <span className="w-14 text-right text-gray-500 dark:text-gray-400 select-none">
                                {index + 1}
                            </span>
                            <span className="truncate">{text || ' '}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default PickCard;
