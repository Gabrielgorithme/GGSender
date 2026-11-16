# GGSender

A personal fork of [gSender](https://github.com/Sienci-Labs/gsender) (GPLv3) for a FluidNC machine
driven through gSender's Grbl controller with a fixed tool length sensor.

This file is the entry point for whoever edits this fork next, human or AI. It covers what was
changed and why, how to build and install, the traps, and what is still to do. `CLAUDE.md` is the
short version that Claude Code loads by itself.

- Base: official gSender **v1.6.4** (tag `v1.6.4`).
- Fork build: **0.4.1**, set in `src/app/src/gg-build.json`.
- Branches: `gg/main` is the current state of the fork and the repository's default branch.
  Branch from it for each change (`gg/<version>`) and open a pull request into `gg/main`. The older
  `gg/0.x` branches are history.
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
- **Type-check with `scripts/gg/typecheck.sh`, not `node_modules/.bin/tsc`.** The `tsc` there is
  TypeScript 3.9 (pulled in by another package); it stops at syntax errors in type declarations and
  never checks gSender's code. The script uses TypeScript 5.4.5: upstream has about 740 errors, the
  fork's own files must have none, and the script fails if they do.
- **The toolpath is one continuous line.** `GCodeVisualizer.js` draws all vertices as a single
  `THREE.Line`. A straight move adds 2 vertices, an arc 5 to 26. Anything that walks the vertices
  (the toolpath picker) must not assume pairs.
- **Settings saved by an earlier build win over new defaults.** To change a default for existing
  installs, add a step to `lib/gg/migrations.ts`.
- **Methods called without their object.** `surfacingGcodeGenerator.js` destructures methods from
  `this` and calls them bare. A method that uses `this` must be an arrow property there. The
  surfacing tests catch this.
- **Two controllers.** gSender has separate `Grbl` and `Grblhal` controllers. FluidNC connects as
  `Grbl`. Server changes in this fork are in the `Grbl` controller only.
- **Wizard objects built once.** `manualToolchange.tsx` exports an object created at load. Anything
  in it that depends on a setting must be a getter, or it is frozen at start-up.
- **An official update replaces `app.asar`.** The update check is switched off in this build.

## Traffic log

Everything exchanged with the controller is written to disk as it happens, so it survives a
disconnect or a crash.

- Folder: `%APPDATA%\gSender\logs` (the same folder as gSender's own `server.log` and `grbl.log`).
- One file per app start, `traffic-<date>-<time>.log`, split at 20 MB; the 30 newest are kept.
- `>` sent to the controller, followed by its source (`sender` = the job, `feeder` = an injected
  command, `immediate` = polls). `<` received. `#` an event inside gSender.
- Status polls (`?`) are left out. Status reports are kept when the machine state changes and once
  every 5 seconds.

Events worth searching for:

| Search for | Meaning |
| --- | --- |
| `COMMAND DURING JOB` | G-code injected while a job was running, with the call stack that asked for it |
| `interface: origin of next` | The interface-side call stack of an injected command |
| `interface: workspace dropdown fired` | The work-coordinate dropdown sent a value |
| `interface: job:stop received` | The interface is about to re-send the stored coordinate system |
| `ok credited to` | An "ok" that was not counted for the running job (`$G reply`, `feeder`, `paused job`) |
| `accounting` | Sender bookkeeping every 5 s during a job: lines sent and acknowledged, buffer use |
| `STALL` | Job running, sender not holding, machine idle, no reply for 3 s. Followed by a state dump |
| `workflow:` | start, pause, resume, stop, with what caused a pause or stop |

Code: `src/server/lib/gg/trafficLog.js` (the file), `src/server/lib/gg/streamDiagnostics.js` (the
events), hooks in `lib/Connection.js`, `GrblController.js`, `CNCEngine.js`, and
`app/src/lib/controller.ts`. The diagnostics only observe; they do not change what is sent or how
replies are counted.

Build the interface with `GG_READABLE_BUILD=1 scripts/gg/build.sh` when the stacks matter: the
bundle is three times larger but the stack traces carry real function names.

## Simulated-board test

`src/server/controllers/Grbl/__tests__/gg-stream-sim.test.js` runs the real Grbl controller against
a simulated board that answers like Grbl: `ok` per line, a status report per `?`, `[GC:...]` then
`ok` for `$G`, `error:38` for a tool number above 255. It checks that a job streams to the end and
that no T word reaches the board. Extend it when changing anything in the stream path.

## Change log

### 0.4.1 (on gSender 1.6.4)

**Hide a kind of pre-flight warning.** Each warning and note in the pre-flight panel has a *Hide
this kind* button. Hidden kinds are not listed, not counted on the CHK badge and do not open the
panel, for every file. They are listed at the bottom of the panel with *show again*, and kept in
the setting *Hidden pre-flight warnings* (`workspace.gg.preflightHidden`, one code per line,
editable). Errors (travel exceeded, feed before any F) cannot be hidden; an error code put in the
setting by hand is ignored. File: `lib/gg/preflightHidden.ts`.

### 0.4.0 (on gSender 1.6.4)

**Click the toolpath to find its line, and the reverse.**
A click (not a drag) on the toolpath in the 3D view selects the G-code line that drew the nearest
segment within 8 px. That line's motion is highlighted in pink, with a white dot at its start and a
pink one at its end. A card at the bottom of the view shows the line with two lines either side;
◀ ▶ step to the previous or next line with motion, *Go to line* jumps, *Editor* opens the editor
there, Esc or ✕ clears. A line without motion shows where the tool is at that point. In the G-code
editor, clicking a line number shows that line in the 3D view; this is off while the editor has
unsaved edits, since the view still shows the saved file.
How: the visualize worker records, for each entry of `frames`, the file line it came from
(`frameLines`), counting lines exactly as the editor does. The lookups are binary searches in
`lib/gg/toolpathPick.ts`; the click handling and highlight are in `features/gg/ToolpathPicker.js`.
Only the main 3D view; not the surfacing preview.

**Pre-flight check.**
Every loaded file is analysed in the visualize worker (`lib/gg/preflight.ts`). A *CHK* button in
the 3D view opens the report, with a badge counting warnings and errors. Setting *Pre-flight check on
file load* (`workspace.gg.preflightOnLoad`): open by itself *When there are warnings* (default),
*Every file*, or *Never*. Line numbers in the report show the line in the 3D view.
- Per tool: lines, deepest and highest Z cut, highest Z reached, highest feed, spindle speeds.
- File checks: feed move before any F (error:22), feed below Z0 with the spindle off, rapid ending
  below Z0, cutting before the first tool change, M6 without a tool number, change to the tool
  already in use, tool numbers above 255, G53, G28/G30, G92, mixed G20/G21.
- Machine checks (`lib/gg/preflightContext.ts`), recomputed live, so setting a new zero updates
  them: job extents in machine coordinates against `$130`–`$132` (needs homing), spindle speed above
  `$30`, tool changes with the *Ignore* strategy, tool numbers above 255 when they are sent, the
  first tool against the loaded tool, feed rules that will change this program.
- Travel sides: an axis is taken to run [-travel, 0] unless the machine reports a clearly positive
  position on it, then [0, travel]. With the machine at 0 on an axis (just homed) the side cannot be
  told; an excess that would fit on the other side is a warning ("at 0: unsure"), not an error.
- Z extents are for the tool now in the spindle; after a tool change work Z shifts by the length
  difference.
- Limits: arcs outside XY count only their end points; after G53/G28/G30 positions are unknown
  until set again; probing moves are not counted.

**Feed override in 1% steps by default.** The default of *Feed override step* is now 1, and a
one-time settings update (`lib/gg/migrations.ts`) sets it to 1 for installs that saved 10 under
0.3.0. The spindle step stays as set.

**`scripts/gg/typecheck.sh`.** See Traps.

Tests added: line lookup and screen picking (including arcs), the picker against a real three.js
camera, the worker's line table, the pick card and editor link, the analyzer, the machine checks,
the panel, the settings update.

Not checked: nothing run on Windows or on the machine; the picking was tested against computed
camera matrices, not in the running app.

### 0.3.0 (on gSender 1.6.4)

**Loaded tool is recorded, shown and correctable.**
Upstream keeps no record of what a tool change left in the spindle. The tool number is now saved
with the settings when a tool change finishes (`workspace.gg.loadedTool`), shown as a chip in the
top bar (`T5`, or `T?` when unknown), and can be corrected or marked unknown by clicking the chip.
It becomes unknown by itself if a job is stopped in the middle of a tool change.
Files: `lib/gg/loadedTool.ts`, `features/gg/LoadedToolIndicator.tsx`, `controllerSagas.tsx`,
and one `emit("gg:toolchange:complete")` in `GrblController.js`.

**No forced tool change for the tool that is already loaded.**
When an `M6` asks for the recorded tool, the setting *When the requested tool is already loaded*
(`workspace.gg.sameToolPolicy`) decides: *Ask* (default), *Continue without asking*, or *Always run
tool change* (upstream). Continuing skips the change and the probing; work Z is left as it is.
The length reference: gSender probes the tool in the spindle on the first change of a job and
matches every later tool to that reading. If the first `M6` was skipped that reading does not exist
for the job, so the next real change is run as a first one (it probes the old tool before the
swap). `effectiveToolChangeCount()` in `lib/gg/loadedTool.ts`.
Applies to the three wizard strategies. With *Pause*, the requested tool is recorded as loaded when
the pause is reached.

**Override steps down to 1%.**
The firmware has always had 1% realtime override commands and gSender's server already sends them;
only the slider was fixed at 10. Settings *Spindle override step* and *Feed override step*
(`workspace.gg.*OverrideStep`: 1, 2, 5 or 10). Below 10 the change is sent 0.25 s after the last
click instead of 1 s. The server now counts the steps to send from the previous request while the
controller's report is still catching up, otherwise quick fine steps were counted twice.
Files: `features/JobControl/FeedOverride.tsx`, `server/lib/gg/overrideBase.js`.

**Per-tool feed and speed rules.**
Setting *Per-tool feed and speed rules* (`workspace.toolChange.feedRules`), one rule per line, for
example `T5 F1000 -> F200`, `T5 F>800 -> F800`, `T5 F* -> 50%`, `T* S* -> 90%`. Applied to each
program line in the sender, for the tool of the last `M6` seen. Rules can be changed while a job
runs; they act on F and S words as they are sent, so the change shows at the next such word and a
few lines later than that (lines already inside the controller). Syntax and limits are documented
at the top of `server/lib/gg/feedRules.js`.

**Progress area.** The bar that replaced the wood animation in 0.1.0 is gone; only the percentage
remains.

Tests added: `loadedTool`, `feedRules`, `overrideBase`, rendering tests for the indicator and the
coordinate field, and four simulated-board tests (feed rules through the real controller, a rule
added mid-job, 1% override steps).

Not checked on the machine: everything above. Not checked at all: whether the settings screen can
be opened while a job runs (needed to change feed rules mid-job).

### 0.2.0-diag (on gSender 1.6.4)

**Traffic log and stream diagnostics.** See the section above. Added to find an intermittent stall
seen on official 1.6.4 as well as on 0.1.0: the job shows as running, the controller is idle, the
spindle stays on. A `G54` that is not in the program appears around the stall. Never seen on 1.6.2.

What is known so far:
- Nothing that changed in the server between 1.6.2 and 1.6.4 writes to the controller.
- A bare `G54` can only come from the workspace dropdown, the end-of-job restore
  (`[global.state.workspace]` in `controllerSagas.tsx`), check mode, or start-from-line.
- The official 1.6.4 build contains a newer dropdown library (Radix Select) than the official
  1.6.2 build; this fork builds with the locked, older one. The stall was reported on both, so the
  library alone does not explain it.
- In the simulation, a `G54` injected mid-job does not stall the stream when the board answers
  every line.

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

### Tests added in 0.1.0

`lib/gg/__tests__/`, `server/lib/gg/__tests__/`, `wizards/__tests__/gg-toolchange-z.test.ts`, and a
block at the end of `features/Surfacing/tests/surfacing-output.test.ts`.

## To check on the machine after installing 0.4.0

1. Title bar shows `GGSender 0.4.0 (gSender 1.6.4)`.
2. Feed override +/- move 1%.
3. Load a file: if it has warnings, the pre-flight panel opens. The *CHK* button opens it anyway.
   Per-tool table matches what you know of the file.
4. Home, set the zero, open CHK: the travel table shows machine coordinates that make sense. Move
   the zero so the job runs off the bed: the axis turns red.
5. Click a cut in the 3D view: the pink highlight and the card show the right line. Rotate and pan
   the view: no line is selected by dragging.
6. Click a line number in the G-code editor: the view shows that line.
7. Click a line in the pre-flight report: same.

## To check on the machine after installing 0.3.0

1. Title bar shows `GGSender 0.3.0 (gSender 1.6.4)`.
2. Top bar shows a `T?` chip. Click it, type a number, Enter: it shows that tool. It keeps it after
   a restart.
3. Run a program whose first tool is the one shown: a prompt offers to continue without a tool
   change. Continuing resumes the job with no motion to the tool setter.
4. Same program with a second tool: at the second `M6` the wizard shows the "probe initial tool"
   step before the swap.
5. After a normal tool change the chip shows the new tool.
6. Settings, *Spindle override step* = 1: the +/- buttons next to the spindle slider move 1% and the
   reported override follows.
7. Settings, *Per-tool feed and speed rules* = `T<n> F* -> 50%` for the tool in use: in the console
   the F words of the job are halved. Remove the rule, they return.
8. Check whether Settings can be opened while a job is running.

## Checklist for 0.1.0 (reported working by the owner)

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

- A panel for the feed rules next to the override sliders, if Settings cannot be opened mid-job.
- Start from a chosen tool change, rebuilding modal state.
- Editable tool-change sequences (text templates instead of code).
- Air-cut mode (temporary Z offset).
- Publish each build as a release with `app.asar` attached; optional Windows installer built by CI.

## Open problem

Soft-limit alarm when a job is started with the machine at machine Z0, at the moment the tool lifts
off the tool setter (fixed sensor). Jogging Z down a little before starting avoids it. It happens
with any tool, so it is not the retract overshooting. Not explained from the code. Needed: the
console lines from the probe touch to the alarm.
