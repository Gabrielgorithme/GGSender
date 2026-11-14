/*
 * GGSender: the four tool change wizards must honour the safe height and
 * "return to starting Z" settings.
 */
import store from 'app/store';
import controller from 'app/lib/controller';
import createAutomatic from '../automaticToolchange';
import createProbeToolLength from '../probeToolLength';
import createSemiauto from '../semiautoToolchange';
import manual from '../manualToolchange';

const allActionLines = (wizard: any): string[] =>
    wizard.steps.flatMap((step: any) =>
        step.substeps.flatMap((substep: any) =>
            (substep.actions || []).flatMap(
                (action: any) => action.gcodeLines || [],
            ),
        ),
    );

const lastActionLines = (wizard: any): string[] => {
    const steps = wizard.steps;
    const substeps = steps[steps.length - 1].substeps;
    const actions = substeps[substeps.length - 1].actions;
    return actions[actions.length - 1].gcodeLines;
};

// onStart either returns its lines or sends them through the controller
const startLines = (wizard: any): string[] => {
    const spy = jest
        .spyOn(controller, 'command')
        .mockImplementation(() => undefined as any);
    const returned = wizard.onStart();
    const sent = spy.mock.calls.flatMap((call) => call[1] as string[]);
    spy.mockRestore();
    return Array.isArray(returned) ? returned : sent;
};

const set = (safeZ: number, returnToStartZ: boolean) => {
    store.set('workspace.toolChange.safeZ', safeZ);
    store.set('workspace.toolChange.returnToStartZ', returnToStartZ);
};

const wizards: [string, () => any][] = [
    ['fixed tool sensor', () => createAutomatic(2)],
    ['probe tool length', () => createProbeToolLength()],
    ['flexible re-zero', () => createSemiauto(2)],
    ['standard re-zero', () => manual],
];

describe.each(wizards)('GGSender tool change Z moves: %s', (_name, make) => {
    it('uses the configured safe height', () => {
        set(-0.1, false);
        expect(startLines(make())).toContain(
            '%global.toolchange.Z_SAFE_HEIGHT=-0.1',
        );
        set(0, false);
        expect(startLines(make())).toContain(
            '%global.toolchange.Z_SAFE_HEIGHT=0',
        );
        set(-7.5, false);
        expect(startLines(make())).toContain(
            '%global.toolchange.Z_SAFE_HEIGHT=-7.5',
        );
    });

    it('does not plunge back to the starting Z when the setting is off', () => {
        set(-0.1, false);
        const lines = lastActionLines(make());
        expect(lines.join('\n')).not.toMatch(/toolchange\.ZPOS/);
        expect(lines).toContain('(Z stays at tool change safe height)');
        // still returns in X/Y and hands back to the job
        expect(lines.join('\n')).toMatch(/toolchange\.XPOS/);
        expect(lines).toContain('%toolchange_complete');
    });

    it('goes to the safe height before returning in X/Y when the setting is off', () => {
        set(-0.1, false);
        const lines = lastActionLines(make());
        const safe = lines.findIndex((l) => /G53.*Z_SAFE_HEIGHT/.test(l));
        const xy = lines.findIndex((l) => /toolchange\.XPOS/.test(l));
        expect(safe).toBeGreaterThanOrEqual(0);
        expect(safe).toBeLessThan(xy);
    });

    it('returns to the starting Z, after X/Y, when the setting is on', () => {
        set(-0.1, true);
        const lines = lastActionLines(make());
        const xy = lines.findIndex((l) => /toolchange\.XPOS/.test(l));
        const z = lines.findIndex((l) => /toolchange\.ZPOS/.test(l));
        expect(z).toBeGreaterThan(xy);
        expect(lines).toContain('%toolchange_complete');
    });

    it('contains no hard-coded safe height', () => {
        set(-0.1, false);
        const lines = [...startLines(make()), ...allActionLines(make())];
        const g53z = lines.filter((l) => /G53.*\bZ/.test(l));
        expect(g53z.length).toBeGreaterThan(0);
        g53z.forEach((l) => expect(l).toMatch(/Z\[global\.toolchange\./));
    });
});
