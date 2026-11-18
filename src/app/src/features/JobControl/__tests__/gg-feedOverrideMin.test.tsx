/*
 * GGSender: the feed override slider goes down to 10% (FluidNC's minimum),
 * or 20% with the upstream setting.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import store from 'app/store';
import { FEED_OVERRIDE_MIN_KEY, feedOverrideMin } from 'app/lib/gg/overrideLimits';

const sent: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: { command: (...args: any[]) => sent.push(args) },
}));
jest.mock('app/hooks/useWorkspaceState.ts', () => ({
    useWorkspaceState: () => ({ units: 'mm' }),
}));
jest.mock('posthog-js', () => ({ capture: () => undefined }));

// eslint-disable-next-line import/first
import Overrides from '../FeedOverride';

(global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const feedRequests = () => sent.filter(([c]) => c === 'feedOverride').map(([, v]) => v);

const lowest = async (min: string) => {
    sent.length = 0;
    store.set(FEED_OVERRIDE_MIN_KEY, min);
    const r = render(<Overrides ovF={100} ovS={100} ovTimestamp={0} feedrate="1000" spindle="24000" isConnected />);
    const minus = screen.getByRole('button', { name: 'Decrease Feed override' });
    for (let i = 0; i < 12; i++) {
        fireEvent.click(minus);
    }
    await wait(1000);
    r.unmount();
    return Math.min(...feedRequests());
};

describe('GGSender: feed override minimum', () => {
    beforeEach(() => {
        store.set('workspace.gg.feedOverrideStep', '10');
    });
    it('the setting: 10 unless 20', () => {
        expect(feedOverrideMin('10')).toBe(10);
        expect(feedOverrideMin('20')).toBe(20);
        expect(feedOverrideMin(undefined)).toBe(10);
        expect(feedOverrideMin('5')).toBe(10);
    });
    it('the - button goes down to 10%, not lower', async () => {
        expect(await lowest('10')).toBe(10);
    });
    it('upstream setting: 20%', async () => {
        expect(await lowest('20')).toBe(20);
    });
});
