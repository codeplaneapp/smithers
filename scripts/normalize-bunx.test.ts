import assert from "node:assert/strict"
import test from "node:test"
import { normalizeCommand, normalizeProseLine, rewrite } from "./normalize-bunx.ts"

test("rewrites every runner spelling of the old package onto the command", () => {
  assert.equal(normalizeCommand("bunx smthrs ps"), "smithers ps")
  assert.equal(normalizeCommand("bun x smthrs up flow"), "smithers up flow")
  assert.equal(normalizeCommand("npx smthrs logs RUN_ID"), "smithers logs RUN_ID")
  assert.equal(normalizeCommand("pnpm dlx smithers-orchestrator ps"), "smithers ps")
})

test("rewrites a bare old-package invocation", () => {
  assert.equal(normalizeCommand("smthrs plan example/Build"), "smithers plan example/Build")
})

test("leaves a version-pinned 0.x invocation alone", () => {
  const pinned = "bunx smthrs@0.35.0 ps"
  assert.equal(normalizeCommand(pinned), pinned)
})

test("leaves the 1.0 spellings alone", () => {
  for (const line of [
    "smithers ps",
    "npx @smthrs/cli@rc smithers ls",
    "bun x --package @smthrs/cli@rc smithers serve",
    "pnpm add @smthrs/flow@rc"
  ]) {
    assert.equal(normalizeCommand(line), line)
  }
})

test("rewrites a command inside a code span and leaves prose alone", () => {
  assert.equal(normalizeProseLine("Run `bunx smthrs ps` first."), "Run `smithers ps` first.")
  assert.equal(normalizeProseLine("The smthrs package is a notice."), "The smthrs package is a notice.")
})

test("rewrites a shell block and leaves a typescript block alone", () => {
  const page = [
    "```bash",
    "bunx smthrs ps",
    "```",
    "",
    "```ts",
    'import { Flow } from "@smthrs/flow"',
    "```",
    ""
  ].join("\n")
  const next = rewrite(page)
  assert.match(next, /^smithers ps$/m)
  assert.match(next, /import \{ Flow \} from "@smthrs\/flow"/)
})

test("is idempotent", () => {
  const once = rewrite("```bash\nbunx smthrs ps\n```\n")
  assert.equal(rewrite(once), once)
})
