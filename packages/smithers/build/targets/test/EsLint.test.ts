/**
 * ESLint source declarations must select real files from the tool's cwd.
 *
 * @since 0.1.0
 */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import * as EsLint from "../src/EsLint.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const execFile = promisify(ChildProcess.execFile)
const eslint = NodePath.join(
  NodePath.dirname(createRequire(import.meta.url).resolve("eslint/package.json")),
  "bin/eslint.js"
)

describe("ESLint source paths", () => {
  it.each([".", "packages/example"])("lints rooted and relative globs from cwd %s", async (cwd) => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-eslint-")))
    try {
      const directory = NodePath.join(root, cwd)
      const rooted = NodePath.join(directory, "src/rooted/value.ts")
      const relative = NodePath.join(directory, "src/relative/value.ts")
      await Fs.mkdir(NodePath.dirname(rooted), { recursive: true })
      await Fs.mkdir(NodePath.dirname(relative), { recursive: true })
      await Fs.writeFile(rooted, "const rooted = 1\n")
      await Fs.writeFile(relative, "const relative = 2\n")
      await Fs.writeFile(
        NodePath.join(directory, "eslint.config.mjs"),
        "export default [{ files: [\"**/*.ts\"], rules: { \"no-debugger\": \"error\" } }]\n"
      )
      const sources = [
        Input.glob(`//${cwd === "." ? "" : `${cwd}/`}src/rooted/**/*.ts`),
        Input.glob("src/relative/**/*.ts")
      ]
      const configs = [Input.file("eslint.config.mjs")]
      const target = EsLint.EsLint({ packageManager, sources, configs, deps: [], maxWarnings: 0, fix: false, cwd })
      const argv = plannedArgv(target)
      const args = [eslint, ...argv.slice(3), "--format", "json"]
      const result = await execFile(process.execPath, args, { cwd: directory })
      const files = JSON.parse(result.stdout) as Array<{ readonly filePath: string }>
      expect(files.map((file) => file.filePath).sort()).toEqual([relative, rooted].sort())
      expect(plannedCalls(target)[0]?.payload["cwd"]).toBe(cwd)
      expect(argv.slice(-2).map((pattern) => NodePath.resolve(directory, pattern))).toEqual([
        NodePath.join(directory, "src/rooted/**/*.ts"),
        NodePath.join(directory, "src/relative/**/*.ts")
      ])
      expect(Target.metadata(target).inputs).toEqual([...sources, ...configs])

      // A clean exit alone could hide an empty selection. The rooted source
      // must also make the actual tool fail when its contents violate a rule.
      await Fs.writeFile(rooted, "debugger\n")
      await expect(execFile(process.execPath, args, { cwd: directory })).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("\"ruleId\":\"no-debugger\"")
      })
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
