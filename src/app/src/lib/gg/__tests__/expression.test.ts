import { evaluateNumericInput } from '../expression';

describe('GGSender: evaluateNumericInput', () => {
    it('reads plain numbers as before', () => {
        expect(evaluateNumericInput('12.5')).toBe(12.5);
        expect(evaluateNumericInput('-5')).toBe(-5);
        expect(evaluateNumericInput('+5')).toBe(5);
        expect(evaluateNumericInput('0')).toBe(0);
        expect(evaluateNumericInput('.5')).toBe(0.5);
        expect(evaluateNumericInput(' 7 ')).toBe(7);
    });

    it('accepts a comma as decimal separator', () => {
        expect(evaluateNumericInput('12,5')).toBe(12.5);
    });

    it('evaluates arithmetic with the usual precedence', () => {
        expect(evaluateNumericInput('12.5/2')).toBe(6.25);
        expect(evaluateNumericInput('2+3*4')).toBe(14);
        expect(evaluateNumericInput('(2+3)*4')).toBe(20);
        expect(evaluateNumericInput('(120-6)/2')).toBe(57);
        expect(evaluateNumericInput('10 - 4 - 3')).toBe(3);
        expect(evaluateNumericInput('100/4/5')).toBe(5);
        expect(evaluateNumericInput('-(3+2)')).toBe(-5);
        expect(evaluateNumericInput('2*-3')).toBe(-6);
    });

    it('applies a leading * or / to the current value', () => {
        expect(evaluateNumericInput('/2', '80.000')).toBe(40);
        expect(evaluateNumericInput('*3', 1.5)).toBe(4.5);
        expect(evaluateNumericInput('/2', '-80')).toBe(-40);
        expect(evaluateNumericInput('/2+1', 10)).toBe(6);
    });

    it('treats a leading + or - as a sign, not as an operation on the current value', () => {
        expect(evaluateNumericInput('-5', 80)).toBe(-5);
        expect(evaluateNumericInput('+5', 80)).toBe(5);
    });

    it('removes floating point noise', () => {
        expect(evaluateNumericInput('0.1+0.2')).toBe(0.3);
        expect(evaluateNumericInput('1/3')).toBe(0.333333);
    });

    it('rejects anything that is not a finite result', () => {
        expect(evaluateNumericInput('')).toBeNull();
        expect(evaluateNumericInput('abc')).toBeNull();
        expect(evaluateNumericInput('12..5')).toBeNull();
        expect(evaluateNumericInput('1/0')).toBeNull();
        expect(evaluateNumericInput('(1+2')).toBeNull();
        expect(evaluateNumericInput('1+')).toBeNull();
        expect(evaluateNumericInput('2 3')).toBeNull();
        expect(evaluateNumericInput('/2', 'abc')).toBeNull();
        expect(evaluateNumericInput(undefined)).toBeNull();
        expect(evaluateNumericInput(NaN)).toBeNull();
    });

    it('never executes code', () => {
        expect(evaluateNumericInput('alert(1)')).toBeNull();
        expect(evaluateNumericInput('1;2')).toBeNull();
        expect(evaluateNumericInput('1e3')).toBeNull();
    });
});
