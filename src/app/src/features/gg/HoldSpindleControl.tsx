/*
 * GGSender addition (not part of upstream gSender).
 *
 * Above the job controls while gSender holds the job (pause = feed hold, see
 * src/server/lib/gg/holdPause.js): stop or start the spindle, and what
 * resuming will do. The state comes from the server ('gg:hold:state').
 */
import { useEffect, useState } from 'react';
import cx from 'classnames';
import controller from 'app/lib/controller';
import store from 'app/store';
import { spinupSeconds } from 'app/lib/gg/holdSettings';

export interface HoldState {
    active: boolean;
    holding: boolean;
    holdComplete: boolean;
    spindleOn: boolean | null;
    spindleWasOn: boolean | null;
    stopped: boolean;
    pending: boolean;
    resuming: boolean;
    resumeInMs: number | null;
    canToggle: boolean;
}

interface Display {
    button: string | null; // null: no button
    tone: 'stop' | 'start' | 'busy';
    caption: string;
}

/** What to show for a hold state (pure, for tests). */
export const holdDisplay = (s: HoldState, secondsLeft: number | null, spinup: number): Display => {
    if (s.resuming) {
        return {
            button: null,
            tone: 'busy',
            caption:
                secondsLeft !== null
                    ? `Spindle starting · resuming in ${secondsLeft} s`
                    : 'Resuming as soon as the machine has stopped…',
        };
    }
    if (!s.holding) {
        return { button: 'Holding…', tone: 'busy', caption: 'Stopping the machine' };
    }
    if (s.spindleWasOn === false) {
        return { button: null, tone: 'busy', caption: 'Held · spindle was off' };
    }
    if (s.pending) {
        return {
            button: s.stopped ? 'Stopping spindle…' : 'Starting spindle…',
            tone: 'busy',
            caption: 'Held',
        };
    }
    if (s.stopped) {
        return {
            button: 'Start spindle',
            tone: 'start',
            caption: `Held · spindle stopped · Resume starts it and waits ${spinup} s`,
        };
    }
    return { button: 'Stop spindle', tone: 'stop', caption: 'Held · spindle turning' };
};

export const HoldSpindleControl = () => {
    const [state, setState] = useState<HoldState | null>(null);
    const [resumeBy, setResumeBy] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        const onState = (s: HoldState) => {
            setState(s);
            setResumeBy(s && s.resumeInMs !== null && s.resumeInMs !== undefined ? Date.now() + s.resumeInMs : null);
            setNow(Date.now());
        };
        controller.addListener('gg:hold:state', onState);
        controller.command('gg:hold:query');
        return () => {
            controller.removeListener('gg:hold:state', onState);
        };
    }, []);

    useEffect(() => {
        if (resumeBy === null) {
            return undefined;
        }
        const id = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(id);
    }, [resumeBy]);

    if (!state || !state.active) {
        return null;
    }
    const secondsLeft = resumeBy === null ? null : Math.max(0, Math.ceil((resumeBy - now) / 1000));
    const display = holdDisplay(state, secondsLeft, spinupSeconds((k, d) => store.get(k, d)));

    return (
        <div
            className="z-10 absolute top-[-84px] max-xl:top-[-80px] left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 whitespace-nowrap"
            data-testid="gg-hold-control"
        >
            {display.button && (
                <button
                    type="button"
                    className={cx(
                        'h-9 px-4 rounded border-solid border text-sm font-semibold shadow',
                        {
                            'bg-red-500 dark:bg-red-700 text-white border-red-700': display.tone === 'stop',
                            'bg-green-600 dark:bg-green-700 text-white border-green-800': display.tone === 'start',
                            'bg-gray-300 text-gray-600 dark:bg-dark dark:text-gray-400 border-gray-400 cursor-not-allowed':
                                display.tone === 'busy',
                        },
                    )}
                    disabled={!state.canToggle}
                    onClick={() => controller.command('gg:hold:spindle')}
                    data-testid="gg-hold-spindle"
                >
                    {display.button}
                </button>
            )}
            <span className="text-xs text-gray-700 dark:text-gray-300" data-testid="gg-hold-caption">
                {display.caption}
            </span>
        </div>
    );
};

export default HoldSpindleControl;
