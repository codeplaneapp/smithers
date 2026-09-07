/**
 * `HomePane` end to end: a temp workspace whose `PACKAGE.ts` exports
 * `Smithers.Factory.Home`, driven through the CLI verbs.
 *
 * `target --write` renders `flows/home.json` from the declaration; `lint` and
 * `ci` check it and red on drift; a declaration carrying raw HTML never
 * loads, so nothing is written for it.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
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
export const Workspace = S.Workspace("home-pane", {
  repository: "git+https://example.invalid/home-pane.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = (text: string) =>
  `import { Smithers as S } from "@smthrs/targets"
export const home = S.Factory.Home({
  blocks: [
    S.Home.Text({ text: ${JSON.stringify(text)} }),
    S.Home.Flows({ title: "Try first" }),
    S.Home.CiBenchmark({ title: "CI", measures: ["cold", "incremental"] }),
  ],
})
export const Package = S.Package({
  targets: {
    homePane: S.HomePane({ home }),
  },
})
`

const fixture = async (text = "Builds itself."): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-home-pane-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "home-pane", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule(text))
  return root
}

const homeOf = async (root: string) =>
  JSON.parse(await Fs.readFile(NodePath.join(root, "flows", "home.json"), "utf8")) as {
    readonly blocks: ReadonlyArray<Record<string, unknown>>
  }

describe("HomePane through the CLI", () => {
  it("reports the missing pane, writes it under --write, then checks it and reds on drift", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:homePane"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("the generated file is missing")

    const written = await serve(root, ["target", "//:homePane", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const home = await homeOf(root)
    expect(home).toEqual({
      blocks: [
        { type: "text", text: "Builds itself." },
        { type: "flows", title: "Try first" },
        { type: "ci-benchmark", title: "CI", measures: ["cold", "incremental"] }
      ]
    })

    const fresh = await serve(root, ["lint", "//:homePane"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    const ci = await serve(root, ["ci", "//:homePane"])
    expect(ci.exitCode, ci.logs).toBe(0)

    await write(root, "flows/home.json", JSON.stringify({ blocks: [{ type: "flows" }] }, null, 2) + "\n")
    const drifted = await serve(root, ["ci", "//:homePane"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted from its generated form")
    expect(await homeOf(root)).toEqual({ blocks: [{ type: "flows" }] })

    const rewritten = await serve(root, ["target", "//:homePane", "--write"])
    expect(rewritten.exitCode, rewritten.logs).toBe(0)
    expect(await homeOf(root)).toEqual(home)
  })

  it("refuses a declaration that carries raw HTML and writes nothing", async () => {
    const root = await fixture("<h1>Hello</h1>")
    const result = await serve(root, ["target", "//:homePane", "--write"])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("must not contain HTML")
    await expect(Fs.access(NodePath.join(root, "flows", "home.json"))).rejects.toThrow()
  })
})
