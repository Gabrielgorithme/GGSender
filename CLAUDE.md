# GGSender

Personal fork of gSender (Sienci Labs, GPLv3), based on official **v1.6.4**, for one FluidNC
CNC machine with a fixed tool length sensor. FluidNC connects to gSender as **Grbl**, so server
changes go in `src/server/controllers/Grbl/`, not `Grblhal/`.

**Read `GGSENDER.md` before changing anything.** It has the build and packaging recipe, the traps
already hit, the change log, the machine checklists, the backlog and an open problem.

## Branches

- `gg/main` is the current state of the fork and the default branch.
- For a change, branch from an up-to-date `gg/main` (`gg/<version>`), open a pull request into
  `gg/main`.
- One session at a time. Before starting, check that no other branch has unmerged work you would
  be building beside instead of on.

## Commands

```bash
bun install --ignore-scripts                          # dependencies (403 on browser-serialport is expected, harmless)
node_modules/.bin/jest --config jest.config.js        # all tests
scripts/gg/typecheck.sh                               # fork files must have 0 type errors (NOT node_modules/.bin/tsc)
scripts/gg/build.sh                                   # build into dist/gsender
node scripts/gg/pack-asar.mjs --stock <official 1.6.4 app.asar> --out app.asar
```

The official `app.asar` comes from `gSender-1.6.4-x64.exe` on Sienci's GitHub release page; how
to extract it is in `GGSENDER.md` ("Package and install").

## Rules

1. Every edit to an upstream file carries a comment starting `GGSender:`.
2. New logic goes in new files under `src/app/src/lib/gg/`, `src/app/src/features/gg/` or
   `src/server/lib/gg/`; edits to upstream files stay a few lines that call it.
3. Anything that generates, filters or interprets G-code gets unit tests. The machine cannot be
   reached from a development session; tests are the only check before the owner runs it.
   Server-side stream behaviour: extend `src/server/controllers/Grbl/__tests__/gg-stream-sim.test.js`
   (real controller, simulated board).
4. New behaviour gets a setting; upstream behaviour stays reachable. To change a default for
   existing installs, add a step to `src/app/src/lib/gg/migrations.ts` (saved settings win over
   defaults).
5. Each build: bump `src/app/src/gg-build.json`, add a change-log entry and a machine checklist to
   `GGSENDER.md`, one commit per change.
6. Deliver the packaged `app.asar` to the owner. Say plainly what was not checked: nothing here is
   run on Windows or on the machine.

## The owner

Wants direct answers and pushes back when reasoning is wrong. Accurate UI directions for the exact
software matter. Machine motion is involved: when unsure whether a change can move the machine
somewhere unexpected, say so rather than guess.
