// GGSender e2e: a jog from the pendant at a tool change, in the built app
// against fake-fluidnc.js (see GGSENDER.md, "End-to-end run of the built app").
//
// The owner's case of 22 Nov: the program stops the spindle and asks for a
// tool change. FluidNC shows Idle while it waits for the spindle; the owner
// jogs from the pendant; FluidNC runs the jog when the wait ends and refuses
// the lines that waited (the program's "G28 G91 Z0" and "G90", and the tool
// change's first line). Before 0.7.5: an error for each line and a dead tool
// change window; the job had to be stopped.
//
// Start the fake with SPINDOWN_MS=5000.
// usage: node jog.js <out dir> <file.nc>      (FAKE_LOG, PENDANT_PORT)
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');

const SP = process.argv[2];
const FILE = process.argv[3];
const PENDANT_PORT = Number(process.env.PENDANT_PORT || 2324);
const FAKE_LOG = process.env.FAKE_LOG || '/tmp/fake.log';
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
// what the fake board logged, without gSender's own "$" queries
const fakeLog = () =>
    fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !(e.ev === 'line' && String(e.line).startsWith('$')));

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
        await p.waitForTimeout(300);
    };
    const waitWizardGone = () => p.locator('[data-testid=gg-toolchange-reason]').first().waitFor({ state: 'detached', timeout: 60000 });
    const ready = (want, ms) =>
        p
            .waitForFunction((w) => document.querySelector('[data-testid=gg-machine-ready]')?.getAttribute('data-ready') === w, want, { timeout: ms })
            .then(() => true, () => false);

    await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('sienci') || '{}');
        raw.state = raw.state || {};
        const st = raw.state;
        st.widgets = st.widgets || {};
        st.widgets.connection = { ...(st.widgets.connection || {}), ip: [127, 0, 0, 1], ethernetPort: 2323 };
        st.workspace = st.workspace || {};
        st.workspace.toolChangeOption = 'Fixed Tool Sensor';
        st.workspace.toolChange = { ...(st.workspace.toolChange || {}), firstToolBehaviour: 'Always probe length only', moveToManualPosition: false, skipDialog: false };
        st.workspace.toolChangePosition = { x: -10, y: -10, z: -20 };
        st.workspace.gg = { ...(st.workspace.gg || {}), preflightOnLoad: 'Never', loadedTool: { tool: '1', since: Date.now() }, lastStop: null };
        localStorage.setItem('sienci', JSON.stringify(raw));
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'Skip', 'Got it', 'No thanks', 'Not now', 'Later', 'Decline']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    await pendant('tool 30');
    await pendant('zero');
    await p.getByText('Connect to CNC', { exact: false }).first().click();
    await p.waitForTimeout(800);
    await p.getByText('Ethernet (port 2323)').first().click();
    await p.waitForTimeout(4000);
    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(6000);
    await p.locator('button', { hasText: /^Start$/ }).first().click();

    // ---- first tool: the reference
    await waitWizard();
    await run('Probe Tool Length');
    await run('Resume');
    await waitWizardGone();
    const plane = (await pendant('state')).zeroPlane;

    // ---- the first operation runs to its end; the program stops the spindle and asks for T2
    await waitWizard();
    check('the tool change window says WAIT while the spindle stops (the controller shows Idle)', (await attr('gg-machine-ready', 'data-ready')) === 'false', await text('gg-machine-ready'));
    await shot('jog-01-wait');

    // the owner jogs now, from the pendant
    await pendant('jog 1500');
    const notice = p.locator('[data-testid=gg-refused]');
    const shown = await notice.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
    check('the controller refused the lines that waited: gSender shows them, with no error window', shown);
    const refused = fakeLog().filter((e) => e.ev === 'refused').map((e) => e.line);
    console.log('refused by the controller:', JSON.stringify(refused));
    check('the refused lines are the program\'s retract and the first line of the tool change', refused.some((l) => /G28 G91 Z0/.test(l)) && refused.some((l) => /G90/.test(l)) && refused.some((l) => /G4 P0.5/.test(l)));
    const listed = (await text('gg-refused-lines')) || '';
    console.log('notice:', await text('gg-refused-title'), '|', JSON.stringify(listed), '|', await text('gg-refused-action'));
    check('the notice lists them in order', /G28 G91 Z0[\s\S]*G90[\s\S]*G4 P0\.5/.test(listed));
    check('no "Error 9" window', (await p.locator('[data-testid=gg-job-error]').count()) === 0 && (await p.getByText('the controller did not accept a line').count()) === 0);
    await shot('jog-02-refused');

    // nothing is sent by itself: the retract can move the machine
    const linesBefore = fakeLog().filter((e) => e.ev === 'line').length;
    await p.waitForTimeout(2500);
    check('nothing is sent again by itself', fakeLog().filter((e) => e.ev === 'line').length === linesBefore);
    await p.waitForFunction(() => !document.querySelector('[data-testid=gg-refused-send]')?.disabled, null, { timeout: 10000 }).catch(() => {});
    check('"Send again" can be pressed when the machine is idle', await p.locator('[data-testid=gg-refused-send]').isEnabled());

    // ---- Send again
    await p.locator('[data-testid=gg-refused-send]').click();
    const gone = await notice.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
    check('after "Send again" the notice goes away', gone);
    const after = fakeLog();
    const lastRefused = after.map((e) => e.ev).lastIndexOf('refused');
    const sentAgain = after.slice(lastRefused + 1).filter((e) => e.ev === 'line').map((e) => e.line);
    console.log('accepted after that:', JSON.stringify(sentAgain.slice(0, 6)));
    check('the controller got the same lines again, in order, before any other tool change line',
        /G28 G91 Z0/.test(sentAgain[0] || '') && /G90/.test(sentAgain[1] || '') && /G4 P0.5/.test(sentAgain.slice(2, 4).join(' ')));
    check('the window says that the machine is ready', await ready('true', 20000), await text('gg-machine-ready'));
    await shot('jog-03-ready');

    // ---- the tool change goes on as usual
    const variant = await attr('gg-toolchange-reason', 'data-variant');
    check('the tool change is the usual one: T2 against the reference', variant === 'measure', variant);
    await pendant('tool 22');
    await run('Probe Changed Tool');
    await run('Resume Cutting');
    await waitWizardGone();
    const end = await pendant('state');
    check('after the tool change Z zero is where it was', near(end.zeroPlane, plane), `${end.zeroPlane} vs ${plane}`);
    await p.waitForTimeout(3000);
    const running = (await p.locator('[data-testid=gg-refused]').count()) === 0 && (await p.locator('[data-testid=gg-job-error]').count()) === 0;
    check('the job runs on, with no notice and no error', running);

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
