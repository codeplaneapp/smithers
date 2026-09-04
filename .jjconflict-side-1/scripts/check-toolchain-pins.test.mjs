import assert from "node:assert/strict"
import test from "node:test"
import { check, findings, satisfies } from "./check-toolchain-pins.mjs"

const workspace = {
  runtime: { version: ">=22.19.0" },
  packageManager: { version: "11.21.0" },
  bunRuntime: { version: ">=1.3.0" }
}
const packageJson = JSON.stringify({
  packageManager: "pnpm@11.21.0",
  engines: { node: ">=22.19.0", bun: ">=1.3.0" }
})
const flake = `pnpmPinned = pkgs: pkgs.stdenvNoCC.mkDerivation rec {
  pname = "pnpm";
  version = "11.21.0";
};
packages = [ pkgs.nodejs_22 (pnpmPinned pkgs) ];`
const ci = `      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14`

test("an exact release satisfies its floor only within the declared major", () => {
  assert.equal(satisfies("22.19.0", ">=22.19.0"), true)
  assert.equal(satisfies("22.23.2", ">=22.19.0"), true)
  assert.equal(satisfies("22.18.0", ">=22.19.0"), false)
  assert.equal(satisfies("24.0.0", ">=22.19.0"), false)
})

test("files that agree with the workspace declaration produce no findings", () => {
  assert.deepEqual(findings({ workspace, packageJson, flake, ci }), [])
})

test("every file that disagrees is named with both values", () => {
  const drifted = findings({
    workspace,
    packageJson: JSON.stringify({ packageManager: "pnpm@11.20.0", engines: { node: ">=22.0.0", bun: ">=1.2.0" } }),
    flake: flake.replace("11.21.0", "11.19.0").replace("nodejs_22", "nodejs_24"),
    ci: ci.replace("22.19.0", "20.11.0").replace("1.3.14", "1.2.9")
  })
  assert.deepEqual(drifted, [
    "package.json packageManager is \"pnpm@11.20.0\"; WORKSPACE.ts declares pnpm@11.21.0",
    "package.json engines.node is \">=22.0.0\"; WORKSPACE.ts declares >=22.19.0",
    "package.json engines.bun is \">=1.2.0\"; WORKSPACE.ts declares >=1.3.0",
    "flake.nix pins pnpm 11.19.0; WORKSPACE.ts declares 11.21.0",
    "flake.nix uses nodejs_24; WORKSPACE.ts declares Node >=22.19.0",
    "ci.yml installs node 20.11.0; WORKSPACE.ts declares >=22.19.0",
    "ci.yml installs bun 1.2.9; WORKSPACE.ts declares >=1.3.0"
  ])
})

test("a flake without the pnpm pin or a Node package is a finding, not a pass", () => {
  assert.deepEqual(findings({ workspace, packageJson, flake: "{ }", ci }), [
    "flake.nix pins no pnpm tarball (expected pname = \"pnpm\"; version = \"...\")",
    "flake.nix names no nodejs_<major> package"
  ])
})

test("the real repository is in sync", async () => {
  assert.deepEqual(await check(), [])
})
