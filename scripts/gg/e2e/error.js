// GGSender e2e: drive the built app against fake-fluidnc.js (see GGSENDER.md,
// "End-to-end run of the built app").
// A job with an XZ arc and no G18: the fake board answers error:33; the
// machine must be held and the notice shown.
// usage: node error.js <out dir> <file.nc>
const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.argv[2];
const FILE = process.argv[3];
fs.mkdirSync(SP, { recursive: true });
(async () => {
    const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('sienci') || '{}');
        const st = (raw.state = raw.state || {});
        st.widgets = st.widgets || {};
        st.widgets.connection = { ...(st.widgets.connection || {}), ip: [127, 0, 0, 1], ethernetPort: 2323 };
        st.workspace = st.workspace || {};
        st.workspace.toolChangeOption = 'Ignore';
        st.workspace.gg = { ...(st.workspace.gg || {}), preflightOnLoad: 'Never' };
        localStorage.setItem('sienci', JSON.stringify(raw));
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    for (const label of ['Close', 'Skip', 'Got it', 'No thanks', 'Not now', 'Later', 'Decline']) {
        const btn = p.getByRole('button', { name: label });
        if (await btn.count()) { try { await btn.first().click({ timeout: 1000 }); } catch {} }
    }
    await p.keyboard.press('Escape');
    await p.getByText('Connect to CNC', { exact: false }).first().click();
    await p.waitForTimeout(800);
    await p.getByText('Ethernet (port 2323)').first().click();
    await p.waitForTimeout(4000);
    await p.locator('input[type=file]').first().setInputFiles(FILE);
    await p.waitForTimeout(5000);
    await p.locator('button', { hasText: /^Start$/ }).first().click();
    await p.waitForTimeout(9000);
    await p.screenshot({ path: SP + '/err-1.png' });
    console.log('notice', await p.locator('[data-testid=gg-job-error]').textContent().catch(() => 'none'));
    await b.close();
})();
