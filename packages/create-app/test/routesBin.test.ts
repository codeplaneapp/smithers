/**
 * The `smithers-routes` executable.
 *
 * Two layers, because they fail differently. `runRoutesBin` is driven
 * in-process, so every flag form, exit code and reported line is asserted
 * against what a user would see. The shim in `bin/routes.mjs` is spawned, so
 * the one thing only a real process can prove is proved: Node refuses to strip
 * types from any file under `node_modules`, which is exactly where
 * `S.NodeModule.Bin("@smthrs/create-app", "smithers-routes")` resolves and
 * where both templates' `pnpm routes` runs.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runRoutesBin, usage } from "../src/routesBin.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binPath = join(packageRoot, "bin", "routes.mjs")

const roots: Array<string> = []

const appTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-routes-bin-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

const layers = {
  "AGENT.ts": "export const Agent = {}\n",
  "SANDBOX.ts": "export const Sandbox = {}\n",
  "TOOLS.ts": "export const Tools = {}\n"
}

/** Runs the bin body and returns its exit code beside the two streams. */
const run = (argv: ReadonlyArray<string>, cwd?: string) => {
  const out: Array<string> = []
  const err: Array<string> = []
  const code = runRoutesBin(argv, {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    ...(cwd === undefined ? {} : { cwd })
  })
  return { code, out, err }
}

// Drained after the whole file rather than after each test, so a spawned child
// that still holds a handle cannot make an individual test flaky.
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("runRoutesBin", () => {
  it("prints usage and succeeds for --help and -h", () => {
    for (const flag of ["--help", "-h"]) {
      const result = run([flag])
      expect(result.code).toBe(0)
      expect(result.out).toEqual([usage])
      expect(result.err).toEqual([])
    }
  })

  it("documents both flag forms in the usage text", () => {
    expect(usage).toContain("--root=<dir>")
    expect(usage).toContain("--check")
  })

  it("writes both tables and reports the counts", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run(["--root", root])
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 1 panes, 1 flows"])
    expect(readFileSync(join(root, "routes.gen.ts"), "utf8")).toContain("import * as flow0")
  })

  it("accepts the equals form of every flag", () => {
    const root = appTree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "pipelines/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run([`--root=${root}`, "--app=site", "--flows=pipelines", "--tools=kit"])
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 0 panes, 1 flows"])
  })

  it("defaults the root to the working directory it is given", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const result = run([], root)
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 0 panes, 0 flows"])
  })

  it("exits 2 when a flag is given no value", () => {
    for (
      const [name, argv] of [
        ["root", ["--root"]],
        ["app", ["--app", "--flows", "x"]],
        ["flows", ["--flows="]],
        ["tools", ["--tools"]]
      ] as const
    ) {
      const result = run(argv)
      expect(result.code).toBe(2)
      expect(result.err).toEqual([`--${name} expects a value`])
      expect(result.out).toEqual([])
    }
  })

  it("reports drift per file and exits 1 in check mode", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const stale = run(["--root", root, "--check"])
    expect(stale.code).toBe(1)
    expect(stale.err).toEqual([
      "routes.gen.ts is out of date; run `pnpm routes`",
      "routes.ui.gen.ts is out of date; run `pnpm routes`"
    ])

    expect(run(["--root", root]).code).toBe(0)
    const clean = run(["--root", root, "--check"])
    expect(clean.code).toBe(0)
    expect(clean.err).toEqual([])
  })

  it("reports a refused tree as its message and exits 1", () => {
    const root = appTree({
      "AGENT.ts": layers["AGENT.ts"],
      "SANDBOX.ts": layers["SANDBOX.ts"],
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run(["--root", root])
    expect(result.code).toBe(1)
    expect(result.err).toEqual(["no TOOLS.ts found for flows/chat or any ancestor; add one at the app root"])
    expect(result.out).toEqual([])
  })

  it("reports a non-Error throw as text rather than [object Object]", () => {
    const out: Array<string> = []
    const err: Array<string> = []
    const code = runRoutesBin(["--root", "/nowhere"], {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      write: () => {
        throw "the router died without an Error"
      }
    })
    expect(code).toBe(1)
    expect(err).toEqual(["the router died without an Error"])
  })
})

describe("bin/routes.mjs", () => {
  it("runs the shipped bin end to end against a real tree", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const result = spawnSync(process.execPath, [binPath, "--root", root], { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("routes: 1 pages, 0 panes, 0 flows")
  })

  it("runs from inside node_modules, where Node refuses to strip types", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const installed = join(root, "node_modules", "@smthrs", "create-app")
    mkdirSync(join(installed, "bin"), { recursive: true })
    mkdirSync(join(installed, "dist", "esm"), { recursive: true })
    copyFileSync(binPath, join(installed, "bin", "routes.mjs"))
    // A published install ships JavaScript here. The point of the assertion is
    // that the shim reaches it and never touches a `.ts` file: importing one
    // from under node_modules fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
    writeFileSync(
      join(installed, "dist", "esm", "routesBin.js"),
      "export const runRoutesBin = (argv, options) => {\n"
        + "  options.io.out(`routes: 0 pages, 0 panes, 0 flows (argv ${argv.length})`)\n"
        + "  return 0\n"
        + "}\n"
    )
    const result = spawnSync(process.execPath, [join(installed, "bin", "routes.mjs"), "--root", root], {
      encoding: "utf8"
    })
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("routes: 0 pages, 0 panes, 0 flows (argv 2)")
  })

  it("exits 1 and names the refusal when the tree has no layer", () => {
    const root = appTree({ "flows/chat/flow.ts": "export const Flow = {}\n" })
    const result = spawnSync(process.execPath, [binPath, "--root", root], { encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("no AGENT.ts found for flows/chat")
  })
})
