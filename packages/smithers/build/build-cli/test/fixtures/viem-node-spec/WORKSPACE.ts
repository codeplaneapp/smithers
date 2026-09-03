/// <reference path="./smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const lockfile = S.file("//pnpm-lock.yaml")
const workspaceConfig = S.file("//pnpm-workspace.yaml")

// engines.node (>=24.5) comes from the manifest.
const runtime = S.Runtime.Node({ manifest: packageJson })

// packageManager pins pnpm@11.13.1. The workspace file carries the package
// globs, the typescript catalog pin, the dependency overrides, and the
// audit allowlist; passing it makes those graph inputs, so an override
// bump invalidates exactly the targets that resolve through it.
const packageManager = S.PackageManager.Pnpm({
  manifest: packageJson,
  lockfile,
  workspaces: workspaceConfig,
})

const nodeModules = S.Npm.NodeModules({
  packageJson,
  workspaces: workspaceConfig,
})

// forge and anvil come from the host foundry install (CI pins v1.7.1),
// docker backs the tempo localnet containers, git materializes the
// contract submodules.
const host = S.Host({
  bins: ["forge", "anvil", "docker", "git"],
})

export const Workspace = S.Workspace("viem", {
  repository: "git+https://github.com/wevm/viem.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules,
  host,
})
