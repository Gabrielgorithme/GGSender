// GGSender: the Resume From dialog
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import store from 'app/store';
import { analyzeJob } from 'app/lib/gg/jobOperations';
import { setJobInfo } from 'app/lib/gg/jobInfoStore';
import { LOADED_TOOL_KEY } from 'app/lib/gg/loadedTool';
import { LAST_STOP_KEY } from 'app/lib/gg/stopPoint';
import { getLoadedTool } from 'app/lib/gg/loadedTool';
import { setReference } from 'app/lib/gg/probeStore';
import { publishPick } from '../pickTopics';

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
const started = () => mockCommands.filter(([c]) => c === 'gg:resume:start').map(([, p]) => p);

const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
};
const VALID: Record<string, any> = {
    status: 'valid',
    reference: { value: -15.002, tool: '45', at: at(14, 32), wcs: 'G54', wcoZ: -50 },
    lastProbe: { kind: 'reference', tool: '45', at: at(14, 32) },
    stale: null,
    watching: true,
    wcs: 'G54',
    history: [],
};
const STALE: Record<string, any> = { ...VALID, status: 'stale', stale: { kind: 'zero', at: at(14, 40), deltaZ: -8 } };
const NONE: Record<string, any> = { status: 'none', reference: null, lastProbe: null, stale: null, watching: true, wcs: 'G54', history: [] };
const reference = (s: unknown) => act(() => setReference(s));
const startButton = () => screen.getByTestId('gg-resume-start');

describe('GGSender: Resume From dialog', () => {
    beforeEach(() => {
        mockCommands.length = 0;
        store.set(LOADED_TOOL_KEY, { tool: '45', since: 1 });
        store.set(LAST_STOP_KEY, null);
        store.set('workspace.toolChange.safeZ', -0.1);
        store.set('workspace.gg.resumeSpinupSeconds', 5);
        publishPick(null);
        act(() => setJobInfo(analyzeJob(PROGRAM), 'job.nc'));
        reference(VALID);
    });

    it('shows the line, its operation, and every line it sends; Resume sends the plan', () => {
        renderButton();
        open();
        expect(mockCommands).toContainEqual(['gg:probe:query']);
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
            { seq: 19, text: 'N26 X20 Y20 Z-2.5', total: TOTAL, preamble: pre.split('\n'), target: null, toolMode: 'keep', measureTool: false },
        ]);
        expect(screen.queryByTestId('gg-resume-dialog')).toBeNull();
    });

    it('shows the reference at a glance: the tool, the time, and whether it is correct', () => {
        renderButton();
        open();
        type('N26');
        const block = screen.getByTestId('gg-resume-reference');
        expect(block).toHaveTextContent('Reference: T45, probed at 14:32. Z zero did not change after that.');
        expect(within(block).getByTestId('gg-reference-icon-valid')).toBeInTheDocument();
        reference(STALE);
        expect(block).toHaveTextContent('Z zero changed at 14:40, after the last probe (T45, 14:32). The reference is not correct now.');
        expect(within(block).getByTestId('gg-reference-icon-stale')).toBeInTheDocument();
        reference(NONE);
        expect(block).toHaveTextContent('No reference.');
        expect(within(block).getByTestId('gg-reference-icon-none')).toBeInTheDocument();
    });

    it('three choices, each saying what happens to the tool and to Z zero', () => {
        renderButton();
        open();
        type('N26');
        const dialog = screen.getByTestId('gg-resume-dialog');
        expect(dialog).toHaveTextContent('1. Same tool. Z zero did not change.');
        expect(dialog).toHaveTextContent('T45 is in the spindle. gSender measures nothing.');
        expect(dialog).toHaveTextContent('2. New or refitted tool. Z zero did not change.');
        expect(dialog).toHaveTextContent('You fit T45. gSender measures it against the reference (T45, 14:32). Z zero stays at the same position on the part.');
        expect(dialog).toHaveTextContent('3. I set Z zero again by hand, with this tool in the spindle.');
        expect(dialog).toHaveTextContent('gSender measures T45 on the tool sensor. It becomes the new reference. Z zero does not change.');
    });

    it('choice 2 with a valid reference: tool change first, measured against the reference', () => {
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        // another tool is recorded: 2 by default
        expect(screen.getByTestId('gg-resume-tool-measure')).toBeChecked();
        expect(screen.getByTestId('gg-resume-preamble')).toHaveTextContent('T45 M6');
        expect(screen.queryByTestId('gg-resume-source')).toBeNull();
        fireEvent.click(startButton());
        expect(started()[0]).toMatchObject({ toolMode: 'measure', measureTool: true });
        expect(started()[0].preamble).toContain('T45 M6');
    });

    it('the owner\'s case: Z zero set by hand after a broken bit. 3 is selected; the tool is measured as the new reference', () => {
        reference(STALE);
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-reference')).toBeChecked();
        expect(screen.getByTestId('gg-resume-preamble')).toHaveTextContent('T45 M6');
        expect(startButton()).toBeEnabled();
        fireEvent.click(startButton());
        expect(started()[0]).toMatchObject({ toolMode: 'reference', measureTool: true });
    });

    it('choice 2 after Z zero changed: not possible without a second answer, and the old reference carries a warning', () => {
        reference(STALE);
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-tool-measure'));
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('The reference is not correct now: Z zero changed at 14:40.');
        expect(startButton()).toBeDisabled();
        expect(screen.getByTestId('gg-resume-tool-needed')).toHaveTextContent('Select how gSender gets a reference.');
        const sources = screen.getByTestId('gg-resume-source');
        expect(sources).toHaveTextContent('If the old tool is broken or removed: set Z zero by hand with the new tool. Then use option 3.');
        // the old reference: Z zero goes back, said in so many words
        expect(sources).toHaveTextContent('Use the old reference (T45, 14:32). WARNING: Z zero goes back to its position of 14:32. The Z zero of 14:40 is lost.');
        fireEvent.click(screen.getByTestId('gg-resume-source-old-reference'));
        expect(startButton()).toBeEnabled();
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('measure-old');
    });

    it('choice 2 after Z zero changed, old tool still in the spindle: it is measured first', () => {
        reference(STALE);
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-tool-measure'));
        fireEvent.click(screen.getByTestId('gg-resume-source-old-tool'));
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('full');
    });

    it('no reference (after a reconnection), same tool: 1 by default, and the tool is measured as the reference first', () => {
        reference(NONE);
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-keep')).toBeChecked();
        const box = screen.getByTestId('gg-resume-same-tool');
        expect(screen.getByTestId('gg-resume-same-tool-measure')).toBeChecked();
        expect(box).toHaveTextContent('Measure T45 first. gSender measures it on the tool sensor before the job continues. It becomes the reference. Z zero does not change.');
        expect(box).toHaveTextContent('If this tool breaks later, gSender can measure the new tool against the reference.');
        // the statement of choice 1 stays true: nothing says that Z zero was set by hand
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('T45 is in the spindle. gSender has no reference.');
        // the measurement starts with the tool change line
        expect(screen.getByTestId('gg-resume-preamble')).toHaveTextContent('T45 M6');
        fireEvent.click(startButton());
        expect(started()[0]).toMatchObject({ toolMode: 'reference-same', measureTool: true });
    });

    it('no reference, same tool, "Do not measure": the job continues at once, as in 0.7.1', () => {
        reference(NONE);
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-same-tool-skip'));
        expect(screen.getByTestId('gg-resume-same-tool')).toHaveTextContent(
            'Do not measure. The job continues at once. At the next tool change, gSender first measures the tool in the spindle. If this tool breaks before that, you must set Z zero by hand.',
        );
        expect(screen.getByTestId('gg-resume-preamble')).not.toHaveTextContent('M6');
        fireEvent.click(startButton());
        expect(started()[0]).toMatchObject({ toolMode: 'keep', measureTool: false });
    });

    it('a correct reference, same tool: no second question, nothing is measured', () => {
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-keep')).toBeChecked();
        expect(screen.queryByTestId('gg-resume-same-tool')).toBeNull();
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('T45 is in the spindle. gSender measures nothing. The reference stays correct.');
        expect(screen.getByTestId('gg-resume-preamble')).not.toHaveTextContent('M6');
    });

    it('choice 1 after gSender saw a change of Z zero: says so, and offers the same measurement', () => {
        reference(STALE);
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-tool-keep'));
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('gSender saw a change of Z zero at 14:40. The reference is not correct now.');
        expect(screen.getByTestId('gg-resume-same-tool-measure')).toBeChecked();
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('reference-same');
    });

    it('the second answer of choice 1 is forgotten when the dialog opens again', () => {
        reference(NONE);
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-same-tool-skip'));
        fireEvent.click(screen.getByText('Cancel'));
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-same-tool-measure')).toBeChecked();
    });

    it('no reference, another tool recorded: nothing selected, Resume waits; choice 2 can only measure the old tool first', () => {
        reference(NONE);
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-keep')).not.toBeChecked();
        expect(screen.getByTestId('gg-resume-tool-measure')).not.toBeChecked();
        expect(screen.getByTestId('gg-resume-tool-reference')).not.toBeChecked();
        expect(startButton()).toBeDisabled();
        expect(screen.getByTestId('gg-resume-tool-needed')).toHaveTextContent('gSender recorded T7 in the spindle. This line uses T45. Select option 1, 2 or 3.');
        fireEvent.click(screen.getByTestId('gg-resume-tool-measure'));
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('There is no reference. gSender cannot measure the new tool against it.');
        expect(screen.queryByTestId('gg-resume-source-old-reference')).toBeNull();
        expect(startButton()).toBeDisabled();
        fireEvent.click(screen.getByTestId('gg-resume-source-old-tool'));
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('full');
    });

    it('choice 1 with the tool measured first also records the line\'s tool as loaded', () => {
        reference(NONE);
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-tool-keep'));
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('reference-same');
        expect(getLoadedTool().tool).toBe('45');
    });

    it('choice 1 with another tool recorded: says so, and records the line\'s tool as loaded', () => {
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        fireEvent.click(screen.getByTestId('gg-resume-tool-keep'));
        expect(screen.getByTestId('gg-resume-dialog')).toHaveTextContent('gSender recorded T7 in the spindle. Make sure that T45 is in the spindle.');
        expect(screen.getByTestId('gg-resume-preamble')).not.toHaveTextContent('M6');
        fireEvent.click(startButton());
        expect(started()[0].toolMode).toBe('keep');
        expect(getLoadedTool().tool).toBe('45');
    });

    it('the reference going stale while the dialog is open: a selected choice 2 stops being enough', () => {
        store.set(LOADED_TOOL_KEY, { tool: '7', since: 1 });
        renderButton();
        open();
        type('N26');
        expect(screen.getByTestId('gg-resume-tool-measure')).toBeChecked();
        expect(startButton()).toBeEnabled();
        reference(STALE); // the pendant set Z zero just now
        // nothing was selected by hand: the default moves to 3
        expect(screen.getByTestId('gg-resume-tool-reference')).toBeChecked();
        fireEvent.click(screen.getByTestId('gg-resume-tool-measure'));
        expect(startButton()).toBeDisabled();
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
        expect(within(screen.getByTestId('gg-resume-issues')).getByText(/after the stop line/)).toBeInTheDocument();
    });

    it('a line selected in the 3D view is offered; the stop point stays the line the dialog opens on', () => {
        store.set(LAST_STOP_KEY, { fileName: 'job.nc', total: TOTAL + 1, received: 21, wpos: { x: 20, y: 15, z: -2.25 }, inches: false, at: 1 });
        publishPick({ line: 21, drew: true, shownLine: 21 }); // N27 G1 X40 Y20
        renderButton();
        open();
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N26');
        const button = screen.getByTestId('gg-resume-selected-line');
        expect(button).toHaveTextContent('Selected line (N27)');
        fireEvent.click(button);
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N27');
        expect(startButton()).toHaveTextContent('Resume at N27');
        // and back
        fireEvent.click(screen.getByTestId('gg-resume-where-stopped'));
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N26');
    });

    it('with no stop point, the dialog opens on the line selected in the 3D view', () => {
        publishPick({ line: 20, drew: true, shownLine: 20 }); // N26
        renderButton();
        open();
        expect(screen.getByTestId('gg-resume-query')).toHaveValue('N26');
        expect(screen.getByTestId('gg-resume-selected-line')).toHaveTextContent('Selected line (N26)');
    });

    it('no line selected in the 3D view: no such button; a line of another file is not offered', () => {
        renderButton();
        open();
        expect(screen.queryByTestId('gg-resume-selected-line')).toBeNull();
        fireEvent.click(screen.getByText('Cancel'));
        publishPick({ line: 5000, drew: true, shownLine: 5000 });
        open();
        expect(screen.queryByTestId('gg-resume-selected-line')).toBeNull();
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
        expect(screen.getByTestId('gg-resume-stop-far')).toHaveTextContent(/distance is large/);
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
