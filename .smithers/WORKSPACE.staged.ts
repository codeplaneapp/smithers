// STAGED WORKSPACE DECLARATION — not yet live.
//
// Discovery flips a repo into package mode the moment `.smithers/WORKSPACE.ts`
// exists (packages/build-cli/src/PackageDiscovery.ts), so during the port this
// file is named WORKSPACE.staged.ts and the tree stays in BUILD.ts mode. The
// flip commit renames it to `.smithers/WORKSPACE.ts`, re-expresses CI, and
// updates the pins listed in docs/migration/package-mode-port.md ("Staging").
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.js"
import { agents } from "./agents.ts"

const packageJson = S.file("//package.json")
const workspaceConfig = S.file("//pnpm-workspace.yaml")

// The durable engine's floor; ci/BUILD.ts pins the CI release to 22.19.0.
const runtime = S.Runtime.Node({ version: ">=22.19.0" })

// package.json packageManager pins pnpm@11.21.0. pnpm-workspace.yaml carries
// the package globs and the catalog pins, so it is a graph input.
const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

const nodeModules = S.Npm.NodeModules({
  packageJson,
  workspaces: workspaceConfig
})

// Every S.Cargo.* target in crates/flows-jj resolves cargo through this layer.
// A workspace that declares none refuses those targets by name rather than
// running whatever cargo sits on PATH (PackageExec.ts, the CargoBin branch).
//
// The pin is the checked-in rust-toolchain.toml, which fixes channel 1.89.0
// plus the minimal profile, clippy, rustfmt, and the wasm32-wasip1 target that
// the committed packages/jj/wasm/flows_jj.wasm was built with. Naming the file
// instead of restating the channel keeps one source of truth and reproduces
// ci.yml's bare `rustup toolchain install`, which reads the file and installs
// the components and targets with it. Cargo.lock is declared because the repo
// commits one and every cargo target runs --locked.
const rust = S.Rust.Toolchain({
  workspace: S.file("//Cargo.toml"),
  toolchain: S.file("//rust-toolchain.toml"),
  lockfile: S.file("//Cargo.lock")
})

// The binaries CI actually installs (ci.yml): git checks out and drives the
// working copy, jj backs the Jujutsu host service and the fault matrix, bun
// runs apps/* and the ci/BUILD.ts matrix, cargo builds crates/flows-jj and
// the wasm reproducibility gate.
const host = S.Host({
  bins: ["git", "jj", "bun", "cargo"]
})

export const Workspace = S.Workspace("smithers", {
  repository: "git+https://github.com/smithersai/smithers.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules,
  toolchains: [rust],
  host,
  agents,
  gitHooks: {
    preCommit: root.preCommit,
    prePush: root.prePush
  },
  // Every nested tree that carries its own WORKSPACE.ts (or
  // .smithers/WORKSPACE.ts) must be declared here or discovery throws
  // nested_workspace_undeclared (PackageDiscovery.ts:232). Declared repos are
  // opaque boundaries: their inner PACKAGE.ts files never join this graph,
  // which is exactly what the build-cli fixtures, the create-app templates,
  // and the apps/ui e2e fixture need. Repos nested inside a declared repo
  // (multi-repo/child, repo-plugin/tools) are covered by their parent.
  repos: {
    "fixture-chain-exec": S.LocalRepository("packages/build-cli/test/fixtures/chain-exec"),
    "fixture-force-spec": S.LocalRepository("packages/build-cli/test/fixtures/force-spec"),
    "fixture-multi-repo": S.LocalRepository("packages/build-cli/test/fixtures/multi-repo"),
    "fixture-steps-form": S.LocalRepository("packages/build-cli/test/fixtures/steps-form"),
    "fixture-viem-node-spec": S.LocalRepository("packages/build-cli/test/fixtures/viem-node-spec"),
    "template-aomi": S.LocalRepository("packages/create-app/template/aomi"),
    "template-default": S.LocalRepository("packages/create-app/template/default"),
    "ui-e2e-repo-plugin": S.LocalRepository("apps/ui/e2e/fixtures/repo-plugin"),
    // Not package workspaces, but declared to prune the walk: the pinned jj
    // submodule and the 0.x sources are both large trees no PACKAGE.ts will
    // ever join, and discovery's directory/entry limits are finite.
    "vendor-jj": S.LocalRepository("vendor/jj"),
    "legacy-0x": S.LocalRepository("legacy")
  }
})
