/*
 * GGSender addition (not part of upstream gSender).
 *
 * gSender turns "set the override to N%" into a number of +/-10% and +/-1%
 * realtime commands, counted from the override the controller last REPORTED.
 * That report is up to a few hundred milliseconds old. With fine steps sent
 * in quick succession the second request can arrive before the report shows
 * the first one, and the difference is counted twice.
 *
 * So for a short while after a request, count from the value we asked for
 * instead of the reported one.
 */

// Long enough for the realtime commands to be sent (25ms apart) and for a
// status report to come back; short enough that a clamp by the firmware
// (which we cannot see until the next report) corrects itself quickly.
export const TARGET_TRUST_MS = 1500;

/**
 * @param reported  override last reported by the controller, in percent
 * @param last      { value, at } of the previous request, or undefined
 * @param now       current time in ms
 * @returns the value to count the next difference from
 */
export const overrideBase = (reported, last, now = Date.now()) => {
    const reportedValue = Number(reported);
    if (
        last &&
        Number.isFinite(Number(last.value)) &&
        Number.isFinite(Number(last.at)) &&
        now - last.at >= 0 &&
        now - last.at < TARGET_TRUST_MS
    ) {
        return Number(last.value);
    }
    return Number.isFinite(reportedValue) ? reportedValue : 100;
};
