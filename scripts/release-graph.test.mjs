import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

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
