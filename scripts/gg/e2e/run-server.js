// GGSender e2e: run the built server (dist/gsender) without Electron.
// usage: node scripts/gg/e2e/run-server.js <home dir> [port]
const Module = require('module');
const path = require('path');
const fs = require('fs');
const home = path.resolve(process.argv[2] || '/tmp/gg-e2e-home');
const port = process.argv[3] || '8765';
fs.mkdirSync(home, { recursive: true });
const orig = Module._load;
const stub = {
    app: { getPath: () => home, getVersion: () => '1.6.4', isPackaged: false, on() {}, getName: () => 'gSender' },
    ipcMain: { on() {}, handle() {} },
};
Module._load = function load(req, ...rest) {
    if (req === 'electron') return stub;
    return orig.call(this, req, ...rest);
};
process.argv = ['node', 'gsender', '-p', port, '-H', '127.0.0.1', '-c', path.join(home, '.cncrc')];
require(path.resolve(__dirname, '../../../dist/gsender/server-cli.js'))()
    .then(() => console.log(`server up on ${port}`))
    .catch((e) => {
        console.error('ERR', e);
        process.exit(1);
    });
