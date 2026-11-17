/*
 * GGSender: the spindle override slider with the default settings moves in
 * 1% steps, and a drag released off the slider is still sent.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import store from 'app/store';

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

// jsdom has no ResizeObserver; the slider only needs it for layout
(global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

// the spindle row: reset, minus, plus (the +/- buttons have no accessible name)
const spindleButtons = () => {
    const reset = screen.getByRole('button', { name: 'Reset Spindle override to 100%' });
    const row = reset.closest('div.flex.flex-row') as HTMLElement;
    const [, minus, plus] = within(row).getAllByRole('button');
    return { minus, plus };
};

const renderOverrides = () =>
    render(<Overrides ovF={100} ovS={100} ovTimestamp={0} feedrate="1000" spindle="24000" isConnected />);

describe('GGSender: spindle override, default settings', () => {
    beforeEach(() => {
        sent.length = 0;
        store.set('workspace.spindleFunctions', true);
        store.set('widgets.spindle.mode', 'spindle');
        store.set('workspace.gg.spindleOverrideStep', '1');
    });

    it('+ asks for 101%, then - back to 100%', async () => {
        renderOverrides();
        fireEvent.click(spindleButtons().plus);
        await wait(300);
        expect(sent).toContainEqual(['spindleOverride', 101]);
        sent.length = 0;
        fireEvent.click(spindleButtons().minus);
        await wait(300);
        expect(sent).toContainEqual(['spindleOverride', 100]);
    });

    it('a drag ending off the slider is sent', async () => {
        const { container } = renderOverrides();
        const slider = container.querySelector('#spindle-override') as HTMLElement;
        expect(slider).not.toBeNull();
        fireEvent.lostPointerCapture(slider);
        await wait(300);
        expect(sent).toContainEqual(['spindleOverride', 100]);
    });

    it('step 10 still gives the upstream 10% step', async () => {
        store.set('workspace.gg.spindleOverrideStep', '10');
        renderOverrides();
        fireEvent.click(spindleButtons().plus);
        await wait(1100);
        expect(sent).toContainEqual(['spindleOverride', 110]);
    });
});
