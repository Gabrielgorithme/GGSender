/*
 * GGSender addition (not part of upstream gSender).
 *
 * Hold the machine at the first error the controller returns for a job line.
 *
 * Upstream, an "error:N" reply to a job line pauses the job: gSender stops
 * sending. The controller still has the lines sent after the failing one
 * (gSender keeps its receive buffer full, about 100 bytes, several lines) and
 * runs them. After a refused arc (error:33, for example an XZ arc read in
 * the XY plane) the next move starts from where the arc should have begun:
 * a straight line through the part.
 *
 * So, with the setting on, the first error of a running job sends a feed hold
 * at once ("!", as the pause button does in 0.6.0): nothing more moves,
 * including the lines already queued. The job is paused and the interface is
 * told which line failed (the exact one: each reply is matched to the line it
 * answers, in writtenLines.js; gSender's own "received" count runs ahead on
 * skipped comment lines). Stop throws the queued lines away (soft reset); a resume
 * would run them.
 */

export const holdOnErrorPreference = (prefs = {}) => prefs?.ggHoldOnError !== false;

/** What the interface is told about the failing line. */
export const errorReport = ({ code, message, failed, held }) => ({
    code,
    message: message || '',
    line: failed ? failed.line : '',
    seq: failed ? failed.seq : null,
    held: Boolean(held),
});
