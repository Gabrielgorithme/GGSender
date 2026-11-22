// GGSender: the notice for lines refused during a jog, and "the machine is ready"
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import { setRefused, setSettled } from 'app/lib/gg/refusedStore';

const mockCommands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: { command: (...args: any[]) => mockCommands.push(args), addListener: jest.fn(), removeListener: jest.fn() },
}));
jest.mock('app/features/Helper/context', () => ({ useWizardContext: () => ({}) }));

// eslint-disable-next-line import/first
import { RefusedLinesNotice } from '../RefusedLinesNotice';
// eslint-disable-next-line import/first
import { MachineReady } from '../ToolChangeReason';

const withState = (activeState: string, node: React.ReactNode) =>
    render(<Provider store={configureStore({ reducer: () => ({ controller: { state: { status: { activeState } } } }) as any })}>{node}</Provider>);

const OWNER: Record<string, any> = {
    lines: [
        { source: 'job', text: 'N1052420 G28 G91 Z0' },
        { source: 'job', text: 'N1052425 G90' },
        { source: 'job', text: 'N1052430 (M6)' },
        { source: 'feeder', text: 'G4 P0.5' },
    ],
    moves: true,
    broken: null,
    replaying: false,
};

describe('GGSender: notice for refused lines', () => {
    beforeEach(() => {
        mockCommands.length = 0;
        act(() => setRefused(null));
    });
    afterEach(() => act(() => setRefused(null)));

    it('shows nothing while no line was refused', () => {
        withState('Idle', <RefusedLinesNotice />);
        expect(screen.queryByTestId('gg-refused')).toBeNull();
    });

    it('the owner\'s case: the lines, and "Send again" asks the server', () => {
        withState('Idle', <RefusedLinesNotice />);
        act(() => setRefused(OWNER));
        expect(screen.getByTestId('gg-refused-title')).toHaveTextContent('The controller refused 3 lines');
        expect(screen.getByTestId('gg-refused-lines').textContent).toBe('N1052420 G28 G91 Z0\nN1052425 G90\nG4 P0.5');
        expect(screen.getByTestId('gg-refused-action')).toHaveTextContent('Press Send again to send these lines now. The machine can move.');
        const button = screen.getByTestId('gg-refused-send');
        expect(button).toBeEnabled();
        fireEvent.click(button);
        expect(mockCommands).toEqual([['gg:refused:replay']]);
    });

    it('while the machine is not idle the button cannot be pressed', () => {
        withState('Jog', <RefusedLinesNotice />);
        act(() => setRefused(OWNER));
        expect(screen.getByTestId('gg-refused-send')).toBeDisabled();
        expect(screen.getByTestId('gg-refused-action')).toHaveTextContent('Wait until the machine is idle. Then press Send again.');
    });

    it('it goes away when the lines were sent again', () => {
        withState('Idle', <RefusedLinesNotice />);
        act(() => setRefused(OWNER));
        act(() => setRefused({ ...OWNER, replaying: true }));
        expect(screen.queryByTestId('gg-refused-send')).toBeNull();
        expect(screen.getByTestId('gg-refused-action')).toHaveTextContent('gSender sends the lines again.');
        act(() => setRefused({ lines: [], moves: false, broken: null, replaying: false }));
        expect(screen.queryByTestId('gg-refused')).toBeNull();
    });

    it('a broken sequence: red, no button, stop the job', () => {
        withState('Idle', <RefusedLinesNotice />);
        act(() => setRefused({ ...OWNER, broken: 'accepted-after-refused' }));
        expect(screen.getByTestId('gg-refused').dataset.severe).toBe('true');
        expect(screen.queryByTestId('gg-refused-send')).toBeNull();
        expect(screen.getByTestId('gg-refused-action')).toHaveTextContent('Stop the job. Then use Resume From.');
    });
});

describe('GGSender: "the machine is ready" in the tool change window', () => {
    afterEach(() => act(() => setSettled(null)));

    it('says WAIT while lines wait in the controller, and ready after that', () => {
        withState('Idle', <MachineReady />);
        act(() => setSettled(false));
        expect(screen.getByTestId('gg-machine-ready').dataset.ready).toBe('false');
        expect(screen.getByTestId('gg-machine-ready')).toHaveTextContent('WAIT. The machine is not ready. Do not jog.');
        act(() => setSettled(true));
        expect(screen.getByTestId('gg-machine-ready').dataset.ready).toBe('true');
        expect(screen.getByTestId('gg-machine-ready')).toHaveTextContent('The machine is ready. You can jog.');
    });

    it('not connected: no WAIT', () => {
        act(() => setSettled(false));
        act(() => setSettled(null));
        withState('', <MachineReady />);
        expect(screen.getByTestId('gg-machine-ready').dataset.ready).toBe('true');
    });
});
