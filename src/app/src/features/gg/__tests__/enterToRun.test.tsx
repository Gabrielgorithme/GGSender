/*
 * GGSender: in the tool change window, Enter presses the step's Run button.
 * Drives the real wizard Actions component.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import store from 'app/store';
import { ARM_DELAY_MS, TOOLCHANGE_ENTER_KEY, decideEnter, isTextEntry, otherDialogOpen } from '../enterToRun';

const mockCommands: any[][] = [];
jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: { command: (...args: any[]) => mockCommands.push(args) },
}));
const mockWizard: any = {};
const mockApi = {
    markActionAsComplete: jest.fn(),
    completeSubStep: jest.fn(),
    setIsLoading: jest.fn(),
    setResumingJob: jest.fn(),
};
jest.mock('app/features/Helper/context', () => ({
    useWizardContext: () => mockWizard,
    useWizardAPI: () => mockApi,
}));

// eslint-disable-next-line import/first
import Actions from 'app/features/Helper/components/Actions';

const PROBE = { label: 'Probe Changed Tool', gcodeLines: ['G38.2 Z-10 F100'] };
const OTHER = { label: 'Something else', gcodeLines: ['G0 X0'] };

const steps = (actionTaken = false) => [
    { title: 'Prepare', substeps: [{ title: 'Measure', actions: [PROBE], actionTaken }] },
    { title: 'Resume', substeps: [{ title: 'Resume', actions: [{ label: 'Resume Cutting', gcodeLines: ['%toolchange_complete'] }] }] },
];

const renderActions = ({
    actions = [PROBE],
    activeState = 'Idle',
    isLoading = false,
    actionTaken = false,
} = {}) => {
    Object.assign(mockWizard, { isLoading, steps: steps(actionTaken) });
    const redux = configureStore({
        reducer: () => ({ controller: { state: { status: { activeState } } } }) as any,
    });
    return render(
        <Provider store={redux}>
            <Actions actions={actions} stepIndex={0} substepIndex={0} />
        </Provider>,
    );
};

const enter = (init: KeyboardEventInit = {}, target: Element | Window = window) =>
    act(() => {
        fireEvent.keyDown(target, { key: 'Enter', ...init });
    });
const ran = () => mockCommands.filter(([c]) => c === 'gcode').map(([, lines]) => lines);

describe('GGSender: Enter decision', () => {
    const ok = { key: 'Enter', repeat: false, modifier: false, textEntry: false, dialogOpen: false, armed: true, readyForMs: ARM_DELAY_MS };
    it('runs only a fresh, plain Enter on an armed button that has been ready long enough', () => {
        expect(decideEnter(ok)).toBe('run');
        expect(decideEnter({ ...ok, readyForMs: ARM_DELAY_MS - 1 })).toBe('swallow');
        expect(decideEnter({ ...ok, repeat: true })).toBe('swallow');
        expect(decideEnter({ ...ok, modifier: true })).toBe('swallow');
        expect(decideEnter({ ...ok, armed: false })).toBe('swallow');
    });
    it('leaves typing, dialogs and other keys alone', () => {
        expect(decideEnter({ ...ok, textEntry: true })).toBe('ignore');
        expect(decideEnter({ ...ok, dialogOpen: true })).toBe('ignore');
        expect(decideEnter({ ...ok, key: ' ' })).toBe('ignore');
        expect(decideEnter({ ...ok, key: 'a' })).toBe('ignore');
    });
    it('knows text fields from buttons', () => {
        const el = (html: string) => {
            const d = document.createElement('div');
            d.innerHTML = html;
            return d.firstElementChild as Element;
        };
        expect(isTextEntry(el('<input type="text">'))).toBe(true);
        expect(isTextEntry(el('<input>'))).toBe(true);
        expect(isTextEntry(el('<input type="number">'))).toBe(true);
        expect(isTextEntry(el('<textarea></textarea>'))).toBe(true);
        expect(isTextEntry(el('<div contenteditable="true"></div>'))).toBe(true);
        expect(isTextEntry(el('<input type="checkbox">'))).toBe(false);
        expect(isTextEntry(el('<button>x</button>'))).toBe(false);
        expect(isTextEntry(null)).toBe(false);
    });
    it('sees an open dialog, not a closed one', () => {
        document.body.innerHTML = '<div role="dialog" data-state="closed"></div>';
        expect(otherDialogOpen(document)).toBe(false);
        document.body.innerHTML = '<div role="alertdialog" data-state="open"></div>';
        expect(otherDialogOpen(document)).toBe(true);
        document.body.innerHTML = '';
    });
});

describe('GGSender: Enter in the tool change window', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockCommands.length = 0;
        store.set(TOOLCHANGE_ENTER_KEY, true);
        Object.values(mockApi).forEach((f) => f.mockClear());
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    const settle = () =>
        act(() => {
            jest.advanceTimersByTime(ARM_DELAY_MS);
        });

    it('Enter runs the step, once', () => {
        renderActions();
        expect(screen.getByTestId('wizard-run')).toHaveTextContent('Run⏎ Enter');
        settle();
        enter();
        expect(ran()).toEqual([PROBE.gcodeLines]);
        expect(mockCommands).toContainEqual(['wizard:step', 0, 0]);
        // a second press right after does nothing
        enter();
        expect(ran()).toHaveLength(1);
    });

    it('not in the first moment after the step appears', () => {
        renderActions();
        act(() => {
            jest.advanceTimersByTime(ARM_DELAY_MS - 100);
        });
        enter();
        expect(ran()).toEqual([]);
        act(() => {
            jest.advanceTimersByTime(100);
        });
        enter();
        expect(ran()).toHaveLength(1);
    });

    it('held key (auto-repeat) or with a modifier: nothing', () => {
        renderActions();
        settle();
        enter({ repeat: true });
        enter({ ctrlKey: true });
        enter({ shiftKey: true });
        expect(ran()).toEqual([]);
    });

    it('nothing while the machine moves, while a step runs, or once the step is done', () => {
        const a = renderActions({ activeState: 'Run' });
        settle();
        enter();
        a.unmount();
        const b = renderActions({ isLoading: true });
        settle();
        enter();
        b.unmount();
        renderActions({ actionTaken: true });
        settle();
        enter();
        expect(ran()).toEqual([]);
    });

    it('several actions in a step: Enter does not choose, no hint', () => {
        renderActions({ actions: [PROBE, OTHER] });
        settle();
        enter();
        expect(ran()).toEqual([]);
        expect(screen.getAllByTestId('wizard-run')[0]).not.toHaveTextContent('Enter');
    });

    it('typing in a text field is left alone', () => {
        renderActions();
        settle();
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        enter({}, input);
        expect(ran()).toEqual([]);
        input.remove();
    });

    it('Enter does not reach a button outside the window that still has focus (a rapid-position button)', () => {
        renderActions();
        settle();
        const outside = jest.fn();
        const button = document.createElement('button');
        button.addEventListener('keydown', outside);
        document.body.appendChild(button);
        button.focus();
        enter({}, button);
        expect(outside).not.toHaveBeenCalled();
        expect(ran()).toEqual([PROBE.gcodeLines]); // it ran the step instead
        button.remove();
    });

    it('setting off: upstream small button, Enter does nothing', () => {
        store.set(TOOLCHANGE_ENTER_KEY, false);
        renderActions();
        settle();
        enter();
        expect(ran()).toEqual([]);
        expect(screen.getByTestId('wizard-run')).toHaveTextContent(/^Run$/);
        expect(screen.getByText('Run G-Code')).toBeInTheDocument();
        // the mouse still works
        fireEvent.click(screen.getByTestId('wizard-run'));
        expect(ran()).toEqual([PROBE.gcodeLines]);
    });
});
