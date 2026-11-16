import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

import { PickCard, parseLineInput } from '../PickCard';
import { PICK_REQUEST, publishPick } from '../pickTopics';

const tick = () => new Promise((r) => setTimeout(r, 0));
const content = ['G21', 'G0 X0 Y0', 'G1 X10 F100', 'G1 Y10', 'M5', 'G0 Z5'].join('\n');
const makeStore = () => configureStore({ reducer: () => ({ file: { content } }) as any });

const renderCard = () =>
    render(
        <Provider store={makeStore()}>
            <PickCard />
        </Provider>,
    );

describe('GGSender: pick card', () => {
    let requests: any[];
    let token: string;
    beforeEach(() => {
        requests = [];
        token = pubsub.subscribe(PICK_REQUEST, (_m, p) => requests.push(p));
        publishPick(null);
    });
    afterEach(() => pubsub.unsubscribe(token));

    it('is hidden until a line is picked', () => {
        renderCard();
        expect(screen.queryByTestId('gg-pick-card')).toBeNull();
    });

    it('shows the picked line with the lines around it', async () => {
        renderCard();
        await act(async () => {
            publishPick({ line: 2, drew: true, shownLine: 2 });
            await tick();
        });
        expect(screen.getByTestId('gg-pick-line')).toHaveTextContent('Line 3');
        expect(screen.getByText('G1 X10 F100')).toBeInTheDocument();
        expect(screen.getByText('G0 X0 Y0')).toBeInTheDocument();
        expect(screen.getByText('M5')).toBeInTheDocument();
        expect(screen.queryByText('G0 Z5')).toBeNull(); // 3 lines after: out of view
    });

    it('explains a line without motion', async () => {
        renderCard();
        await act(async () => {
            publishPick({ line: 4, drew: false, shownLine: 3 });
            await tick();
        });
        expect(screen.getByText(/no motion; tool position after line 4/)).toBeInTheDocument();
    });

    it('sends step, go-to and clear requests', async () => {
        renderCard();
        await act(async () => {
            publishPick({ line: 2, drew: true, shownLine: 2 });
            await tick();
        });
        fireEvent.click(screen.getByLabelText('Next move'));
        fireEvent.click(screen.getByLabelText('Previous move'));
        const input = screen.getByTestId('gg-pick-goto');
        fireEvent.change(input, { target: { value: '6' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.click(screen.getByText('G1 Y10'));
        fireEvent.click(screen.getByLabelText('Close'));
        await act(tick);
        expect(requests).toEqual([{ step: 1 }, { step: -1 }, { line: 5 }, { line: 3 }, { clear: true }]);
    });

    it('opens the editor', async () => {
        const opened: any[] = [];
        const t = pubsub.subscribe('gcode-editor:toggle', (_m, v) => opened.push(v));
        renderCard();
        await act(async () => {
            publishPick({ line: 2, drew: true, shownLine: 2 });
            await tick();
        });
        fireEvent.click(screen.getByText('Editor'));
        await act(tick);
        pubsub.unsubscribe(t);
        expect(opened).toEqual([true]);
    });

    it('reads typed line numbers', () => {
        expect(parseLineInput('6', 6)).toBe(5);
        expect(parseLineInput(' 1 ', 6)).toBe(0);
        expect(parseLineInput('7', 6)).toBeNull();
        expect(parseLineInput('0', 6)).toBeNull();
        expect(parseLineInput('2.5', 6)).toBeNull();
        expect(parseLineInput('abc', 6)).toBeNull();
    });
});
