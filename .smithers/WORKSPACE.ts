import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const workspaceConfig = S.file("//pnpm-workspace.yaml")
const runtime = S.Runtime.Node({ version: ">=22.19.0" })

const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

const nodeModules = S.Npm.NodeModules({
  packageJson,
  workspaces: workspaceConfig
})

const rust = S.Rust.Toolchain({
  workspace: S.file("//Cargo.toml"),
  toolchain: S.file("//rust-toolchain.toml"),
  lockfile: S.file("//Cargo.lock")
})

export const Workspace = S.Workspace("smithers", {
  repository: "git+https://github.com/smithersai/smithers.git",
  // SMITHERS_CACHE_URL overrides the endpoint at the process boundary and
  // SMITHERS_CACHE_TOKEN is the default remote-cache credential.
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules,
  toolchains: [rust],
  host: S.Host({ bins: ["git", "jj", "bun", "cargo"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() }),
  repos: {
    "fixture-chain-exec": S.LocalRepository("packages/build-cli/test/fixtures/chain-exec"),
    "fixture-force-spec": S.LocalRepository("packages/build-cli/test/fixtures/force-spec"),
    "fixture-multi-repo": S.LocalRepository("packages/build-cli/test/fixtures/multi-repo"),
    "fixture-steps-form": S.LocalRepository("packages/build-cli/test/fixtures/steps-form"),
    "fixture-target-body": S.LocalRepository("packages/build-cli/test/fixtures/target-body"),
    "fixture-viem-node-spec": S.LocalRepository("packages/build-cli/test/fixtures/viem-node-spec"),
    "template-aomi": S.LocalRepository("packages/create-app/template/aomi"),
    "template-default": S.LocalRepository("packages/create-app/template/default"),
    "ui-e2e-repo-plugin": S.LocalRepository("apps/ui/e2e/fixtures/repo-plugin")
  }
})
