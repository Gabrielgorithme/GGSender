# GGSender

A personal fork of [gSender](https://github.com/Sienci-Labs/gsender) (GPLv3) for a FluidNC machine
driven through gSender's Grbl controller with a fixed tool length sensor.

This file is the entry point for whoever edits this fork next, human or AI. It covers what was
changed and why, how to build and install, the traps, and what is still to do. `CLAUDE.md` is the
short version that Claude Code loads by itself.

- Base: official gSender **v1.6.4** (tag `v1.6.4`).
- Fork build: **0.7.0**, set in `src/app/src/gg-build.json`.
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
- **Realtime bytes from 0x80 up go out as UTF-8.** The serial port encodes strings as UTF-8, so
  `String.fromCharCode(0x9E)` leaves as C2 9E. FluidNC decodes realtime input as UTF-8 and needs
  exactly that; a single raw 0x9E byte is a decoding error there and is ignored. Send these
  commands as one-character strings (as the override code does), never as a raw byte buffer.
- **Every loaded program gets a `%wait` line appended.** `gcode:load` adds it, so the sender holds
  one line more than the file has non-blank lines. Anything that compares line counts between the
  interface and the server must allow for it (`programLength` in `server/lib/gg/opResets.js`).
- **The server's job has no name.** The interface sends `gcode:load` the file name as a bare
  string and the server reads `meta.name` from it, so `sender.state.name` is undefined. Take the
  name from the interface (`state.file.name`).
- **G2/G3 alone is an error.** Grbl and FluidNC refuse a G2/G3 word with no axis words (`G0`/`G1`
  alone are fine). Fusion writes arcs modally (664 lines of the owner's file continue an arc with
  only X Y I J), so anything that restarts the program on such a line must put the G2/G3 on it.
- **The tool sensor reference lives in the server's memory.** The fixed-sensor wizard's first
  change of a job probes the tool in the spindle and keeps its work Z at the sensor in
  `global.toolchange.TOOL_OFFSET` (`controller.sharedContext`); later changes set the new tool to
  read the same with `G10 L20 P0 Z`. It is lost on disconnection. The work offset itself is stored
  in the controller and survives resets.
- **Upstream does not pause on errors unless told to.** The error handler pauses the job only when
  the server's `preferences.showLineWarnings` is `false` or true; the interface sends it only when
  it is on, so by default it is undefined and the job streams on after an error. 0.7.0's error hold
  pauses by itself.
- **No G-code during a feed hold.** Lines sent while the controller is held queue behind the held
  moves; an M3 or M5 waits for them. Anything that must happen during a hold (spindle stop) has to
  be a realtime command, and anything that waits for G-code to finish before sending `~` deadlocks.

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
| `hold` | The pause-as-feed-hold state after each change: held, spindle stopped, spin-up wait (0.6.0) |
| `ops` | Operation starts received from the interface, and each override reset (or why none) (0.7.0) |
| `homed` | The homed state read from the controller, at each change (0.7.0) |
| `resume` | A resume from a line: the line, the entry lines, refusals, program restored (0.7.0) |
| `error-hold` | A job line refused by the controller, and the machine held (0.7.0) |

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

## End-to-end run of the built app

`scripts/gg/e2e/` drives the built interface and server (`dist/gsender`, after
`scripts/gg/build.sh`) against a fake FluidNC over TCP, with Playwright's Chromium:

```bash
node scripts/gg/e2e/run-server.js /tmp/gg-e2e-home 8765 &
node scripts/gg/e2e/fake-fluidnc.js 2323 /tmp/fake.log 25 &
node scripts/gg/e2e/resume.js /tmp/gg-e2e src/app/src/lib/gg/__tests__/fixtures/fusion-one-of-each.nc
node scripts/gg/e2e/error.js /tmp/gg-e2e scripts/gg/e2e/xz-arc-without-g18.nc
```

The scripts set the interface's stored settings (`localStorage` key `sienci`: Ethernet to
127.0.0.1:2323, tool change strategy *Ignore*, no pre-flight pop-up), connect, load the file, run,
and leave screenshots in the output folder; the fake board logs every line, realtime byte and
executed move as JSON lines. The fake answers `ok` once a move is queued (planner of 16), runs
moves one by one, holds on `!`, synchronises on `G4`, tracks overrides and the spindle, and refuses
an I/K arc in G17 with `error:33`. It is a stand-in for what the fork depends on, not FluidNC.

## Change log

### 0.7.0 (on gSender 1.6.4)

**Resume From** replaces upstream's *Start From* (setting *Resume from a line*,
`workspace.gg.resumeFromLine`, default on; off gives upstream's dialog back). It does what the owner
did by hand: keep the program's set-up, go to where the tool was from above, come down, carry on.
- Where: an N number (`N60005`, or `L` + a file line), *Where it stopped*, or *Start of an
  operation*. *Where it stopped* is the move the tool was on when the last run ended early:
  gSender's line count runs ahead of the machine by FluidNC's planner queue, so the stop position
  (work coordinates, from the last status report) is matched to the moves of the last 300 lines
  counted. The record is kept in the settings (`workspace.gg.lastStop`) and survives a restart.
- The program is read up to that line for units, distance and feed mode, plane (Fusion's parallel
  passes use G18), work offset, motion mode, feed, spindle and speed, coolant, tool, and the
  position the line starts from (the end of the previous move; unknown after G28/G53).
- Lines sent first, all shown in the dialog before anything moves:
  `G21 G53 G0 Z<tool change safe height>` (straight up), the modes (`G21 G90 G94 G17 G54`), an
  optional `T.. M6`, `S.. M3` and `G4 P<spin-up>`, `M8`, `G0 X.. Y..`, `G0 Z<operation's highest
  rapid>`, `G1 Z<start> F<operation's plunge feed>`, then the feed and motion mode. Rapid height,
  plunge feed and spin-up can be changed in the dialog.
- Why the way down is clear: the start point is a point the tool reached, so the column above it,
  as wide as the tool, was empty then. True when resuming at or before where the job stopped with a
  tool of the same diameter; a later line is flagged in the dialog (the moves in between are
  skipped, and the way down may meet uncut material).
- A line continuing a modal arc gets its G2/G3 written on it (see Traps). A line after
  `G2`/`G3`/`G1` with no G word of its own (`X12.98 Z-0.959`) gets the motion mode and F
  sent before it.
- A tool length offset set by the program (`G43.1 Z..`) is restored; its Z is not read as a move.
  When the tool change wizard runs, the modes line is sent again after it.
- The dialog warns when the stop position is more than 0.5 mm from every move near where the job
  had got to (jogged after the stop, or position lost).
- Refused, with the reason: a tool change line (pick the operation's first move and tick the tool
  change instead), at or before the program's first move, G10/G92 before the line, G91 or G93 at
  the line, M2/M30 before it, rotary programs, G90.1 (FluidNC refuses it; arc centres are always
  incremental there), too close to the start for the entry lines.
- Tool: *untouched* (default when the tool recorded as loaded is the line's) or *change or measure
  it first* (default otherwise), which runs the normal tool change wizard before the spindle
  starts. If a tool sensor reference exists from this connection, the change count starts at 1 so
  the wizard skips *Probe Initial Tool* and sets the new tool against the kept reference, which is
  what is needed after a broken bit (probing the broken one as the reference would put every later
  Z off by what it lost). Without one, the wizard first probes the tool in the spindle as the
  reference; the dialog says which applies.
- The server (`gg:resume:start`) checks the job is idle and the machine Idle, the loaded program has
  the planned number of lines and the chosen line the planned text, and that the entry lines are
  plain G-code. It writes them in place of the program lines just before the chosen one, so every
  line from it on keeps its number (progress, operations list, tool card and override resets work
  as in a normal run), and starts the job the normal way (Program Start event included). The
  program is put back as loaded when the job stops, and before any normal start.
Files: `lib/gg/resumePlan.ts` (the plan), `lib/gg/stopPoint.ts`, `features/gg/ResumeFromLine.tsx`;
`server/lib/gg/resumeSplice.js`; hooks in `JobControl/index.tsx` (the button), `controllerSagas.tsx`
(stop point), `GrblController.js` (`gcode:start`, workflow stop, commands `gg:resume:start` and
`gg:resume:query`).

**The machine is held at the first error of a job** (setting *Hold the machine on a job error*,
`workspace.gg.holdOnError`, default on). Reported by the owner: resuming by hand mid-file without
the earlier `G18`, every XZ arc (`G2 X16.529 Z-0.5 I0.4 K0`) got `error:33` and the job went on
streaming. Two upstream behaviours combine there:
- gSender pauses on an error only if the server's preferences hold `showLineWarnings`, and the
  interface sends that preference only when it is on. With it off (the default) the job keeps
  streaming after every error.
- Even when it pauses, it only stops sending: the lines already in FluidNC's buffer still run.
  After a refused arc the next move starts from where the arc began: a straight line through
  the part.
Now the first error of a running job sends a feed hold at once (as the 0.6.0 pause does) and
pauses the job. A message names the exact line, matched to the reply rather than gSender's line
count, which runs ahead on comment lines. It says to stop the job, not resume it. Upstream's *Invalid Line* message ("Press Start to resume the job") is
not shown when the machine was held. Stop flushes the queued lines (soft reset); a resume would run
them. Files: `server/lib/gg/errorHold.js`, `features/gg/JobErrorNotice.tsx`; hooks in the
controller's error handler and the interface's error listener.

**Hold control above the progress text.** The 0.6.0 *Stop spindle* / *Start spindle* control was
drawn over the job progress (different containers at overlapping heights; the progress box used to
hide it). It is now stacked above the percentage.

**Feed and spindle overrides back to 100% at each operation** (setting *Reset overrides at each
operation*, `workspace.gg.resetOverridesPerOp`, default on). Not at the first operation; the rapid
override is left alone. Timing: lines are sent well ahead of the machine, so a reset sent when the
next operation's first line goes out would land on the last cuts of the previous one. The server
adds `G4 P0` to the operation's first move; the firmware runs a dwell only once every earlier move
is done and before the motion of the same block (checked in FluidNC's `GCode.cpp` and
`MotionControl.cpp`), so its `ok` arrives exactly when the previous operation has finished, and the
resets (0x90, 0x99) go out on it, at once rather than through the 25 ms override queues. The
feed override does not act on rapids, so the reset is invisible until the operation's first cut.
Cost: the machine stops at the top of the retract between operations, where the corner between the
vertical and horizontal rapids almost stops it anyway. The interface sends each operation's first
move (sender index and text); the server uses one only if the loaded program matches, and adds the
dwell only to a plain move. Replies are matched to lines with a queue of lines written (gSender's
`received` count runs ahead on skipped comment lines). Files: `server/lib/gg/opResets.js`,
`lib/gg/opBoundaries.ts`; hooks in the data filter, sender write, `ok` and error handlers.

**Pre-flight: homed state from the controller** (setting *Homed state from the controller*,
`workspace.gg.homedFromController`, default on). Upstream counts only a homing gSender sends, so a
machine homed from the FluidDial before connecting showed *not been homed*. FluidNC has no status
field for it, but: with `must_home` (its default) it starts in alarm and leaves it only by homing or
`$X` (and `$X` also marks every axis homed); during homing its state is `Home`; it ends each cycle
with `[MSG:Homed:XYZ]` on every channel, USB included. So the server counts a homing seen while
connected that ends out of alarm, or the controller being out of alarm when gSender connects; the
second case is shown in the pre-flight as *homed before, or unlocked with $X*. Hard limit, hard
stop, unhomed and failed-homing alarms clear it. Only the pre-flight uses it: the rapid-position,
go-to and parking buttons keep upstream's flag. Files: `server/lib/gg/homedState.js`,
`lib/gg/homedStore.ts`.

**Job progress as text over the 3D view.** The percentage and time left, with a soft halo, and no
box (it held the router-bit animation removed earlier and stayed empty). The line count and cutting
time below are unchanged. Files: `features/gg/ProgressText.tsx`, hook in `ProgressArea.tsx`.

Tests added: the resume plan (the owner's manual method line by line, modal arcs, G18, unknown Z
after G28, every refusal, units, the move nearest a stop position on lines and arcs); the stop
record; the dialog (what it shows and sends, tool defaults, the reference message, the stop point,
refusals, operation start); the server splice and session (indices kept, checks, restore never
overwriting a newer program, the change count); override boundaries from the Fusion fixture, the
dwell placement and reply matching; the homed tracker; the progress text. Simulated-board runs of
the real controller: a board with a planner queue shows the override resets arrive after the last
move of the first operation has run and before the first cut of the next (and nothing with the
setting off); a pendant homing and a machine homed before connecting; a resume sends exactly the
entry lines then the program from the chosen line to its end, is refused without sending anything
when the program differs, restores the program on stop, and gives the wizard change count 2 with a
reference and 1 without; an XZ arc refused in G17 holds the machine before the next line runs (and
with the setting off, the next line runs: the owner's gouge).

The built app was also driven end to end against a fake FluidNC over Ethernet (see *End-to-end
run of the built app*): a job stopped mid-operation, *Resume From* proposed the move the tool was
on (0 mm away), and the board received exactly the entry lines, then the program from that line,
with `G4 P0` on each following operation's first move; a file with an XZ arc and no `G18` was held
at the refused line, the next line received but not run, the notice shown. That run found the two
fixes above (stop position far from the path; hold control over the progress).

Not checked: nothing run on Windows or on the machine; the end-to-end run used a simulated
controller, not FluidNC. The tool change part of a resume was not run through the wizard (the
end-to-end run used the *Ignore* strategy; the change count is covered by the simulated-board
test). FluidNC's behaviour (dwell sync, homed messages, `$X`, error:33) comes from its current
source, not the owner's firmware version. The resume's come-down rests on the reasoning above; the first one should be an
air cut.

### 0.6.1 (on gSender 1.6.4)

**Tool change window: large Run button, Enter runs it.** Upstream's Run button is small and sits
under the step's text, so it moves from step to step. Setting *Large Run button, Enter runs it*
(`workspace.gg.toolChangeEnter`, Tool Changing section, default on):
- The step's Run button is large (48 px high), shows `⏎ Enter`, and sits at the bottom of the
  window just above Back/Next, in the same place on every step. The small *RUN G-CODE* heading is
  left out.
- Enter presses it: one step per press. Enter does nothing while a step runs, during the first
  0.7 s after a step's button appears (a second press meant for the step that just finished does not
  start the next one), once the step's action has run, while the machine is not Idle (the button's
  own condition), when a step offers several actions, on key repeat, or with Ctrl/Alt/Shift/Meta.
- While the window is open Enter does nothing else: the jog, jog-stop and rapid-position buttons
  react to Enter when they have focus, and one of them may still have it from before the tool
  change (a rapid-position button would move the machine). Typing in a text field and a dialog
  opened on top of the window are left alone.
- The tool card beside *Install New Tool* is more compact (drawing 124 px, size on one line,
  operations on at most two lines, full list on hover), so the Run button stays in view; the
  drawing's labels now keep the same size whatever height it is drawn at.
- Off: upstream's small button and heading, no Enter.
Files: `features/gg/enterToRun.ts`; hooks in `Helper/components/Actions.tsx` (button class, ref,
hint, heading) and `Substep.tsx` (fills the window so the button can sit at the bottom).

Tests added: the Enter decision (repeat, modifiers, arming delay, text fields, open dialogs), and
the real wizard Actions component: Enter runs the step once, not too early, not while the machine
moves or a step runs or after it is done, not with several actions, not from a text field, does not
reach a focused button outside the window, and does nothing with the setting off.

Not checked: nothing run on Windows or on the machine; the window was checked in rendered previews
of the real components at the wizard's size, not opened by a real M6.

### 0.6.0 (on gSender 1.6.4)

**Pause is an immediate feed hold, with the spindle stoppable during the hold.**
Upstream's pause, with a *Program Pause* event set up (the owner's stops the spindle), only stops
sending the program and sends the event's G-code behind it, so the machine first runs everything
already in FluidNC's buffer: it stops "a little later". The FluidDial hold button stops at once.
Now, with the setting *Pause button* (`workspace.gg.pauseMode`) at *Immediate feed hold* (default):
- Pause sends `!` at once; the job stops being fed. Applies to the Pause button, the keyboard
  shortcut and the gamepad (all send `gcode:pause`).
- While held, above the Start/Pause/Stop buttons (where *Outline* and *Start from line* are when
  idle): *Stop spindle* / *Start spindle*, with the state below it. It sends 0x9E, the Grbl/FluidNC
  spindle-stop override, which the controller accepts only in Hold. The button follows the
  controller's reports (`A:S` while the spindle turns), so a stop made from the pendant shows too.
- Resume (Start button): waits until the hold is complete (FluidNC ignores `~` while still slowing
  down, `Hold:1`); if the spindle is stopped, starts it while still held, waits *Spin-up wait when
  resuming* (`workspace.gg.resumeSpinupSeconds`, default 5 s) with a countdown, then `~`.
- *Stop the spindle when pausing* (`workspace.gg.holdStopsSpindle`, default off): sends the spindle
  stop as soon as the hold is reported.
- The Program Pause and Resume events are not run in this mode: G-code cannot run during a hold, and
  upstream's resume waits for the Resume event's G-code before sending `~`, which would never come.
  For the same reason a resume while the controller reports Hold (a hold made from the pendant) also
  skips them and only sends `~`.
- A cycle start from the pendant during a gSender hold: when the controller reports Run again the
  job goes on being fed (otherwise gSender would stay paused while the machine ran out of buffer).
  FluidNC restarts a stopped spindle itself in that case, waiting only its `spinup_ms`.
- *Upstream: run the Program Pause event* gives the upstream pause back.
Checked against FluidNC's source (main branch, Nov 2026): 0x9E in Hold stops or restores the
spindle; `~` with it stopped restores it then resumes, waiting only the spindle's `spinup_ms`
(default 0); `A:` reports the real spindle state; realtime bytes are decoded as UTF-8.
Files: `server/lib/gg/holdPause.js` (the logic), hooks in `GrblController.js` (pause, resume, status,
stop, two commands `gg:hold:spindle` and `gg:hold:query`, event `gg:hold:state`);
`features/gg/HoldSpindleControl.tsx`, `lib/gg/holdSettings.ts` (settings pushed to the server's
preferences on connection and on change). Grbl controller only, as the rest of the fork.

Tests added: the hold logic with a fake clock (immediate hold, resume ordering and waits, a resume
during deceleration, a toggle not yet confirmed, a stale report, the pendant, auto stop, spindle
already off, stop during the spin-up wait, the C2 9E encoding); four simulated-board runs of the
real controller against a board that holds like FluidNC (pause holds with no line in between and
nothing moves while held, events not run, spindle stopped and restarted before `~` after the wait,
job completes; auto stop; pendant resume; upstream mode still runs the event); the settings mapping
read back by the server; the button states and countdown.

Not checked: nothing run on Windows or on the machine; the button was not seen in the running app
(no machine to hold); FluidNC's behaviour comes from its current source, not the owner's firmware
version.

### 0.5.1 (on gSender 1.6.4)

**No more "tool already loaded" prompt.** Removed at the owner's request: when a program asks for the
tool recorded as loaded (e.g. T45 loaded, program starts with T45), the *T45 Already Loaded* window no
longer appears and nothing is skipped; every M6 runs its tool change exactly as upstream, including
the "probe the initial tool" step on the first M6 of a job. Gone with it: the setting *When the
requested tool is already loaded* (`workspace.gg.sameToolPolicy`; a saved value is ignored), and the
0.3.0 rule that made the next change probe the old tool when the first M6 had been skipped. Kept: the
loaded tool is still recorded after each change and shown as the `T45` chip in the top bar, and the
pre-flight notes about it. Upstream's own *First tool behaviour* setting (Fixed Tool Sensor) is
untouched; its *Prompt for first tool* choice shows a different window, *First Tool Change Detected*.
Files: `lib/gg/loadedTool.ts`, `controllerSagas.tsx`; `features/gg/sameToolPrompt.tsx` deleted.

**Spindle override in 1% steps by default.** Up to 0.5.0 the spindle step defaulted to 10 and only
went finer after changing *Spindle override step* in Settings; reported as "still 10%". The default is
now 1, and a one-time settings update moves an install still at 10 to 1 (a step of 1, 2 or 5 chosen
earlier is kept; 10 can be chosen again for the upstream step). Also fixed: dragging the spindle slider
and letting go off the slider showed the new value but never sent it (upstream sent it on pointer-up,
which does not fire there; the feed slider already used pointer-capture-lost, now both do). The server
side already sent FluidNC's 1% spindle commands (0x9C/0x9D); the simulated-board test covers that.
Files: `features/JobControl/FeedOverride.tsx`, `lib/gg/migrations.ts`, defaults and Settings.

Tests added: the real tool change handler of the controller saga with T45 loaded and T45 requested
(wizard opens, no prompt, job not resumed; fails on 0.5.0), the initial-tool step on the first M6,
recording the tool on completion and losing it on a stop; the override panel with default settings
(+ sends 101, - sends 100; a drag released off the slider is sent, which fails with the upstream
handler; step 10 still sends 110); the settings update.

Not checked: nothing run on Windows or on the machine.

### 0.5.0 (on gSender 1.6.4)

**Operations list in the 3D view.** The operations of the loaded file, read from the comments Fusion
writes (`(3D Adaptive Roughing1)` before each operation), grouped under the tool change they follow,
in the top-left corner of the 3D view. Each tool group shows a small outline of the tool, `T45`,
`⌀4 R0.5 bullnose end mill` and its time; each operation its time. While a job runs: ✓ done (grey),
▶ running (highlighted, with a bar for how far through it is), the rest to come; the header reads
`6/11` and *Next tool change: T20 in ~6 min*. Clicking an operation shows its first move in the 3D
view (same as clicking the toolpath). The header collapses the list to one line. Replaces the
upstream tool timeline (top-left, `T45` cards) when the file has operations; setting *Operations list
in the 3D view* (`workspace.gg.operationsPanel`, default on) brings the upstream timeline back.
- How operations are found (`lib/gg/jobOperations.ts`): a run of comment-only lines after the
  header starts one. A comment run right after an M6 that already had a name before it is the tool's
  description, not an operation. A comment with no move before the next one (a manual NC note before
  an M0) becomes a note of the next operation. Tool table comments (`T5 D=6 ...`) are never
  operations. Works for any program with comment names, not only Fusion's.
- Where the job is: gSender's own running-line estimate (`currentLineRunning`, the one the progress
  percentage and the grey toolpath use), falling back to the lines the controller acknowledged.
  Both count non-blank lines, which is how the server's Sender numbers them; the analysis keeps that
  numbering (`seq`). `lib/gg/jobProgress.ts`.
- Times are gSender's estimate summed per operation and per tool group (one estimate per line with
  code; checked to line up exactly with the 60 627 code lines of the owner's file). The time to the
  next tool change divides by the feed override. As good as gSender's total estimate, no better.

**Tool drawing at tool change.** In the tool change window, beside the green *Install New Tool / T43*
banner: a side view of the tool drawn from the tool table Fusion writes at the top of the program
(`(T43 D=4 CR=0 TAPER=45deg - ZMIN=-0.35 - chamfer mill)`), with the diameter, corner radius and
taper angle dimensioned, the type, *Cuts down to Z-0.35* (Fusion's ZMIN), and the operations this
tool is fitted for (*For 2 operations: 2D Contour2, Bore1*). Same tool fitted twice in a job (T40 in
the owner's file): the operations come from the M6 line the job stopped at, so each change lists its
own. Setting *Tool drawing at tool change* (`workspace.gg.toolDrawing`, default on). Shown in the
wizard steps that show the banner (Fixed Tool Sensor, Standard and Flexible Re-zero); not with the
*Pause* strategy, which has no window.
- Shapes (`lib/gg/toolProfile.ts`): flat, bull nose, ball, chamfer, tapered, lollipop, thread mill,
  drill; spot/centre drills, countersinks and engraving tools as chamfer; anything else as a plain
  body with its diameter. Schematic: the tip and diameter follow the numbers; flute length, neck and
  shank are not in the file and are drawn at fixed proportions. All tools are drawn at the same
  size; the ⌀ label tells them apart.
- Fusion's definitions used: TAPER is the half angle from the axis (45deg = 90° tool). Chamfer mill:
  D is the top of the cone; the tip diameter is not in the file, so the tip is drawn pointed. Tapered
  mill: D is measured at the tip (the corner arc is centred at D/2 - CR) and the flank leaves the arc
  tangent. The tapered-mill definition comes from Autodesk forum answers, not from Autodesk's
  reference page, which could not be reached from the development session.

Files: `lib/gg/toolSpec.ts`, `jobOperations.ts`, `jobProgress.ts`, `jobInfoStore.ts`,
`toolProfile.ts`; `features/gg/JobOperations.tsx`, `ToolDrawing.tsx`, `ToolChangeCard.tsx`,
`useStoreSetting.ts`. Hooks: the visualize worker (`analyzeJob` beside `analyzeProgram`),
`Visualize.response.js`, `PrimaryVisualizer.tsx` (in place of `{timeline}`), the wizard's
`Instructions.tsx` (around `ToolRequirementBanner`).

Tests added: tool table parsing (all seven tool types of the owner's sample file), operation finding
on the owner's two files (one trimmed to its structure, `lib/gg/__tests__/fixtures/`) and on other
layouts (tool description after M6, name after M6, manual NC notes, no M6, semicolon comments,
inches, CRLF), sender numbering, durations, job position, same tool twice, the drawing geometry
(arc radii, tapered flank tangent to the corner arc), the panel, the card, and the card inside the
real wizard step. The built app was started headless in a browser with the owner's full file: the
list appears, with the times above.

Not checked: nothing run on Windows or on the machine. No job was run, so the running/done marks and
the time to the next tool change were only checked in tests against a simulated sender status; the
tool change window was only rendered in tests, never opened by a real M6.

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

**No forced tool change for the tool that is already loaded.** (Removed in 0.5.1.)
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

## To check on the machine after installing 0.7.0

Air cut first for the resume (Z zero set well above the work, or no stock), hand near the e-stop.

1. Title bar shows `GGSender 0.7.0 (gSender 1.6.4)`.
2. Home with the FluidDial, then connect gSender and load a file: the pre-flight checks the travel
   and has a note *homed before, or unlocked with $X*. Home again from the pendant while connected:
   the note goes away.
3. During a job of several operations, set feed to 80% and spindle to 90%: when the next operation
   starts, both go back to 100%, after the previous operation's last cut (the machine may stop for
   a moment at the top of the retract). The traffic log has `# ops: "<name>" begins, reset: feed
   spindle`.
4. Stop a job in the middle of an operation. *Resume From*: *Where it stopped* gives the line the
   tool was on, its operation and tool, and the lines it will send. Resume with *untouched*: the
   tool goes straight up, the spindle spins up, moves over the point, rapids down to the operation's retract
   height, feeds down, and carries on from that line.
5. Resume at an N number on a line that continues an arc (`X.. Y.. I.. J..` with no G2/G3): the
   dialog shows the line rewritten with `G3`/`G2`; it runs without error.
6. *Change or measure it first* after a tool change earlier in the same session: the wizard goes
   straight to *Measure New Tool*, no *Probe Initial Tool*. After reconnecting: it starts with
   *Probe Initial Tool*, and the dialog said so.
7. Stop the resumed job, then plain Start: the job runs from the top of the file.
8. Error hold, in the air (Z zero well above the work): a short file with an XZ arc but no G18,
   one line each: `G21 G90`, `G0 X0 Y0 Z5`, `G1 X10 F500`, `G2 X10.4 Z4.6 I0.4 K0`, `G1 X20`.
   (With G18 that arc is a valid quarter circle; in G17 its end point is at zero radius, as in the
   owner's error:33.) At the arc the machine holds (header *Hold*), the message names that line and
   says to stop; the `G1 X20` does not run. Stop.
9. While held (Pause, or an error), *Stop spindle* sits above the percentage, not on it.
10. While a job runs: the percentage and time left are plain text over the 3D view, no box.
11. Settings, *Resume from a line* off: upstream's *Start From*. *Reset overrides at each
    operation* off: overrides stay across operations, no pause at the retract. *Hold the machine
    on a job error* off: upstream's behaviour.

## To check on the machine after installing 0.6.1

1. Title bar shows `GGSender 0.6.1 (gSender 1.6.4)`.
2. At a tool change: each step's Run button is large, at the bottom of the window, labelled
   `⏎ Enter`, in the same place on every step, and visible without scrolling.
3. Without touching the mouse: Enter probes the initial tool (first change of a job), Enter probes
   the new tool, Enter resumes. Each press runs one step.
4. Press Enter twice quickly right after a probe finishes: the next step does not start by itself.
5. Click a jog button before the job, then at the tool change press Enter: the machine does not jog;
   the step runs.
6. Settings, *Large Run button, Enter runs it* off: upstream's small Run button, Enter does nothing.

## To check on the machine after installing 0.6.0

Air cut first (spindle on, Z well above the work), hand near the e-stop.

1. Title bar shows `GGSender 0.6.0 (gSender 1.6.4)`.
2. Settings: *Pause button* = Immediate feed hold; *Spin-up wait when resuming* at least the time
   your spindle takes to reach speed (time it from M3).
3. During a job, Pause: the machine stops at once, like the FluidDial hold. The console shows no
   pause-event G-code.
4. *Stop spindle*: the spindle stops; the button turns into *Start spindle*. *Start spindle*: it
   starts. Stop it again.
5. Resume: the spindle starts, the caption counts down, the machine moves only after the wait.
6. Pause and resume within half a second: the job resumes (it must not stay held).
7. Pause from gSender, resume from the FluidDial: the job carries on and the progress keeps going.
   Do this with the spindle running: with it stopped, FluidNC restarts it and waits only its own
   `spinup_ms`.
8. Pause, then Stop: the job stops, spindle off.
9. *Stop the spindle when pausing* on: Pause stops the spindle by itself.
10. *Pause button* = Upstream: the old pause, with the Program Pause event.

Suggestion: set `spinup_ms` on the spindle in the FluidNC config as well, so a resume from the
pendant also waits.

## To check on the machine after installing 0.5.1

1. Title bar shows `GGSender 0.5.1 (gSender 1.6.4)`.
2. The `T` chip in the top bar shows the tool fitted last. Start a program whose first tool is that
   tool: no *Already Loaded* window; the normal tool change window opens, with the "probe initial
   tool" step.
3. During a job (spindle on, or air cut): the spindle override +/- buttons move 1%, the slider moves
   in 1% steps, and the RPM shown follows a second or so later.
4. Drag the spindle slider and let go with the pointer off the slider: the reported override follows
   (upstream it stayed where it was).
5. Settings, *Spindle override step*: shows 1.

## To check on the machine after installing 0.5.0

Air cut or spindle off for the job parts.

1. Title bar shows `GGSender 0.5.0 (gSender 1.6.4)`.
2. Load a Fusion file: the *Operations* list is in the top-left corner of the 3D view (close the
   pre-flight panel if it opened over it). Operations and tools match the Fusion setup; times add
   up to about gSender's estimated time.
3. Click an operation: its first move is highlighted in the 3D view.
4. Start the job: the first operation is marked ▶, its bar grows. Over an operation boundary with the
   same tool (e.g. Flat1 → Parallel1) the mark moves within a few seconds of the machine starting the
   new operation. *Next tool change* counts down.
5. At the first tool change (Fixed Tool Sensor): the window shows the drawing beside *Install New
   Tool*, with the right diameter, corner radius or angle, *Cuts down to*, and the operations for that
   tool.
6. In a file with the same tool fitted twice (T40 in the sample), the second change lists only its
   own operations.
7. Settings: turn *Operations list in the 3D view* off: the upstream tool timeline is back. Turn
   *Tool drawing at tool change* off: the tool change window is as upstream.
8. Stop the job half way: the marks disappear; the list is back to its idle look.

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
- Start from a chosen tool change, rebuilding modal state. (0.7.0: *Resume From* can start at any
  operation's first move, with the tool change; left here until the owner has used it.)
- Editable tool-change sequences (text templates instead of code).
- Air-cut mode (temporary Z offset).
- Publish each build as a release with `app.asar` attached; optional Windows installer built by CI.
- Operations list: highlight an operation's whole toolpath in the 3D view on hover; start the job
  from a chosen operation (needs the modal-state rebuild above).

## Open problem

Soft-limit alarm when a job is started with the machine at machine Z0, at the moment the tool lifts
off the tool setter (fixed sensor). Jogging Z down a little before starting avoids it. It happens
with any tool, so it is not the retract overshooting. Not explained from the code. Needed: the
console lines from the probe touch to the alarm.
