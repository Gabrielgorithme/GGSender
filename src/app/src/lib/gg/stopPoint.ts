/*
 * GGSender addition (not part of upstream gSender).
 *
 * Where the last job stopped before its end: the program, how far gSender had
 * got (its count of acknowledged lines) and where the tool was (work
 * position from the last status report). Kept in the settings store so it
 * survives a restart. The resume dialog uses it to find the move the tool was
 * on (resumePlan.nearestMove): gSender's count runs ahead of the machine by
 * the controller's planner queue, up to some tens of lines.
 */
import store from 'app/store';

export const LAST_STOP_KEY = 'workspace.gg.lastStop';

export interface StopRecord {
    fileName: string;
    total: number; // the server's line count (the program plus its %wait line)
    received: number;
    wpos: { x: number; y: number; z: number };
    inches: boolean; // the position was reported in inches ($13=1)
    at: number;
}

interface Live {
    total: number;
    received: number;
}

let live: Live | null = null;

/** Every sender status while connected. */
export const noteSenderStatus = (status: any) => {
    const sent = Number(status?.sent);
    const total = Number(status?.total);
    if (sent > 0 && total > 0) {
        live = { total, received: Number(status?.received) || 0 };
    }
};

type Setter = (key: string, value: unknown) => void;

/**
 * The job is over (the workflow went idle, or the connection closed): keep
 * the stop point when it ended early, forget it when the job ran to its end.
 * `where` gives the tool position and the loaded file's name (the server's
 * sender has no usable name: the interface sends it as a bare string).
 */
export const noteJobOver = (
    where: () => { wpos: any; inches: boolean; fileName: string },
    set: Setter = (k, v) => store.set(k, v),
    now: () => number = Date.now,
): StopRecord | null => {
    const job = live;
    live = null;
    if (!job) {
        return null;
    }
    if (job.received >= job.total - 1) {
        set(LAST_STOP_KEY, null);
        return null;
    }
    const { wpos, inches, fileName } = where();
    const p = { x: Number(wpos?.x), y: Number(wpos?.y), z: Number(wpos?.z) };
    if (![p.x, p.y, p.z].every(Number.isFinite)) {
        return null;
    }
    const record: StopRecord = { fileName: String(fileName ?? ''), ...job, wpos: p, inches, at: now() };
    set(LAST_STOP_KEY, record);
    return record;
};

export const getStopRecord = (): StopRecord | null => {
    const r = store.get(LAST_STOP_KEY, null) as StopRecord | null;
    return r && typeof r === 'object' && Number.isFinite(Number(r.received)) ? r : null;
};

/** The stop record, when it is for this program (same name and length). */
export const stopFor = (record: StopRecord | null, fileName: string, programLines: number): StopRecord | null => {
    if (!record) return null;
    if (record.fileName !== fileName) return null;
    // the server counts the program's non-blank lines plus its %wait line
    if (record.total !== programLines + 1 && record.total !== programLines) return null;
    return record;
};

/** The stop position in program units. */
export const stopPosition = (record: StopRecord, programInches: boolean) => {
    const k = record.inches === programInches ? 1 : programInches ? 1 / 25.4 : 25.4;
    return { x: record.wpos.x * k, y: record.wpos.y * k, z: record.wpos.z * k };
};

/** For tests. */
export const resetLiveJob = () => {
    live = null;
};
