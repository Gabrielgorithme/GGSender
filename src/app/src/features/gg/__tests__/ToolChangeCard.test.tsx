// GGSender: tool drawing in the tool change wizard
import fs from 'fs';
import path from 'path';
import { act, render, screen, within } from '@testing-library/react';

import store from 'app/store';
import { analyzeJob } from 'app/lib/gg/jobOperations';
import { setJobInfo } from 'app/lib/gg/jobInfoStore';
import { TOOL_DRAWING_KEY, WithToolDrawing } from '../ToolChangeCard';

// The real Instructions component, with a wizard on its "Measure New Tool" step
const wizard: any = {};
jest.mock('app/features/Helper/context', () => ({
    useWizardContext: () => wizard,
}));
// the step's text and buttons are not what is tested here
jest.mock('app/features/Helper/components/Substep', () => () => <div data-testid="substep" />);
// eslint-disable-next-line import/first
import Instructions from 'app/features/Helper/components/Instructions';

const tick = () => new Promise((r) => setTimeout(r, 0));
const fixture = fs.readFileSync(path.join(__dirname, '../../../lib/gg/__tests__/fixtures/fusion-job-trimmed.nc'), 'utf8');
const info = analyzeJob(fixture);
const t40 = info.groups.filter((g) => g.tool === '40');

const Banner = () => <div data-testid="upstream-banner">Install New Tool</div>;

describe('GGSender: tool change card', () => {
    beforeEach(async () => {
        store.set(TOOL_DRAWING_KEY, true);
        await act(async () => {
            setJobInfo(info, 'job.nc');
            await tick();
        });
    });

    it('draws the tool beside the upstream banner, with its numbers', () => {
        render(
            <WithToolDrawing toolLabel="T43" toolchangeContext={{ line: (info.groups[6].changeSeq as number) + 1 }}>
                <Banner />
            </WithToolDrawing>,
        );
        expect(screen.getByTestId('upstream-banner')).toBeInTheDocument();
        const card = screen.getByTestId('gg-toolchange-card');
        expect(within(card).getByTestId('gg-tool-drawing').getAttribute('data-kind')).toBe('chamfer');
        expect(within(card).getByText('chamfer mill')).toBeInTheDocument();
        expect(within(card).getByTestId('gg-toolchange-size')).toHaveTextContent('⌀ 4 mm');
        expect(card).toHaveTextContent('Taper 45° (90° tool)');
        expect(card).toHaveTextContent('Cuts down to Z-0.35');
        expect(within(card).getByTestId('gg-toolchange-ops')).toHaveTextContent('For operation: Trace1');
        expect(within(card).getByTestId('gg-tool-dim-angle')).toBeInTheDocument();
    });

    it('the same tool fitted twice: the operations of this change, from the M6 line', () => {
        const ops = (line: number) => {
            const { unmount } = render(
                <WithToolDrawing toolLabel="T40" toolchangeContext={{ line }}>
                    <Banner />
                </WithToolDrawing>,
            );
            const text = screen.getByTestId('gg-toolchange-ops').textContent;
            unmount();
            return text;
        };
        expect(ops((t40[0].changeSeq as number) + 1)).toBe('For 2 operations: 2D Contour2, Bore1');
        expect(ops((t40[1].changeSeq as number) + 1)).toBe('For operation: 2D Contour3');
    });

    it('bull nose: corner radius shown', () => {
        render(
            <WithToolDrawing toolLabel="T45" toolchangeContext={{ line: (info.groups[0].changeSeq as number) + 1 }}>
                <Banner />
            </WithToolDrawing>,
        );
        expect(screen.getByTestId('gg-toolchange-size')).toHaveTextContent('⌀ 4 mm · R 0.5 mm');
        expect(screen.getByTestId('gg-tool-dim-radius')).toHaveTextContent('R0.5');
    });

    it('only the upstream banner when the tool is not described, or the setting is off', async () => {
        const { unmount } = render(
            <WithToolDrawing toolLabel="T7" toolchangeContext={null}>
                <Banner />
            </WithToolDrawing>,
        );
        expect(screen.getByTestId('upstream-banner')).toBeInTheDocument();
        expect(screen.queryByTestId('gg-toolchange-card')).toBeNull();
        unmount();

        store.set(TOOL_DRAWING_KEY, false);
        render(
            <WithToolDrawing toolLabel="T43" toolchangeContext={null}>
                <Banner />
            </WithToolDrawing>,
        );
        expect(screen.getByTestId('upstream-banner')).toBeInTheDocument();
        expect(screen.queryByTestId('gg-toolchange-card')).toBeNull();
    });

    it('in the real wizard step, next to "Install New Tool"', () => {
        Object.assign(wizard, {
            steps: [
                {
                    title: 'Prepare New Tool',
                    substeps: [{ title: 'Measure New Tool', description: 'Probe it.', toolBanner: true, actions: [] }],
                },
            ],
            activeStep: 0,
            activeSubstep: 0,
            toolchangeContext: { tool: 'T45', line: (info.groups[2].changeSeq as number) + 1 },
            toolchangeComment: '',
            pendingToolchangeNotice: false,
            resumingJob: false,
        });
        render(<Instructions />);
        expect(screen.getByText('Install New Tool')).toBeInTheDocument();
        const row = screen.getByTestId('gg-toolchange-row');
        expect(within(row).getByText('T45')).toBeInTheDocument();
        expect(within(row).getByTestId('gg-toolchange-ops')).toHaveTextContent(
            'For 4 operations: 3D Adaptive Roughing1 2, Flat1, Parallel1, Parallel1 2',
        );
    });
});
