# GGSender

A personal fork of [gSender](https://github.com/Sienci-Labs/gsender) (GPLv3) for a FluidNC machine
driven through gSender's Grbl controller with a fixed tool length sensor.

This file is the entry point for whoever edits this fork next, human or AI. It covers what was
changed and why, how to build and install, the traps, and what is still to do.

- Base: official gSender **v1.6.4** (tag `v1.6.4`).
- Fork build: **0.1.0**, set in `src/app/src/gg-build.json`.
- Branches: `gg/main` holds the current state of the fork. Work on a branch, open a pull request into `gg/main`.
- Not supported by Sienci Labs. Do not report problems with this build to them.

## Rules for editing

1. Mark every change to an upstream file with a comment starting `GGSender:`. `git grep -n "GGSender"` then lists every touch point.
2. Put new logic in new files under a `gg/` folder (`src/app/src/lib/gg/`, `src/server/lib/gg/`) and keep the edits to upstream files to a few lines that call it. This keeps moving to a newer gSender cheap.
3. Anything that generates or filters G-code gets a unit test. The machine cannot be tested from a development session, so the tests are the only check before the owner runs it.
4. A changed default must stay switchable. New behaviour gets a setting; the upstream behaviour stays reachable.
5. One change per commit, and one entry in the change log below.

## Build

Needs Node 18 or later, and `bun` (the repository's lock file is `bun.lock`).

```bash
bun install --ignore-scripts     # dependencies, without downloading Electron
scripts/gg/build.sh              # builds interface, server and main process into dist/gsender
node_modules/.bin/jest --config jest.config.js    # tests
```

`scripts/gg/build.sh` runs the same steps as the official `build-prod`, with source maps off.
Checked against the official release: built from the untouched `v1.6.4` tag, `main.js`,
`server/index.js` and `server-cli.js` come out byte-identical to the files inside the official
1.6.4 installer, and the interface has the same file layout.

## Package and install (Windows)

The installed program is the generic Electron runtime plus one archive,
`C:\Program Files\gSender\resources\app.asar`, which holds all of gSender's JavaScript.
Only that archive is replaced.

```bash
node scripts/gg/pack-asar.mjs --stock <official app.asar> --out app.asar
```

`pack-asar.mjs` takes the `app.asar` of the **official release of the same version** and swaps in
the files from `dist/gsender` (`main.js`, `preload.js`, `server-cli.js`, `server/index.js` and the
whole `app/` folder). Everything else, including `node_modules`, is copied through byte for byte.

To get the official `app.asar` without a Windows machine: download `gSender-1.6.4-x64.exe` from the
official release page. The installer contains a 7-Zip archive; find the `7z` signature
(`37 7A BC AF 27 1C`) in the file, cut from there to the end, and extract `resources/app.asar`
with `7za`.

Install:

1. Install official gSender 1.6.4 (`gSender-1.6.4-x64.exe`).
2. Close gSender.
3. In `C:\Program Files\gSender\resources\`, rename `app.asar` to `app.asar.stock`.
4. Copy the built `app.asar` into that folder. Windows asks for administrator permission.
5. Start gSender. The window title reads `GGSender 0.1.0 (gSender 1.6.4)`.

To go back: delete `app.asar` and rename `app.asar.stock` to `app.asar`.

Do not touch `app.asar.unpacked` next to it; it holds the native serial-port libraries.

## Traps

- **The archive integrity check is off.** `gSender.exe` embeds a hash of the archive index, but the
  Electron fuse that enforces it (`EnableEmbeddedAsarIntegrityValidation`) is disabled in the
  official 1.6.2 and 1.6.4 builds. A repacked archive loads. If a future official build turns the
  fuse on, the hash inside the executable has to be updated as well. `pack-asar.mjs` prints the new
  index hash for that case.
- **One dependency does not download in a restricted network.** `bun install` reports a 403 on
  `noopkat/browser-serialport` (a GitHub tarball). The build does not need it, and the installed
  archive keeps the official `node_modules`.
- **The Sentry build plugin can stall the build** when no token is set. `vite.config.js` now loads
  it only when `SENTRY_AUTH_TOKEN` exists.
- **`tsc` reports about 2600 type errors in upstream code.** The build does not type-check. Compare
  the error list before and after a change instead of expecting zero.
- **Methods called without their object.** `surfacingGcodeGenerator.js` destructures methods from
  `this` and calls them bare. A method that uses `this` must be an arrow property there. The
  surfacing tests catch this.
- **Two controllers.** gSender has separate `Grbl` and `Grblhal` controllers. FluidNC connects as
  `Grbl`. Server changes in this fork are in the `Grbl` controller only.
- **Wizard objects built once.** `manualToolchange.tsx` exports an object created at load. Anything
  in it that depends on a setting must be a getter, or it is frozen at start-up.
- **An official update replaces `app.asar`.** The update check is switched off in this build.

## Change log

### 0.1.0 (on gSender 1.6.4)

**Tool change: safe height is a setting.**
Upstream retracts to machine Z-5 (fixed sensor) or Z-10 (probe tool length), which costs that much
usable tool length over the tool setter. New setting *Tool change safe height*
(`workspace.toolChange.safeZ`, machine mm, default `-0.1`, `0` allowed). A positive entry is read as
that far below the top.
Files: `lib/gg/toolChangeMoves.ts`, the four files in `wizards/`.

**Tool change: no plunge back to the starting Z.**
Upstream ends a tool change by returning to the Z the job was at. New setting *Return to starting Z
after tool change* (`workspace.toolChange.returnToStartZ`, default off): the machine goes to the
safe height, returns in X/Y, stays there, and the program continues. On gives the upstream moves.
Applies to all four wizards. In the two wizards meant for machines without homing (Standard and
Flexible Re-zero), "off" uses a machine-coordinate move, so turn the setting on if the machine is
not homed.

**Tool numbers are not sent to the controller.**
Grbl-family firmware stores the tool number in 8 bits and answers `error:38` above 255. When
gSender runs the tool change itself, the T word is now removed from the stream and gSender tracks
the tool number. This also covers check mode and a T word on a line before its `M6`.
New setting *Send tool numbers to controller* (`workspace.toolChange.sendToolNumber`, default off).
Ignored when Passthrough is on.
Files: `server/lib/gg/toolWord.js`, `GrblController.js`, `GrblRunner.js`.
Not confirmed on the machine: that FluidNC has the 255 limit, and that this was the cause of the
stutter seen with T405.

**Surfacing: start height and ramp angle are fields.**
Upstream starts, ramps in from and travels at 3 mm (0.12 in) above Z0, with a 10 degree ramp. Two
new fields in the surfacing dialog, *Start Height & Ramp*. Defaults reproduce upstream output
exactly. At a start height of 0 the tool travels at the original surface height.
Files: `features/Surfacing/utils/surfacingGcodeGenerator.js`, `features/Surfacing/index.tsx`.

**Coordinate fields accept calculations.**
The work-coordinate fields take `12.5/2`, `(120-6)/2`, and `*2` or `/2` applied to the current
value. A leading `+` or `-` is still a sign: `-5` sets -5. Invalid text turns red and sends
nothing. (Upstream sent `NaN` to the handler on invalid text.)
Files: `lib/gg/expression.ts`, `features/DRO/component/WCSInput.tsx`.

**Progress bar instead of the wood-cutting animation.**
File: `features/JobControl/WoodcuttingProgress.tsx` (name kept so its two users are untouched).

**Build label, no update prompt, no crash reports.**
Window title and About page show the fork version. The update check does not run, so the update
badge never appears. Sentry crash reporting is off, so a modified build does not send reports to
Sienci. Switches are in `src/app/src/gg-build.json`.

### Tests added

`lib/gg/__tests__/`, `server/lib/gg/__tests__/`, `wizards/__tests__/gg-toolchange-z.test.ts`, and a
block at the end of `features/Surfacing/tests/surfacing-output.test.ts`.

## To check on the machine after installing 0.1.0

Do these with the spindle off or as an air cut first.

1. Title bar shows `GGSender 0.1.0 (gSender 1.6.4)`; no update badge on the logo.
2. Settings: search "tool change". The three new settings are there with defaults -0.1, off, off.
3. Fixed tool sensor change: Z goes to machine -0.1 before moving over the setter, probes, returns
   to -0.1, returns in X/Y, does not plunge.
4. A file using T405: no `error:38` in the console, no stutter, tool shown as T405.
5. A file using T5: tool shown as T5 during and after the change.
6. Surfacing: generate with start height 1 mm, read the G-code preview: `G0 Z1` in the header and
   no absolute Z above 1.
7. Type `/2` then Enter in the X work coordinate: the value halves.
8. Job progress shows a plain bar.

## Still to do (agreed with the owner)

- Loaded-tool indicator saved to disk, with manual correction and an "unknown" state.
- Skip the tool change when the requested tool is already loaded; prompt on the first `M6`.
  gSender 1.6.4 already has *First tool behaviour* (prompt, or probe length only); build on it.
- Per-tool feed and speed rules applied in the sender's line filter.
- Start from a chosen tool change, rebuilding modal state.
- Editable tool-change sequences (text templates instead of code).
- Pre-flight check on file load (tools, Z range per tool, travel limits).
- Air-cut mode (temporary Z offset).
- Publish each build as a release with `app.asar` attached; optional Windows installer built by CI.

## Open problem

Soft-limit alarm when a job is started with the machine at machine Z0, at the moment the tool lifts
off the tool setter (fixed sensor). Jogging Z down a little before starting avoids it. It happens
with any tool, so it is not the retract overshooting. Not explained from the code. Needed: the
console lines from the probe touch to the alarm.
