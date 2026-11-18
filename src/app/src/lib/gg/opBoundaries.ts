/*
 * GGSender addition (not part of upstream gSender).
 *
 * Tells the server where each operation of the loaded program begins, so it
 * can put the feed and spindle overrides back to 100% there
 * (src/server/lib/gg/opResets.js). Sent whenever the program's operations
 * are read (jobInfoStore) and on connection.
 *
 * The first operation is left out: the overrides set before starting a job
 * stay for its first operation.
 */
import pubsub from 'pubsub-js';
import controller from 'app/lib/controller';
import { JOB_INFO_TOPIC, JobInfoEntry, getJobInfo } from './jobInfoStore';

export const RESET_OVERRIDES_KEY = 'workspace.gg.resetOverridesPerOp';

export interface BoundariesPayload {
    name: string;
    total: number | null;
    boundaries: { seq: number; text: string; name: string }[];
}

export const operationBoundaries = (entry: JobInfoEntry | null): BoundariesPayload => {
    if (!entry) {
        return { name: '', total: null, boundaries: [] };
    }
    const { info, fileName } = entry;
    return {
        name: fileName,
        total: info.totalSeq,
        boundaries: info.operations
            .slice(1)
            .filter((op) => op.firstMotionSeq !== null && op.firstMotionText)
            .map((op) => ({
                seq: op.firstMotionSeq as number,
                text: op.firstMotionText as string,
                name: op.name,
            })),
    };
};

export const pushOperationBoundaries = () => {
    controller.command('gg:job:operations', operationBoundaries(getJobInfo()));
};

let watching = false;

/** Send the boundaries each time a program's operations are read. */
export const watchOperationBoundaries = () => {
    if (watching) {
        return;
    }
    watching = true;
    pubsub.subscribe(JOB_INFO_TOPIC, () => pushOperationBoundaries());
};
