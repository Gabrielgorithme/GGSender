// GGSender: which line a reply answers (lib/gg/writtenLines.js)
import { SOURCE_FEEDER, SOURCE_JOB, SOURCE_OTHER, WrittenLines } from '../writtenLines';

describe('GGSender: the record of written lines', () => {
    it('each reply answers the oldest line written, with where it came from', () => {
        const w = new WrittenLines();
        w.mark(SOURCE_JOB, { seq: 10 });
        w.onWrite('N20 G1 X1 \n');
        w.onWrite('$G\n'); // gSender's own query, no mark
        w.mark(SOURCE_FEEDER);
        w.onWrite('G4 P0.5\n');
        expect(w.onReply()).toEqual({ source: SOURCE_JOB, seq: 10, text: 'N20 G1 X1' });
        expect(w.onReply()).toEqual({ source: SOURCE_OTHER, text: '$G' });
        expect(w.onReply()).toEqual({ source: SOURCE_FEEDER, text: 'G4 P0.5' });
    });

    it('a mark is for the next write only', () => {
        const w = new WrittenLines();
        w.mark(SOURCE_JOB, { seq: 1 });
        w.onWrite('G0 X0\n');
        w.onWrite('G0 X1\n');
        expect(w.onReply().source).toBe(SOURCE_JOB);
        expect(w.onReply().source).toBe(SOURCE_OTHER);
    });

    it('realtime bytes have no reply and take no mark from a line', () => {
        const w = new WrittenLines();
        ['?', '!', '~', '\x90', '\x9e'].forEach((b) => w.onWrite(b));
        expect(w.queue).toEqual([]);
        w.mark(SOURCE_FEEDER);
        w.onWrite('G4 P0.5\n');
        w.onWrite('?');
        expect(w.onReply()).toEqual({ source: SOURCE_FEEDER, text: 'G4 P0.5' });
    });

    it('several lines in one write are several lines; a line with only a comment still gets a reply', () => {
        const w = new WrittenLines();
        w.mark(SOURCE_FEEDER);
        w.onWrite('G91\n(Restart Spindle)\nG90\n');
        expect(w.queue.map((l) => l.text)).toEqual(['G91', '(Restart Spindle)', 'G90']);
        expect(w.queue.every((l) => l.source === SOURCE_FEEDER)).toBe(true);
    });

    it('a soft reset throws away what waits; so does a restart of the controller', () => {
        const w = new WrittenLines();
        w.onWrite('G1 X1\n');
        w.onWrite('\x18');
        expect(w.onReply()).toBeNull();
        w.onWrite('G1 X2\n');
        w.reset();
        expect(w.onReply()).toBeNull();
    });

    it('a reply when nothing waits is counted, and breaks nothing', () => {
        const w = new WrittenLines();
        expect(w.onReply()).toBeNull();
        expect(w.unmatched).toBe(1);
        w.onWrite('G1 X1\n');
        expect(w.onReply().text).toBe('G1 X1');
    });
});
