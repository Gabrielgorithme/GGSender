/*
 * GGSender: the G-code of the Fixed Tool Sensor wizards, as the interface
 * sends it (src/app/src/wizards/automaticToolchange.tsx, probeToolLength.tsx),
 * for the simulated-board test (controllers/Grbl/__tests__/gg-stream-sim.test.js).
 * src/app/src/wizards/__tests__/
 * gg-wizard-lines.test.tsx checks that these are the real wizards' lines, so
 * the simulation cannot drift from what the app sends.
 */

/** The wizard's start code, with the settings filled in. */
const startLines = ({ probe = { x: -10, y: -20, z: -30 }, safeZ = '-0.1', probeDistance = '48.000', comment = 'Toolchange initiated' } = {}) => [
    '%wait',
    '%global.toolchange.PROBE_THICKNESS_MM=15',
    `%global.toolchange.PROBE_DISTANCE=${probeDistance}`,
    '%global.toolchange.PROBE_FEEDRATE=150',
    '%global.toolchange.PROBE_SLOW_FEEDRATE=75',
    '%global.toolchange.RETRACT=4',
    `%global.toolchange.PROBE_POS_X=${probe.x}`,
    `%global.toolchange.PROBE_POS_Y=${probe.y}`,
    `%global.toolchange.PROBE_POS_Z=${probe.z}`,
    `%global.toolchange.Z_SAFE_HEIGHT=${safeZ}`,
    '%global.toolchange.UNITS=modal.units',
    '%global.toolchange.SPINDLE=modal.spindle',
    '%global.toolchange.DISTANCE=modal.distance',
    '%global.toolchange.FEEDRATE=programFeedrate',
    '%global.toolchange.SPINDLE_RATE=spindleRate',
    '(STORED: [global.toolchange.SPINDLE] S[global.toolchange.SPINDLE_RATE])',
    'M5 S0',
    '%wait',
    '%global.toolchange.XPOS=posx',
    '%global.toolchange.YPOS=posy',
    '%global.toolchange.ZPOS=posz',
    'G91 G21',
    'G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
    `(${comment})`,
];

/** "Probe Initial Tool" (full wizard) and "Probe Tool Length" (measure only): the tool in the spindle becomes the reference. */
const PROBE_AS_REFERENCE = [
    'G91 G21',
    'G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
    'G53 G0 X[global.toolchange.PROBE_POS_X] Y[global.toolchange.PROBE_POS_Y]',
    'G53 G0 Z[global.toolchange.PROBE_POS_Z]',
    'G38.2 Z-[global.toolchange.PROBE_DISTANCE] F[global.toolchange.PROBE_FEEDRATE]',
    'G0 Z[global.toolchange.RETRACT]',
    'G38.2 Z-10 F[global.toolchange.PROBE_SLOW_FEEDRATE]',
    'G4 P0.3',
    '%global.toolchange.TOOL_OFFSET=posz',
    '(TLO set: [global.toolchange.TOOL_OFFSET])',
    'G0 Z[global.toolchange.RETRACT]',
    'G90 G21',
    'G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
];

/** "Probe Changed Tool": the new tool is set to read the reference on the sensor. */
const PROBE_AGAINST_REFERENCE = [
    '(Moving back to configured location)',
    'G90 G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
    'G90 G53 G0 X[global.toolchange.PROBE_POS_X] Y[global.toolchange.PROBE_POS_Y]',
    'G53 G0 Z[global.toolchange.PROBE_POS_Z]',
    'G91 G21',
    'G38.2 Z-[global.toolchange.PROBE_DISTANCE] F[global.toolchange.PROBE_FEEDRATE]',
    'G0 Z[global.toolchange.RETRACT]',
    'G38.2 Z-15 F[global.toolchange.PROBE_SLOW_FEEDRATE]',
    '(Set Z to Tool offset and wait)',
    'G4 P0.3',
    'G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]',
    'G0 Z[global.toolchange.RETRACT]',
    'G53 G21 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
    'G21 G91',
];

/** "Resume Cutting" / "Resume", with the fork's default (Z stays at the safe height). */
const RESUME = [
    '(Restart Spindle)',
    '([global.toolchange.SPINDLE] S[global.toolchange.SPINDLE_RATE])',
    '[global.toolchange.SPINDLE] S[global.toolchange.SPINDLE_RATE]',
    '(Returning to initial position)',
    'G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]',
    'G90 G0 X[global.toolchange.XPOS] Y[global.toolchange.YPOS]',
    '(Z stays at tool change safe height)',
    '(Restore initial modals)',
    '[global.toolchange.UNITS] [global.toolchange.DISTANCE] [global.toolchange.FEEDRATE]',
    '%wait',
    '%toolchange_complete',
];

module.exports = { startLines, PROBE_AS_REFERENCE, PROBE_AGAINST_REFERENCE, RESUME };
