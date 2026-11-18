// GGSender e2e: drive the built app against fake-fluidnc.js (see GGSENDER.md,
// "End-to-end run of the built app").
// Connect over Ethernet, load a Fusion file, run, stop mid-way, Resume From.
// usage: node resume.js <out dir> <file.nc>   (RUN_MS, RESUME_MS: timings)
const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.argv[2];
const FILE = process.argv[3];
const step = process.argv[4] || 'all';
fs.mkdirSync(SP, { recursive: true });
(async () => {
    const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    const logs = [];
    p.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
    await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2000);
    // settings: ethernet to the fake board, Ignore strategy (no wizard), no pre-flight popup
    await p.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('sienci') || '{}');
        raw.state = raw.state || {};
        const st = raw.state;
        st.widgets = st.widgets || {};
        st.widgets.connection = { ...(st.widgets.connection || {}), ip: [127, 0, 0, 1], ethernetPort: 2323 };
        st.workspace = st.workspace || {};
        st.workspace.toolChangeOption = 'Ignore';
        st.workspace.gg = { ...(st.workspace.gg || {}), preflightOnLoad: 'Never', loadedTool: { tool: '45', since: 1 } };
        localStorage.setItem('sienci', JSON.stringify(raw));
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'Skip', 'Got it', 'No thanks', 'Not now', 'Later', 'Decline']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    await p.screenshot({ path: SP + '/r-0.png' });
    if (step === 'look') { await b.close(); return; }
    // connect
    await p.getByText('Connect to CNC', { exact: false }).first().click();
    await p.waitForTimeout(800);
    await p.screenshot({ path: SP + '/r-1.png' });
    await p.getByText('Ethernet (port 2323)').first().click();
    await p.waitForTimeout(4000);
    await p.screenshot({ path: SP + '/r-2.png' });
    // load the file
    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(6000);
    await p.screenshot({ path: SP + '/r-3.png' });
    console.log('resume button', await p.locator('[data-testid=gg-resume-button]').count());
    // run, then stop mid-way
    const start = p.locator('button', { hasText: /^Start$/ }).first();
    console.log('start buttons', await start.count());
    await start.click();
    await p.waitForTimeout(Number(process.env.RUN_MS || 2500));
    await p.screenshot({ path: SP + '/r-4.png' });
    await p.locator('button', { hasText: /^Stop$/ }).first().click();
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'OK', 'Ok']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    await p.screenshot({ path: SP + '/r-5.png' });
    console.log('lastStop', await p.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('sienci')).state.workspace.gg.lastStop)));
    // resume
    await p.locator('[data-testid=gg-resume-button]').click();
    await p.waitForTimeout(1500);
    await p.screenshot({ path: SP + '/r-6.png' });
    const pre = await p.locator('[data-testid=gg-resume-preamble]').textContent().catch(() => null);
    console.log('query', await p.locator('[data-testid=gg-resume-query]').inputValue());
    console.log('preamble', JSON.stringify(pre));
    console.log('reference', await p.locator('[data-testid=gg-resume-reference]').textContent().catch(() => '-'));
    fs.writeFileSync(SP + '/r-mark', String(Date.now()));
    await p.locator('[data-testid=gg-resume-start]').click();
    await p.waitForTimeout(Number(process.env.RESUME_MS || 6000));
    await p.screenshot({ path: SP + '/r-7.png' });
    console.log(logs.slice(0, 10).join('\n'));
    await b.close();
})();
