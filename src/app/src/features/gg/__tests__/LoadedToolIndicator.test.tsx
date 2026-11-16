import { act, fireEvent, render, screen } from '@testing-library/react';

import { LoadedToolIndicator } from '../LoadedToolIndicator';
import { getLoadedTool, setLoadedTool } from 'app/lib/gg/loadedTool';

describe('GGSender: loaded tool indicator', () => {
    beforeEach(() => {
        act(() => setLoadedTool(null));
    });

    it('shows T? when the tool is unknown', () => {
        render(<LoadedToolIndicator />);
        expect(screen.getByTestId('gg-loaded-tool')).toHaveTextContent('T?');
    });

    it('shows the recorded tool and follows changes', () => {
        act(() => setLoadedTool('T5'));
        render(<LoadedToolIndicator />);
        expect(screen.getByTestId('gg-loaded-tool')).toHaveTextContent('T5');
        act(() => setLoadedTool('405'));
        expect(screen.getByTestId('gg-loaded-tool')).toHaveTextContent('T405');
    });

    it('lets the user correct the tool', () => {
        render(<LoadedToolIndicator />);
        fireEvent.click(screen.getByTestId('gg-loaded-tool'));
        const input = screen.getByTestId('gg-loaded-tool-input');
        fireEvent.change(input, { target: { value: '12' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(getLoadedTool().tool).toBe('12');
        expect(screen.getByTestId('gg-loaded-tool')).toHaveTextContent('T12');
        // editor closed
        expect(screen.queryByTestId('gg-loaded-tool-input')).toBeNull();
    });

    it('refuses something that is not a tool number', () => {
        act(() => setLoadedTool('T5'));
        render(<LoadedToolIndicator />);
        fireEvent.click(screen.getByTestId('gg-loaded-tool'));
        const input = screen.getByTestId('gg-loaded-tool-input');
        fireEvent.change(input, { target: { value: 'abc' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(getLoadedTool().tool).toBe('5');
        expect(screen.getByText('Set')).toBeDisabled();
    });

    it('can mark the tool as unknown', () => {
        act(() => setLoadedTool('T5'));
        render(<LoadedToolIndicator />);
        fireEvent.click(screen.getByTestId('gg-loaded-tool'));
        fireEvent.click(screen.getByText('Mark as unknown'));
        expect(getLoadedTool().tool).toBeNull();
        expect(screen.getByTestId('gg-loaded-tool')).toHaveTextContent('T?');
    });
});
