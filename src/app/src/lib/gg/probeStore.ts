/*
 * GGSender addition (not part of upstream gSender).
 *
 * The tool sensor reference as the server tracks it
 * (src/server/lib/gg/probeHistory.js): whether a reference exists, which
 * tool it was probed with and when, whether the work Z zero changed after
 * it, and the history. The server sends a snapshot at each change
 * ("gg:probe:state"); this keeps the last one for the interface.
 *
 * Also tells the server which tool the interface records as loaded, so that
 * the history can name the tools.
 */
import { useEffect, useState } from 'react';
import pubsub from 'pubsub-js';

import controller from 'app/lib/controller';
import store from 'app/store';
import { LOADED_TOOL_KEY, getLoadedTool } from './loadedTool';

/** Setting: follow the reference at tool changes (off: upstream's count of tool changes). */
export const REFERENCE_GUARD_KEY = 'workspace.gg.referenceGuard';
export const REFERENCE_TOPIC = 'gg:probe:state';

export type ReferenceStatus = 'valid' | 'stale' | 'none';
export type HistoryKind = 'reference' | 'measured' | 'zero' | 'wcs' | 'program';

export interface HistoryEntry {
    kind: HistoryKind;
    at: number;
    tool?: string | null;
    value?: number; // reference: the work Z read on the sensor (mm)
    zeroShift?: number; // reference: how much higher Z zero is than with the reference before (mm)
    deltaZ?: number | null; // how much the work Z of a fixed point moved (mm)
    oldReference?: boolean; // measured against a reference that was stale
    restored?: boolean; // the offset the reference goes with is back
    from?: string;
    to?: string;
}

export interface ReferenceSnapshot {
    status: ReferenceStatus;
    reference: { value: number; tool: string | null; at: number; wcs: string | null } | null;
    lastProbe: { kind: 'reference' | 'measured'; tool: string | null; at: number } | null;
    stale: { kind: 'zero' | 'wcs' | 'program'; at: number; deltaZ: number | null; from?: string; to?: string } | null;
    watching: boolean;
    wcs: string | null;
    history: HistoryEntry[];
    /** false: no state from the server (not connected) */
    live: boolean;
}

export const NO_REFERENCE: ReferenceSnapshot = {
    status: 'none',
    reference: null,
    lastProbe: null,
    stale: null,
    watching: true,
    wcs: null,
    history: [],
    live: false,
};

let current: ReferenceSnapshot = NO_REFERENCE;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Whatever arrives is read defensively: a wrong "valid" would move Z. */
export const normalizeReference = (s: unknown): ReferenceSnapshot => {
    const v = (s ?? {}) as Record<string, any>;
    const ref = v.reference && num(v.reference.value) !== null && num(v.reference.at) !== null
        ? {
              value: v.reference.value as number,
              tool: text(v.reference.tool),
              at: v.reference.at as number,
              wcs: text(v.reference.wcs),
          }
        : null;
    let status: ReferenceStatus = v.status === 'valid' || v.status === 'stale' ? v.status : 'none';
    if (!ref) {
        status = 'none';
    }
    const last = v.lastProbe && num(v.lastProbe.at) !== null && (v.lastProbe.kind === 'reference' || v.lastProbe.kind === 'measured')
        ? { kind: v.lastProbe.kind, tool: text(v.lastProbe.tool), at: v.lastProbe.at as number }
        : null;
    const stale = status === 'stale' && v.stale && num(v.stale.at) !== null
        ? {
              kind: (['zero', 'wcs', 'program'].includes(v.stale.kind) ? v.stale.kind : 'zero') as 'zero' | 'wcs' | 'program',
              at: v.stale.at as number,
              deltaZ: num(v.stale.deltaZ),
              from: text(v.stale.from) ?? undefined,
              to: text(v.stale.to) ?? undefined,
          }
        : null;
    const history: HistoryEntry[] = Array.isArray(v.history)
        ? v.history.filter((h: any) => h && typeof h.kind === 'string' && num(h.at) !== null)
        : [];
    return {
        status,
        reference: ref,
        lastProbe: last,
        stale,
        watching: v.watching !== false,
        wcs: text(v.wcs),
        history,
        live: true,
    };
};

export const getReference = (): ReferenceSnapshot => current;

export const setReference = (s: unknown) => {
    current = s === null ? NO_REFERENCE : normalizeReference(s);
    // at once: what is on screen must never lag behind the state
    pubsub.publishSync(REFERENCE_TOPIC, current);
};

export const useReference = (): ReferenceSnapshot => {
    const [value, setValue] = useState<ReferenceSnapshot>(current);
    useEffect(() => {
        setValue(current);
        const token = pubsub.subscribe(REFERENCE_TOPIC, (_msg: string, s: ReferenceSnapshot) => setValue(s));
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);
    return value;
};

// ---- the loaded tool, for the server's history --------------------------------

let lastPushed: string | null | undefined;

/** Send the recorded tool to the server (on connection, and when it changes). */
export const pushLoadedTool = (force = false) => {
    const { tool } = getLoadedTool();
    if (!force && tool === lastPushed) {
        return;
    }
    lastPushed = tool;
    controller.command('gg:probe:loaded', tool);
};

let watching = false;

export const watchLoadedTool = () => {
    if (watching) {
        return;
    }
    watching = true;
    store.on('change', () => {
        // only when this key moved: the store reports every change
        if (store.get(LOADED_TOOL_KEY, null)?.tool !== lastPushed) {
            pushLoadedTool();
        }
    });
};
