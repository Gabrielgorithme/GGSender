/*
 * GGSender addition (not part of upstream gSender).
 * Holds the pre-flight report of the loaded file and announces new ones.
 */
import pubsub from 'pubsub-js';
import { PreflightReport } from './preflight';

export const PREFLIGHT_TOPIC = 'gg:preflight:report';

export interface PreflightEntry {
    report: PreflightReport;
    fileName: string;
    at: number;
}

let current: PreflightEntry | null = null;

export const getPreflight = (): PreflightEntry | null => current;

export const setPreflight = (report: PreflightReport | null, fileName = '') => {
    current = report ? { report, fileName, at: Date.now() } : null;
    pubsub.publish(PREFLIGHT_TOPIC, current);
};
