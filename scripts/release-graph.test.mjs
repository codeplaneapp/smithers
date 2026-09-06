import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("the shipping-links gate depends on the site build even when selected alone", () => {
  // Query the evaluated declarations: an earlier workflow step cannot supply
  // the route oracle when this target runs on its own or through //scripts/....
  const graph = JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "query",
    "deps(//scripts/repo-contract:smithersLinks)",
    "--json"
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 300_000
  }))

  assert.ok(graph.dependencies.includes("//apps/site:build"), "shipping links require the built site routes")
})

test("the ordinary PR CLI entrypoint plans both executable examples checks and the suite", () => {
  const cliRoot = new URL("../packages/smithers/", import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL("package.json", cliRoot), "utf8"))
  // CI invokes the public smthrs bin, which must compose the graph commands.
  // Read the manifest so a stale checkout .bin alias cannot satisfy this gate.
  const entry = fileURLToPath(new URL(manifest.bin.smthrs, cliRoot))
  const plan = JSON.parse(execFileSync(process.execPath, [
    entry, "ci", "//examples/...", "--plan", "--json"
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 300_000 }))
  assert.ok(plan.roots.includes("//examples:check"), "examples CI must typecheck the executable tutorials")
  assert.ok(plan.roots.includes("//examples:suite"), "examples CI must execute the Vitest suite")
})
