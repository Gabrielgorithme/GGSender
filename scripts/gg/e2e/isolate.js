// GGSender e2e: one operation shown alone in the 3D view (see GGSENDER.md,
// "End-to-end run of the built app"). No board is needed: the file is only loaded.
// Loads a file with three operations in three places, clicks the operations in
// the list, and compares what the 3D view draws, pixel by pixel.
// usage: node isolate.js <out dir> [file.nc] [another file.nc]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const SP = process.argv[2];
const FILE = process.argv[3] || path.join(__dirname, 'three-operations.nc');
const OTHER = process.argv[4] || path.join(__dirname, 'xz-arc-without-g18.nc');
fs.mkdirSync(SP, { recursive: true });

let failed = 0;
const check = (ok, text) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
    if (!ok) failed++;
};

(async () => {
    const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('sienci') || '{}');
        raw.state = raw.state || {};
        const st = raw.state;
        st.workspace = st.workspace || {};
        st.workspace.gg = { ...(st.workspace.gg || {}), preflightOnLoad: 'Never' };
        localStorage.setItem('sienci', JSON.stringify(raw));
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'Skip', 'Got it', 'No thanks', 'Not now', 'Later', 'Decline']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(6000);

    const canvas = p.locator('canvas').first();
    const box = await canvas.boundingBox();
    // the operations list and the cards lie over the canvas: hide them for the pictures
    const shot = async (name) => {
        await p.addStyleTag({ content: '[data-testid=gg-ops-panel],[data-testid=gg-pick-card]{visibility:hidden !important}' }).then((h) => (shot.handle = h));
        await p.waitForTimeout(400);
        const file = `${SP}/${name}.png`;
        await canvas.screenshot({ path: file });
        await shot.handle.evaluate((el) => el.remove());
        return file;
    };
    // pixels that differ between two pictures: count, and the middle of them
    const diff = async (fileA, fileB) => {
        const [a, bb] = [fileA, fileB].map((f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
        return p.evaluate(async ([ua, ub]) => {
            const load = async (u) => {
                const img = new Image();
                img.src = u;
                await img.decode();
                const c = document.createElement('canvas');
                c.width = img.width;
                c.height = img.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, c.width, c.height);
            };
            const [A, B] = [await load(ua), await load(ub)];
            let count = 0;
            let minX = Infinity;
            let maxX = -Infinity;
            const points = [];
            for (let i = 0; i < A.data.length; i += 4) {
                const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
                if (d > 60) {
                    count++;
                    const x = (i / 4) % A.width;
                    const y = Math.floor(i / 4 / A.width);
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (points.length < 5000) points.push([x, y]);
                }
            }
            return { count, minX, maxX, width: A.width, points };
        }, [a, bb]);
    };
    const op = (name) => p.locator('[data-testid=gg-ops-list] button', { hasText: name }).first();
    const isolatedText = async () => {
        const el = p.locator('[data-testid=gg-ops-isolated]');
        return (await el.count()) ? (await el.textContent()).trim() : null;
    };

    check((await p.locator('[data-testid=gg-ops-panel]').count()) === 1, 'the operations list is shown');
    // a click in the 3D view changes the label of the camera button ("3D" to
    // "Free"): do one on an empty place first, so that all pictures have it
    await p.mouse.click(box.x + box.width - 60, box.y + box.height - 40);
    await p.waitForTimeout(400);
    const all = await shot('i-0-all');
    await p.screenshot({ path: `${SP}/i-0-all-window.png` });

    // ---- the middle operation alone
    await op('Diamond middle').click();
    await p.waitForTimeout(600);
    check(/shows only\s*Diamond middle/.test((await isolatedText()) || ''), `the list says what is shown: "${await isolatedText()}"`);
    const middle = await shot('i-1-middle');
    await p.screenshot({ path: `${SP}/i-1-middle-window.png` });
    const hiddenByMiddle = await diff(all, middle);
    check(hiddenByMiddle.count > 300, `the middle operation alone: ${hiddenByMiddle.count} pixels of toolpath are gone`);

    // ---- the left operation alone, then the right one
    await op('Square left').click();
    await p.waitForTimeout(600);
    const left = await shot('i-2-left');
    await op('Zigzag right').click();
    await p.waitForTimeout(600);
    check(/Zigzag right/.test((await isolatedText()) || ''), 'a click on another operation shows that one');
    const right = await shot('i-3-right');
    await p.screenshot({ path: `${SP}/i-3-right-window.png` });
    // what "left alone" draws and "right alone" does not, and the other way round
    const lr = await diff(left, right);
    check(lr.count > 300, `left alone and right alone are different pictures (${lr.count} pixels)`);

    // the three pictures show three different parts: what is in "all" and not in
    // "left alone" lies to the right of what is in "all" and not in "right alone"
    const notLeft = await diff(all, left); // middle + right are gone
    const notRight = await diff(all, right); // left + middle are gone
    check(notLeft.maxX > notRight.maxX && notLeft.minX > notRight.minX,
        `left alone hides the right side (x ${notLeft.minX}..${notLeft.maxX}), right alone hides the left side (x ${notRight.minX}..${notRight.maxX})`);

    // ---- a click on a hidden toolpath finds nothing; on the shown one it finds a line of that operation
    // a point of the left operation that "right alone" does not draw, away from the right side
    const hiddenPoint = notRight.points.filter(([x]) => x < notRight.minX + (notRight.maxX - notRight.minX) / 3)[0];
    await p.mouse.click(box.x + hiddenPoint[0], box.y + hiddenPoint[1]);
    await p.waitForTimeout(500);
    check((await p.locator('[data-testid=gg-pick-card]').count()) === 0, 'a click where a hidden operation runs selects nothing');
    // a point that only "right alone" draws (in "left alone" it is empty)
    const rightPoints = lr.points.filter(([x]) => x > lr.minX + ((lr.maxX - lr.minX) * 2) / 3);
    let picked = null;
    for (const [x, y] of rightPoints.filter((_, i) => i % 7 === 0).slice(0, 40)) {
        await p.mouse.click(box.x + x, box.y + y);
        await p.waitForTimeout(250);
        if (await p.locator('[data-testid=gg-pick-line]').count()) {
            picked = (await p.locator('[data-testid=gg-pick-line]').textContent()).trim();
            break;
        }
    }
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    const first = lines.findIndex((l) => l.includes('(Zigzag right)')) + 1;
    const pickedNumber = picked ? Number(picked.replace(/\D/g, '')) : null;
    check(pickedNumber !== null && pickedNumber >= first, `a click on the shown operation selects one of its lines: ${picked} (the operation starts at line ${first})`);
    check(/Zigzag right/.test((await isolatedText()) || ''), 'the operation stays alone after the selection');
    await p.screenshot({ path: `${SP}/i-4-picked-window.png` });

    // the steps stop at the first move of the operation
    for (let i = 0; i < 30; i++) {
        await p.locator('[data-testid=gg-pick-card] button[aria-label="Previous move"]').click();
    }
    await p.waitForTimeout(400);
    const firstMove = Number((await p.locator('[data-testid=gg-pick-line]').textContent()).replace(/\D/g, ''));
    check(firstMove >= first, `"Previous move" stops in the operation: line ${firstMove}`);
    await p.locator('[data-testid=gg-pick-card] button[aria-label="Close"]').click();
    await p.waitForTimeout(300);

    // ---- a second click on the operation shows everything again
    await op('Zigzag right').click();
    await p.waitForTimeout(600);
    check((await isolatedText()) === null, 'a second click on the operation: the note is gone');
    const again = await shot('i-5-all-again');
    const back = await diff(all, again);
    check(back.count < 20, `all toolpaths are drawn again as before (${back.count} pixels differ)`);

    // ---- "Show all"
    await op('Square left').click();
    await p.waitForTimeout(400);
    await p.locator('[data-testid=gg-ops-show-all]').click();
    await p.waitForTimeout(600);
    const again2 = await shot('i-6-show-all');
    check((await diff(all, again2)).count < 20 && (await isolatedText()) === null, '"Show all" draws all toolpaths again');

    // ---- with the list closed, the note stays
    await op('Diamond middle').click();
    await p.waitForTimeout(300);
    await p.locator('[data-testid=gg-ops-toggle]').click();
    await p.waitForTimeout(300);
    check(/Diamond middle/.test((await isolatedText()) || '') && (await p.locator('[data-testid=gg-ops-list]').count()) === 0,
        'the list closed: the note and "Show all" stay');
    await p.screenshot({ path: `${SP}/i-7-closed-window.png` });
    await p.locator('[data-testid=gg-ops-toggle]').click();

    // ---- another file ends it
    await p.locator('input[type=file]').first().setInputFiles(OTHER);
    await p.waitForTimeout(6000);
    check((await isolatedText()) === null, 'another file loaded: nothing is hidden');
    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(6000);
    check((await isolatedText()) === null, 'the first file loaded again: nothing is hidden');
    await p.mouse.click(box.x + box.width - 60, box.y + box.height - 40);
    await p.waitForTimeout(400);
    const reloaded = await shot('i-8-reloaded');
    check((await diff(all, reloaded)).count < 20, 'the first file loaded again: all toolpaths are drawn');

    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
    await b.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(2);
});
