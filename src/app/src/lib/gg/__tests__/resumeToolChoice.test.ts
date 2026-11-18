// GGSender: the tool choices of the Resume From dialog (lib/gg/resumeToolChoice.ts)
import { defaultChoice, sourcesFor, toolModeFor } from '../resumeToolChoice';

describe('GGSender: resume tool choices', () => {
    it('default: Z zero changed after the last probe -> 3 (measure this tool as the new reference)', () => {
        expect(defaultChoice('stale', '45', '45')).toBe(3);
        expect(defaultChoice('stale', '7', '45')).toBe(3);
        expect(defaultChoice('stale', null, '45')).toBe(3);
    });

    it('default: the recorded tool is the line\'s tool -> 1 (nothing measured)', () => {
        expect(defaultChoice('valid', '45', '45')).toBe(1);
        expect(defaultChoice('none', '45', '45')).toBe(1);
        // a program without tools
        expect(defaultChoice('valid', '45', null)).toBe(1);
        expect(defaultChoice('none', null, null)).toBe(1);
    });

    it('default: another tool recorded -> 2 with a valid reference, else no default', () => {
        expect(defaultChoice('valid', '7', '45')).toBe(2);
        expect(defaultChoice('valid', null, '45')).toBe(2);
        expect(defaultChoice('none', '7', '45')).toBeNull();
        expect(defaultChoice('none', null, '45')).toBeNull();
    });

    it('choice 1 keeps the tool, choice 3 measures it as the new reference, in every state', () => {
        (['valid', 'stale', 'none'] as const).forEach((status) => {
            expect(toolModeFor(1, null, status)).toBe('keep');
            expect(toolModeFor(3, null, status)).toBe('reference');
            expect(toolModeFor(3, 'old-reference', status)).toBe('reference');
        });
    });

    it('choice 2 with a valid reference needs nothing more', () => {
        expect(sourcesFor('valid')).toEqual([]);
        expect(toolModeFor(2, null, 'valid')).toBe('measure');
        expect(toolModeFor(2, 'old-tool', 'valid')).toBe('measure');
    });

    it('choice 2 without a correct reference is not complete until the source is selected', () => {
        expect(toolModeFor(2, null, 'stale')).toBeNull();
        expect(toolModeFor(2, null, 'none')).toBeNull();
        expect(sourcesFor('stale')).toEqual(['old-tool', 'old-reference']);
        expect(sourcesFor('none')).toEqual(['old-tool']);
        expect(toolModeFor(2, 'old-tool', 'stale')).toBe('full');
        expect(toolModeFor(2, 'old-tool', 'none')).toBe('full');
        expect(toolModeFor(2, 'old-reference', 'stale')).toBe('measure-old');
        // there is no old reference to use
        expect(toolModeFor(2, 'old-reference', 'none')).toBeNull();
    });

    it('nothing selected: the resume cannot start', () => {
        expect(toolModeFor(null, null, 'valid')).toBeNull();
        expect(toolModeFor(null, 'old-tool', 'none')).toBeNull();
    });
});
