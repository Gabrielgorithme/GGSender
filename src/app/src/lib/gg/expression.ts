/*
 * GGSender addition (not part of upstream gSender).
 *
 * A small arithmetic evaluator for coordinate fields, so that "12.5/2",
 * "(120-6)/2" or "/2" can be typed where a number is expected.
 *
 * Supported: decimal numbers (a comma is accepted as decimal separator),
 * + - * / and parentheses, unary + and -.
 *
 * A leading "*" or "/" applies to the field's current value:
 *   current 80, typed "/2"  -> 40
 * A leading "+" or "-" is a sign, exactly as before this feature existed:
 *   typed "-5" -> -5 (not "current minus 5"; type "80-5" for that)
 *
 * Deliberately a hand-written parser: nothing typed here is ever passed to
 * eval() or Function().
 */

class Parser {
    private pos = 0;

    constructor(private readonly text: string) {}

    parse(): number {
        const value = this.expression();
        this.skipSpaces();
        if (this.pos !== this.text.length) {
            throw new Error('Unexpected input');
        }
        return value;
    }

    private skipSpaces() {
        while (this.pos < this.text.length && this.text[this.pos] === ' ') {
            this.pos++;
        }
    }

    private peek(): string {
        this.skipSpaces();
        return this.text[this.pos] ?? '';
    }

    private expression(): number {
        let value = this.term();
        for (;;) {
            const c = this.peek();
            if (c === '+') {
                this.pos++;
                value += this.term();
            } else if (c === '-') {
                this.pos++;
                value -= this.term();
            } else {
                return value;
            }
        }
    }

    private term(): number {
        let value = this.factor();
        for (;;) {
            const c = this.peek();
            if (c === '*') {
                this.pos++;
                value *= this.factor();
            } else if (c === '/') {
                this.pos++;
                value /= this.factor();
            } else {
                return value;
            }
        }
    }

    private factor(): number {
        const c = this.peek();
        if (c === '+') {
            this.pos++;
            return this.factor();
        }
        if (c === '-') {
            this.pos++;
            return -this.factor();
        }
        if (c === '(') {
            this.pos++;
            const value = this.expression();
            if (this.peek() !== ')') {
                throw new Error('Missing closing parenthesis');
            }
            this.pos++;
            return value;
        }
        return this.number();
    }

    private number(): number {
        this.skipSpaces();
        const match = /^(\d+\.?\d*|\.\d+)/.exec(this.text.slice(this.pos));
        if (!match) {
            throw new Error('Number expected');
        }
        this.pos += match[0].length;
        return Number(match[0]);
    }
}

/**
 * Evaluate what was typed in a numeric field.
 *
 * @param input    the typed text
 * @param current  the field's current value, used when the text starts with
 *                 "*" or "/"
 * @returns the resulting number, or null if the text is not a valid
 *          expression or does not give a finite number (e.g. division by 0)
 */
export const evaluateNumericInput = (
    input: unknown,
    current: unknown = 0,
): number | null => {
    if (typeof input === 'number') {
        return Number.isFinite(input) ? input : null;
    }
    if (typeof input !== 'string') {
        return null;
    }

    let text = input.trim().replace(/,/g, '.').replace(/\s+/g, ' ');
    if (text === '') {
        return null;
    }

    if (text[0] === '*' || text[0] === '/') {
        const base = Number(current);
        if (!Number.isFinite(base)) {
            return null;
        }
        // Parenthesised so a negative current value keeps its sign
        text = `(${base})${text}`;
    }

    try {
        const value = new Parser(text).parse();
        if (!Number.isFinite(value)) {
            return null;
        }
        // Avoid float noise such as 0.1+0.2 = 0.30000000000000004
        const rounded = Number(value.toFixed(6));
        return Object.is(rounded, -0) ? 0 : rounded;
    } catch (e) {
        return null;
    }
};
