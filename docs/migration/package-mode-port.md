# Package-mode port (smthrs dogfood)

Branch `smthrs-dogfood`, worktree `~/smithers-smthrs-dogfood`. Goal: this repo
authors its whole build, lint, CI, and agent-lane surface as `PACKAGE.ts`
package-mode graphs (the ~/artsy factory convention), replacing the BUILD.ts
convention, so the repo dogfoods the same surface partners use.

## Facts the port stands on

- One engine. `packages/targets` + `smithers-build` serve both conventions;
  `.smithers/WORKSPACE.ts` presence flips discovery to package mode
  (`packages/build-cli/src/PackageDiscovery.ts:74`).
- Package mode executes: `Shell.*`, `Generate`, `Materialize`, `Clean`,
  `Suite`, `Alias`, `ImportClosure`, `Test`, `Bundler.Rspack.*`, `Agent.*`,
  `Git.Commit`, `Github.*`, `Memory.Retain`, `Cargo.*`, `Go.*`, `Foundry.*`,
  `Docker.*`, `Npm.*` (`PackageExec.ts:248`). BUILD-era rules (`Typecheck`,
  `Vitest`, `EsLint`, `Dprint`, `Tsconfig`, `Lockfile`, `Install`,
  `GithubCiGen`, `PackageDefaults`) do not, so every target is re-expressed
  in the implemented vocabulary, not renamed.
- In-repo shape references: `packages/build-cli/test/fixtures/force-spec`
  (root + workflows lanes), `fixtures/viem-node-spec` (pnpm monorepo
  WORKSPACE), `packages/create-app/template/default/.smithers/*`.
  External house shape: `~/artsy/eliza`, brief: `~/artsy/FACTORY-BRIEF.md`.

## Rule translation

| BUILD.ts today | PACKAGE.ts port |
| --- | --- |
| `Typecheck` | `S.Shell.Test({ bin: tsc via using, args: ["-p", …, "--noEmit"], data: [srcs, tsconfigs] })` |
| `Vitest` | `S.Shell.Test` running `vitest run` (or `bun test`) with config + srcs as data |
| `EsLint` / `Dprint` | `S.Shell.Test` (`eslint --max-warnings 0`, `dprint check`) |
| `Generate` (known-files) | `S.Generate` unchanged (implemented) |
| `GithubCiGen //:ci` | `S.Github.Ci({ workflows })` emitting `.github/workflows/*` |
| `Tsconfig` | `S.Generate` script emitting `tsconfig.json` + drift via lint kind |
| `Lockfile` + `Install` | `WORKSPACE.ts` `packageManager` + `nodeModules: S.Npm.NodeModules` |
| `PackageDefaults` synthesis | explicit per-package `PACKAGE.ts` (no macro in package mode) |
| `LlmLint` (lint/BUILD.ts) | `S.Agent.Lint({ agent: S.Agents.reviewPool, prompt: workflows/lints/*.md, data: [S.gitDiff…] })` |

## Authoring contract (every file)

- Header `/// <reference path="…/known-files.d.ts" />`? No: this repo keeps
  its generated `known-files.d.ts` overlay (already covers PACKAGE.ts dirs);
  no artsy `smithers.d.ts` stub.
- `import { Smithers as S } from "@smthrs/targets"`; cross-package imports
  `import { Package as root } from "../../PACKAGE.js"` (`.js` extension).
- Exactly one `export const Package = S.Package({ targets })`; root adds
  `defaultVisibility: "public"`. Naked target exports are a loader error.
- Root exports (canonical set): `ci`, `gates`, `agentLints`, `prGate`,
  `preCommit`, `prePush`, `commit`, `pr`, `githubCi`, plus repo aliases.
- Gates: `.mjs` under `workflows/gates/`, target keys on the script itself.
- Lints: `workflows/lints/<rule>.md`, 5-part shape (title, Evidence, scope,
  exemptions, --fix contract + "an empty diff is a vacuous pass").
- Lanes: `workflows/<lane>/{SKILL.md,PACKAGE.ts}`, `S.Agent.Diff`/`S.Agent.Pr`,
  typed `payload` (`S.Input.*`, plan-safe `S.Input.Optional` in suites),
  `changes` write set, `gates`, outward lanes add `secrets`/`sandbox`/
  `approval: "required"`.

## Staging

`.smithers/WORKSPACE.staged.ts` holds the workspace declaration during the
port so the worktree stays in BUILD mode; the flip commit renames it to
`.smithers/WORKSPACE.ts`, re-expresses CI, and updates the pins:
`docs/migration/rc-contract.md` §9, `CONTRIBUTING.md`, `CLAUDE.md`,
`packages/flows/test/vitestCoverageIsolation.test.ts`, `known-files.d.ts`,
both lockfiles.

Nested `PACKAGE.ts`/`WORKSPACE.ts` trees (build-cli fixtures, create-app
template, examples) must be declared via `repos`/discovery ignores or the
walk throws `nested_workspace_undeclared` (`PackageDiscovery.ts:232`).
