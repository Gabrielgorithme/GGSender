// GGSender: operations list in the 3D view
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import store from 'app/store';
import { analyzeJob } from 'app/lib/gg/jobOperations';
import { setJobInfo } from 'app/lib/gg/jobInfoStore';
import { JobOperations, OPERATIONS_PANEL_KEY } from '../JobOperations';
import { PICK_REQUEST } from '../pickTopics';

const tick = () => new Promise((r) => setTimeout(r, 0));

const PROGRAM = [
    '(job)', // seq 0
    '(T1 D=6 CR=0 - ZMIN=-3 - flat end mill)', // 1
    '(T2 D=4 CR=0 TAPER=45deg - ZMIN=-0.5 - chamfer mill)', // 2
    'G21', // 3
    '', //
    '(Adaptive1)', // 4
    'T1 M6', // 5
    'G0 X0 Y0', // 6
    'G1 Z-1 F100', // 7
    '', //
    '(Contour1)', // 8
    'G1 X10', // 9
    'G1 X20', // 10
    '', //
    '(Chamfer1)', // 11
    'T2 M6', // 12
    'G0 X5', // 13
    'G1 Z-0.5', // 14
    'M30', // 15
].join('\n');
// one estimate per line with code: G21, T1 M6, G0, G1, G1, G1, T2 M6, G0, G1, M30
const ESTIMATES = [0, 0, 1, 59, 60, 60, 0, 1, 119, 0];

const reduxState = (sender: any, workflow = 'running', fileLoaded = true) => ({
    controller: { sender: { status: sender }, workflow: { state: workflow } },
    file: { fileLoaded },
});

const renderPanel = (state: any) =>
    render(
        <Provider store={configureStore({ reducer: () => state })}>
            <JobOperations fallback={<div data-testid="upstream-timeline">timeline</div>} />
        </Provider>,
    );

const load = async (program: string | null) => {
    await act(async () => {
        setJobInfo(program === null ? null : analyzeJob(program, ESTIMATES), 'job.nc');
        await tick();
    });
};

describe('GGSender: operations list', () => {
    beforeEach(() => {
        store.set(OPERATIONS_PANEL_KEY, true);
        setJobInfo(null);
    });

    it('lists operations under their tool, with times, nothing running', async () => {
        renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
        await load(PROGRAM);
        const panel = screen.getByTestId('gg-ops-panel');
        expect(within(panel).getByText('3 operations')).toBeInTheDocument();
        const g0 = screen.getByTestId('gg-ops-group-0');
        expect(within(g0).getByText('T1')).toBeInTheDocument();
        expect(within(g0).getByText('⌀6 flat end mill')).toBeInTheDocument();
        expect(within(g0).getByText('Adaptive1')).toBeInTheDocument();
        expect(within(g0).getByText('Contour1')).toBeInTheDocument();
        expect(within(g0).getByText('2 min')).toBeInTheDocument(); // group T1: 1 + 59 + 60 + 60 s
        expect(within(screen.getByTestId('gg-ops-group-1')).getByText('⌀4 45° chamfer mill')).toBeInTheDocument();
        expect(screen.getByTestId('gg-op-0').dataset.state).toBe('idle');
        expect(screen.queryByTestId('gg-ops-next-change')).toBeNull();
        // the upstream timeline stays mounted, hidden
        expect(screen.getByTestId('gg-ops-fallback')).toHaveClass('hidden');
    });

    it('marks done, running and upcoming, and the time to the next tool change', async () => {
        // running line 9 (seq): first line of Contour1's moves
        renderPanel(reduxState({ sent: 14, received: 12, total: 17, currentLineRunning: 10 }));
        await load(PROGRAM);
        expect(screen.getByTestId('gg-op-0').dataset.state).toBe('done');
        expect(screen.getByTestId('gg-op-1').dataset.state).toBe('current');
        expect(screen.getByTestId('gg-op-2').dataset.state).toBe('upcoming');
        expect(screen.getByText('2/3')).toBeInTheDocument();
        // Contour1 is lines 8..10 (3 lines, 120 s); at line 9 a third is done: 80 s left
        expect(screen.getByTestId('gg-ops-next-change')).toHaveTextContent('Next tool change: T2 in ~1 min');
        expect(screen.getByTestId('gg-op-progress')).toHaveStyle({ width: '33%' });
    });

    it('in the last tool group there is no next tool change', async () => {
        renderPanel(reduxState({ sent: 16, received: 15, total: 17, currentLineRunning: 15 }));
        await load(PROGRAM);
        expect(screen.getByTestId('gg-op-2').dataset.state).toBe('current');
        expect(screen.queryByTestId('gg-ops-next-change')).toBeNull();
    });

    it('a click on an operation shows its first move in the 3D view', async () => {
        const requests: any[] = [];
        const token = pubsub.subscribe(PICK_REQUEST, (_m: string, d: any) => requests.push(d));
        renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
        await load(PROGRAM);
        fireEvent.click(screen.getByText('Contour1'));
        await act(async () => {
            await tick();
        });
        pubsub.unsubscribe(token);
        expect(requests).toEqual([{ line: 11 }]); // 0-based file line of "G1 X10"
    });

    it('collapses to one line showing the running operation', async () => {
        renderPanel(reduxState({ sent: 14, received: 12, total: 17, currentLineRunning: 10 }));
        await load(PROGRAM);
        fireEvent.click(screen.getByTestId('gg-ops-toggle'));
        expect(screen.queryByTestId('gg-ops-list')).toBeNull();
        expect(within(screen.getByTestId('gg-ops-toggle')).getByText('Contour1')).toBeInTheDocument();
    });

    it('setting off, no operations, or no file: the upstream timeline', async () => {
        const { unmount } = renderPanel(reduxState({ sent: 0 }, 'idle'));
        await load('G21\nT1 M6\nG0 X0\n');
        expect(screen.queryByTestId('gg-ops-panel')).toBeNull();
        expect(screen.getByTestId('gg-ops-fallback')).not.toHaveClass('hidden');
        unmount();

        store.set(OPERATIONS_PANEL_KEY, false);
        const second = renderPanel(reduxState({ sent: 0 }, 'idle'));
        await load(PROGRAM);
        expect(screen.queryByTestId('gg-ops-panel')).toBeNull();
        // turned on in Settings: shown without reloading the file
        await act(async () => {
            store.set(OPERATIONS_PANEL_KEY, true);
            await tick();
        });
        expect(screen.getByTestId('gg-ops-panel')).toBeInTheDocument();
        second.unmount();

        renderPanel(reduxState({ sent: 0 }, 'idle', false));
        await load(PROGRAM);
        expect(screen.queryByTestId('gg-ops-panel')).toBeNull();
    });
});
