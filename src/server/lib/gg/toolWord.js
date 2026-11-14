/*
 * GGSender addition (not part of upstream gSender).
 *
 * Grbl-family firmware keeps the tool number in 8 bits and answers error:38
 * to anything above 255. When gSender itself runs the tool change (no M6
 * passthrough) the firmware has no use for the T word, so we can keep it out
 * of the stream and track the tool number here instead.
 */

// A T word: the letter, optional spaces, then a number. Lines are expected to
// have had their comments removed already.
const TOOL_WORD = /T\s*(-?\d*\.?\d+)\.?/i;
const TOOL_WORD_GLOBAL = /T\s*-?\d*\.?\d+\.?/gi;

// Lines that are not g-code blocks: firmware commands, gSender expressions
const isNotGcode = (line) => /^\s*[$%[]/.test(line);

/**
 * The tool number programmed on this line, or null.
 * "T405 M6" -> "405", "G1 X10" -> null
 */
export const findToolNumber = (line = '') => {
    if (typeof line !== 'string' || isNotGcode(line)) {
        return null;
    }
    const match = line.match(TOOL_WORD);
    return match ? match[1] : null;
};

/**
 * Remove T words from a g-code line. Returns the line unchanged when it has
 * none or is not g-code.
 */
export const stripToolWord = (line = '') => {
    if (typeof line !== 'string' || isNotGcode(line)) {
        return line;
    }
    return line.replace(TOOL_WORD_GLOBAL, '').replace(/\s{2,}/g, ' ').trim();
};

/**
 * Whether T words should be withheld from the firmware.
 * Only when gSender owns the tool change: no passthrough, and the user has
 * not asked for tool numbers to be sent anyway.
 */
export const shouldStripToolWord = (toolChangeContext = {}) => {
    const { passthrough = false, sendToolNumber = false } = toolChangeContext || {};
    return !passthrough && !sendToolNumber;
};
