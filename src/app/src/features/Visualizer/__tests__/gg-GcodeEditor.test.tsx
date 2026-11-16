import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import pubsub from 'pubsub-js';

// the shared mock has no default export flag; render plain text instead
jest.mock('react-syntax-highlighter', () => ({
    __esModule: true,
    default: ({ children }: any) => <span>{children}</span>,
    a11yDark: {},
    a11yLight: {},
}));

// eslint-disable-next-line import/first
import GcodeEditor from '../GcodeEditor';
import { PICK_REQUEST, publishPick } from 'app/features/gg/pickTopics';

const tick = () => new Promise((r) => setTimeout(r, 0));
const content = Array.from({ length: 200 }, (_, i) => `G1 X${i} F100`).join('\n');

const renderEditor = (onClose = jest.fn()) => {
    const reduxStore = configureStore({
        reducer: () =>
            ({
                file: { content, name: 'job.nc' },
                controller: { workflow: { state: 'idle' }, sender: { status: {} } },
            }) as any,
    });
    const utils = render(
        <Provider store={reduxStore}>
            <GcodeEditor onClose={onClose} />
        </Provider>,
    );
    return { ...utils, onClose };
};

describe('GGSender: editor and 3D view', () => {
    beforeAll(() => {
        Element.prototype.scrollTo = function scrollTo(opts: any) {
            (this as any).scrollTop = opts?.top ?? 0;
        };
    });

    it('a line number shows the line in the 3D view and closes the editor', async () => {
        publishPick(null);
        const requests: any[] = [];
        const token = pubsub.subscribe(PICK_REQUEST, (_m, p) => requests.push(p));
        const { onClose } = renderEditor();
        await act(tick); // lines are split on the next tick
        fireEvent.click(screen.getByTestId('gg-editor-line-number-4'));
        await act(tick);
        pubsub.unsubscribe(token);
        expect(requests).toEqual([{ line: 4 }]);
        expect(onClose).toHaveBeenCalled();
    });

    it('opens at the line picked in the 3D view, highlighted', async () => {
        publishPick({ line: 150, drew: true, shownLine: 150 });
        const { container } = renderEditor();
        await act(tick);
        const scroller = container.querySelector('.line-container') as HTMLElement;
        // line 150 is 150 * 32 px down; the editor centres it
        expect(scroller.scrollTop).toBeGreaterThan(140 * 32);
        await act(async () => {
            fireEvent.scroll(scroller);
            await new Promise((r) => setTimeout(r, 50));
        });
        const number = screen.getByTestId('gg-editor-line-number-150');
        expect(number.parentElement.className).toMatch(/ring-pink-500/);
    });
});
