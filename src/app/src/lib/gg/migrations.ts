/*
 * GGSender addition (not part of upstream gSender).
 *
 * One-time changes to settings saved by an earlier GGSender build. Runs at
 * start-up, after the saved settings are loaded. Each step runs once:
 * workspace.gg.settingsVersion records the last one applied.
 */
export const GG_SETTINGS_VERSION_KEY = 'workspace.gg.settingsVersion';

type Get = (key: string, fallback?: any) => any;
type Set = (key: string, value: any) => void;

const STEPS: Array<{ version: number; apply: (get: Get, set: Set) => void }> = [
    {
        // 0.4.0: feed override in 1% steps by default (0.3.0 saved 10)
        version: 4,
        apply: (_get, set) => {
            set('workspace.gg.feedOverrideStep', '1');
        },
    },
];

/** @returns the versions applied */
export const applyGGMigrations = (get: Get, set: Set): number[] => {
    const from = Number(get(GG_SETTINGS_VERSION_KEY, 0)) || 0;
    const applied: number[] = [];
    STEPS.forEach((step) => {
        if (step.version > from) {
            step.apply(get, set);
            applied.push(step.version);
        }
    });
    const latest = STEPS[STEPS.length - 1].version;
    if (from < latest) {
        set(GG_SETTINGS_VERSION_KEY, latest);
    }
    return applied;
};
