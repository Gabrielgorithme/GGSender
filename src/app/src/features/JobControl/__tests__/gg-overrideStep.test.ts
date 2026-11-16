import store from 'app/store';
import { readOverrideStep } from '../FeedOverride';

describe('GGSender: override step setting', () => {
    const key = 'workspace.gg.spindleOverrideStep';
    it('reads the allowed steps, stored as text or number', () => {
        store.set(key, '1');
        expect(readOverrideStep(key)).toBe(1);
        store.set(key, 5);
        expect(readOverrideStep(key)).toBe(5);
        store.set(key, '10');
        expect(readOverrideStep(key)).toBe(10);
    });
    it('falls back to the upstream step of 10', () => {
        store.set(key, '3');
        expect(readOverrideStep(key)).toBe(10);
        store.set(key, 'abc');
        expect(readOverrideStep(key)).toBe(10);
        store.set(key, 0);
        expect(readOverrideStep(key)).toBe(10);
    });
});
