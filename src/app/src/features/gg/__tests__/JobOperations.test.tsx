// GGSender: operations list in the 3D view
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import store from 'app/store';
import { analyzeJob } from 'app/lib/gg/jobOperations';
import { setJobInfo } from 'app/lib/gg/jobInfoStore';
import { ISOLATE_OPERATION_KEY, JobOperations, OPERATIONS_PANEL_KEY } from '../JobOperations';
import { ISOLATE_REQUEST, PICK_REQUEST, publishIsolation } from '../pickTopics';

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

    describe('a click on an operation', () => {
        let isolateRequests: any[];
        let pickRequests: any[];
        let tokens: string[];
        beforeEach(() => {
            isolateRequests = [];
            pickRequests = [];
            // stands for the 3D view: it shows what is asked, and says so
            tokens = [
                pubsub.subscribe(ISOLATE_REQUEST, (_m: string, d: any) => {
                    isolateRequests.push(d);
                    publishIsolation(d.clear ? null : d);
                }),
                pubsub.subscribe(PICK_REQUEST, (_m: string, d: any) => pickRequests.push(d)),
            ];
        });
        afterEach(() => {
            tokens.forEach((t) => pubsub.unsubscribe(t));
            act(() => publishIsolation(null));
            store.set(ISOLATE_OPERATION_KEY, true);
        });
        // the button of an operation (the note above the list can show the same name)
        const op = (name: string) => within(screen.getByTestId('gg-ops-list')).getByText(name);
        const settle = () =>
            act(async () => {
                await tick();
            });

        it('shows only that operation in the 3D view, and the panel says so', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            expect(screen.queryByTestId('gg-ops-isolated')).toBeNull();
            fireEvent.click(op('Contour1'));
            await settle();
            // file lines: "(Contour1)" is line 10, "(Chamfer1)" is line 14
            expect(isolateRequests).toEqual([{ key: 'op:1', label: 'Contour1', firstLine: 10, endLine: 14 }]);
            expect(pickRequests).toEqual([]);
            expect(screen.getByTestId('gg-ops-isolated')).toHaveTextContent('The 3D view shows only Contour1.');
            expect(screen.getByTestId('gg-op-1').dataset.isolated).toBe('true');
            expect(screen.getByTestId('gg-op-0').dataset.isolated).toBeUndefined();
            expect(op('Contour1')).toHaveAttribute('aria-pressed', 'true');
            expect(op('Contour1').title).toContain('Click to show all operations in the 3D view.');
            expect(op('Adaptive1').title).toContain('Click to show only this operation in the 3D view.');
        });

        it('the last operation runs to the end of the file', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Chamfer1'));
            await settle();
            expect(isolateRequests).toEqual([{ key: 'op:2', label: 'Chamfer1', firstLine: 14, endLine: null }]);
        });

        it('a second click, or "Show all", shows all operations again', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            fireEvent.click(op('Contour1'));
            await settle();
            expect(isolateRequests[1]).toEqual({ clear: true });
            expect(screen.queryByTestId('gg-ops-isolated')).toBeNull();
            expect(screen.getByTestId('gg-op-1').dataset.isolated).toBeUndefined();

            fireEvent.click(op('Adaptive1'));
            await settle();
            expect(screen.getByTestId('gg-ops-isolated')).toHaveTextContent('Adaptive1');
            fireEvent.click(screen.getByTestId('gg-ops-show-all'));
            await settle();
            expect(isolateRequests[isolateRequests.length - 1]).toEqual({ clear: true });
            expect(screen.queryByTestId('gg-ops-isolated')).toBeNull();
        });

        it('a click on another operation shows that one', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            fireEvent.click(op('Adaptive1'));
            await settle();
            expect(isolateRequests[1]).toEqual({ key: 'op:0', label: 'Adaptive1', firstLine: 5, endLine: 10 });
            expect(screen.getByTestId('gg-op-0').dataset.isolated).toBe('true');
            expect(screen.getByTestId('gg-op-1').dataset.isolated).toBeUndefined();
        });

        it('the panel says that a part is hidden also when the list is closed', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            fireEvent.click(screen.getByTestId('gg-ops-toggle'));
            expect(screen.queryByTestId('gg-ops-list')).toBeNull();
            expect(screen.getByTestId('gg-ops-isolated')).toHaveTextContent('Contour1');
            expect(screen.getByTestId('gg-ops-show-all')).toBeInTheDocument();
        });

        it('when the 3D view shows everything again by itself, the panel follows', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            act(() => publishIsolation(null)); // a new file, a line outside of the operation
            expect(screen.queryByTestId('gg-ops-isolated')).toBeNull();
            expect(screen.getByTestId('gg-op-1').dataset.isolated).toBeUndefined();
        });

        it('the list or the setting turned off: everything is shown again', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            await act(async () => {
                store.set(ISOLATE_OPERATION_KEY, false);
                await tick();
            });
            expect(isolateRequests[isolateRequests.length - 1]).toEqual({ clear: true });
            expect(screen.queryByTestId('gg-ops-isolated')).toBeNull();

            await act(async () => {
                store.set(ISOLATE_OPERATION_KEY, true);
                await tick();
            });
            fireEvent.click(op('Contour1'));
            await settle();
            expect(screen.getByTestId('gg-ops-isolated')).toBeInTheDocument();
            const before = isolateRequests.length;
            await act(async () => {
                store.set(OPERATIONS_PANEL_KEY, false); // the list is replaced by the upstream timeline
                await tick();
            });
            expect(screen.queryByTestId('gg-ops-panel')).toBeNull();
            expect(isolateRequests.slice(before)).toEqual([{ clear: true }]);
            store.set(OPERATIONS_PANEL_KEY, true);
        });

        it('setting off: the click selects the first move of the operation', async () => {
            store.set(ISOLATE_OPERATION_KEY, false);
            renderPanel(reduxState({ sent: 0, received: 0, total: 16 }, 'idle'));
            await load(PROGRAM);
            fireEvent.click(op('Contour1'));
            await settle();
            expect(pickRequests).toEqual([{ line: 11 }]); // 0-based file line of "G1 X10"
            expect(isolateRequests).toEqual([]);
            expect(op('Contour1').title).toContain('Click to see its first move in the 3D view.');
            expect(op('Contour1')).not.toHaveAttribute('aria-pressed');
        });

        it('an operation without a move has no toolpath: the click selects its line', async () => {
            renderPanel(reduxState({ sent: 0, received: 0, total: 3 }, 'idle'));
            await load(['(job)', 'G21', '', '(Remove the clamps)', 'M0', 'M30'].join('\n'));
            fireEvent.click(op('Remove the clamps'));
            await settle();
            expect(isolateRequests).toEqual([]);
            expect(pickRequests).toEqual([{ line: 3 }]);
        });
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
