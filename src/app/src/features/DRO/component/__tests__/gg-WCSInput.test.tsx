import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('@posthog/react', () => ({ usePostHog: () => null }));

// eslint-disable-next-line import/first
import { WCSInput } from '../WCSInput';

describe('GGSender: calculations in the work coordinate field', () => {
    const setup = (value = '80.000') => {
        const handler = jest.fn();
        render(<WCSInput value={value} axis={'X' as any} movementHandler={handler} />);
        return { handler, input: screen.getByTestId('wcs-input-X') as HTMLInputElement };
    };

    it('sends the result of a calculation', () => {
        const { handler, input } = setup();
        fireEvent.change(input, { target: { value: '(120-6)/2' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(57, 'X');
    });

    it('applies /2 to the current value', () => {
        const { handler, input } = setup('80.000');
        fireEvent.change(input, { target: { value: '/2' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(handler).toHaveBeenCalledWith(40, 'X');
    });

    it('still accepts a plain number', () => {
        const { handler, input } = setup();
        fireEvent.change(input, { target: { value: '-12.5' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(handler).toHaveBeenCalledWith(-12.5, 'X');
    });

    it('sends nothing for invalid text', () => {
        const { handler, input } = setup();
        fireEvent.change(input, { target: { value: '12..5' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(handler).not.toHaveBeenCalled();
        expect(input.className).toMatch(/text-red-500/);
    });
});
