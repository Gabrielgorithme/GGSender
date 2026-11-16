import {
    formatHiddenCodes,
    getHiddenCodes,
    hideCode,
    parseHiddenCodes,
    splitIssues,
    unhideCode,
} from '../preflightHidden';
import store from 'app/store';

describe('GGSender: hidden pre-flight warnings', () => {
    it('reads codes one per line, with commas or spaces too, in any case', () => {
        expect(Array.from(parseHiddenCodes('RAPID_BELOW_ZERO\ng92, same_tool_twice  G53_IN_PROGRAM')).sort())
            .toEqual(['G53_IN_PROGRAM', 'G92', 'RAPID_BELOW_ZERO', 'SAME_TOOL_TWICE']);
        expect(parseHiddenCodes('').size).toBe(0);
        expect(parseHiddenCodes(undefined).size).toBe(0);
        expect(parseHiddenCodes('not a code!').has('CODE!')).toBe(false);
    });

    it('never hides errors', () => {
        const issues = [
            { severity: 'error' as const, code: 'TRAVEL_Z', message: '' },
            { severity: 'warning' as const, code: 'RAPID_BELOW_ZERO', message: '' },
            { severity: 'info' as const, code: 'G53_IN_PROGRAM', message: '' },
        ];
        const { shown, hidden } = splitIssues(issues, new Set(['TRAVEL_Z', 'RAPID_BELOW_ZERO', 'G53_IN_PROGRAM']));
        expect(shown.map((i) => i.code)).toEqual(['TRAVEL_Z']);
        expect(hidden.map((i) => i.code)).toEqual(['RAPID_BELOW_ZERO', 'G53_IN_PROGRAM']);
    });

    it('adds and removes codes in the setting', () => {
        store.set('workspace.gg.preflightHidden', '');
        hideCode('RAPID_BELOW_ZERO');
        hideCode('g92');
        hideCode('RAPID_BELOW_ZERO');
        expect(store.get('workspace.gg.preflightHidden')).toBe('G92\nRAPID_BELOW_ZERO');
        unhideCode('G92');
        expect(Array.from(getHiddenCodes())).toEqual(['RAPID_BELOW_ZERO']);
        expect(formatHiddenCodes(new Set())).toBe('');
    });
});
