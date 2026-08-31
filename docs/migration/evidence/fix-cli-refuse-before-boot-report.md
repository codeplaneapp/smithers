# Fix lane: cli-refuse-before-boot

Status: **done**. Branch `phase7/cli-refuse-before-boot`, one commit `a506d60231` on base
`f63809382b`. Worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/cli-refuse-before-boot`.
No lockfile changed. rc-contract section 4.1 needed no wording change: the sentence, the exit code,
and the `https://smithers.sh/migration/1.0#<verb>` anchor are byte-identical before and after.

## Item 1: a removed verb refuses before any layer is built

### The source line

`packages/cli/src/bin.ts` short-circuits documents and nothing else. Before this change `main`
read, in order:

```ts
const argv = process.argv.slice(2)
if (documentRequested(argv)) { ... }
const applicationConfig = yield* NodeControl.config
...
yield* Command.run(cli, { version: packageVersion }).pipe(
  Effect.provide(NodeControl.layer(applicationConfig))
)
```

Every removed verb is a hidden subcommand of `cli` (`packages/cli/src/Command.ts:1386`
`const removedCommands = Unsupported.removedVerbs`), so its refusal ran inside
`NodeControl.layer(applicationConfig)`.

### Reproduction

From an empty directory, with `HOME` and `SMITHERS_HOME` pointed at scratch:

```
$ cd <empty> && node packages/cli/src/bin.ts ui
smithers ui was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
exit=1
$ find .
.
./.flows
./.flows/engine.db
./.flows/control.db
```

### Tests

`packages/cli/test/Bin.test.ts`, new describe **"a removed verb refuses before the control plane
boots"**:

- `prints its sentence and leaves the working directory empty` — runs `smithers ui` from a fresh
  `mkdtemp` with `HOME` set to that directory, asserts exit 1, asserts `stderr.trim()` equals
  `Unsupported.message("ui", ui.reason, "ui")`, and asserts `readdirSync(cwd)` is `[]`.
- `leaves the working directory empty for a removed form of a surviving parent` — the same for
  `smithers gateway status`.
- `still boots the control plane for a surviving verb` — `smithers --json ls` exits 0, prints
  `{"_tag":"flows",...}`, and does create `.flows/control.db`, so the guard is scoped to the
  removal table.

`packages/cli/test/Unsupported.test.ts`, new describe **"the refusal `bin.ts` answers before the
control plane boots"**: for each of the 75 forms (67 bare verbs plus the 8 removed subcommands of
`gateway` and `workflow`), the message `Unsupported.refusal(args)` produces must equal the message
the real command tree produces for the same vector; plus the sub-verb carry, the surviving
invocations (`ls`, `gateway`, `gateway serve`, `workflow list`, `--version`, empty), and the
flag-bearing vectors the short-circuit declines to read.

### Red, against the pre-fix source

`Bin.test.ts` on `f63809382b` (`vitest run test/Bin.test.ts -t "refuses before the control plane boots"`,
load 3.66):

```
 FAIL  test/Bin.test.ts > a removed verb refuses before the control plane boots > prints its sentence and leaves the working directory empty
AssertionError: expected [ '.flows' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   ".flows",
+ ]

 ❯ test/Bin.test.ts:313:32
```

The `gateway status` case failed identically at `test/Bin.test.ts:326:32`.

`Unsupported.test.ts` with `src/bin.ts` and `src/Unsupported.ts` stashed back to the base
(78 of 78 parametrised cases red):

```
 FAIL  test/Unsupported.test.ts > the refusal `bin.ts` answers before the control plane boots > `smithers replay` gets the same sentence before boot as the command tree gives after it
TypeError: refusal is not a function
 ❯ test/Unsupported.test.ts:88:33
```

### Fix

- `packages/cli/src/Unsupported.ts`: new `refusal(args): CliError.UnsupportedError | undefined`,
  plus the private `survivingParents` set. It fires only for `smithers <verb> [<positional>...]`;
  any argument starting with `-` anywhere in the vector returns `undefined` and the invocation
  takes the ordinary path, because a flag can take a value and a value can be spelled like a verb.
  `gateway` refuses only `status` and `stop`; `workflow` refuses every form but `list`, bare
  `workflow` included, which is exactly what `Command.ts` does with `config.rest[0]`.
- `packages/cli/src/bin.ts`: between the `documentRequested` short-circuit and
  `yield* NodeControl.config`,

  ```ts
  const refused = Unsupported.refusal(argv)
  if (refused !== undefined) return yield* Effect.fail(refused)
  ```

  Failing with the same `UnsupportedError` reuses the existing `teardown` path, so `report` writes
  the same sentence to stderr and `CliError.exitCode` still returns 1.
- `packages/cli/README.md`: `refusal` added to the `Unsupported` row of the public-export table,
  which `test/Readme.test.ts` enforces.

### Green

`vitest run test/Bin.test.ts -t "refuses before the control plane boots"`: `Tests 3 passed | 53 skipped (56)`.

Ten forms driven by hand from one empty directory, all exit 1 with their documented sentence and
leave the directory empty (`find .` returns `.` alone): `ui`, `gateway status`, `gateway stop`,
`workflow run`, `workflow path ship.tsx`, `worktrees prune`, `rewind run-1`, `workflows`,
`docs-full`, `agents add`. `gateway --help` still renders serve's document and
`--json workflow list` still prints `{"_tag":"flows","items":[]}`.

Cold start for one refusal fell from 7.1 s wall (the third-run measurement) to 0.89 s.

## Item 2: `scripts/docs-removals.test.mjs` stays as it is

No change was needed and none was made. The 15,000 ms bound in `scripts/docs-help.mjs` `runCli`
is untouched, the `did not exit` reporting is intact, and both spawning tests still cover all 75
forms.

Per-spawn timings, 8-wide from `repoRoot`, the same data and concurrency the test uses:

| Run | `uptime` load | spawns | min | median | max | over 15,000 ms | did not exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline, third gate run at `cd14388ed7` | 9 to 60 | 75 | 7,262 ms | 7,486 ms | 9,810 ms | 0 (at a 120 s bound) | 8 at load 13, 7 DB errors at load 9 |
| after the fix | 5.38 | 75 | 1,223 ms | 1,624 ms | 1,884 ms | 0 | 0 |
| after the fix, under the `packages/cli` suite | 13.44 | 75 | 955 ms | 1,267 ms | 1,357 ms | 0 | 0 |

The worst spawn is 1.9 s against a 15 s bound, so the bound keeps about eight times the headroom
it needs.

`pnpm exec smithers-build test '//scripts:docsUnit'`, three runs, the second and third with the
full `packages/cli` vitest suite running beside them:

| Run | `uptime` load before | Result | Wall |
| --- | --- | --- | --- |
| 1 | 4.61 | `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped` | 28.3 s |
| 2 (`--no-cache`, under load) | 8.47 | `0 failed` | 34.3 s |
| 3 (`--no-cache`, under load) | 12.82 | `0 failed` | 32.0 s |

For comparison the same target was red in three of three runs at `cd14388ed7` and took 79 s when
it passed at load 3.

## Item 3: gates

| Gate | Load | Result |
| --- | --- | --- |
| `packages/cli` `pnpm run check` (`tsc -b` + `tsc -p tsconfig.test.json --noEmit`) | 4.92 | pass |
| `packages/cli` `pnpm run lint` (`eslint src --max-warnings=0 && dprint check`) | 4.92 | pass |
| `packages/cli` `pnpm run circular` | 11.6 | pass |
| `packages/cli` `vitest run` | 5.60 | `Test Files 36 passed (36)`, `Tests 707 passed (707)` |
| `packages/cli` `vitest run --coverage` | 4.92 | statements 81.77% (>= 78), branches 78.74% (>= 76), functions 76.57% (>= 72), lines 82.10% (>= 79) |
| `smithers-build test '//scripts:docsUnit'` x3 | 4.61 / 8.47 / 12.82 | pass, pass, pass |
| `smithers-build test '//scripts/...'` | 5.60 | 20 ran, 1 failed, 1 skipped — see below |
| `node scripts/check-docs.mjs` | 11.56 | pass, all 16 checks including "the CLI catalog matches 26 commands from --help" and "all 74 anchors the removal messages link to have a heading in the migration guide" |
| `node scripts/check-llms.mjs` | 11.56 | `✓ 12 documentation artifact(s) are current` |

`Unsupported.ts` coverage rose from 69.64% statements / 27.58% branches to 98.21% / 96.55%.

The one failing script target is `//scripts:releasePack`, and it is unrelated to this lane and
pre-existing in any unbuilt worktree:

```
Error: ENOENT: no such file or directory, access '<worktree>/packages/canonical/dist/cjs/Canonical.js'
    at async assertBuilt (scripts/pack-release.mjs:240:5)
```

It asserts every package is built; this worktree has no `dist/`. `//scripts:releaseSmoke` skips
because it depends on it. Neither touches `packages/cli/src`.

## Files changed

- `packages/cli/src/bin.ts` — the pre-boot short-circuit.
- `packages/cli/src/Unsupported.ts` — `refusal` and `survivingParents`.
- `packages/cli/README.md` — the public-export table row.
- `packages/cli/test/Bin.test.ts` — the three real-process cases.
- `packages/cli/test/Unsupported.test.ts` — the 75-form agreement cases and the parsing rules.

`scripts/docs-removals.test.mjs`, `scripts/docs-help.mjs`, and
`docs/migration/rc-contract.md` are unchanged.
