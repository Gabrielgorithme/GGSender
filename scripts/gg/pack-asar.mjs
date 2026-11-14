#!/usr/bin/env node
/*
 * GGSender: make an app.asar for an installed gSender by taking the official
 * app.asar of the same version and swapping in the files built from this
 * repository (scripts/gg/build.sh).
 *
 * Everything that is not rebuilt -- node_modules, translations, the native
 * serial-port libraries that live next to the archive -- is copied through
 * byte for byte, so the result drops into the official install.
 *
 *   node scripts/gg/pack-asar.mjs --stock <official app.asar> \
 *        [--dist dist/gsender] --out <new app.asar>
 *
 * No dependencies. The asar format is: two small length-prefixed blocks
 * holding a JSON index (file name -> size, offset, integrity hash), then the
 * file contents back to back.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
        if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
        return acc;
    }, []),
);
const stockPath = args.stock;
const distPath = args.dist || 'dist/gsender';
const outPath = args.out;
if (!stockPath || !outPath) {
    console.error('usage: pack-asar.mjs --stock <app.asar> [--dist dist/gsender] --out <app.asar>');
    process.exit(2);
}

// Paths (inside the archive) that are replaced by the build output.
// Directories are replaced as a whole: stale files from the official build
// (for example the previous index-XXXX.js) must not survive.
const REPLACED_FILES = ['main.js', 'preload.js', 'server-cli.js', 'server/index.js'];
const REPLACED_DIRS = ['app'];

const BLOCK_SIZE = 4 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const integrityOf = (buf) => {
    const blocks = [];
    for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
        blocks.push(sha256(buf.subarray(i, i + BLOCK_SIZE)));
    }
    if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
    return { algorithm: 'SHA256', hash: sha256(buf), blockSize: BLOCK_SIZE, blocks };
};

// ---- read the official archive ---------------------------------------------
const fd = fs.openSync(stockPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const index = JSON.parse(jsonBuf.toString('utf8'));
const stockDataStart = 8 + headerSize;

// ---- helpers on the index tree ---------------------------------------------
const getNode = (parts, create = false) => {
    let node = index;
    for (const part of parts) {
        if (!node.files) {
            if (!create) return null;
            node.files = {};
        }
        if (!node.files[part]) {
            if (!create) return null;
            node.files[part] = { files: {} };
        }
        node = node.files[part];
    }
    return node;
};

const newContent = new Map(); // entry object -> Buffer

const setFile = (archivePath, buf, executable = false) => {
    const parts = archivePath.split('/');
    const name = parts.pop();
    const dir = getNode(parts, true);
    const entry = { size: buf.length, offset: '0', integrity: integrityOf(buf) };
    if (executable) entry.executable = true;
    dir.files[name] = entry;
    newContent.set(entry, buf);
};

const addDir = (diskDir, archiveDir) => {
    for (const item of fs.readdirSync(diskDir, { withFileTypes: true })) {
        const disk = path.join(diskDir, item.name);
        const inArchive = `${archiveDir}/${item.name}`;
        if (item.isDirectory()) {
            getNode(inArchive.split('/'), true);
            addDir(disk, inArchive);
        } else if (item.isFile()) {
            setFile(inArchive, fs.readFileSync(disk));
        }
    }
};

// ---- swap in the build output -----------------------------------------------
for (const file of REPLACED_FILES) {
    const disk = path.join(distPath, file);
    if (!fs.existsSync(disk)) {
        console.error(`missing build output: ${disk} (run scripts/gg/build.sh first)`);
        process.exit(1);
    }
    if (!getNode(file.split('/'))) {
        console.error(`official archive has no ${file}; is this a gSender app.asar?`);
        process.exit(1);
    }
    setFile(file, fs.readFileSync(disk));
}
for (const dir of REPLACED_DIRS) {
    const disk = path.join(distPath, dir);
    if (!fs.existsSync(path.join(disk, 'index.html'))) {
        console.error(`missing build output: ${disk}/index.html (run scripts/gg/build.sh first)`);
        process.exit(1);
    }
    const parts = dir.split('/');
    const name = parts.pop();
    const parent = getNode(parts);
    if (!parent?.files?.[name]) {
        console.error(`official archive has no ${dir}/ directory`);
        process.exit(1);
    }
    parent.files[name] = { files: {} };
    addDir(disk, dir);
}

// ---- lay out the new archive -------------------------------------------------
// Walk in index order, give every packed file its new offset.
const packed = [];
const walk = (node) => {
    for (const child of Object.values(node.files || {})) {
        if (child.files) {
            walk(child);
        } else if (!child.unpacked && !child.link) {
            packed.push(child);
        }
    }
};
walk(index);

let offset = 0;
const sources = packed.map((entry) => {
    const stockOffset = Number(entry.offset);
    const isNew = newContent.has(entry);
    entry.offset = String(offset);
    offset += entry.size;
    return { entry, isNew, stockOffset };
});

const newJson = Buffer.from(JSON.stringify(index), 'utf8');
const padding = (4 - (newJson.length % 4)) % 4;
const pickledString = 4 + newJson.length + padding; // length field + text + padding
const headerPickle = 4 + pickledString; // payload-size field + payload
const out = fs.openSync(outPath, 'w');
const prefix = Buffer.alloc(16);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(headerPickle, 4);
prefix.writeUInt32LE(pickledString, 8);
prefix.writeUInt32LE(newJson.length, 12);
fs.writeSync(out, prefix);
fs.writeSync(out, newJson);
if (padding) fs.writeSync(out, Buffer.alloc(padding));

for (const { entry, isNew, stockOffset } of sources) {
    if (entry.size === 0) continue;
    if (isNew) {
        fs.writeSync(out, newContent.get(entry));
    } else {
        const buf = Buffer.alloc(entry.size);
        fs.readSync(fd, buf, 0, entry.size, stockDataStart + stockOffset);
        fs.writeSync(out, buf);
    }
}
fs.closeSync(out);
fs.closeSync(fd);

const replaced = [...newContent.keys()].length;
console.log(`wrote ${outPath}`);
console.log(`  files in archive: ${packed.length}, replaced or added: ${replaced}`);
console.log(`  size: ${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB`);
console.log(`  header sha256: ${sha256(newJson)}`);
