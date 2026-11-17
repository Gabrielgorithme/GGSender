// GGSender: spindle stop/start button while the job is held
import { act, fireEvent, render, screen } from '@testing-library/react';
import store from 'app/store';
import { HoldState, holdDisplay } from '../HoldSpindleControl';

const listeners: Record<string, (s: any) => void> = {};
const commands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: {
        addListener: (event: string, fn: (s: any) => void) => {
            listeners[event] = fn;
        },
        removeListener: (event: string) => {
            delete listeners[event];
        },
        command: (...args: any[]) => commands.push(args),
    },
}));

// eslint-disable-next-line import/first
import HoldSpindleControl from '../HoldSpindleControl';

const base: HoldState = {
    active: true,
    holding: true,
    holdComplete: true,
    spindleOn: true,
    spindleWasOn: true,
    stopped: false,
    pending: false,
    resuming: false,
    resumeInMs: null,
    canToggle: true,
};

const send = (s: Partial<HoldState>) =>
    act(() => {
        listeners['gg:hold:state']({ ...base, ...s });
    });

describe('GGSender: hold control', () => {
    beforeEach(() => {
        commands.length = 0;
        store.set('workspace.gg.resumeSpinupSeconds', 6);
    });

    it('asks the server for the state, shows nothing outside a hold', () => {
        render(<HoldSpindleControl />);
        expect(commands).toEqual([['gg:hold:query']]);
        expect(screen.queryByTestId('gg-hold-control')).toBeNull();
        send({ active: false });
        expect(screen.queryByTestId('gg-hold-control')).toBeNull();
    });

    it('held with the spindle turning: "Stop spindle" sends the toggle', () => {
        render(<HoldSpindleControl />);
        send({});
        const button = screen.getByTestId('gg-hold-spindle');
        expect(button).toHaveTextContent('Stop spindle');
        fireEvent.click(button);
        expect(commands).toContainEqual(['gg:hold:spindle']);
        expect(screen.getByTestId('gg-hold-caption')).toHaveTextContent('Held · spindle turning');
    });

    it('spindle stopped: "Start spindle", and what Resume will do', () => {
        render(<HoldSpindleControl />);
        send({ stopped: true, spindleOn: false });
        expect(screen.getByTestId('gg-hold-spindle')).toHaveTextContent('Start spindle');
        expect(screen.getByTestId('gg-hold-caption')).toHaveTextContent('Resume starts it and waits 6 s');
    });

    it('waiting for the controller: button disabled', () => {
        render(<HoldSpindleControl />);
        send({ holding: false, canToggle: false });
        expect(screen.getByTestId('gg-hold-spindle')).toBeDisabled();
        expect(screen.getByTestId('gg-hold-spindle')).toHaveTextContent('Holding…');
        send({ pending: true, stopped: true, canToggle: false });
        expect(screen.getByTestId('gg-hold-spindle')).toHaveTextContent('Stopping spindle…');
        expect(screen.getByTestId('gg-hold-spindle')).toBeDisabled();
    });

    it('resuming: counts down the spin-up, no button', () => {
        jest.useFakeTimers();
        try {
            render(<HoldSpindleControl />);
            send({ resuming: true, resumeInMs: 3000, canToggle: false });
            expect(screen.queryByTestId('gg-hold-spindle')).toBeNull();
            expect(screen.getByTestId('gg-hold-caption')).toHaveTextContent('resuming in 3 s');
            act(() => {
                jest.advanceTimersByTime(1100);
            });
            expect(screen.getByTestId('gg-hold-caption')).toHaveTextContent('resuming in 2 s');
        } finally {
            jest.useRealTimers();
        }
    });

    it('spindle was off at the pause: nothing to stop', () => {
        expect(holdDisplay({ ...base, spindleWasOn: false, canToggle: false }, null, 5)).toMatchObject({
            button: null,
            caption: 'Held · spindle was off',
        });
    });
});
