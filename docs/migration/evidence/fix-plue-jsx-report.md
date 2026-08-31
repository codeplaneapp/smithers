# Phase 7 fix lane: plue-jsx

Round 1. Date 2026-08-30. Branch `smithers-rc0-cutover` in the worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/plue-cutover`.
Base `df7bb2017`, fix commit `93abe834f`. Status: done. No lockfile changed.

Environment: bun 1.4.0-canary.1 (6618e7f7e), pnpm 10.6.5 via corepack, go1.26.0
darwin/arm64. Setup ran exactly as specified: `git status --short | wc -l` = 0,
`corepack pnpm install --frozen-lockfile` exit 0, `bun install --frozen-lockfile`
in `cmd/runner/workflow` → `Checked 36 installs across 62 packages (no changes)`.
Machine load before every suite is recorded with each gate line; it never rose
above 19, so no run used `--maxWorkers=4`.

## Item 1: Path D cannot resolve a JSX runtime

### Confirmation at the source

Three lines carry the defect, each read in the lane tree at `df7bb2017`.

`cmd/runner/workflow/execute-step.ts:171` spawns the step runner with the
checked-out repository as cwd and no compiler options:

```ts
    return Bun.spawn(["bun", "run", TSX_TASK_RUNTIME, tsxTaskID], {
      cwd: repoPath,
```

`cmd/runner/workflow/tsx-task-runtime.ts` writes the SDK shim with one export:

```ts
        exports: {
          ".": "./index.js",
        },
```

`packages/workflow/package.json` was `{name, version, type, main, types}` with no
`exports` map and no `jsx-runtime` module, and `packages/workflow/tsconfig.json`
set no `jsx` or `jsxImportSource`. The root manifest pins no `react`
(`package.json:20` records the removal in prose), and the repository has no root
`tsconfig.json`.

### Reproduction

Reproduced outside the suite before touching anything, in a scratch repository at
`$SCRATCH/jsxprobe/repo` holding one `.smithers/workflows/ci.tsx` and a
hand-written `node_modules/@smithers-ai/workflow` with only a `"."` export:

```
error: Cannot find module 'react/jsx-dev-runtime' from '<scratch>/repo/.smithers/workflows/ci.tsx'
```

The same probe answered the design question the spec asked, which of the three
candidate places Bun honors:

| Probe | tsconfig placement | cwd | Result |
| --- | --- | --- | --- |
| A | none | repo root | `Cannot find module 'react/jsx-dev-runtime'` |
| B | `.smithers/workflows/tsconfig.json`, beside the file | repo root | same failure |
| C | repo root | repo root | loads |
| D | repo root | elsewhere | same failure |
| E | repo root | `repo/.smithers` | same failure |
| F | loader's own directory | loader's directory | loads |
| H | none, `bun run --jsx-import-source=@smithers-ai/workflow` | repo root | loads |
| I | repo root sets `jsxImportSource: "react"`, flag set | repo root | `Cannot find module 'react/jsx-runtime'` |
| K/L/M | repo root sets no `jsxImportSource` (absent, `jsx: react-jsx`, `jsx: preserve`), flag set | repo root | loads |

Bun reads compiler options from `$cwd/tsconfig.json` and nowhere else: no walk-up
from the file (B), no walk-up from cwd (E), no honoring of the entry point's
directory (D). The runner's spawn sets cwd to the checked-out repository, so no
tsconfig on that path belongs to the runner. `--jsx-import-source` is therefore
the only knob the runner controls (H), and only an explicit `jsxImportSource` in
the consumer's own root tsconfig outranks it (I versus K/L/M), which is the right
precedence for an explicit declaration. Probe J confirmed the production entry
point is also needed: with `NODE_ENV=production` Bun imports `/jsx-runtime`, not
`/jsx-dev-runtime`.

### Tests and their red runs

Four behavior tests, all run against the pre-fix source.

**1. `execute-step end-to-end > executes a JSX workflow document in a repo with no react on the resolution path`**
(new, `cmd/runner/workflow/execute-step.e2e.test.ts:373`). A temp repository
outside the project tree, so no walk-up to a parent `node_modules` can mask a
missing entry point. Red against the pre-fix source:

```
456 |       expect(stderr).toBe("");
                           ^
error: expect(received).toBe(expected)

- ""
+ "ResolveMessage: Cannot find module 'react/jsx-dev-runtime' from '/private/var/folders/4s/d0wlfs9d00v4349cdqgd13f00000gn/T/smithers-execute-step-MZim02/.smithers/workflows/ci.tsx'
+ [execute-step] Step "tsx" failed with exit code 1
+ "
```

**2. `ensureWorkflowSDKAvailable > exports the JSX runtime entry points Bun's automatic runtime imports`**
(new, `cmd/runner/workflow/tsx-task-runtime.test.ts:139`). Red:

```
148 |     expect(manifest.exports["./jsx-runtime"]).toBe("./jsx-runtime.js");
                                                    ^
error: expect(received).toBe(expected)

Expected: "./jsx-runtime.js"
Received: undefined
```

**3. `ensureWorkflowSDKAvailable > reinstalls a shim that predates the JSX runtime entry points`**
(new, same file). Pins the upgrade path: the old shim carries the same version
string and the same ready marker, so the readiness check has to look at the files.
Red:

```
195 |     expect(fs.existsSync(join(packagePath, "jsx-dev-runtime.js"))).toBe(true);
                                                                         ^
error: expect(received).toBe(expected)

Expected: true
Received: false
```

The sibling case `ensureWorkflowSDKAvailable > builds the same nodes through JSX
as through the shim's constructors` was red in the same run with
`error: Cannot find module '<tmp>/node_modules/@smithers-ai/workflow/jsx-dev-runtime.js'`.

**4. `packages/workflow JSX runtime` (7 cases, new `packages/workflow/src/jsx-runtime.test.ts`).**
Red with the two new source files moved aside:

```
error: Cannot find module './jsx-runtime' from '<lane>/packages/workflow/src/jsx-runtime.test.ts'
 0 pass
 1 fail
```

**5. The two cases the gate named**, unchanged, red at the branch tip before the
fix (`bun test execute-step.e2e.test.ts` → `9 pass, 2 fail`):

```
459 |       expect(exitCode).toBe(0);
                             ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1
(fail) execute-step end-to-end > installs repo dependencies before the workflow SDK shim [189.52ms]
```

```
814 |         expect(exitCode).toBe(0);
                               ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1
(fail) execute-step end-to-end > uploads and downloads artifacts from a checked-out workflow import without buffering the download [48.00ms]
```

### Fix

Ruling R-19 says Plue keeps the TSX DSL under its own name, react-free. Four
locations, commit `93abe834f`.

| Location | Change |
| --- | --- |
| `packages/workflow/src/jsx-runtime.ts` (new) | `jsx`, `jsxs`, `Fragment`, and the `JSX` namespace. `jsx(type, props, key)` calls a component type, so `<Task id="build">` and `Task({ id: "build" })` return the identical `{ type, props }` node; anything else is wrapped, which covers `Fragment`. A JSX `key` is folded back into `props`, where `TaskProps` declares it. No import outside the package, pinned by a test. |
| `packages/workflow/src/jsx-dev-runtime.ts` (new) | `jsxDEV` over the same `jsx`, re-exporting `Fragment`. Bun picks this entry point unless `NODE_ENV` is `production`. |
| `packages/workflow/package.json` | Adds the `exports` map: `"."`, `"./jsx-runtime"`, `"./jsx-dev-runtime"`. Still no dependencies. |
| `cmd/runner/workflow/tsx-task-runtime.ts` | Two new shim source strings written next to `index.js`, both entry points added to the shim manifest's `exports`, and `isWorkflowSDKReady` now requires `jsx-runtime.js` and `jsx-dev-runtime.js` on disk so a shim written before they existed is replaced rather than reused. |
| `cmd/runner/workflow/execute-step.ts:171` | The spawn passes `--jsx-import-source=@smithers-ai/workflow`, with the probe result recorded in a comment. |
| `packages/workflow/tsconfig.json` | `jsx: "react-jsx"`, `jsxImportSource: "@smithers-ai/workflow"`. |
| `packages/workflow/src/jsx-syntax.compile-fixture.tsx` (new) | The CI DSL written as JSX. Nothing imports it at runtime; it fails the package typecheck if a change to the `JSX` namespace would stop a workflow document from compiling. |
| `docs/migration/smithers-rc0-pack-dispositions.md` | New section "How a kept TSX workflow compiles" with the table above, the `components.tsx` row updated, and the `git ls-files '*.tsx'` sentence corrected for the added fixture. |

### Green

`bun test` in `cmd/runner/workflow`: `227 pass, 0 fail, 565 expect() calls, Ran
227 tests across 13 files`, **exit code 0**. Both named cases pass by name:
`bun test -t "installs repo dependencies before the workflow SDK shim"` → `1 pass`;
`bun test -t "uploads and downloads artifacts from a checked-out workflow import
without buffering the download"` → `1 pass`. No remaining failure, so no
base-reproduction proof at `664c95c60` is owed.

Beyond the suite: all eight surviving Tier 0 workflows load through the runner's
real shape. The `.smithers` tree was copied to a scratch repository, the shim
installed with `ensureWorkflowSDKAvailable`, and each file imported under
`bun run --jsx-import-source=@smithers-ai/workflow` — `build`, `canary`, `ci`,
`deploy`, `release`, `remediate`, `terraform`, `update-homebrew` all loaded, exit 0.

## Gates

| Gate | Load before | Result |
| --- | --- | --- |
| `bun test` in `cmd/runner/workflow` | 3.43 | `227 pass, 0 fail`, exit 0 |
| `bun test execute-step.e2e.test.ts` | 8.19 | `12 pass, 0 fail, 92 expect() calls` |
| `bun test tsx-task-runtime.test.ts` | 8.19 | `14 pass, 0 fail` |
| `bun test packages/workflow` | 5.84 | `16 pass, 0 fail, 52 expect() calls` |
| `npx tsc --noEmit -p packages/workflow/tsconfig.json` | 5.84 | Only the pre-existing `bun:test` TS2307 on the two test files; the compile fixture and both runtimes are clean |
| `npx tsc --noEmit -p tsconfig.json` in `cmd/runner/workflow` | 7.50 | exit 0 |
| `go build ./...` | 7.50 | exit 0 |
| `bun test scripts/` | 7.50 | `294 pass, 0 fail, Ran 294 tests across 40 files` |
| `bun test scripts/workflow-renderer.test.ts` (the static parser) | 7.50 | `10 pass, 0 fail` |
| `bun test ./.smithers/workflows/canary-runner.test.ts` | 7.50 | `31 pass, 0 fail` |
| `bun run scripts/check-naming.ts` | 4.11 | exit 0 |
| `corepack pnpm install --frozen-lockfile` | 4.11 | `Done in 479ms using pnpm v10.6.5` |
| `bun install --frozen-lockfile` in `cmd/runner/workflow` | 4.11 | `Checked 36 installs across 62 packages (no changes)` |
| Item 11, all fifteen scans, `git grep -F -l -- "<pat>" -- ':!*.md' ':!*.mdx'` | 4.11 | CLEAN, all fifteen |
| `git grep -n react -- package.json cmd/runner/workflow/package.json packages/workflow/package.json` | 4.11 | One hit: `package.json:20`, the `comments.overrides` prose recording the pin's removal. No dependency. |
| `git status --short` after the commit | — | empty; `pnpm-lock.yaml` and both `bun.lock` files unchanged |

The fifteen scans, each returning nothing: `smithers-orchestrator`,
`@smithers-orchestrator/`, `from "smthrs"`, `from "smithers"`, `from "smithers/`,
`"smithers": "file:`, `@smthrs/errors/SmithersError`,
`jsxImportSource: "smithers-orchestrator"`, `mdxPlugin(`, `createSmithers(`,
`openSmithersBackend`, `stream.ndjson`, `/v1/rpc`, `/v1/api/stream`,
`connect.challenge`.

Consumer-contract item 12 also stays true: `packages/workflow/package.json`
declares no dependency and no smithers `jsxImportSource`. The option added is
`@smithers-ai/workflow`, Plue's own package, and it lives in the package's
tsconfig and in the runner's spawn, not in the manifest.

## Not in scope, recorded

A consumer repository that sets `jsxImportSource` in its own root
`tsconfig.json` overrides the runner's flag (probe I). That is correct precedence
for an explicit declaration, and Plue's own tree has no root `tsconfig.json`, so
no Tier 0 workflow is affected. If a hosted repository ever needs to override it,
the fix is a `/** @jsxImportSource @smithers-ai/workflow */` pragma in the
workflow file, which outranks both.
