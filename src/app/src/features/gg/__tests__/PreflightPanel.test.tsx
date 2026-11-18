import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import store from 'app/store';
import { analyzeProgram } from 'app/lib/gg/preflight';
import { setPreflight } from 'app/lib/gg/preflightStore';
import { HOMED_FROM_CONTROLLER_KEY, setHomed } from 'app/lib/gg/homedStore';
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
        store.set('workspace.gg.preflightHidden', '');
        store.set(HOMED_FROM_CONTROLLER_KEY, true);
        setPreflight(null);
        setHomed(null);
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

    // ---- GGSender 0.7.0: homed state from the controller ------------------

    it('homed from the pendant before connecting: travel checked, with a note', async () => {
        renderControl({ hasHomed: false });
        act(() => setHomed({ homed: true, how: 'before-connect', axes: '' }));
        await load(PROGRAM);
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        expect(screen.queryByTestId('gg-preflight-travel-unchecked')).toBeNull();
        expect(within(screen.getByTestId('gg-preflight-travel')).getAllByText('fits')).toHaveLength(3);
        expect(screen.getByTestId('gg-preflight-issue-HOMED_BEFORE_CONNECT')).toHaveTextContent(/unlocked with \$X/);
    });

    it('a homing reported while connected: travel checked, no note', async () => {
        renderControl({ hasHomed: false });
        act(() => setHomed({ homed: true, how: 'seen', axes: 'XYZ' }));
        await load(PROGRAM);
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        expect(within(screen.getByTestId('gg-preflight-travel')).getAllByText('fits')).toHaveLength(3);
        expect(screen.queryByTestId('gg-preflight-issue-HOMED_BEFORE_CONNECT')).toBeNull();
    });

    it('setting off: only a homing from gSender counts', async () => {
        store.set(HOMED_FROM_CONTROLLER_KEY, false);
        renderControl({ hasHomed: false });
        act(() => setHomed({ homed: true, how: 'seen', axes: 'XYZ' }));
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

    // ---- GGSender 0.4.1: hiding kinds of warning --------------------------

    const RAPID_LOW = 'G21 G90\nS10000 M3\nG0 X0 Y0 Z5\nG0 Z-1\nG1 X10 F500\nG0 Z5';

    it('hides a kind of warning: gone from the list and the badge, and stays closed', async () => {
        renderControl();
        await load(RAPID_LOW);
        // opened by itself because of the warning
        expect(screen.getByTestId('gg-preflight-issue-RAPID_BELOW_ZERO')).toBeInTheDocument();
        expect(screen.getByTestId('gg-preflight-badge')).toHaveTextContent('1');

        act(() => {
            fireEvent.click(screen.getByTestId('gg-preflight-hide-RAPID_BELOW_ZERO'));
        });
        expect(screen.queryByTestId('gg-preflight-issue-RAPID_BELOW_ZERO')).toBeNull();
        expect(screen.queryByTestId('gg-preflight-badge')).toBeNull();
        expect(screen.getByTestId('gg-preflight-hidden')).toHaveTextContent(/RAPID_BELOW_ZERO\s*\(1 in this file\)/);
        expect(store.get('workspace.gg.preflightHidden')).toBe('RAPID_BELOW_ZERO');

        // the next file with the same warning does not open the panel
        await load(RAPID_LOW.replace('X10', 'X20'));
        expect(screen.queryByTestId('gg-preflight-panel')).toBeNull();
        expect(screen.queryByTestId('gg-preflight-badge')).toBeNull();
    });

    it('brings a hidden kind back', async () => {
        store.set('workspace.gg.preflightHidden', 'RAPID_BELOW_ZERO');
        renderControl();
        await load(RAPID_LOW);
        fireEvent.click(screen.getByTestId('gg-preflight-button'));
        act(() => {
            fireEvent.click(screen.getByTestId('gg-preflight-unhide-RAPID_BELOW_ZERO'));
        });
        expect(screen.getByTestId('gg-preflight-issue-RAPID_BELOW_ZERO')).toBeInTheDocument();
        expect(screen.getByTestId('gg-preflight-badge')).toHaveTextContent('1');
        expect(store.get('workspace.gg.preflightHidden')).toBe('');
    });

    it('offers no hide button on errors, and ignores an error code in the list', async () => {
        store.set('workspace.gg.preflightHidden', 'TRAVEL_Z\nFEED_UNDEFINED');
        renderControl({ mpos: { x: -200, y: -150, z: -5 } });
        await load('G21\nM3 S1000\nG0 Z10\nG1 X10 Z-1');
        expect(screen.getByTestId('gg-preflight-issue-TRAVEL_Z')).toBeInTheDocument();
        expect(screen.getByTestId('gg-preflight-issue-FEED_UNDEFINED')).toBeInTheDocument();
        expect(screen.queryByTestId('gg-preflight-hide-TRAVEL_Z')).toBeNull();
        expect(screen.queryByTestId('gg-preflight-hide-FEED_UNDEFINED')).toBeNull();
    });
});
