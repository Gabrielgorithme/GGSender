/*
 * GGSender addition (not part of upstream gSender).
 *
 * Diagnostics for the g-code stream, written to the traffic log
 * (see trafficLog.js). Read-only: nothing here changes what is sent or how
 * replies are counted.
 *
 * Records:
 *   - every command the controller object is asked to run, and for g-code
 *     injected while a job is running, where the request came from
 *   - workflow changes (start, pause, resume, stop) and sender holds
 *   - every "ok" that is NOT credited to the running job
 *   - the sender's buffer bookkeeping every few seconds during a job
 *   - a full state dump when the stream looks stalled: job running, sender
 *     not on hold, machine idle, and no reply for a while
 */
import { WORKFLOW_STATE_RUNNING } from '../Workflow';
import { callerStack, logEvent } from './trafficLog';

const STALL_AFTER_MS = 3000;
const ACCOUNTING_EVERY_MS = 5000;
const CHECK_EVERY_MS = 1000;
const MAX_TEXT = 400;

const clip = (text, max = MAX_TEXT) => {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max)}... (${s.length} chars)` : s;
};

const safeJson = (value) => {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
};

/** The numbers that decide whether the sender may send another line. */
export const senderAccounting = (controller) => {
    const sender = controller.sender;
    const sp = sender?.sp || {};
    const s = sender?.state || {};
    return {
        workflow: controller.workflow?.state,
        machine: controller.runner?.state?.status?.activeState,
        sent: s.sent,
        received: s.received,
        total: s.total,
        hold: s.hold,
        holdReason: s.holdReason,
        // character-counting protocol: bytes believed to be in the
        // controller's receive buffer, out of bufferSize
        bufferUsed: sp.dataLength,
        bufferSize: sp.bufferSize,
        unackedLines: Array.isArray(sp.queue) ? sp.queue.length : undefined,
        waitingLine: sp.line ? clip(sp.line, 80) : '',
        feederPending: controller.feeder?.state?.pending,
        feederOutstanding: controller.feeder?.state?.outstanding,
        feederQueued: controller.feeder?.state?.queue?.length,
        feederHold: controller.feeder?.state?.hold,
        awaitingParserStateReply: controller.actionMask?.queryParserState?.reply,
        parserStateQuerySent: controller.actionMask?.queryParserState?.state,
    };
};

/**
 * True when the stream looks stuck: a job is running, the sender is not
 * holding on purpose, lines are still owed or unacknowledged, the machine
 * reports idle, and nothing has come back for a while.
 */
export const looksStalled = (acct, msSinceLastOk, stallAfterMs = STALL_AFTER_MS) => {
    if (acct.workflow !== WORKFLOW_STATE_RUNNING || acct.hold) {
        return false;
    }
    const linesOwed = Number(acct.sent) < Number(acct.total);
    const repliesOwed = Number(acct.received) < Number(acct.sent);
    if (!linesOwed && !repliesOwed) {
        return false;
    }
    return acct.machine === 'Idle' && msSinceLastOk >= stallAfterMs;
};

/** Called at the top of controller.command(). */
export const noteCommand = (controller, cmd, args = []) => {
    try {
        const running = controller.workflow?.state === WORKFLOW_STATE_RUNNING;

        if (cmd === 'gcode' || cmd === 'gcode:safe') {
            const data = [].concat(args[0] ?? []).join(' | ');
            if (running) {
                logEvent(
                    'COMMAND DURING JOB',
                    `${cmd} "${clip(data)}"\n${callerStack(3, 8)}`,
                );
                logEvent('accounting', safeJson(senderAccounting(controller)));
            } else {
                logEvent('command', `${cmd} "${clip(data)}"`);
            }
            return;
        }

        if (cmd === 'gcode:load') {
            const meta = args[0] || {};
            const gcode = args[1] || '';
            logEvent('command', `gcode:load name="${meta.name}" bytes=${String(gcode).length}`);
            return;
        }

        const printableArgs = args.filter((a) => typeof a !== 'function');
        logEvent('command', `${cmd} ${clip(safeJson(printableArgs), 200)}`);
    } catch (err) {
        // diagnostics must never disturb the stream
    }
};

/** Called where an "ok" is credited to something other than the running job. */
export const noteOkElsewhere = (controller, creditedTo) => {
    try {
        const running = controller.workflow?.state === WORKFLOW_STATE_RUNNING;
        // Outside a job every ok goes to the feeder; only the unusual cases
        // are worth a line.
        if (creditedTo === 'feeder' && !running) {
            return;
        }
        logEvent('ok credited to', creditedTo);
    } catch (err) {
        // diagnostics must never disturb the stream
    }
};

/** Called once, when the controller's sender, feeder, workflow and runner exist. */
export const attachStreamDiagnostics = (controller) => {
    try {
        let lastOk = Date.now();
        let lastAccounting = 0;
        let stallReported = false;

        controller.runner.on('ok', () => {
            lastOk = Date.now();
            if (stallReported) {
                stallReported = false;
                logEvent('stream', 'replies resumed after the stall');
            }
        });

        ['start', 'stop', 'pause', 'resume'].forEach((name) => {
            controller.workflow.on(name, (...args) => {
                logEvent(
                    'workflow',
                    `${name} -> ${controller.workflow.state} ${clip(safeJson(args), 200)}`,
                );
                if (name === 'stop' || name === 'pause') {
                    logEvent('  caused by', callerStack(3, 8));
                }
            });
        });

        controller.sender.on('hold', () => {
            logEvent('sender', `hold ${safeJson(controller.sender.state.holdReason)}`);
        });
        controller.sender.on('unhold', () => logEvent('sender', 'unhold'));
        controller.sender.on('start', () => logEvent('sender', 'start'));
        controller.sender.on('end', () => logEvent('sender', 'end (all lines sent and acknowledged)'));

        const timer = setInterval(() => {
            try {
                if (!controller.connection || !controller.workflow) {
                    clearInterval(timer);
                    return;
                }
                if (controller.workflow.state !== WORKFLOW_STATE_RUNNING) {
                    return;
                }
                const now = Date.now();
                const acct = senderAccounting(controller);

                if (now - lastAccounting >= ACCOUNTING_EVERY_MS) {
                    lastAccounting = now;
                    logEvent('accounting', safeJson(acct));
                }

                if (!stallReported && looksStalled(acct, now - lastOk)) {
                    stallReported = true;
                    logEvent(
                        'STALL',
                        `job running, sender not on hold, machine idle, no reply for ${now - lastOk} ms`,
                    );
                    logEvent('STALL state', safeJson(acct));
                    logEvent(
                        'STALL action times',
                        safeJson(controller.actionTime || {}),
                    );
                }
            } catch (err) {
                // diagnostics must never disturb the stream
            }
        }, CHECK_EVERY_MS);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        logEvent('controller', `attached (${controller.type}) port=${controller.options?.port}`);
    } catch (err) {
        // diagnostics must never disturb the stream
    }
};
