import { act, fireEvent, render, screen } from '@testing-library/react';

import { LoadedToolIndicator } from '../LoadedToolIndicator';
import { getLoadedTool, setLoadedTool } from 'app/lib/gg/loadedTool';
import { setReference } from 'app/lib/gg/probeStore';

describe('GGSender: loaded tool indicator', () => {
    beforeEach(() => {
        act(() => setLoadedTool(null));
        act(() => setReference(null));
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

describe('GGSender: the tool sensor reference on the chip', () => {
    const at = (h: number, m: number) => {
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d.getTime();
    };
    const VALID: Record<string, any> = {
        status: 'valid',
        reference: { value: -15.002, tool: '45', at: at(14, 32), wcs: 'G54', wcoZ: -50 },
        lastProbe: { kind: 'measured', tool: '20', at: at(14, 45) },
        stale: null,
        watching: true,
        wcs: 'G54',
        history: [
            { kind: 'reference', at: at(14, 32), tool: '45', value: -15.002 },
            { kind: 'measured', at: at(14, 45), tool: '20', deltaZ: -12.5 },
        ],
    };
    const STALE: Record<string, any> = {
        ...VALID,
        status: 'stale',
        stale: { kind: 'zero', at: at(14, 50), deltaZ: 3.2 },
        history: [...VALID.history, { kind: 'zero', at: at(14, 50), tool: '20', deltaZ: 3.2 }],
    };

    beforeEach(() => {
        act(() => setLoadedTool('T20'));
        act(() => setReference(null));
    });

    it('not connected: the tool only, no pictogram', () => {
        render(<LoadedToolIndicator />);
        const chip = screen.getByTestId('gg-loaded-tool');
        expect(chip).toHaveTextContent('T20');
        expect(chip.querySelector('[data-testid^="gg-reference-icon"]')).toBeNull();
        fireEvent.click(chip);
        expect(screen.getByTestId('gg-reference-panel')).toHaveTextContent('Not connected');
    });

    it('connected: a pictogram for the state, which follows the server', () => {
        render(<LoadedToolIndicator />);
        const chip = screen.getByTestId('gg-loaded-tool');
        act(() => setReference({ status: 'none', reference: null, history: [] }));
        expect(chip.querySelector('[data-testid="gg-reference-icon-none"]')).not.toBeNull();
        act(() => setReference(VALID));
        expect(chip.querySelector('[data-testid="gg-reference-icon-valid"]')).not.toBeNull();
        expect(chip.getAttribute('title')).toContain('Last probe: T20 at 14:45, against the reference (T45, 14:32).');
        act(() => setReference(STALE)); // Z zero set from the pendant
        expect(chip.querySelector('[data-testid="gg-reference-icon-stale"]')).not.toBeNull();
        expect(chip.querySelector('[data-testid="gg-reference-icon-valid"]')).toBeNull();
        expect(chip.getAttribute('title')).toContain('Z zero changed at 14:50');
    });

    it('the panel: which tool was probed and when, what a tool change will do, and the history, newest first', () => {
        act(() => setReference(STALE));
        render(<LoadedToolIndicator />);
        fireEvent.click(screen.getByTestId('gg-loaded-tool'));
        const panel = screen.getByTestId('gg-reference-panel');
        expect(panel).toHaveTextContent('Reference not correct');
        expect(panel).toHaveTextContent('Z zero changed at 14:50, after the last probe (T45, 14:32). The reference is not correct now.');
        expect(panel).toHaveTextContent('At a tool change, gSender first measures the tool in the spindle as the new reference.');
        expect(panel).toHaveTextContent('If you use the old reference, Z zero goes back to its position of 14:32.');
        const lines = Array.from(screen.getByTestId('gg-reference-history').querySelectorAll('li')).map((li) => li.textContent);
        expect(lines).toEqual([
            '14:50Z zero changed (by hand, pendant, probe or command).',
            '14:45T20 measured against the reference. Z zero stays on the part.',
            '14:32T45 probed as the reference.',
        ]);
        // the tool can still be corrected in the same panel
        expect(screen.getByTestId('gg-loaded-tool-input')).toBeInTheDocument();
    });
});

