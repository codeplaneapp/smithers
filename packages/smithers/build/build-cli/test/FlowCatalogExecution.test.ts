/**
 * `FlowCatalog` end to end: a temp workspace whose `PACKAGE.ts` features one
 * flow with `Smithers.Flow`, driven through the CLI verbs.
 *
 * `target --write` renders `flows/catalog.json` from the registry's discovery
 * joined with the declarations; `lint` and `ci` check it and red on drift; a
 * declaration naming a flow discovery does not find fails the write with the
 * id in the message.
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
export const Workspace = S.Workspace("flow-catalog", {
  repository: "git+https://example.invalid/flow-catalog.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = (featured: string) =>
  `import { Smithers as S } from "@smthrs/targets"
export const review = S.Flow({ flow: ${JSON.stringify(featured)}, summary: "Review the change.", featured: true })
export const lint = S.Flow({ flow: "lint", summary: "Lint the named files." })
export const Package = S.Package({
  targets: {
    flowCatalog: S.FlowCatalog({ flows: [review, lint] }),
  },
})
`

const reviewFlow = `---
description: Reviews the uncommitted change and returns a verdict.
capabilities: ["fs:read:**", "proc:spawn:git *"]
model: openai:gpt-5.6-sol
---

# Review the change
`

const fixture = async (featured = "review"): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-flow-catalog-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "flow-catalog", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule(featured))
  await write(root, "flows/review/flow.mdx", reviewFlow)
  await write(
    root,
    "flows/lint/flow.mdx",
    "---\ndescription: Lints the named files.\ncapabilities: [\"fs:read:**\"]\ndisable-model-invocation: true\n---\n\n# Lint\n"
  )
  await write(
    root,
    "flows/ops/deploy/SKILL.md",
    "---\nname: deploy\ndescription: Deploys the service.\n---\n\n# Deploy\n"
  )
  return root
}

const catalogOf = async (root: string) =>
  JSON.parse(await Fs.readFile(NodePath.join(root, "flows", "catalog.json"), "utf8")) as {
    readonly flows: ReadonlyArray<Record<string, unknown>>
  }

describe("FlowCatalog through the CLI", () => {
  it("reports the missing catalog, writes it under --write, then checks it and reds on drift", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:flowCatalog"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("the generated file is missing")

    const written = await serve(root, ["target", "//:flowCatalog", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const catalog = await catalogOf(root)
    expect(catalog.flows.map((row) => [row["id"], row["featured"], row["summary"]])).toEqual([
      ["review", true, "Review the change."],
      ["lint", false, "Lint the named files."],
      ["ops/deploy", false, null]
    ])
    expect(catalog.flows[0]).toEqual({
      id: "review",
      description: "Reviews the uncommitted change and returns a verdict.",
      summary: "Review the change.",
      featured: true,
      kind: "mdx",
      path: "flows/review/flow.mdx",
      capabilities: ["fs:read:**", "proc:spawn:git *"],
      model: "openai:gpt-5.6-sol",
      modelInvocable: true
    })
    expect(catalog.flows[1]).toMatchObject({ modelInvocable: false, model: null })
    expect(catalog.flows[2]).toMatchObject({ kind: "skill", path: "flows/ops/deploy/SKILL.md" })

    const fresh = await serve(root, ["lint", "//:flowCatalog"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    const ci = await serve(root, ["ci", "//:flowCatalog"])
    expect(ci.exitCode, ci.logs).toBe(0)
    expect(await catalogOf(root)).toEqual(catalog)

    await write(root, "flows/review/flow.mdx", reviewFlow.replace("returns a verdict", "returns two verdicts"))
    const drifted = await serve(root, ["ci", "//:flowCatalog"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted from its generated form")
    expect(await catalogOf(root)).toEqual(catalog)

    const rewritten = await serve(root, ["target", "//:flowCatalog", "--write"])
    expect(rewritten.exitCode, rewritten.logs).toBe(0)
    expect((await catalogOf(root)).flows[0]!["description"]).toBe(
      "Reviews the uncommitted change and returns two verdicts."
    )
  })

  it("fails the write by id when a declaration names a flow discovery does not find", async () => {
    const root = await fixture("reveiw")
    const result = await serve(root, ["target", "//:flowCatalog", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("discovery did not find: \"reveiw\"")
    await expect(Fs.access(NodePath.join(root, "flows", "catalog.json"))).rejects.toThrow()
  })

  it("names the flows directory when it does not exist", async () => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, "flows"), { recursive: true })
    const result = await serve(root, ["target", "//:flowCatalog", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("could not discover the flows under flows")
  })
})
