// GGSender: where the server resets the overrides, from the program's operations
import fs from 'fs';
import path from 'path';
import { analyzeJob } from '../jobOperations';
import { operationBoundaries } from '../opBoundaries';

const read = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('GGSender: operation boundaries sent to the server', () => {
    it('one per operation after the first, at its first move, with the sender index and text', () => {
        const content = read('fusion-job-trimmed.nc');
        const info = analyzeJob(content);
        const payload = operationBoundaries({ info, fileName: 'job.nc' });
        expect(payload.name).toBe('job.nc');
        // the sender's numbering: non-blank lines
        const senderLines = content.split('\n').filter((l) => l.trim().length > 0);
        expect(payload.total).toBe(senderLines.length);
        expect(payload.boundaries).toHaveLength(info.operations.length - 1);
        payload.boundaries.forEach((b) => {
            expect(senderLines[b.seq].trim()).toBe(b.text);
            expect(b.text).toMatch(/^N\d+ G0 X/); // Fusion starts each operation with a rapid
        });
        const flat = payload.boundaries.find((b) => b.name === 'Flat1');
        expect(flat?.text).toBe('N76941 G0 X43.057 Y17.572');
        expect(payload.boundaries.map((b) => b.name)).not.toContain(info.operations[0].name);
    });

    it('nothing loaded: an empty list', () => {
        expect(operationBoundaries(null)).toEqual({ name: '', total: null, boundaries: [] });
    });
});
