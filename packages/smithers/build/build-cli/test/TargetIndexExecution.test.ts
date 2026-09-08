/**
 * `TargetIndex` end to end: a temp workspace whose root PACKAGE.ts declares a
 * test, a suite over it, a generator, and the index target, driven through
 * the CLI verbs.
 *
 * `target --write` writes `.smithers/target-index.json` with one row per
 * labeled target, sorted by label, carrying only what the declarations state;
 * `lint` checks it, reds on a missing file, and reds again after a declaration
 * changes, because the planner-filled rows are key material; `index` prints
 * the same rows.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as TargetIndex from "../src/TargetIndex.ts"
import { executionPresentation } from "./fixtures/presentation.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly output: string; readonly logs: string }> => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const errWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({ presentation: executionPresentation }).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
  } finally {
    process.stderr.write = errWrite
  }
  return { exitCode, output, logs }
}

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("indexed", {
  repository: "git+https://example.invalid/indexed.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = (extra = "") =>
  `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: "true" })
const all = S.Suite({ tests: [good] })
const notes = S.Generate({
  summary: "Regenerate NOTES.md.",
  featured: true,
  script: S.file("//scripts/notes.mjs"),
  data: [S.file("//package.json"), S.glob("docs/**/*.md")],
  changes: ["NOTES.md"],
})
const targetIndex = S.TargetIndex({ summary: "Index every target." })
${extra}
export const Package = S.Package({ targets: { all, good, notes, targetIndex${extra === "" ? "" : ", later"} } })
`

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-target-index-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "indexed", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, ".smithers/WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule())
  await write(root, "scripts/notes.mjs", "process.stdout.write('')\n")
  return root
}

const indexOf = async (root: string): Promise<ReadonlyArray<TargetIndex.Row>> =>
  JSON.parse(await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8"))

describe("TargetIndex through the CLI", () => {
  it("reds on the missing file, writes one row per target under --write, checks it, and reds after a declaration edit", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("the generated file is missing")

    const written = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const raw = await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8")
    expect(raw.endsWith("]\n")).toBe(true)
    expect(raw).not.toContain(root)
    const rows = await indexOf(root)
    expect(rows.map((row) => row.label)).toEqual(["//:all", "//:good", "//:notes", "//:targetIndex"])
    expect(rows.find((row) => row.label === "//:notes")).toEqual({
      label: "//:notes",
      package: "",
      name: "notes",
      rule: "Generate",
      kinds: ["run", "lint"],
      summary: "Regenerate NOTES.md.",
      featured: true,
      mode: "write",
      cacheable: false,
      inputs: [
        { kind: "file", path: "scripts/notes.mjs" },
        { kind: "file", path: "package.json" },
        { kind: "glob", pattern: "docs/**/*.md", exclude: [] }
      ],
      outputs: ["NOTES.md"],
      dependencies: [],
      source: { file: "PACKAGE.ts" }
    })
    expect(rows.find((row) => row.label === "//:all")).toMatchObject({
      rule: "Suite",
      kinds: ["test"],
      dependencies: ["//:good"],
      outputs: []
    })
    expect(rows.find((row) => row.label === "//:targetIndex")).toMatchObject({
      rule: "TargetIndex",
      kinds: ["build", "lint"],
      mode: "check",
      inputs: [{ kind: "file", path: ".smithers/target-index.json" }],
      outputs: [".smithers/target-index.json"]
    })
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("key")
      expect(Object.keys(row)).not.toContain("digest")
      for (const input of row.inputs) expect(Object.keys(input)).not.toContain("_tag")
    }

    const fresh = await serve(root, ["lint", "//:targetIndex"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    expect(await indexOf(root)).toEqual(rows)

    await write(root, "PACKAGE.ts", packageModule(`const later = S.Shell.Test({ shell: "true" })`))
    const drifted = await serve(root, ["lint", "//:targetIndex"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted")
    expect(await indexOf(root)).toEqual(rows)

    const rewritten = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(rewritten.exitCode, rewritten.logs).toBe(0)
    expect((await indexOf(root)).map((row) => row.label)).toEqual([
      "//:all",
      "//:good",
      "//:later",
      "//:notes",
      "//:targetIndex"
    ])
  })

  it("prints the same rows through the index verb", async () => {
    const root = await fixture()
    const listed = await serve(root, ["index", "//..."])
    expect(listed.exitCode, listed.logs).toBe(0)
    expect(listed.output).toContain("//:notes")
    expect(listed.output).toContain("NOTES.md")
    expect(listed.output).toContain("//:targetIndex")
    expect(listed.output).not.toContain(root)
  })
})
