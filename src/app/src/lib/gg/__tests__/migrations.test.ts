import { applyGGMigrations, GG_SETTINGS_VERSION_KEY } from '../migrations';

const makeStore = (initial: Record<string, any>) => {
    const data = { ...initial };
    return {
        data,
        get: (k: string, d?: any) => (k in data ? data[k] : d),
        set: (k: string, v: any) => {
            data[k] = v;
        },
    };
};

describe('GGSender: settings migrations', () => {
    it('sets the feed step to 1% once for a 0.3.0 install', () => {
        const s = makeStore({ 'workspace.gg.feedOverrideStep': '10' });
        expect(applyGGMigrations(s.get, s.set)).toEqual([4, 5]);
        expect(s.data['workspace.gg.feedOverrideStep']).toBe('1');
        expect(s.data[GG_SETTINGS_VERSION_KEY]).toBe(5);
    });

    it('0.5.1: moves the spindle step from the old default 10 to 1%, once', () => {
        const s = makeStore({ 'workspace.gg.spindleOverrideStep': '10', [GG_SETTINGS_VERSION_KEY]: 4 });
        expect(applyGGMigrations(s.get, s.set)).toEqual([5]);
        expect(s.data['workspace.gg.spindleOverrideStep']).toBe('1');
        expect(s.data[GG_SETTINGS_VERSION_KEY]).toBe(5);
        // chosen 10 again afterwards: left alone
        s.data['workspace.gg.spindleOverrideStep'] = '10';
        expect(applyGGMigrations(s.get, s.set)).toEqual([]);
        expect(s.data['workspace.gg.spindleOverrideStep']).toBe('10');
    });

    it('0.5.1: keeps a finer spindle step chosen earlier', () => {
        for (const step of ['1', '2', '5']) {
            const s = makeStore({ 'workspace.gg.spindleOverrideStep': step, [GG_SETTINGS_VERSION_KEY]: 4 });
            applyGGMigrations(s.get, s.set);
            expect(s.data['workspace.gg.spindleOverrideStep']).toBe(step);
        }
    });

    it('leaves a later choice alone', () => {
        const s = makeStore({ 'workspace.gg.feedOverrideStep': '5', [GG_SETTINGS_VERSION_KEY]: 5 });
        expect(applyGGMigrations(s.get, s.set)).toEqual([]);
        expect(s.data['workspace.gg.feedOverrideStep']).toBe('5');
    });
});
