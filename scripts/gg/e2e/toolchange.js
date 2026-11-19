// GGSender e2e: the tool sensor reference and the resume tool choices, in the
// built app against fake-fluidnc.js (see GGSENDER.md, "End-to-end run of the
// built app"). Fixed Tool Sensor strategy.
//
// The owner's case: a job with tool changes runs, is stopped in its first
// operation (broken bit), a bit of another length is fitted and Z zero is set
// again "from the pendant" (the fake's second port: nothing passes through
// gSender), then Resume From with choice 3, then the program's next tool
// change. Checks, from the fake board's own state: the hand-set Z zero is
// still the Z zero after the resume and after the next tool.
//
// usage: node toolchange.js <out dir> <file.nc>
//   FIRST_TOOL = "Prompt for first tool" (default) | "Always probe length only" | "Always run full wizard"
//   CHOICE = 3 (default) | 1   (1: resume keeping the tool, no Z zero by hand:
//            the next M6 must ask for the new tool, never "first tool")
//   NOREF = 1   as after a lost connection: gSender connects, the file is loaded and
//            the job is resumed with no job run before, so there is no reference.
//            Choice 1 with its default second answer: the tool is measured as the
//            reference first (0.7.3). NOREF=skip: "Do not measure".
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');

const SP = process.argv[2];
const FILE = process.argv[3];
const FIRST_TOOL = process.env.FIRST_TOOL || 'Prompt for first tool';
const NOREF = process.env.NOREF || '';
const CHOICE = NOREF ? 1 : Number(process.env.CHOICE || 3);
const PENDANT_PORT = Number(process.env.PENDANT_PORT || 2324);
fs.mkdirSync(SP, { recursive: true });

const pendant = (cmd) =>
    new Promise((resolve, reject) => {
        const sock = net.connect(PENDANT_PORT, '127.0.0.1', () => sock.write(cmd + '\n'));
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
            sock.end();
            resolve(JSON.parse(d));
        });
        sock.on('error', reject);
    });

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const near = (a, b) => Math.abs(a - b) < 0.002;

(async () => {
    const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    const shot = (name) => p.screenshot({ path: `${SP}/${name}.png` });
    const text = (id) => p.locator(`[data-testid=${id}]`).first().textContent({ timeout: 5000 }).catch(() => null);
    const attr = (id, a) => p.locator(`[data-testid=${id}]`).first().getAttribute(a, { timeout: 5000 }).catch(() => null);
    const chipState = async () => {
        for (const s of ['valid', 'stale', 'none']) {
            if (await p.locator(`[data-testid=gg-loaded-tool] [data-testid=gg-reference-icon-${s}]`).count()) return s;
        }
        return null;
    };
    const waitChip = async (want, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if ((await chipState()) === want) return true;
            await p.waitForTimeout(100);
        }
        return false;
    };
    /** Press Run on the step whose action has this label, once the machine is Idle. */
    const run = async (label) => {
        await p.locator('code', { hasText: new RegExp(`^${label}$`) }).first().waitFor({ state: 'visible', timeout: 30000 });
        const btn = p.locator('[data-testid=wizard-run]').first();
        await btn.waitFor({ state: 'visible', timeout: 30000 });
        await p.waitForFunction(() => !document.querySelector('[data-testid=wizard-run]')?.disabled, null, { timeout: 30000 });
        await p.waitForTimeout(900);
        await btn.click();
    };
    const waitWizard = async () => {
        await p.locator('[data-testid=gg-toolchange-reason]').first().waitFor({ state: 'visible', timeout: 60000 });
        await p.waitForTimeout(600);
    };
    const waitWizardGone = async () => {
        await p.locator('[data-testid=gg-toolchange-reason]').first().waitFor({ state: 'detached', timeout: 60000 });
    };

    await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2000);
    await p.evaluate((firstTool) => {
        const raw = JSON.parse(localStorage.getItem('sienci') || '{}');
        raw.state = raw.state || {};
        const st = raw.state;
        st.widgets = st.widgets || {};
        st.widgets.connection = { ...(st.widgets.connection || {}), ip: [127, 0, 0, 1], ethernetPort: 2323 };
        st.workspace = st.workspace || {};
        st.workspace.toolChangeOption = 'Fixed Tool Sensor';
        st.workspace.toolChange = { ...(st.workspace.toolChange || {}), firstToolBehaviour: firstTool, moveToManualPosition: false, skipDialog: false };
        st.workspace.toolChangePosition = { x: -10, y: -10, z: -20 };
        st.workspace.gg = { ...(st.workspace.gg || {}), preflightOnLoad: 'Never', loadedTool: { tool: '1', since: Date.now() }, lastStop: null };
        localStorage.setItem('sienci', JSON.stringify(raw));
    }, FIRST_TOOL);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'Skip', 'Got it', 'No thanks', 'Not now', 'Later', 'Decline']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }

    // the owner zeroes Z on the part with T1 in the spindle, before connecting
    await pendant('tool 30');
    await pendant('zero');

    check('not connected: the chip shows the tool only', (await chipState()) === null);
    await p.getByText('Connect to CNC', { exact: false }).first().click();
    await p.waitForTimeout(800);
    await p.getByText('Ethernet (port 2323)').first().click();
    await p.waitForTimeout(4000);
    check('connected: no reference yet (pictogram "none")', await waitChip('none'));
    await shot('tc-01-connected');

    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(6000);
    let firstPlane;
    if (NOREF) {
        firstPlane = (await pendant('state')).zeroPlane;
    } else {
    await p.locator('button', { hasText: /^Start$/ }).first().click();

    // ---- first M6 of a job from the top: upstream's First tool setting
    if (FIRST_TOOL === 'Prompt for first tool') {
        const only = p.getByRole('button', { name: 'Only Probe Tool Length' });
        await only.waitFor({ state: 'visible', timeout: 30000 });
        await shot('tc-02-first-tool-prompt');
        await only.click();
    }
    await waitWizard();
    await shot('tc-03-first-tool-wizard');
    const firstVariant = await attr('gg-toolchange-reason', 'data-variant');
    check('first tool of the job: upstream\'s setting decides the wizard', firstVariant === (FIRST_TOOL === 'Always run full wizard' ? 'full' : 'reference'), firstVariant);
    console.log('first tool banner:', await text('gg-toolchange-reason-headline'), '|', await text('gg-toolchange-reason-why'));
    if (firstVariant === 'full') {
        await run('Probe Initial Tool');
        await run('Probe Changed Tool'); // the same tool here
        await run('Resume Cutting');
    } else {
        await run('Probe Tool Length'); // the tool in the spindle as the reference
        await run('Resume');
    }
    await waitWizardGone();
    check('after the first probe: reference valid (pictogram)', await waitChip('valid', 8000));
    const afterFirst = await pendant('state');
    firstPlane = afterFirst.zeroPlane;
    console.log('after first tool:', JSON.stringify(afterFirst));

    // ---- the job runs, then stops in its first operation
    await p.waitForTimeout(Number(process.env.RUN_MS || 2500));
    await shot('tc-04-running');
    await p.locator('button', { hasText: /^Stop$/ }).first().click();
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'OK', 'Ok']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    check('stopped: the reference is still valid', (await chipState()) === 'valid');
    }

    let handPlane = firstPlane;
    if (CHOICE === 3) {
        // ---- broken bit: another bit, Z zero by hand from the pendant, 0.12 mm higher
        await pendant('tool 36.4');
        const hand = await pendant('zero 0.12');
        handPlane = hand.zeroPlane;
        console.log('after the pendant zero:', JSON.stringify(hand));
        // FluidNC shows a new offset at its next report with a WCO: up to 2.5 s when idle, 7.5 s after a move
        check('Z zero from the pendant: the chip turns to "not correct" within 8 s', await waitChip('stale', 8500));
        await p.locator('[data-testid=gg-loaded-tool]').click();
        await p.waitForTimeout(400);
        await shot('tc-05-chip-stale');
        console.log('chip panel:', await text('gg-reference-panel'));
        await p.keyboard.press('Escape');
        await p.mouse.click(800, 600);
    }

    // ---- Resume From
    await p.locator('[data-testid=gg-resume-button]').click();
    await p.waitForTimeout(1500);
    console.log('resume reference block:', await text('gg-resume-reference'));
    if (NOREF) {
        // no job was stopped: start in the first operation, a few moves in
        await p.locator('[data-testid=gg-resume-query]').fill(process.env.NOREF_LINE || 'N100');
        await p.waitForTimeout(600);
        check('no reference, same tool: choice 1 is selected', await p.locator('[data-testid=gg-resume-tool-keep]').isChecked());
        check('no reference: choice 1 asks, and "Measure first" is selected', await p.locator('[data-testid=gg-resume-same-tool-measure]').isChecked());
        console.log('choice 1 box:', await text('gg-resume-same-tool'));
        if (NOREF === 'skip') {
            await p.locator('[data-testid=gg-resume-same-tool-skip]').click();
        }
        const pre = (await text('gg-resume-preamble')) || '';
        check(NOREF === 'skip' ? '"Do not measure": no tool change line is sent' : '"Measure first": the tool change line is sent', /M6/.test(pre) === (NOREF !== 'skip'));
    } else if (CHOICE === 3) {
        check('resume dialog: choice 3 is selected by default after a Z zero by hand', await p.locator('[data-testid=gg-resume-tool-reference]').isChecked());
    } else {
        check('resume dialog: choice 1 is selected by default (same tool, reference valid)', await p.locator('[data-testid=gg-resume-tool-keep]').isChecked());
    }
    await p.locator('[data-testid=gg-resume-dialog]').evaluate((el) => el.scrollTo(0, 250));
    await shot('tc-06-resume-dialog');
    console.log('preamble', JSON.stringify(await text('gg-resume-preamble')));
    const g10Before = fs.readFileSync(process.env.FAKE_LOG || '/tmp/fake.log', 'utf8').split('\n').filter((l) => /"ev":"wco"/.test(l) && /G10/.test(l)).length;
    await p.locator('[data-testid=gg-resume-start]').click();

    if (NOREF && NOREF !== 'skip') {
        await waitWizard();
        await shot('tc-07-resume-wizard');
        const v = await attr('gg-toolchange-reason', 'data-variant');
        check('choice 1, measure first: the wizard only measures the tool as the reference', v === 'reference', v);
        const why = await text('gg-toolchange-reason-why');
        console.log('choice 1 banner:', await text('gg-toolchange-reason-headline'), '|', why, '|', await text('gg-toolchange-zero'));
        check('the window does not say that Z zero was set by hand', /same tool is in the spindle/.test(why || '') && !/You set Z zero/.test(why || ''));
        check('no "Install New Tool" in that wizard', (await p.getByText('Install New Tool').count()) === 0);
        await run('Probe Tool Length');
        await run('Resume');
        await waitWizardGone();
        const st = await pendant('state');
        console.log('after the measurement:', JSON.stringify(st));
        check('measured as the reference: Z zero is unchanged', near(st.zeroPlane, handPlane), `${st.zeroPlane} vs ${handPlane}`);
        check('there is a reference now', await waitChip('valid', 8000));
    }
    if (NOREF === 'skip') {
        // ---- the program's next tool change, with no reference: the tool in the spindle first
        await waitWizard();
        await shot('tc-08-next-tool-wizard');
        const v = await attr('gg-toolchange-reason', 'data-variant');
        check('"Do not measure": the next M6 measures the tool in the spindle first, then asks for the new tool', v === 'full', v);
        console.log('next tool banner:', await text('gg-toolchange-reason-headline'), '|', await text('gg-toolchange-reason-why'));
        check('no first-tool prompt', (await p.getByRole('button', { name: 'Only Probe Tool Length' }).count()) === 0);
        await run('Probe Initial Tool');
        // the owner changes the tool only after the tool in the spindle was measured
        check('the tool in the spindle was measured as the reference', await waitChip('valid', 20000));
        await pendant('tool 22');
        await run('Probe Changed Tool');
        await run('Resume Cutting');
        await waitWizardGone();
        const end = await pendant('state');
        console.log('after T2:', JSON.stringify(end));
        check('after the next tool: Z zero is unchanged', near(end.zeroPlane, handPlane), `${end.zeroPlane} vs ${handPlane}`);
        check('chip: reference valid', await waitChip('valid', 8000));
        await p.locator('button', { hasText: /^Stop$/ }).first().click();
        await p.waitForTimeout(1500);
        check('no page errors', errors.length === 0);
        const failedSkip = results.filter((r) => !r.ok).length;
        console.log(`${results.length - failedSkip}/${results.length} checks passed`);
        await b.close();
        process.exit(failedSkip ? 1 : 0);
    }

    if (CHOICE === 3 && !NOREF) {
        await waitWizard();
        await shot('tc-07-resume-wizard');
        const v = await attr('gg-toolchange-reason', 'data-variant');
        check('resume choice 3: the wizard only measures the tool as the new reference', v === 'reference', v);
        console.log('choice 3 banner:', await text('gg-toolchange-reason-headline'), '|', await text('gg-toolchange-reason-why'), '|', await text('gg-toolchange-zero'));
        check('no "Install New Tool" in that wizard', (await p.getByText('Install New Tool').count()) === 0);
        await run('Probe Tool Length');
        await run('Resume');
        await waitWizardGone();
        const st = await pendant('state');
        console.log('after choice 3:', JSON.stringify(st));
        check('choice 3: the hand-set Z zero is unchanged', near(st.zeroPlane, handPlane), `${st.zeroPlane} vs ${handPlane}`);
        check('choice 3: reference valid again', await waitChip('valid', 8000));
    }

    // ---- the program's next tool change (T2)
    await waitWizard();
    await shot('tc-08-next-tool-wizard');
    // the Run button is in view, below the banner and the tool card
    const inView = await p.evaluate(() => {
        const btn = document.querySelector('[data-testid=wizard-run]');
        let box = btn && btn.parentElement;
        while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement;
        if (!btn || !box) return null;
        return btn.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom + 1;
    });
    check('next M6: the Run button is in view without scrolling', inView === true, String(inView));
    const v2 = await attr('gg-toolchange-reason', 'data-variant');
    check('next M6 of the resumed job: the new tool is measured against the reference (never "first tool")', v2 === 'measure', v2);
    check('next M6: "Install New Tool" is shown', (await p.getByText('Install New Tool').count()) > 0);
    check('next M6: no first-tool prompt', (await p.getByRole('button', { name: 'Only Probe Tool Length' }).count()) === 0);
    console.log('next tool banner:', await text('gg-toolchange-reason-headline'), '|', await text('gg-toolchange-reason-why'), '|', await text('gg-toolchange-zero'));

    // Z zero set from the pendant with the window open: the window decides again by itself
    const open = await pendant('state');
    await pendant(`wco ${open.wcoZ + 2}`);
    const turned = await p
        .waitForFunction(() => document.querySelector('[data-testid=gg-toolchange-reason]')?.getAttribute('data-variant') === 'full', null, { timeout: 8500 })
        .then(() => true, () => false);
    check('pendant zero with the window open: it switches to "the tool in the spindle first" within 8 s', turned);
    await shot('tc-08b-window-follows');
    console.log('window after the pendant zero:', await text('gg-toolchange-reason-headline'), '|', await text('gg-toolchange-reason-why'));
    await pendant(`wco ${open.wcoZ}`);
    const back = await p
        .waitForFunction(() => document.querySelector('[data-testid=gg-toolchange-reason]')?.getAttribute('data-variant') === 'measure', null, { timeout: 8500 })
        .then(() => true, () => false);
    check('offset put back: the window is back to "against the reference"', back);

    // the overrule and the way back, before anything has run
    const over = p.locator('[data-testid=gg-toolchange-overrule]');
    check('overrule offered: "Measure the tool in the spindle first"', ((await over.textContent().catch(() => '')) || '').includes('Measure the tool in the spindle first'));
    await over.click();
    await p.waitForTimeout(600);
    await shot('tc-09-overruled');
    check('overruled: the wizard now starts with the tool in the spindle', (await attr('gg-toolchange-reason', 'data-variant')) === 'full');
    await p.locator('[data-testid=gg-toolchange-overrule]').click();
    await p.waitForTimeout(600);
    check('and back to the default', (await attr('gg-toolchange-reason', 'data-variant')) === 'measure');

    await pendant('tool 22'); // the owner fits T2, a shorter tool
    await run('Probe Changed Tool');
    await run('Resume Cutting');
    await waitWizardGone();
    const end = await pendant('state');
    console.log('after T2:', JSON.stringify(end));
    check('after the next tool: Z zero is still the one set by hand', near(end.zeroPlane, handPlane), `${end.zeroPlane} vs ${handPlane}`);
    const g10After = fs.readFileSync(process.env.FAKE_LOG || '/tmp/fake.log', 'utf8').split('\n').filter((l) => /"ev":"wco"/.test(l) && /G10/.test(l)).length;
    check('exactly one G10 after the resume (for T2)', g10After - g10Before === 1, `${g10After - g10Before}`);
    check('chip: reference valid', await waitChip('valid', 8000));
    // the controller shows the new offset up to 7.5 s after the wizard's G10,
    // when the job runs again: it must not be taken for a change by the program
    await p.waitForTimeout(9000);
    check('9 s after the tool change, the job running: the reference is still correct', (await chipState()) === 'valid');
    await p.locator('[data-testid=gg-loaded-tool]').click();
    await p.waitForTimeout(400);
    await shot('tc-10-chip-history');
    const panel = (await text('gg-reference-panel')) || '';
    console.log('chip panel:', panel);
    check('the history has the measurement of T2, and no change by the program', /T2 measured against the reference/.test(panel) && !/The program changed/.test(panel));
    await p.mouse.click(800, 600);

    // the job can have ended by now (the 9 s above)
    await p.locator('button', { hasText: /^Stop$/ }).first().click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(1500);
    if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5).join('\n'));
    check('no page errors', errors.length === 0);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed}/${results.length} checks passed`);
    await b.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('E2E ERROR', e);
    process.exit(2);
});
