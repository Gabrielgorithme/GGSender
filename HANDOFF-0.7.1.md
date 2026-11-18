# GGSender handoff: 0.7.1 (tool sensor reference, resume tool choices, plain language)

For the next Claude session. Read `CLAUDE.md` and `GGSENDER.md` first: they hold the rules (one
commit per change, `GGSender:` comments in upstream files, new logic in `gg/` folders, tests for
anything that touches G-code, a setting for new behaviour, `scripts/gg/typecheck.sh`, build and
pack recipe, traps). This file adds what is in progress and what the owner asked for.

Delete this file when 0.7.1 is delivered (or fold what is still true into `GGSENDER.md`).

## 1. State of the repository (Nov 2026)

| Branch | Content | State |
| --- | --- | --- |
| `gg/main` | up to 0.6.1 (PR #9 merged) | default branch |
| `gg/0.7.0` | 0.7.0, PR [#10](https://github.com/Gabrielgorithme/GGSender/pull/10) into `gg/main` | open, not merged; the owner has 0.7.0 installed and is testing it |
| `gg/0.7.1` | on top of `gg/0.7.0`: feed override minimum 10%, plain-language text (first pass), this file | all tests pass (537, 3 upstream skipped), 0 type errors in fork files; **not built, not packaged, no PR** |
| `gg/0.7.1-wip-probe` | on top of `gg/0.7.1`: unfinished server half of the probe history | **does not run** (see section 5) |

0.7.0 contents (see the 0.7.0 change log in `GGSENDER.md`): Resume From (replaces Start From),
hold the machine at the first job error, feed/spindle overrides back to 100% at each operation,
pre-flight homed state from the controller, progress as text, hold control layout fix,
`scripts/gg/e2e/` (built app against a fake FluidNC over TCP).

## 2. What the owner asked for, in their words, and what it means

### 2.1 The main problem: resume after a broken end mill

> "There is a major issue when resuming a job. The software gives me the option to either choose
> 'untouched since the job stopped' or 'change or measure it first'. Let's say the endmill was
> broken and I don't trust anything, I set my 0 manually again. Then if I choose the first option,
> the new end mill was never measured and subsequent tool changes will be wrong. If I choose the
> second option, it will treat my new tool as if it was not a correct 0, and give it a wrong
> offset. This is made worse by the text which is not very clear, instead of using ASD-STE100. A
> lot more attention needs to be given to making options clear and concise, and this case needs to
> be included. To make things clearer and avoid me doing the 0 manually in the first place, the
> probing history needs to be more explicit. My branch already is more transparent with tool
> changes, but more transparency and clarity would give the user confidence to trust and
> understand the probing process; the user needs to understand at a glance when a tool was last
> probed, what tool, and how trusting this value will act. The information added by this
> transparency needs to be balanced with clear and unambiguous language, even pictograms when
> needed."

What the owner did when it went wrong: 0.7.0 *Resume From*, chose the second option. The wizard
went straight to *Probe Changed Tool*: a tool change earlier in the same gSender session had left a
reference, so the resume skipped *Probe Initial Tool* and the new bit was measured against the old
reference with `G10 L20`, over the owner's manual zero. Their *First tool* setting
(`workspace.toolChange.firstToolBehaviour`) is **"Prompt for first tool"**. They did not run on to
the next tool change.

Requirements that follow:
1. Resume tool choices that each say plainly what happens to the tool and to the Z zero, including
   "I set Z zero again by hand with the tool in the spindle".
2. The tool sensor reference visible at a glance: which tool it came from, when it was probed,
   whether it can be trusted now, and what using it will do. A short probe history. Pictograms
   where they help. Language: ASD-STE100, short and unambiguous.
3. When a Z zero set by hand is detected after the last probe, gSender decides by default
   (measure the tool in the spindle first, as the new reference) **and shows why**, but the owner
   can overrule it (owner: "make a decision by default but let me overwrite it").
4. The reference is **not** kept across a reconnection or restart (owner chose "lose it on
   reconnect" over saving it).

### 2.2 Plain language (ASD-STE100)

> "A lot of the text in what you made is too verbose. Wherever there is more than a sentence, I
> want you to replace it with ASD-STE100."

Applies to user-facing text the fork added (settings descriptions, dialogs, notices, tooltips,
pre-flight and resume messages). A first pass is committed on `gg/0.7.1`
(commit "user-facing text in ASD-STE100 style"). Rules used: sentences up to 20 words for
instructions, 25 for descriptions; active voice; simple tenses; imperative for instructions; no
"-ing" forms except technical names; approved words where known ("make sure", "do not", "show",
"let", "about"); one topic per sentence; warnings start with the command
("WARNING: Stop the job. Do not resume it."). Not yet done: short status labels in
`features/gg/HoldSpindleControl.tsx` ("Spindle starting · resuming…"), and everything new from
section 4. `GGSENDER.md` (developer notes) was not rewritten; ask the owner if the machine
checklists in it should be.

### 2.3 Feed override to 0%

> "The minimum feed override is 20%. I want it to be 0%."

Not possible: FluidNC clamps the feed override at 10% (`FeedOverride::Min = 10` in its
`src/Config.h`, compiled in, not a config.yaml setting). Done on `gg/0.7.1`: the slider and its
-/+ buttons go down to 10% (setting *Feed override minimum*, 10 or 20 for upstream). The owner has
not yet been told plainly that 0% is impossible and that Pause (the 0.6.0 immediate hold) is the
equivalent; say it in the delivery message. A slider that holds the job at "0%" was not built
(possible idea, ask first).

### 2.4 The owner

Wants direct answers and pushes back when reasoning is wrong; check facts in code or by running
before claiming them (one claim of mine was wrong in context because of the *First tool* setting).
Machine motion is involved: say so when unsure whether a change can move the machine somewhere
unexpected. Accurate UI directions for the exact software. Wants to be made smarter: explain the
mechanism, briefly.

## 3. Facts established (with where to look)

- **The reference.** Fixed-sensor wizard: `src/app/src/wizards/automaticToolchange.tsx`.
  `probeInitialToolStep` (included only when `count === 1`) probes the tool in the spindle and runs
  `%global.toolchange.TOOL_OFFSET=posz` (work Z at the sensor). *Probe Changed Tool* probes the new
  tool and runs `G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]`, which rewrites the work Z zero so
  the new tool reads the same at the sensor. The value lives in `controller.sharedContext`
  (server, per connection; lost on reconnect). The work offset itself is stored in FluidNC and
  survives resets.
- **Which wizard runs.** `src/app/src/lib/toolChangeUtils.ts` `determineFixedSensorInstructions`:
  `count > 1` → full change without initial probe; `count === 1` → by *First tool* setting:
  full wizard (with *Probe Initial Tool*), **probe length only** (`wizards/probeToolLength.tsx`:
  measures the tool in the spindle as the reference and resumes, **no tool change step**), or a
  prompt choosing between the two. `count` comes from `Sender.incrementToolChanges()`; the count
  is reset at every job start (`Sender.rewind`).
- **0.7.0 resume and the count.** `src/server/lib/gg/resumeSplice.js` `ResumeSession.begin` sets
  `sender.state.toolChanges = 1` when the resume measures the tool and a reference exists, so the
  wizard skips *Probe Initial Tool*. That is the owner's bug path. Without that, a resumed job's
  first M6 has `count === 1` and follows the *First tool* setting.
- **Hazard found, verified in the built app** (e2e, fake controller): after a resume, with *First
  tool* = "Always probe length only" (or the prompt answered that way), the next M6 (a real change
  to another tool) only measures the tool in the spindle and resumes; it never asks to fit the new
  tool. Upstream assumes the first M6 of a job is the tool already loaded; a resumed job looks like
  a new job. Must be fixed with the redesign (never the first-tool logic for a resumed job).
- **Seeing a Z zero set by hand, pendant included.** FluidNC calls `gc_wco_changed()` on every
  work-offset change (G10, G92, WCS change, G43.1, probe offset) and puts `WCO:` in the next status
  report (otherwise every 10 reports idle, 30 busy). gSender polls status about 4 times a second,
  so a change is seen within about a second while connected. Not seen: changes while disconnected
  (covered: the reference is dropped on reconnect), and a re-zero to exactly the same value
  (nothing changed). gSender's status parser (`GrblLineParserResultStatus.js`) fills a missing
  `WCO` with 0,0,0, so read `WCO:` from the raw report text. The wizard's own G10 goes through
  gSender's feeder (raw line contains `[global.toolchange.TOOL_OFFSET]`), so it can be told apart.
  gSender's DRO *Zero* button and touch-plate probing also write G10 through the feeder: those are
  Z zeros "by hand" (correct to treat as such). WCO is machine minus work: the work Z of a fixed
  point changes by minus the WCO change.
- **Overruling the wizard choice.** Publishing `wizard:load` again (`features/Helper/HelperWrapper.tsx`)
  reloads the wizard at step 0. The wizard's `onStart` (safe Z, saved position) has already run and
  is the same for all variants, so switching is safe while no step action has run.
- **Resume entry lines.** See 0.7.0 notes. The splice keeps line indices (entry lines replace the
  lines just before the target); the program is restored on stop and before a normal start.

## 4. Design to build (proposed to the owner, accepted in principle)

### 4.1 Reference state (server, `src/server/lib/gg/probeHistory.js`, started)
- `valid`: a reference exists and the work offset did not change since, except by the wizard's
  own G10 for a new tool. `stale`: the work Z zero or the WCS changed after it. `none`: no
  reference since gSender connected.
- History (newest last, capped): `reference` (tool, value), `measured` (tool, how much Z moved),
  `zero` (set by hand, how much Z moved), `wcs` (from/to). Tool of each entry: the tool gSender
  records as loaded (client sends it: `gg:probe:loaded`), or the tool change target for `measured`.
- Event `gg:probe:state` (snapshot) on change and on socket attach; command `gg:probe:query`.

### 4.2 Tool change decision (client, new `lib/gg/toolChangeDecision.ts`; server passes context)
The server adds to the `gcode:toolChange` context: the reference snapshot, whether the job was
started by Resume From, and a one-shot resume tool mode for the first M6 of a resumed job.
Rules (Fixed Tool Sensor):

| Situation | Default wizard | Shown reason (STE) | Overrule offered |
| --- | --- | --- | --- |
| Resume choice ③ (re-zeroed with this tool) | probe length only: the tool in the spindle becomes the reference, Z zero does not change | "You set Z zero with this tool. gSender measures it as the new reference." | none |
| Resume choice ② | measure the new tool against the reference | reference tool and time | if the reference is no longer valid: full wizard instead, with the reason |
| Reference valid, not the first M6 of a job started from the top | measure the new tool against the reference (no initial probe) | "Reference: T45, probed 14:32. The new tool is measured against it." | "Measure the tool in the spindle first" |
| Reference stale | full wizard: measure the tool in the spindle first, then change | "You set Z zero at 14:40, after the last probe (T45, 14:32)." | "Use the old reference" |
| Reference none, resumed job | full wizard | "There is no reference." | none |
| First M6 of a job started from the top | upstream *First tool* setting | as upstream | as upstream |

Never use the first-tool logic (prompt / probe length only) for a resumed job. Remove the
`toolChanges = 1` trick from `ResumeSession.begin`. The banner sits in the tool change window
(next to the 0.5.0 tool card, `features/Helper/components/Instructions.tsx` already hosts
`WithToolDrawing`); the overrule button only before any step action has run.

### 4.3 Resume dialog choices (`features/gg/ResumeFromLine.tsx`, `lib/gg/resumePlan.ts`)
Replace the two radio buttons with three, each saying what happens to the tool and to Z:
1. **Same tool. Z zero did not change.** Nothing measured.
2. **New or refitted tool. Z zero did not change.** The tool is measured against the reference.
   Only when the reference is valid; otherwise disabled with the reason (stale: "You set Z zero at
   14:40. The old reference is not correct now."; none: "There is no reference. Set Z zero with the
   new tool, then use 3.").
3. **I set Z zero again with the tool in the spindle.** The tool is measured on the sensor and
   becomes the new reference. Z zero does not change.

Defaults: reference stale → 3. Recorded tool differs from the line's tool → 2 if valid, else no
default (Resume disabled until a choice is made). Otherwise 1. Show the reference state block
(pictogram, tool, time) in the dialog.

### 4.4 At a glance (`features/gg/LoadedToolIndicator.tsx`, the T45 chip in the top bar)
Add the reference state to the chip: ✅ valid, ⚠ stale, ⛔ none (react-icons: e.g. `MdCheckCircle`,
`MdWarning`, `MdBlock`; history: `MdStraighten` reference, `MdSwapVert` measured, `MdPanTool` zero
by hand). The popup shows the reference (tool, time, what using it does) and the history. STE text.

## 5. Work in progress on `gg/0.7.1-wip-probe`
- `src/server/lib/gg/probeHistory.js`: the tracker (4.1). Untested.
- Hooks in `GrblController.js`: status (`onStatus(res.raw)`, `checkReference` from
  `sharedContext`), parser state (`onWcs(res.modal.wcs)`: **unverified field**; the parser stores
  groups by name in `GrblLineParserResultParserState.js`, check the group name used for G54..G59),
  feeder filter (`onFeederLine`), `ggToolChangeTarget` in the M6 branch, snapshot on attach,
  commands `gg:probe:loaded` / `gg:probe:query`, and the toolChange context fields `ggReference`
  and `ggResume`.
- **Broken:** the context calls `this.ggResume.takeToolMode()`, not written yet: any M6 throws.
  Nothing client-side yet. No tests. Start from this branch or redo it on `gg/0.7.1`.

## 6. How to check
- `node_modules/.bin/jest --config jest.config.js`; `scripts/gg/typecheck.sh` (delete the
  `src/app/tsconfig.tsbuildinfo` it leaves before committing).
- Server stream behaviour: extend `src/server/controllers/Grbl/__tests__/gg-stream-sim.test.js`
  (real controller, simulated boards). Add a board that reports `WCO:` and simulate a pendant zero
  (WCO change without a feeder G10), a wizard G10, a WCS change.
- Built app end to end: `scripts/gg/e2e/` (see "End-to-end run of the built app" in
  `GGSENDER.md`). Extend `fake-fluidnc.js` to report `WCO:` and apply `G10 L20 P0 Z..` from any
  source, plus a way to change WCO "from the pendant" (for example a TCP side command). Use the
  *Fixed Tool Sensor* strategy and both *First tool* settings. `tc-*.png`-style screenshots of the
  wizard after a resume proved the probe-length-only hazard.
- The official 1.6.4 `app.asar` needed for packing is not in the repository: extract it as
  `GGSENDER.md` ("Package and install") says.

## 7. Delivering 0.7.1
Bump `src/app/src/gg-build.json` to 0.7.1, add the change-log entry and machine checklist to
`GGSENDER.md` (include: pendant zero after a probe makes the reference stale; resume choice 3 after
a broken bit; overrule in the wizard; resumed job with *First tool* = prompt / probe length only now
asks to fit the new tool), build, pack, send `app.asar` to the owner, push, open a PR into
`gg/main` stacked after #10 (mirror `.github/PULL_REQUEST_TEMPLATE/developer_template.md`). Say
plainly what was not checked: nothing runs on Windows or on the machine; the e2e uses a simulated
controller. First tests on the machine as air cuts.

## 8. Still open from before
- The soft-limit alarm at job start from machine Z0 (`GGSENDER.md`, "Open problem").
- Backlog in `GGSENDER.md` ("Still to do").
