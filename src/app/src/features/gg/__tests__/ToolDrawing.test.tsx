// GGSender: SVG side view of a tool
import { render } from '@testing-library/react';
import { ToolDrawing } from '../ToolDrawing';
import { ToolKind } from 'app/lib/gg/toolSpec';

const spec = (kind: ToolKind, d = 6, cr = 0, taper: number | null = null) => ({
    kind,
    diameter: d,
    cornerRadius: cr,
    taperDeg: taper,
});

describe('GGSender: tool drawing', () => {
    it.each<[ToolKind, number, number, number | null, string[]]>([
        ['flat', 6, 0, null, ['diameter']],
        ['bullnose', 6, 0.75, null, ['diameter', 'radius']],
        ['ball', 6, 3, null, ['diameter']],
        ['chamfer', 12, 0, 45, ['diameter', 'angle']],
        ['tapered', 12, 2.5, 10, ['diameter', 'radius', 'angle']],
        ['lollipop', 12, 6, null, ['diameter']],
        ['thread', 10, 0, null, ['diameter']],
    ])('%s: outline and dimensions', (kind, d, cr, taper, dims) => {
        const { container, getByTestId } = render(<ToolDrawing spec={spec(kind, d, cr, taper)} />);
        const svg = getByTestId('gg-tool-drawing');
        expect(svg.getAttribute('data-kind')).toBe(kind);
        expect(getByTestId('gg-tool-outline').getAttribute('points')!.split(' ').length).toBeGreaterThan(3);
        const found = ['diameter', 'radius', 'angle'].filter(
            (k) => container.querySelector(`[data-testid="gg-tool-dim-${k}"]`) !== null,
        );
        expect(found).toEqual(dims);
        expect(svg.getAttribute('height')).toBe('150');
    });

    it('compact: outline only', () => {
        const { container } = render(<ToolDrawing spec={spec('bullnose', 4, 0.5)} compact height={26} />);
        expect(container.querySelector('[data-testid^="gg-tool-dim"]')).toBeNull();
        expect(container.querySelector('text')).toBeNull();
    });

    it('each drawing has its own clip path', () => {
        const { container } = render(
            <>
                <ToolDrawing spec={spec('flat')} />
                <ToolDrawing spec={spec('ball', 6, 3)} />
            </>,
        );
        const ids = Array.from(container.querySelectorAll('clipPath')).map((c) => c.id);
        expect(new Set(ids).size).toBe(2);
    });

    it('labels in the file\'s numbers', () => {
        const { getByTestId } = render(<ToolDrawing spec={spec('bullnose', 0.25, 0.03)} />);
        expect(getByTestId('gg-tool-dim-diameter')).toHaveTextContent('⌀0.25');
        expect(getByTestId('gg-tool-dim-radius')).toHaveTextContent('R0.03');
    });
});
