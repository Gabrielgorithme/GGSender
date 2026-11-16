// GGSender: Fusion tool table comments
import { classifyTool, parseToolSpec, toolSummary } from '../toolSpec';

describe('GGSender tool spec: the forms Fusion writes', () => {
    it('chamfer mill with taper and ZMIN', () => {
        expect(parseToolSpec('(T43 D=4 CR=0 TAPER=45deg - ZMIN=-0.35 - chamfer mill)')).toEqual({
            number: '43',
            diameter: 4,
            cornerRadius: 0,
            taperDeg: 45,
            zMin: -0.35,
            type: 'chamfer mill',
            description: '',
            kind: 'chamfer',
            text: 'T43 D=4 CR=0 TAPER=45deg - ZMIN=-0.35 - chamfer mill',
        });
    });

    it.each([
        ['T1 D=6 CR=3 - ZMIN=-0.5 - ball end mill', 'ball', 6, 3, null],
        ['T2 D=6 CR=0.75 - ZMIN=-0.5 - bullnose end mill', 'bullnose', 6, 0.75, null],
        ['T3 D=6 CR=0 - ZMIN=-0.5 - flat end mill', 'flat', 6, 0, null],
        ['T4 D=12 CR=2.5 TAPER=10deg - ZMIN=-0.5 - tapered mill', 'tapered', 12, 2.5, 10],
        ['T6 D=12 CR=0 TAPER=45deg - ZMIN=-0.5 - chamfer mill', 'chamfer', 12, 0, 45],
        ['T9 D=12 CR=6 - ZMIN=-0.5 - lollipop mill', 'lollipop', 12, 6, null],
        ['T11 D=10 CR=0 - ZMIN=-0.5 - thread mill', 'thread', 10, 0, null],
        ['T20 D=2 CR=0 - ZMIN=-5.5 - flat end mill', 'flat', 2, 0, null],
    ])('%s', (text, kind, d, cr, taper) => {
        const spec = parseToolSpec(text);
        expect(spec).toMatchObject({ kind, diameter: d, cornerRadius: cr, taperDeg: taper });
    });

    it('without ZMIN (2D programs), with a description part, inch values', () => {
        expect(parseToolSpec('(T7 D=0.25 CR=0 - flat end mill)')).toMatchObject({ diameter: 0.25, zMin: null, kind: 'flat' });
        expect(parseToolSpec('T7 D=6. CR=0. - ZMIN=-3. - flat end mill - 6mm 2F upcut')).toMatchObject({
            diameter: 6,
            zMin: -3,
            type: 'flat end mill',
            description: '6mm 2F upcut',
        });
    });

    it('is not fooled by other comments', () => {
        expect(parseToolSpec('(3D Adaptive Roughing1)')).toBeNull();
        expect(parseToolSpec('(T5 flat 6mm)')).toBeNull(); // no D=
        expect(parseToolSpec('(Trace1)')).toBeNull();
        expect(parseToolSpec('(TLO set: 12.3)')).toBeNull();
    });

    it('drops impossible numbers', () => {
        expect(parseToolSpec('T5 D=0 CR=-1 TAPER=0deg - flat end mill')).toMatchObject({
            diameter: null,
            cornerRadius: null,
            taperDeg: null,
        });
    });
});

describe('GGSender tool spec: kind of drawing', () => {
    it('from the type name', () => {
        expect(classifyTool('spot drill', 6, 0)).toBe('chamfer');
        expect(classifyTool('drill', 6, 0)).toBe('drill');
        expect(classifyTool('face mill', 50, 0)).toBe('flat');
        expect(classifyTool('dovetail mill', 10, 0)).toBe('other');
        expect(classifyTool('', 6, 0)).toBe('other');
    });

    it('refined by the numbers', () => {
        expect(classifyTool('flat end mill', 6, 1)).toBe('bullnose');
        expect(classifyTool('bullnose end mill', 6, 3)).toBe('ball');
        expect(classifyTool('bullnose end mill', 6, 0)).toBe('flat');
        // a tapered ball stays tapered
        expect(classifyTool('tapered mill', 1, 0.5)).toBe('tapered');
    });
});

describe('GGSender tool spec: summary', () => {
    it('shows R only when it is not the ball radius', () => {
        const s = (t: string) => toolSummary(parseToolSpec(t)!);
        expect(s('T45 D=4 CR=0.5 - ZMIN=-5.8 - bullnose end mill')).toBe('⌀4 R0.5 bullnose end mill');
        expect(s('T31 D=3 CR=1.5 - ball end mill')).toBe('⌀3 ball end mill');
        expect(s('T43 D=4 CR=0 TAPER=45deg - chamfer mill')).toBe('⌀4 45° chamfer mill');
    });
});
