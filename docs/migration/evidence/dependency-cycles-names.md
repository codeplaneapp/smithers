# Gate: dependency-cycles-names

Verdict: **PASS**

PLAN.md Phase 7 requires "dependency-cycle and duplicate-package-name checks" to pass from a clean checkout. Both pass. The repository's cycle check (`corepack pnpm run circular`, madge 8.0.0 per package as rc-contract section 9 names it) exits 0 across all 51 packages that declare it and reports 0 cycles. The workspace holds 64 projects with 64 distinct names and 0 duplicates; pnpm's own project listing agrees.

## Checkout and environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| Branch and HEAD | `v1/rc0-migration` at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (identical to `/Users/williamcory/smithers` HEAD and its `v1/rc0-migration` ref at validation time) |
| Working tree | `git status --short` empty |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` |
| Host | macOS Darwin 25.2.0, arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | 11.21.0 via corepack (`packageManager: pnpm@11.21.0`) |
| madge | 8.0.0 (resolved from each package, for example `packages/engine/node_modules/madge`) |
| Date | 2026-08-31 |

## 1. Frozen install

Command, run from the checkout root:

```sh
corepack pnpm install --frozen-lockfile --offline
```

Output and exit code:

```
Scope: all 64 workspace projects
Already up to date
Done in 1.8s using pnpm v11.21.0
install exit=0
```

The install printed no cyclic-workspace warning (`grep -ic cyclic` over the full output returned 0).

## 2. Dependency-cycle check

Root script (`package.json:30`): `"circular": "pnpm --recursive --if-present run circular"`. Each of the 51 packages that declares the script runs `node scripts/circular.mjs`, which calls madge on `src` with `fileExtensions: ["ts"]`, the package `tsconfig.json`, and `skipTypeImports: true`, then exits 1 if `result.circular()` is non-empty.

Command, run from the checkout root:

```sh
corepack pnpm run circular
```

Result:

| Measure | Value |
| --- | --- |
| Exit code | 0 |
| Scope line | `Scope: 63 of 64 workspace projects` (root excluded by `--recursive`) |
| Packages that ran `circular` | 51 (`circular: Done` lines) |
| Packages that failed | 0 (`circular: Failed` lines) |
| `Circular dependencies found` messages | 0 |
| Warnings or other stderr lines | none |

The same 51 checks exist as build-graph targets: `pnpm exec smithers-build query '//packages/...'` lists 51 `//packages/<name>:circular` targets of type `NodeTest`, and the required CI `test` job runs them through `pnpm exec smithers-build ci '//packages/...' --jobs 2` (`.github/workflows/ci.yml:35`).

Packages under the workspace globs without a `circular` script: `packages/ui`, `packages/ui-styleguide`, `packages/build/infra` (private; the two UI kits carry 0.x tooling per phase2-baseline.md section on `vitestCoverageIsolation`). `apps/*`, `e2e`, and `examples` declare none either. Section 5 covers them for information.

Full output of `corepack pnpm run circular`:

```
### corepack pnpm run circular
$ pnpm --recursive --if-present run circular
Scope: 63 of 64 workspace projects
packages/canonical circular$ node scripts/circular.mjs
packages/capability circular$ node scripts/circular.mjs
packages/crypto circular$ node scripts/circular.mjs
packages/database circular$ node scripts/circular.mjs
packages/crypto circular: Done
packages/errors circular$ node scripts/circular.mjs
packages/canonical circular: Done
packages/smthrs-deprecation circular$ node scripts/circular.mjs
packages/capability circular: Done
packages/database circular: Done
packages/smthrs-deprecation circular: Done
packages/errors circular: Done
packages/jj circular$ node scripts/circular.mjs
packages/journal circular$ node scripts/circular.mjs
packages/artifacts circular$ node scripts/circular.mjs
packages/core circular$ node scripts/circular.mjs
packages/jj circular: Done
packages/keys circular$ node scripts/circular.mjs
packages/artifacts circular: Done
packages/step-cache circular$ node scripts/circular.mjs
packages/core circular: Done
packages/journal circular: Done
packages/keys circular: Done
packages/step-cache circular: Done
packages/observability circular$ node scripts/circular.mjs
packages/run-store circular$ node scripts/circular.mjs
packages/plan circular$ node scripts/circular.mjs
packages/notifications circular$ node scripts/circular.mjs
packages/notifications circular: Done
packages/scorers circular$ node scripts/circular.mjs
packages/observability circular: Done
packages/sync circular$ node scripts/circular.mjs
packages/run-store circular: Done
packages/plan circular: Done
packages/scorers circular: Done
packages/sync circular: Done
packages/flow circular$ node scripts/circular.mjs
packages/flow circular: Done
packages/build circular$ node scripts/circular.mjs
packages/engine circular$ node scripts/circular.mjs
packages/patterns circular$ node scripts/circular.mjs
packages/plugin circular$ node scripts/circular.mjs
packages/plugin circular: Done
packages/build circular: Done
packages/engine circular: Done
packages/patterns circular: Done
packages/targets circular$ node scripts/circular.mjs
packages/targets circular: Done
packages/kernel circular$ node scripts/circular.mjs
packages/platform-browser circular$ node scripts/circular.mjs
packages/platform-browser circular: Done
packages/kernel circular: Done
packages/model circular$ node scripts/circular.mjs
packages/platform-node circular$ node scripts/circular.mjs
packages/sandbox circular$ node scripts/circular.mjs
packages/platform-node circular: Done
packages/sandbox circular: Done
packages/model circular: Done
packages/memory circular$ node scripts/circular.mjs
packages/platform-bun circular$ node scripts/circular.mjs
packages/engine-store circular$ node scripts/circular.mjs
packages/platform-bun circular: Done
packages/memory circular: Done
packages/engine-store circular: Done
packages/time-travel circular$ node scripts/circular.mjs
packages/time-travel circular: Done
packages/flows circular$ node scripts/circular.mjs
packages/flows circular: Done
packages/registry circular$ node scripts/circular.mjs
packages/registry circular: Done
packages/fs circular$ node scripts/circular.mjs
packages/control circular$ node scripts/circular.mjs
packages/harness circular$ node scripts/circular.mjs
packages/fs circular: Done
packages/control circular: Done
packages/harness circular: Done
packages/integrations circular$ node scripts/circular.mjs
packages/gateway circular$ node scripts/circular.mjs
packages/mcp circular$ node scripts/circular.mjs
packages/std circular$ node scripts/circular.mjs
packages/mcp circular: Done
packages/testing circular$ node scripts/circular.mjs
packages/gateway circular: Done
packages/triggers circular$ node scripts/circular.mjs
packages/integrations circular: Done
packages/std circular: Done
packages/triggers circular: Done
packages/testing circular: Done
packages/agent circular$ node scripts/circular.mjs
packages/chain circular$ node scripts/circular.mjs
packages/evals circular$ node scripts/circular.mjs
packages/evals circular: Done
packages/chain circular: Done
packages/agent circular: Done
packages/migrate circular$ node scripts/circular.mjs
packages/create-app circular$ node scripts/circular.mjs
packages/create-app circular: Done
packages/migrate circular: Done
packages/build-cli circular$ node scripts/circular.mjs
packages/cli circular$ node scripts/circular.mjs
packages/cli circular: Done
packages/build-cli circular: Done
circular exit=0
```

## 3. Package-name uniqueness

Method: enumerate every `package.json` under the `pnpm-workspace.yaml` globs (`packages/*`, `packages/build/infra`, `e2e`, `examples`, `apps/*`) plus the root manifest, read `name`, and count duplicates. Cross-check with `corepack pnpm -r ls --depth -1 --json`.

| Measure | Value |
| --- | --- |
| Workspace projects (manifests under the globs + root) | 64 |
| `corepack pnpm -r ls --depth -1 --json` projects | 64 |
| Distinct names | 64 |
| Duplicate names | 0 |
| pnpm-reported duplicate names | `[]` |
| Manifests without a `name` | 0 |
| Non-workspace `package.json` files (fixtures, templates; outside `node_modules`, `dist`, `vendor`, `legacy`) | 17 |
| Non-workspace manifests whose name equals a workspace name | 0 |
| `legacy/` present | no |

Duplicates list: none.

Name table (name, version, visibility, directory):

```
  smithers	0.0.0	private	.
  @smthrs/bug-worker	0.0.1	private	apps/bug-worker
  @smthrs/review	1.0.0-rc.0	private	apps/review
  smithers-server	1.0.0	private	apps/server
  smithers-shared	0.0.0	private	apps/shared
  @smthrs/status-site	0.0.1	private	apps/status-site
  smithers-tui	0.0.0	private	apps/tui
  smithers-ui	1.0.0	private	apps/ui
  @smthrs/e2e	0.0.0	private	e2e
  @smthrs/examples	0.0.0	private	examples
  @smthrs/agent	1.0.0-rc.0	public	packages/agent
  @smthrs/artifacts	1.0.0-rc.0	public	packages/artifacts
  @smthrs/build	0.1.0	private	packages/build
  @smthrs/build-cli	0.1.0	private	packages/build-cli
  @smthrs/build-infra	undefined	private	packages/build/infra
  @smthrs/canonical	1.0.0-rc.0	public	packages/canonical
  @smthrs/capability	1.0.0-rc.0	public	packages/capability
  @smthrs/chain	0.1.0	private	packages/chain
  @smthrs/cli	1.0.0-rc.0	public	packages/cli
  @smthrs/control	1.0.0-rc.0	public	packages/control
  @smthrs/core	1.0.0-rc.0	public	packages/core
  @smthrs/create-app	0.1.0	private	packages/create-app
  @smthrs/crypto	1.0.0-rc.0	public	packages/crypto
  @smthrs/database	1.0.0-rc.0	public	packages/database
  @smthrs/engine	1.0.0-rc.0	public	packages/engine
  @smthrs/engine-store	1.0.0-rc.0	public	packages/engine-store
  @smthrs/errors	1.0.0-rc.0	private	packages/errors
  @smthrs/evals	1.0.0-rc.0	private	packages/evals
  @smthrs/flow	1.0.0-rc.0	public	packages/flow
  @smthrs/flows	1.0.0-rc.0	public	packages/flows
  @smthrs/fs	0.1.0	private	packages/fs
  @smthrs/gateway	1.0.0-rc.0	public	packages/gateway
  @smthrs/harness	1.0.0-rc.0	public	packages/harness
  @smthrs/integrations	1.0.0-rc.0	private	packages/integrations
  @smthrs/jj	1.0.0-rc.0	public	packages/jj
  @smthrs/journal	1.0.0-rc.0	public	packages/journal
  @smthrs/kernel	1.0.0-rc.0	public	packages/kernel
  @smthrs/keys	1.0.0-rc.0	public	packages/keys
  @smthrs/mcp	1.0.0-rc.0	public	packages/mcp
  @smthrs/memory	1.0.0-rc.0	public	packages/memory
  @smthrs/migrate	1.0.0-rc.0	public	packages/migrate
  @smthrs/model	1.0.0-rc.0	public	packages/model
  @smthrs/notifications	1.0.0-rc.0	public	packages/notifications
  @smthrs/observability	1.0.0-rc.0	public	packages/observability
  @smthrs/patterns	1.0.0-rc.0	public	packages/patterns
  @smthrs/plan	1.0.0-rc.0	public	packages/plan
  @smthrs/platform-browser	1.0.0-rc.0	public	packages/platform-browser
  @smthrs/platform-bun	1.0.0-rc.0	public	packages/platform-bun
  @smthrs/platform-node	1.0.0-rc.0	public	packages/platform-node
  @smthrs/plugin	1.0.0-rc.0	public	packages/plugin
  @smthrs/registry	1.0.0-rc.0	public	packages/registry
  @smthrs/run-store	1.0.0-rc.0	public	packages/run-store
  @smthrs/sandbox	1.0.0-rc.0	public	packages/sandbox
  @smthrs/scorers	0.1.0	private	packages/scorers
  smthrs	1.0.0-rc.0	public	packages/smthrs-deprecation
  @smthrs/std	1.0.0-rc.0	public	packages/std
  @smthrs/step-cache	1.0.0-rc.0	public	packages/step-cache
  @smthrs/sync	1.0.0-rc.0	public	packages/sync
  @smthrs/targets	0.1.0	private	packages/targets
  @smthrs/testing	1.0.0-rc.0	public	packages/testing
  @smthrs/time-travel	1.0.0-rc.0	public	packages/time-travel
  @smthrs/triggers	0.1.0	private	packages/triggers
  @smthrs/ui	1.0.0-rc.0	private	packages/ui
  @smthrs/ui-styleguide	1.0.0-rc.0	private	packages/ui-styleguide
```

Scanner: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/names-and-cycles.mjs` (run as `node names-and-cycles.mjs <checkout>` from the checkout root; exit 0). Its full output is in section 6.

## 4. Workspace-graph cycle scan

The scanner also builds the package-level graph from `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` edges that point at workspace names (64 nodes, 349 internal edges) and runs Tarjan's algorithm.

Result: one strongly connected component with a cycle, `@smthrs/platform-browser -> @smthrs/kernel -> @smthrs/platform-browser`. Both edges are runtime `dependencies` at `1.0.0-rc.0`.

This cycle is intentional, documented, and imported unchanged from the flows reference:

- `packages/kernel/src/test/TestHost.ts:16-17` imports `@smthrs/platform-browser/BrowserChildProcessSpawner` and `@smthrs/platform-browser/BrowserFileSystem`; `@smthrs/kernel` publishes `./test/contract` (rc-contract section 3.5, line 162), so the manifest edge is a runtime dependency. No other `packages/kernel/src` module imports the platform bundle. `packages/platform-browser/src/{BrowserHost.ts,BrowserChildProcessSpawner/make.ts,BrowserFileSystem/layer.ts}` import `@smthrs/kernel`.
- `docs/pages/architecture/package-map.md:9` documents it: "The one dotted edge is a test-only seam: `@smthrs/kernel`'s `test/TestHost` composes `@smthrs/platform-browser`'s in-tab `FileSystem` and `ChildProcessSpawner` ... No production module in `@smthrs/kernel` imports a platform bundle."
- `docs/migration/disposition-ledger.md:592` and `:626` record it ("documented cycle kernel/test/TestHost -> platform-browser -> kernel").
- `scripts/pack-release.mjs:157-183` `dependencyOrder` states "The graph is not acyclic" for exactly this pair and enters the cycle at its alphabetically first member, so release ordering handles it (PLAN Phase 3, "release ordering handles internal dependencies correctly").
- `git log -S'"@smthrs/platform-browser"' -- packages/kernel/package.json` resolves to `378c182a75`, the Phase 2 wholesale import of `smithersai/flows@393253c2b`.
- `corepack pnpm -r exec true` prints no cyclic-workspace warning; pnpm orders the two without complaint.

The gate's cycle check is file-level madge inside each package, which passes. The manifest-level cycle is a recorded design decision with release-tooling support, not a defect this gate reports.

## 5. Informational: madge over projects the repository check skips

Run from `packages/engine` (where madge resolves) with `ROOT=<checkout>`, extensions `ts,tsx,mts,mjs,js`, each project's `tsconfig.json` when present, `skipTypeImports: true`, excluding `node_modules`, `dist/`, and `.d.ts`. Not a Phase 7 criterion; recorded for coverage.

```
packages/ui	files=132	cycles=0
packages/ui-styleguide	files=21	cycles=0
packages/build/infra	files=13	cycles=0
apps/bug-worker	files=4	cycles=0
apps/review	files=94	cycles=1	[["cli/main.ts","cli/runReview.ts"]]
apps/server	files=14	cycles=0
apps/shared	files=27	cycles=0
apps/status-site	files=1	cycles=0
apps/tui	files=22	cycles=0
apps/ui	files=343	cycles=3	[["../.hutch/devkit/api/sdks/main/proc/native.ts","../.hutch/devkit/api/sdks/main/core/BrowserView.ts","../.hutch/devkit/api/sdks/main/core/Socket.ts"],["../.hutch/devkit/api/sdks/main/proc/native.ts","../.hutch/devkit/api/sdks/main/core/BrowserView.ts"],["../.hutch/devkit/api/sdks/main/proc/native.ts","../.hutch/devkit/api/sdks/main/core/WGPUView.ts"]]
e2e	files=54	cycles=0
examples	files=40	cycles=0
projects with cycles: 2
```

- `apps/review` (private app): `cli/main.ts:191` lazy-loads `runReview.ts` through `await import("./runReview.ts")` (the header comment at `main.ts:8` names this as the deliberate split that keeps the heavy half out of startup), and `runReview.ts:28` imports `buildRunSummaryLine` from `main.ts`. madge counts the dynamic import as an edge. `apps/review` declares no `circular` script or target.
- `apps/ui`: all three cycles are inside `apps/ui/.hutch/devkit/api/sdks/main/**`, the generated electrobun devkit. `apps/ui/.gitignore:35` ignores `.hutch/`; `git ls-files apps/ui/.hutch` lists 0 tracked files. Not repository source.
- `packages/ui`, `packages/ui-styleguide`, `packages/build/infra`, `apps/bug-worker`, `apps/server`, `apps/shared`, `apps/status-site`, `apps/tui`, `e2e`, `examples`: 0 cycles.

## 6. Scanner output (names and workspace graph)

```
workspace globs from pnpm-workspace.yaml: ["packages/*","packages/build/infra","e2e","examples","apps/*"]

workspace projects (manifests under the globs + root): 64
distinct names: 64
duplicate names: 0

name table:
  smithers	0.0.0	private	.
  @smthrs/bug-worker	0.0.1	private	apps/bug-worker
  @smthrs/review	1.0.0-rc.0	private	apps/review
  smithers-server	1.0.0	private	apps/server
  smithers-shared	0.0.0	private	apps/shared
  @smthrs/status-site	0.0.1	private	apps/status-site
  smithers-tui	0.0.0	private	apps/tui
  smithers-ui	1.0.0	private	apps/ui
  @smthrs/e2e	0.0.0	private	e2e
  @smthrs/examples	0.0.0	private	examples
  @smthrs/agent	1.0.0-rc.0	public	packages/agent
  @smthrs/artifacts	1.0.0-rc.0	public	packages/artifacts
  @smthrs/build	0.1.0	private	packages/build
  @smthrs/build-cli	0.1.0	private	packages/build-cli
  @smthrs/build-infra	undefined	private	packages/build/infra
  @smthrs/canonical	1.0.0-rc.0	public	packages/canonical
  @smthrs/capability	1.0.0-rc.0	public	packages/capability
  @smthrs/chain	0.1.0	private	packages/chain
  @smthrs/cli	1.0.0-rc.0	public	packages/cli
  @smthrs/control	1.0.0-rc.0	public	packages/control
  @smthrs/core	1.0.0-rc.0	public	packages/core
  @smthrs/create-app	0.1.0	private	packages/create-app
  @smthrs/crypto	1.0.0-rc.0	public	packages/crypto
  @smthrs/database	1.0.0-rc.0	public	packages/database
  @smthrs/engine	1.0.0-rc.0	public	packages/engine
  @smthrs/engine-store	1.0.0-rc.0	public	packages/engine-store
  @smthrs/errors	1.0.0-rc.0	private	packages/errors
  @smthrs/evals	1.0.0-rc.0	private	packages/evals
  @smthrs/flow	1.0.0-rc.0	public	packages/flow
  @smthrs/flows	1.0.0-rc.0	public	packages/flows
  @smthrs/fs	0.1.0	private	packages/fs
  @smthrs/gateway	1.0.0-rc.0	public	packages/gateway
  @smthrs/harness	1.0.0-rc.0	public	packages/harness
  @smthrs/integrations	1.0.0-rc.0	private	packages/integrations
  @smthrs/jj	1.0.0-rc.0	public	packages/jj
  @smthrs/journal	1.0.0-rc.0	public	packages/journal
  @smthrs/kernel	1.0.0-rc.0	public	packages/kernel
  @smthrs/keys	1.0.0-rc.0	public	packages/keys
  @smthrs/mcp	1.0.0-rc.0	public	packages/mcp
  @smthrs/memory	1.0.0-rc.0	public	packages/memory
  @smthrs/migrate	1.0.0-rc.0	public	packages/migrate
  @smthrs/model	1.0.0-rc.0	public	packages/model
  @smthrs/notifications	1.0.0-rc.0	public	packages/notifications
  @smthrs/observability	1.0.0-rc.0	public	packages/observability
  @smthrs/patterns	1.0.0-rc.0	public	packages/patterns
  @smthrs/plan	1.0.0-rc.0	public	packages/plan
  @smthrs/platform-browser	1.0.0-rc.0	public	packages/platform-browser
  @smthrs/platform-bun	1.0.0-rc.0	public	packages/platform-bun
  @smthrs/platform-node	1.0.0-rc.0	public	packages/platform-node
  @smthrs/plugin	1.0.0-rc.0	public	packages/plugin
  @smthrs/registry	1.0.0-rc.0	public	packages/registry
  @smthrs/run-store	1.0.0-rc.0	public	packages/run-store
  @smthrs/sandbox	1.0.0-rc.0	public	packages/sandbox
  @smthrs/scorers	0.1.0	private	packages/scorers
  smthrs	1.0.0-rc.0	public	packages/smthrs-deprecation
  @smthrs/std	1.0.0-rc.0	public	packages/std
  @smthrs/step-cache	1.0.0-rc.0	public	packages/step-cache
  @smthrs/sync	1.0.0-rc.0	public	packages/sync
  @smthrs/targets	0.1.0	private	packages/targets
  @smthrs/testing	1.0.0-rc.0	public	packages/testing
  @smthrs/time-travel	1.0.0-rc.0	public	packages/time-travel
  @smthrs/triggers	0.1.0	private	packages/triggers
  @smthrs/ui	1.0.0-rc.0	private	packages/ui
  @smthrs/ui-styleguide	1.0.0-rc.0	private	packages/ui-styleguide

workspace dependency graph: 64 nodes, 349 internal edges (dependencies+devDependencies+peerDependencies+optionalDependencies)
strongly connected components with a cycle: 1
  CYCLE: @smthrs/platform-browser -> @smthrs/kernel

informational: 17 non-workspace package.json files (fixtures, templates) outside node_modules/dist/legacy/vendor
non-workspace manifests whose name equals a workspace package name: 0

legacy/ present: false (excluded from the workspace by pnpm-workspace.yaml; Phase 7 gate check:legacy-absent owns it)
```

## Observations for the orchestrator (non-blocking)

1. Manifest-level cycle `@smthrs/kernel <-> @smthrs/platform-browser` is documented in three places and handled by `pack-release.mjs`; the npm pack/dry-run and release-order gates should confirm `dependencyOrder` emits both packages.
2. `apps/review` carries one dynamic-import cycle (`cli/main.ts <-> cli/runReview.ts`) that no repository check covers. It is a private app and outside this gate.
3. `packages/build/infra` (`@smthrs/build-infra`, private) declares no `version` field. Names stay unique; noted for the manifest gates.

## Verdict

PASS. `corepack pnpm run circular` exits 0 with 0 cycles across 51 packages, and the 64 workspace package names are unique with 0 duplicates.
