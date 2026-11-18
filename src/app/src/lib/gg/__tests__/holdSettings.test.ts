// GGSender: the pause settings as sent to the server
import {
    HOLD_STOPS_SPINDLE_KEY,
    PAUSE_HOLD,
    PAUSE_MODE_KEY,
    PAUSE_UPSTREAM,
    RESUME_SPINUP_KEY,
    holdSettingsPayload,
    spinupSeconds,
} from '../holdSettings';
import { RESET_OVERRIDES_KEY } from '../opBoundaries';
import { holdPreferences } from '../../../../../server/lib/gg/holdPause';
import { resetPreference } from '../../../../../server/lib/gg/opResets';

const getter = (data: Record<string, unknown>) => (k: string, d?: unknown) => (k in data ? data[k] : d);

describe('GGSender: pause settings', () => {
    it('defaults: immediate hold, spindle left running, 5 s spin-up', () => {
        expect(holdSettingsPayload(getter({}))).toEqual({
            ggPauseMode: 'hold',
            ggHoldStopsSpindle: false,
            ggResumeSpinupSeconds: 5,
            ggResetOverridesPerOp: true,
            ggHoldOnError: true,
        });
    });

    it('maps the choices', () => {
        expect(
            holdSettingsPayload(
                getter({ [PAUSE_MODE_KEY]: PAUSE_UPSTREAM, [HOLD_STOPS_SPINDLE_KEY]: true, [RESUME_SPINUP_KEY]: '8' }),
            ),
        ).toEqual({ ggPauseMode: 'upstream', ggHoldStopsSpindle: true, ggResumeSpinupSeconds: 8, ggResetOverridesPerOp: true, ggHoldOnError: true });
        expect(holdSettingsPayload(getter({ [PAUSE_MODE_KEY]: PAUSE_HOLD })).ggPauseMode).toBe('hold');
        expect(holdSettingsPayload(getter({ [PAUSE_MODE_KEY]: 'nonsense' })).ggPauseMode).toBe('hold');
    });

    it('spin-up: 0 allowed, bad values give 5, capped at 60', () => {
        expect(spinupSeconds(getter({ [RESUME_SPINUP_KEY]: 0 }))).toBe(0);
        expect(spinupSeconds(getter({ [RESUME_SPINUP_KEY]: '' }))).toBe(5);
        expect(spinupSeconds(getter({ [RESUME_SPINUP_KEY]: -2 }))).toBe(5);
        expect(spinupSeconds(getter({ [RESUME_SPINUP_KEY]: 'x' }))).toBe(5);
        expect(spinupSeconds(getter({ [RESUME_SPINUP_KEY]: 120 }))).toBe(60);
    });

    it('the server reads what the interface sends', () => {
        const sent = holdSettingsPayload(
            getter({ [PAUSE_MODE_KEY]: PAUSE_HOLD, [HOLD_STOPS_SPINDLE_KEY]: true, [RESUME_SPINUP_KEY]: 7 }),
        );
        expect(holdPreferences(sent)).toEqual({ mode: 'hold', stopSpindle: true, spinupMs: 7000 });
        expect(holdPreferences(holdSettingsPayload(getter({ [PAUSE_MODE_KEY]: PAUSE_UPSTREAM }))).mode).toBe('upstream');
        expect(resetPreference(holdSettingsPayload(getter({})))).toBe(true);
        expect(resetPreference(holdSettingsPayload(getter({ [RESET_OVERRIDES_KEY]: false })))).toBe(false);
        // a server that never got the setting resets (the default)
        expect(resetPreference({})).toBe(true);
    });
});
