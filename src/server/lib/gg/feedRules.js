/*
 * GGSender addition (not part of upstream gSender).
 *
 * Per-tool feed and speed rules, applied to each program line just before it
 * is sent. They let you slow one tool down mid-job without editing the file,
 * and stop applying by themselves when the program moves to another tool.
 *
 * One rule per line:
 *
 *   T5 F1000 -> F200     with T5, every F1000 becomes F200
 *   T5 F>800 -> F800     with T5, any feed above 800 becomes 800 (a cap)
 *   T5 F<100 -> F100     with T5, any feed below 100 becomes 100
 *   T5 F*    -> 50%      with T5, every feed is halved
 *   T5 F*    -> F300     with T5, every feed becomes 300
 *   T12 S18000 -> S12000 with T12, S18000 becomes S12000
 *   T*  S*   -> 90%      with any tool, every spindle speed is reduced by 10%
 *
 * Blank lines and lines starting with # or ; are ignored. For each F or S
 * word the first rule that matches wins. Values are in the units the program
 * uses; nothing is converted.
 *
 * A rule changes F and S words as they go by. It does not change a feed that
 * is already in effect: the new value applies from the next F (or S) word in
 * the program, and a few lines are already inside the controller.
 */

const RULE = /^T\s*(\*|\d+)\s+([FS])\s*(\*|[<>]?\s*-?\d*\.?\d+)\s*(?:->|=>|→)\s*(?:([FS])?\s*(-?\d*\.?\d+)\s*(%)?)$/i;

const formatNumber = (n) => {
    const fixed = Number(n.toFixed(3));
    return Object.is(fixed, -0) ? '0' : String(fixed);
};

/**
 * @returns {{ rules: Array, errors: Array<{ line: number, text: string, reason: string }> }}
 */
export const parseFeedRules = (text = '') => {
    const rules = [];
    const errors = [];
    if (typeof text !== 'string') {
        return { rules, errors };
    }

    text.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        if (line === '' || line[0] === '#' || line[0] === ';') {
            return;
        }
        const fail = (reason) => errors.push({ line: index + 1, text: line, reason });

        const m = RULE.exec(line);
        if (!m) {
            fail('not understood');
            return;
        }
        const [, tool, word, matchText, targetWord, targetValue, percent] = m;
        const letter = word.toUpperCase();

        if (targetWord && targetWord.toUpperCase() !== letter) {
            fail(`left side is ${letter}, right side is ${targetWord.toUpperCase()}`);
            return;
        }
        if (!percent && !targetWord) {
            fail(`right side needs ${letter}<number> or <number>%`);
            return;
        }
        if (percent && targetWord) {
            fail('use either a value or a percentage on the right side');
            return;
        }

        const value = Number(targetValue);
        if (!Number.isFinite(value) || value < 0) {
            fail('right side must be zero or more');
            return;
        }
        if (letter === 'F' && value === 0) {
            fail('a feed of zero would stop the machine mid-cut');
            return;
        }

        let match;
        const compact = matchText.replace(/\s+/g, '');
        if (compact === '*') {
            match = { type: 'any' };
        } else if (compact[0] === '>' || compact[0] === '<') {
            match = { type: compact[0] === '>' ? 'above' : 'below', value: Number(compact.slice(1)) };
        } else {
            match = { type: 'equal', value: Number(compact) };
        }
        if (match.type !== 'any' && !Number.isFinite(match.value)) {
            fail('left side value is not a number');
            return;
        }

        rules.push({
            tool: tool === '*' ? '*' : String(Number(tool)),
            word: letter,
            match,
            target: percent ? { type: 'percent', value } : { type: 'value', value },
        });
    });

    return { rules, errors };
};

const matches = (rule, tool, letter, value) => {
    if (rule.word !== letter) {
        return false;
    }
    if (rule.tool !== '*' && (tool === null || tool === undefined || rule.tool !== String(Number(tool)))) {
        return false;
    }
    switch (rule.match.type) {
    case 'any':
        return true;
    case 'above':
        return value > rule.match.value;
    case 'below':
        return value < rule.match.value;
    default:
        return Math.abs(value - rule.match.value) < 1e-6;
    }
};

const isNotGcode = (line) => /^\s*[$%[]/.test(line);

/**
 * Apply the rules to one program line (comments already removed).
 *
 * @param line   the g-code line
 * @param tool   current tool number (string or number), or null if unknown
 * @param rules  from parseFeedRules
 */
export const applyFeedRules = (line, tool, rules) => {
    if (typeof line !== 'string' || !rules || rules.length === 0 || isNotGcode(line)) {
        return line;
    }

    return line.replace(/([FS])(\s*)(-?\d*\.?\d+)/gi, (whole, letterRaw, space, number) => {
        const letter = letterRaw.toUpperCase();
        const value = Number(number);
        if (!Number.isFinite(value)) {
            return whole;
        }
        const rule = rules.find((r) => matches(r, tool, letter, value));
        if (!rule) {
            return whole;
        }
        const next = rule.target.type === 'percent'
            ? (value * rule.target.value) / 100
            : rule.target.value;
        // Never turn a moving feed into zero by rounding
        if (letter === 'F' && value > 0 && Number(next.toFixed(3)) <= 0) {
            return whole;
        }
        return `${letterRaw}${space}${formatNumber(next)}`;
    });
};

// Parsed rules for the text last seen, so the text is not parsed per line
let cachedText = null;
let cachedRules = [];

export const rulesFromContext = (toolChangeContext = {}) => {
    const text = (toolChangeContext && toolChangeContext.feedRules) || '';
    if (text !== cachedText) {
        cachedText = text;
        cachedRules = parseFeedRules(text).rules;
    }
    return cachedRules;
};
