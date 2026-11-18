// GGSender: job progress as text over the 3D view, no box
import { render, screen } from '@testing-library/react';
import ProgressArea from 'app/features/JobControl/ProgressArea';

const status = (over = {}) =>
    ({
        total: 1000,
        currentLineRunning: 425,
        elapsedTime: 61000,
        remainingTime: 725,
        startTime: Date.now() - 61000,
        ...over,
    }) as any;

describe('GGSender: job progress text', () => {
    it('percentage and time left, with no box behind them', () => {
        const { container } = render(<ProgressArea senderStatus={status()} workflowState="running" />);
        expect(screen.getByTestId('gg-progress-percent')).toHaveTextContent('42%');
        expect(screen.getByTestId('gg-progress-remaining')).toHaveTextContent('12m05sremaining');
        expect(container.querySelector('.border-solid')).toBeNull();
        // upstream's box: bg-gray-100 / dark:bg-dark behind the numbers
        const boxed = Array.from(container.querySelectorAll('*')).filter(
            (el) => el.classList.contains('bg-gray-100') || el.classList.contains('dark:bg-dark'),
        );
        expect(boxed).toEqual([]);
        // the line count and cutting time stay below
        expect(screen.getByText('425 / 1000 Lines')).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
    });

    it('finalizing once all lines are sent but time remains', () => {
        render(<ProgressArea senderStatus={status({ currentLineRunning: 1000, remainingTime: 3 })} />);
        expect(screen.getByTestId('gg-progress-percent')).toHaveTextContent('100%');
        expect(screen.getByTestId('gg-progress-remaining')).toHaveTextContent('Finalizing');
    });
});
