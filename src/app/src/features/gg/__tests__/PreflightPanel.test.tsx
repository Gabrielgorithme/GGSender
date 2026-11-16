import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import store from 'app/store';
import { analyzeProgram } from 'app/lib/gg/preflight';
import { setPreflight } from 'app/lib/gg/preflightStore';
import { PreflightControl, shouldAutoOpen } from '../PreflightPanel';
import { PICK_REQUEST } from '../pickTopics';

const tick = () => new Promise((r) => setTimeout(r, 0));

const PROGRAM = `G21 G90
(T5 flat 6mm)
T5 M6
S18000 M3
G0 X0 Y0 Z10
G1 Z-3 F300
G1 X40 Y20 F1200
G0 Z10`;

const reduxState = (over: any = {}) => ({
    controller: {
        settings: { settings: { $130: '300', $131: '300', $132: '80', $30: '24000' } },
        mpos: { x: -200, y: -150, z: -40 },
        wpos: { x: 0, y: 0, z: 0 },
        hasHomed: true,
        ...over,
    },
    connection: { isConnected: true },
});

const renderControl = (over = {}) =>
    render(
        <Provider store={configureStore({ reducer: () => reduxState(over) as any })}>
            <PreflightControl />
        </Provider>,
    );

const load = async (program: string) => {
    await act(async () => {
        setPreflight(analyzeProgram(program), 'job.nc');
        await tick();
    });
};

describe('GGSender: pre-flight panel', () => {
    beforeEach(() => {
        store.set('workspace.toolChangeOption', 'Fixed Tool Sensor');
        store.set('workspace.gg.loadedTool', { tool: null, since: null });
        store.set('workspace.toolChange.feedRules', '');
        store.set('workspace.gg.preflightOnLoad', 'When there are warnings');
        setPreflight(null);
    });

    it('stays closed for a clean file, and opens on demand', async () => {
        renderControl();
        await load(PROGRAM);
        expect(screen.queryByTestId('gg-preflight-panel')).toBeNull();
        expect(screen.queryByTestId('gg-preflight-badge')).toBeNull();
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        const panel = screen.getByTestId('gg-preflight-panel');
        expect(within(panel).getByText('job.nc')).toBeInTheDocument();
        // tools table
        const tools = screen.getByTestId('gg-preflight-tools');
        expect(within(tools).getByText('T5')).toBeInTheDocument();
        expect(within(tools).getByText('-3')).toBeInTheDocument();
        expect(within(tools).getByText('1200')).toBeInTheDocument();
        expect(within(tools).getByText('T5 flat 6mm')).toBeInTheDocument();
        // travel table
        const travel = screen.getByTestId('gg-preflight-travel');
        expect(within(travel).getAllByText('fits')).toHaveLength(3);
    });

    it('opens by itself and shows a badge when the job leaves the travel', async () => {
        // zero 5mm below the top of Z: the 10mm clearance goes 5mm too high
        renderControl({ mpos: { x: -200, y: -150, z: -5 } });
        await load(PROGRAM);
        expect(screen.getByTestId('gg-preflight-panel')).toBeInTheDocument();
        expect(screen.getByTestId('gg-preflight-badge')).toHaveTextContent('1');
        expect(screen.getByTestId('gg-preflight-issue-TRAVEL_Z')).toHaveTextContent(/5 mm above/);
        expect(screen.getByText('5 mm out')).toBeInTheDocument();
    });

    it('opens by itself for a problem in the file', async () => {
        renderControl();
        await load('G21\nM3 S1000\nG1 X10 Z-1');
        expect(screen.getByTestId('gg-preflight-issue-FEED_UNDEFINED')).toBeInTheDocument();
    });

    it('does not check travel when the machine is not homed', async () => {
        renderControl({ hasHomed: false });
        await load(PROGRAM);
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        expect(screen.getByTestId('gg-preflight-travel-unchecked')).toHaveTextContent(/not been homed/);
    });

    it('line numbers show the line in the 3D view', async () => {
        const requests: any[] = [];
        const token = pubsub.subscribe(PICK_REQUEST, (_m, p) => requests.push(p));
        renderControl();
        await load(PROGRAM);
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        fireEvent.click(screen.getAllByText('line 3')[0]);
        await act(tick);
        pubsub.unsubscribe(token);
        expect(requests).toEqual([{ line: 2 }]);
    });

    it('follows the auto-open setting', () => {
        const clean = analyzeProgram(PROGRAM).issues;
        const bad = analyzeProgram('G1 X1').issues;
        expect(shouldAutoOpen('When there are warnings', clean)).toBe(false);
        expect(shouldAutoOpen('When there are warnings', bad)).toBe(true);
        expect(shouldAutoOpen('Every file', clean)).toBe(true);
        expect(shouldAutoOpen('Never', bad)).toBe(false);
    });
});
