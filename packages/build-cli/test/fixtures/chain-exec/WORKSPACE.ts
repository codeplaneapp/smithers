import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const mise = S.Mise({ config: S.file("//mise.toml") })
const foundry = S.Foundry.Toolchain({ config: S.file("//foundry.toml"), versions: mise })

export const Workspace = S.Workspace("chain-exec", {
  repository: "git+https://example.invalid/chain-exec.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "22" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  toolchains: [mise, foundry],
  host: S.Host({ bins: ["docker", "forge", "anvil"] })
})
