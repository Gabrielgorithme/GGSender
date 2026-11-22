/*
 * GGSender addition (not part of upstream gSender).
 *
 * Shown when the controller refused lines because the machine jogged while
 * gSender sent them (a jog from the pendant while the spindle stops for a
 * tool change, for example). It lists the lines and has the button that
 * sends them again. See src/server/lib/gg/refusedLines.js.
 *
 * It is drawn over everything, the tool change window included: while lines
 * wait, that window can do nothing.
 */
import { createPortal } from 'react-dom';
import get from 'lodash/get';
import cx from 'classnames';

import controller from 'app/lib/controller';
import { useTypedSelector } from 'app/hooks/useTypedSelector';
import { GRBL_ACTIVE_STATE_IDLE } from 'app/constants';
import { useRefused } from 'app/lib/gg/refusedStore';
import { refusedText } from 'app/lib/gg/refusedText';

export const RefusedLinesNotice = () => {
    const state = useRefused();
    const activeState = useTypedSelector((s) => get(s, 'controller.state.status.activeState', '')) as string;
    const text = refusedText(state, activeState === GRBL_ACTIVE_STATE_IDLE);
    if (!text) {
        return null;
    }
    return createPortal(
        <div
            className={cx(
                'fixed left-1/2 top-24 z-[2000] w-[34rem] max-w-[92vw] -translate-x-1/2 rounded-md border-2 px-4 py-3 text-sm shadow-xl',
                text.severe
                    ? 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100'
                    : 'border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
            )}
            role="alert"
            data-testid="gg-refused"
            data-severe={text.severe ? 'true' : undefined}
        >
            <div className="text-base font-bold" data-testid="gg-refused-title">
                {text.title}
            </div>
            <p className="mt-1">{text.cause}</p>
            <pre className="my-2 rounded bg-black/5 px-2 py-1 font-mono text-xs leading-5 dark:bg-white/10" data-testid="gg-refused-lines">
                {text.lines.join('\n')}
                {text.more ? `\n${text.more}` : ''}
            </pre>
            <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 font-semibold" data-testid="gg-refused-action">
                    {text.action}
                </p>
                {text.button && (
                    <button
                        type="button"
                        className="shrink-0 rounded bg-blue-600 px-4 py-2 text-base font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!text.buttonEnabled}
                        onClick={() => controller.command('gg:refused:replay')}
                        data-testid="gg-refused-send"
                    >
                        {text.button}
                    </button>
                )}
            </div>
            {text.hint && <p className="mt-2 text-xs opacity-80">{text.hint}</p>}
        </div>,
        document.body,
    );
};

export default RefusedLinesNotice;
