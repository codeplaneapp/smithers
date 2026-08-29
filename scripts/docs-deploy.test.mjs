import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { repoRoot } from "./docs-contract.mjs"

const workflow = readFileSync(join(repoRoot, ".github", "workflows", "docs-deploy.yml"), "utf8")
const config = readFileSync(join(repoRoot, "vocs.config.ts"), "utf8")

test("the site is built as static HTML, not as an SSR bundle", () => {
  // GitHub Pages serves files. Under vocs's default `dynamic` strategy the
  // build writes `serve-node.js` and no HTML, so the deploy would publish a
  // directory listing that renders nothing.
  assert.match(config, /renderStrategy:\s*"full-static"/)
})

test("the workflow uploads the directory the static build writes", () => {
  // `full-static` writes the site under `<outDir>/public`, beside the server
  // bundle rather than in place of it. Uploading `outDir` itself ships
  // `serve-node.js` and `server/` and no index.
  assert.match(config, /outDir:\s*"docs\/dist"/)
  assert.match(workflow, /path:\s*docs\/dist\/public/)
  assert.doesNotMatch(workflow, /path:\s*docs\/dist\s*$/m)
})

test("the gates run before the site is published", () => {
  // A published site that no gate passed is worse than a stale one: it is the
  // documentation claiming things the repository no longer does.
  const build = workflow.slice(workflow.indexOf("\njobs:"), workflow.indexOf("\n  deploy:"))
  // Match the run steps, not the job's display name, which also says "vocs build".
  const order = ["node scripts/check-docs.mjs", "node scripts/check-llms.mjs", "pnpm exec vocs build"]
  const positions = order.map((step) => build.indexOf(step))
  assert.ok(positions.every((position) => position > 0), `missing steps: ${order.filter((_, index) => positions[index] < 0)}`)
  assert.deepEqual([...positions].sort((left, right) => left - right), positions)
})

test("the deploy job waits on the build job", () => {
  assert.match(workflow, /needs:\s*build/)
})
