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
        expect(applyGGMigrations(s.get, s.set)).toEqual([4]);
        expect(s.data['workspace.gg.feedOverrideStep']).toBe('1');
        expect(s.data[GG_SETTINGS_VERSION_KEY]).toBe(4);
    });

    it('leaves a later choice alone', () => {
        const s = makeStore({ 'workspace.gg.feedOverrideStep': '5', [GG_SETTINGS_VERSION_KEY]: 4 });
        expect(applyGGMigrations(s.get, s.set)).toEqual([]);
        expect(s.data['workspace.gg.feedOverrideStep']).toBe('5');
    });
});
