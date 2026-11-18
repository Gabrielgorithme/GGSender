// GGSender: the Resume From dialog
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import store from 'app/store';
import { analyzeJob } from 'app/lib/gg/jobOperations';
import { setJobInfo } from 'app/lib/gg/jobInfoStore';
import { LOADED_TOOL_KEY } from 'app/lib/gg/loadedTool';
import { LAST_STOP_KEY } from 'app/lib/gg/stopPoint';

const mockCommands: any[][] = [];
const mockListeners: Record<string, Function[]> = {};
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: {
        command: (...args: any[]) => mockCommands.push(args),
        addListener: (e: string, f: Function) => {
            (mockListeners[e] = mockListeners[e] || []).push(f);
        },
        removeListener: (e: string, f: Function) => {
            mockListeners[e] = (mockListeners[e] || []).filter((g) => g !== f);
        },
    },
}));
jest.mock('app/lib/toaster', () => ({ toast: { info: jest.fn(), error: jest.fn() } }));

// eslint-disable-next-line import/first
import { ResumeFromLine } from '../ResumeFromLine';

const PROGRAM = [
    '(1)',
    '(T45 D=4 CR=0.5 - ZMIN=-9.846 - bullnose end mill)',
    'N10 G90 G94',
    'N11 G17',
    'N12 G21',
    'N13 G28 G91 Z0',
    'N14 G90',
    '',
    '(3D Adaptive Roughing2)',
    'N15 T45 M6',
    'N16 S24000 M3',
    'N17 G17 G90 G94',
    'N18 G54',
    'N19 M8',
    'N20 G0 X10 Y10',
    'N21 Z15',
    'N22 G0 Z3',
    'N23 Z1.2',
    'N24 G1 Z-2 F300',
    'N25 G1 X20 Y10 F1200',
    'N26 X20 Y20 Z-2.5',
    'N27 G1 X40 Y20',
    'N28 G0 Z15',
    'N29 M30',
].join('\n');
const TOTAL = PROGRAM.split('\n').filter((l) => l.trim()).length;

const renderButton = () =>
    render(
        <Provider
            store={configureStore({
                reducer: () =>
                    ({
                        file: { content: PROGRAM, name: 'job.nc' },
                        preferences: { accessibility: { focusTrapping: true } },
                        controller: {},
                    }) as any,
            })}
        >
            <ResumeFromLine disabled={false} />
        </Provider>,
    );

const open = () => fireEvent.click(screen.getByTestId('gg-resume-button'));
const type = (v: string) => fireEvent.change(screen.getByTestId('gg-resume-query'), { target: { value: v } });
const serverSays = (event: string, data: unknown) => act(() => (mockListeners[event] || []).forEach((f) => f(data)));
const started = () => mockCommands.filter(([c]) => c === 'gg:resume:start').map(([, p]) => p);

describe('GGSender: Resume From dialog', () => {
    beforeEach(() => {
        mockCommands.length = 0;
        store.set(LOADED_TOOL_KEY, { tool: '45', since: 1 });
        store.set(LAST_STOP_KEY, null);
        store.set('workspace.toolChange.safeZ', -0.1);
        store.set('workspace.gg.resumeSpinupSeconds', 5);
        act(() => setJobInfo(analyzeJob(PROGRAM), 'job.nc'));
    });

    it('shows the line, its operation, and every line it sends; Resume sends the plan', () => {
        renderButton();
        open();
        expect(mockCommands).toContainEqual(['gg:resume:query']);
        type('N26');
        const ctx = screen.getByTestId('gg-resume-context');
        expect(ctx).toHaveTextContent('▶ N26 X20 Y20 Z-2.5');
        const dialog = screen.getByTestId('gg-resume-dialog');
        expect(dialog).toHaveTextContent('In 3D Adaptive Roughing2');
        expect(dialog).toHaveTextContent('tool T45');
        expect(dialog).toHaveTextContent('starts from X20 Y10 Z-2');
        const pre = screen.getByTestId('gg-resume-preamble').textContent as string;
        expect(pre.split('\n')).toEqual([
            '(GGSender resume at line 21 N26 "3D Adaptive Roughing2")',
            'G21 G53 G0 Z-0.1',
            'G21 G90 G94 G17 G54',
            'S24000 M3',
            'G4 P5',
            'M8',
            'G0 X20 Y10',
            'G0 Z15',
            'G1 Z-2 F300',
            'G1 F1200',
        ]);
        // the tool recorded as loaded is the line's: no tool change by default
        expect(screen.getByTestId('gg-resume-tool-keep')).toBeChecked();
        fireEvent.click(screen.getByTestId('gg-resume-start'));
        expect(started()).toEqual([
            { seq: 19, text: 'N26 X20 Y20 Z-2.5', total: TOTAL, preamble: pre.split('\n'), target: null, measureTool: false },
        ]);
        expect(screen.queryByTestId('gg-resume-dialog')).toBeNull();
    });

    it('another tool recorded as loaded: tool change first, and says which reference the wizard uses', () => {
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-measure')).toBeChecked();
        expect(screen.getByTestId('gg-resume-preamble')).toHaveTextContent('T45 M6');
        serverSays('gg:resume:info', { toolReference: false });
        expect(screen.getByTestId('gg-resume-reference')).toHaveTextContent(/first measures the tool now in the spindle/);
        serverSays('gg:resume:info', { toolReference: true });
        expect(screen.getByTestId('gg-resume-reference')).toHaveTextContent(/goes straight to the new tool/);
        fireEvent.click(screen.getByTestId('gg-resume-start'));
        expect(started()[0].measureTool).toBe(true);
        expect(started()[0].preamble).toContain('T45 M6');
    });

    it('can be switched to keep the tool', () => {
        store.set(LOADED_TOOL_KEY, { tool: null, since: null });
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-measure')).toBeChecked();
        fireEvent.click(screen.getByTestId('gg-resume-tool-keep'));
        expect(screen.getByTestId('gg-resume-preamble')).not.toHaveTextContent('M6');
    });

    it('rapid height, plunge feed and spin-up can be changed', () => {
        renderButton();
        open();
        type('N26');
        fireEvent.change(screen.getByTestId('gg-resume-rapid'), { target: { value: '4' } });
        fireEvent.change(screen.getByTestId('gg-resume-plunge'), { target: { value: '150' } });
        fireEvent.change(screen.getByTestId('gg-resume-spinup'), { target: { value: '0' } });
        const pre = screen.getByTestId('gg-resume-preamble').textContent as string;
        expect(pre).toContain('G0 Z4');
        expect(pre).toContain('G1 Z-2 F150');
        expect(pre).not.toContain('G4 P');
    });

    it('starts from where the last run stopped: the move the tool was on', () => {
        store.set(LAST_STOP_KEY, {
            fileName: 'job.nc',
            total: TOTAL + 1,
            received: 21, // gSender had counted past N26; the tool was on N26
            wpos: { x: 20, y: 15, z: -2.25 },
            inches: false,
            at: 1,
        });
        renderButton();
        open();
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N26');
        expect(screen.getByTestId('gg-resume-stop-note')).toHaveTextContent('from N26');
        expect(screen.queryByTestId('gg-resume-stop-far')).toBeNull();
        // a later line is flagged
        type('N27');
        expect(within(screen.getByTestId('gg-resume-issues')).getByText(/after where the tool stopped/)).toBeInTheDocument();
    });

    it('a stop position far from every move is called out', () => {
        store.set(LAST_STOP_KEY, {
            fileName: 'job.nc',
            total: TOTAL + 1,
            received: 21,
            wpos: { x: 0, y: 0, z: 15 }, // jogged away, or position lost
            inches: false,
            at: 1,
        });
        renderButton();
        open();
        expect(screen.getByTestId('gg-resume-stop-far')).toHaveTextContent(/may not be where the tool stopped/);
    });

    it('a line it cannot resume from: the reason, and no Resume', () => {
        renderButton();
        open();
        type('N15');
        expect(screen.getByTestId('gg-resume-issues')).toHaveTextContent(/tool change/);
        expect(screen.getByTestId('gg-resume-start')).toBeDisabled();
        type('N99');
        expect(screen.getByText('No line N99 in the file.')).toBeInTheDocument();
        expect(screen.getByTestId('gg-resume-start')).toBeDisabled();
    });

    it('the start of an operation can be picked', () => {
        renderButton();
        open();
        fireEvent.change(screen.getByTestId('gg-resume-operation'), { target: { value: '0' } });
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N20');
    });
});
