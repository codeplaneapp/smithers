import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { runTemplateReplay } from "./fixtures/dependency-consumers.mjs"

const repoRoot = resolve(import.meta.dirname, "..")

test("the template smoke scaffolds then executes its generated replay, and propagates replay failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-template-replay-")))
  try {
    const templateRoot = join(root, "source-template")
    const template = join(templateRoot, "default")
    const consumer = join(root, "consumer")
    mkdirSync(join(template, "flows/chat"), { recursive: true })
    mkdirSync(join(consumer, "node_modules/.bin"), { recursive: true })
    const dependencies = { vitest: "4.1.9" }
    writeFileSync(join(template, "package.json"), JSON.stringify({ name: "__APP_NAME__", private: true,
      type: "module", devDependencies: dependencies }))
    writeFileSync(join(template, "vitest.config.ts"), 'export default { test: { include: ["flows/**/*.e2e.ts"] } }')
    const replay = join(template, "flows/chat/flow.e2e.ts")
    writeFileSync(replay, [
      'import { test, expect } from "vitest"',
      'import { writeFileSync } from "node:fs"',
      'test("generated recorded replay", () => {',
      '  expect(process.env.SMTHRS_RECORD).toBe("0")',
      '  writeFileSync("replay.ok", process.cwd())',
      '})'
    ].join("\n"))
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
    const scaffold = pathToFileURL(join(repoRoot, "packages/smithers/build/build-cli/src/CreateApp.ts")).href
    const binary = join(consumer, "node_modules/.bin/smithers-build")
    writeFileSync(binary, [
      "#!/usr/bin/env node",
      `import { scaffold } from ${JSON.stringify(scaffold)}`,
      'if (process.argv[2] !== "create-app") throw new Error("unexpected CLI command")',
      `await scaffold({ directory: process.argv[3], templateRoot: ${JSON.stringify(templateRoot)} })`
    ].join("\n"))
    chmodSync(binary, 0o755)
    // Use the real installed Vitest without a network installation. This
    // focused runner regression is separate from the packed consumer matrix.
    const require = createRequire(join(repoRoot, "packages/smithers/build/targets/package.json"))
    const vitest = dirname(require.resolve("vitest/package.json"))
    symlinkSync(vitest, join(consumer, "node_modules/vitest"), "dir")
    symlinkSync(join(vitest, "vitest.mjs"), join(consumer, "node_modules/.bin/vitest"))
    const profile = { name: "template-default", dependencies }
    const app = await runTemplateReplay(consumer, profile)
    assert.equal(readFileSync(join(app, "replay.ok"), "utf8"), app, "the replay must run from the generated app")
    rmSync(app, { recursive: true })
    writeFileSync(replay, 'import { test } from "vitest"; test("broken generated replay", () => { throw new Error("replay regression") })')
    await assert.rejects(runTemplateReplay(consumer, profile), /replay regression/)
    rmSync(app, { recursive: true })
    await assert.rejects(runTemplateReplay(consumer, { ...profile, dependencies: { vitest: "0.0.0" } }),
      /generated app dependencies differ/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
