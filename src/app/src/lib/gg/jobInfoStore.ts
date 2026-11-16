/*
 * GGSender addition (not part of upstream gSender).
 * Holds the operations and tool table of the loaded file (jobOperations.ts)
 * and announces new ones.
 */
import pubsub from 'pubsub-js';
import { JobInfo } from './jobOperations';

export const JOB_INFO_TOPIC = 'gg:job:info';

export interface JobInfoEntry {
    info: JobInfo;
    fileName: string;
}

let current: JobInfoEntry | null = null;

export const getJobInfo = (): JobInfoEntry | null => current;

export const setJobInfo = (info: JobInfo | null, fileName = '') => {
    current = info ? { info, fileName } : null;
    pubsub.publish(JOB_INFO_TOPIC, current);
};
