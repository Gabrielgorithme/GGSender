/*
 * GGSender addition (not part of upstream gSender).
 *
 * Settings of the pause-as-feed-hold (server: src/server/lib/gg/holdPause.js).
 * The server decides what a pause does, so the settings are sent to it, in
 * its stored preferences: on connection and whenever one changes.
 */
import store from 'app/store';
import controller from 'app/lib/controller';

export const PAUSE_MODE_KEY = 'workspace.gg.pauseMode';
export const HOLD_STOPS_SPINDLE_KEY = 'workspace.gg.holdStopsSpindle';
export const RESUME_SPINUP_KEY = 'workspace.gg.resumeSpinupSeconds';

export const PAUSE_HOLD = 'Immediate feed hold';
export const PAUSE_UPSTREAM = 'Upstream: run the Program Pause event';
export const PAUSE_MODES = [PAUSE_HOLD, PAUSE_UPSTREAM];

export const DEFAULT_SPINUP_SECONDS = 5;

type Get = (key: string, fallback?: unknown) => unknown;

export const spinupSeconds = (get: Get): number => {
    const raw = get(RESUME_SPINUP_KEY, DEFAULT_SPINUP_SECONDS);
    const n = raw === '' || raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : DEFAULT_SPINUP_SECONDS;
};

/** What the server stores (preferences.ggPauseMode, ...). */
export const holdSettingsPayload = (get: Get) => ({
    ggPauseMode: get(PAUSE_MODE_KEY, PAUSE_HOLD) === PAUSE_UPSTREAM ? 'upstream' : 'hold',
    ggHoldStopsSpindle: get(HOLD_STOPS_SPINDLE_KEY, false) === true,
    ggResumeSpinupSeconds: spinupSeconds(get),
});

export const pushHoldSettings = () => {
    controller.command('settings:updated', holdSettingsPayload((k, d) => store.get(k, d)));
};
