/*
 * GGSender addition (not part of upstream gSender).
 *
 * The homed state the server reads from the controller's reports
 * (src/server/lib/gg/homedState.js), for the pre-flight check. Upstream's
 * own flag (controller.hasHomed) only counts a homing sent by gSender and is
 * left as it is: the rapid-position, go-to and parking buttons keep using it.
 */
import { useEffect, useState } from 'react';
import pubsub from 'pubsub-js';

export const HOMED_FROM_CONTROLLER_KEY = 'workspace.gg.homedFromController';
export const HOMED_TOPIC = 'gg:homed';

export type HomedHow = 'seen' | 'before-connect' | null;

export interface HomedSnapshot {
    homed: boolean;
    how: HomedHow;
    axes: string;
}

const NOT_HOMED: HomedSnapshot = { homed: false, how: null, axes: '' };

let current: HomedSnapshot = NOT_HOMED;

const normalize = (s: unknown): HomedSnapshot => {
    const v = (s ?? {}) as Partial<HomedSnapshot>;
    const how = v.how === 'seen' || v.how === 'before-connect' ? v.how : null;
    return { homed: v.homed === true, how: v.homed === true ? how : null, axes: String(v.axes ?? '') };
};

export const getHomed = (): HomedSnapshot => current;

export const setHomed = (s: unknown) => {
    current = normalize(s);
    pubsub.publish(HOMED_TOPIC, current);
};

export const useHomed = (): HomedSnapshot => {
    const [value, setValue] = useState<HomedSnapshot>(current);
    useEffect(() => {
        setValue(current);
        const token = pubsub.subscribe(HOMED_TOPIC, (_msg: string, s: HomedSnapshot) => setValue(s));
        return () => {
            pubsub.unsubscribe(token);
        };
    }, []);
    return value;
};

/**
 * What the pre-flight goes by: homed when gSender homed the machine itself
 * (upstream's flag) or, with the setting on, when the controller says so.
 * `beforeConnect`: only known from the controller being out of alarm when
 * gSender connected (homed, or unlocked with $X).
 */
export const effectiveHomed = (
    upstreamHasHomed: boolean,
    fromController: HomedSnapshot,
    useController: boolean,
): { hasHomed: boolean; beforeConnect: boolean } => {
    if (upstreamHasHomed) {
        return { hasHomed: true, beforeConnect: false };
    }
    if (useController && fromController.homed) {
        return { hasHomed: true, beforeConnect: fromController.how === 'before-connect' };
    }
    return { hasHomed: false, beforeConnect: false };
};
