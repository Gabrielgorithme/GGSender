/*
 * GGSender addition (not part of upstream gSender).
 *
 * What the owner sees when the controller refuses a line of a running job
 * (src/server/lib/gg/errorHold.js): the line, the error, and that the machine
 * is held and the job should be stopped, not resumed. Upstream's "Invalid
 * Line" message ends with "Press Start to resume the job", which would run
 * the lines after the refused one from the wrong position; it is not shown
 * when the machine was held.
 */
import pubsub from 'pubsub-js';
import { indexLines, nWordOf } from 'app/lib/gg/resumePlan';

export const HOLD_ON_ERROR_KEY = 'workspace.gg.holdOnError';

export interface JobErrorReport {
    code: number;
    message: string;
    line: string;
    seq: number | null;
    held: boolean;
}

/** 1-based file line of a sender index, or null. */
export const fileLineOfSeq = (content: string, seq: number | null): number | null => {
    if (seq === null || seq === undefined || !content) return null;
    const { seqOf } = indexLines(content);
    const i = seqOf.indexOf(seq);
    return i >= 0 ? i + 1 : null;
};

export const jobErrorText = (report: JobErrorReport, content: string) => {
    const fileLine = fileLineOfSeq(content, report.seq);
    const n = nWordOf(report.line);
    const where = [n, fileLine ? `file line ${fileLine}` : null].filter(Boolean).join(', ');
    return {
        title: `Error ${report.code}: the controller did not accept a line`,
        where: where || 'line not known',
        line: report.line,
        message: report.message,
        // error 9 is not a fault of the line: the machine could not take it
        cause:
            report.code === 9
                ? 'The machine was in a jog or in an alarm when this line came. Do not jog while the spindle starts or stops: the controller shows Idle then, but lines wait.'
                : '',
        advice: report.held
            ? 'WARNING: Stop the job. Do not resume it. The machine is on hold, and the lines after this line did not run. If you resume, these lines start from an incorrect position and can cut into the part. Correct the cause, then use Resume From.'
            : 'The job is paused. But the controller runs the lines that it has after this line.',
    };
};

export const showJobError = (report: JobErrorReport, content: string) => {
    const t = jobErrorText(report, content);
    pubsub.publish('helper:info', {
        title: t.title,
        description: (
            <div className="flex flex-col gap-2" data-testid="gg-job-error">
                <p>
                    <b>{t.where}</b>: <code className="font-mono">{t.line}</code>
                </p>
                {t.message && <p className="text-sm">{t.message}</p>}
                {t.cause && <p className="text-sm" data-testid="gg-job-error-cause">{t.cause}</p>}
                <p className={report.held ? 'font-semibold text-red-600 dark:text-red-400' : ''}>{t.advice}</p>
            </div>
        ),
    });
};
