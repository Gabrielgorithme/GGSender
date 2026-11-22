/*
 * GGSender addition (not part of upstream gSender).
 *
 * Which line a reply answers.
 *
 * The controller answers every line it gets with one "ok" or one "error:N",
 * in the order the lines arrived. gSender writes lines from several places:
 * the job (sender), the feeder (tool change lines, console, macros), its own
 * queries ("$G" twice a second). Upstream does not keep the order: it credits
 * a reply to the job or to the feeder from the state the job is in. Around a
 * tool change that is one off (a feeder reply that arrives when the job runs
 * again is taken for a job line's), so "the line that failed" was sometimes
 * the next line, and a reply to a tool change line was counted as a job
 * line's.
 *
 * This keeps the order: every line written is put in a queue with where it
 * came from, and every reply takes the first one out. It is only a record.
 * The crediting of upstream is left as it is; the fork's own features (the
 * hold at an error, the lines refused during a jog) read the record.
 *
 * Realtime bytes ("?", "!", "~", overrides) have no line end and no reply.
 * A soft reset (0x18) throws the controller's buffer away: the queue too.
 */

export const SOURCE_JOB = 'job';
export const SOURCE_FEEDER = 'feeder';
export const SOURCE_REPLAY = 'replay';
export const SOURCE_OTHER = 'other';

export class WrittenLines {
    constructor() {
        this.queue = [];
        this.label = null;
        this.unmatched = 0; // replies that came when no line waited
    }

    /** Who writes next, said just before the write. */
    mark(source, extra = {}) {
        this.label = { source, ...extra };
    }

    /** Every write to the controller, as given to the connection. */
    onWrite(data) {
        const text = String(data ?? '');
        const label = this.label;
        this.label = null;
        if (text.includes('\x18')) {
            this.queue = [];
            return;
        }
        if (!text.includes('\n')) {
            return; // a realtime byte
        }
        const parts = text.split('\n');
        parts.pop(); // what follows the last line end
        parts.forEach((part) => {
            this.queue.push({ source: SOURCE_OTHER, ...label, text: part.trim() });
        });
    }

    /** An "ok" or an "error": the line it answers, or null when none waited. */
    onReply() {
        const line = this.queue.shift();
        if (!line) {
            this.unmatched += 1;
            return null;
        }
        return line;
    }

    /** The controller started again, or the port closed: nothing waits. */
    reset() {
        this.queue = [];
        this.label = null;
    }
}
