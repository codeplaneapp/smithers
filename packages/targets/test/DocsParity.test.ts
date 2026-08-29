import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Executor from "../../build-cli/src/Executor.ts"
import * as Planner from "../../build-cli/src/Planner.ts"
import { Workspace } from "../../build-cli/src/Workspace.ts"
import * as DocsParity from "../src/DocsParity.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

const badges = [
  "# my-package",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/build)",
  "[![npm](https://img.shields.io/npm/v/my-package)](https://npm.example/my-package)",
  ""
].join("\n")

const real = [
  "# my-package",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/build)",
  "",
  "The package turns a declared plan into a keyed, cacheable target graph and",
  "reports every step it skipped, so a rebuild explains itself rather than",
  "silently reusing an answer.",
  "",
  "## Install",
  "",
  "```sh",
  "pnpm add my-package",
  "```"
].join("\n")

describe("DocsParity.summarize", () => {
  it("reads the first level-one heading as the title", () => {
    expect(DocsParity.summarize(real).title).toBe("my-package")
    expect(DocsParity.summarize("## only a subheading\n").title).toBeUndefined()
    expect(DocsParity.summarize("#not-a-heading\n").title).toBeUndefined()
  })

  it("counts no prose in a README that is a title over a badge row", () => {
    expect(DocsParity.summarize(badges)).toEqual({ title: "my-package", proseCharacters: 0 })
  })

  it("counts the prose a reader would actually read", () => {
    const summary = DocsParity.summarize(real)
    expect(summary.title).toBe("my-package")
    expect(summary.proseCharacters).toBeGreaterThan(DocsParity.defaultMinimumProseCharacters)
  })

  it("ignores headings, lists, quotes, tables, and thematic breaks", () => {
    const text = [
      "# t",
      "",
      "## heading",
      "",
      "- a list item that is quite long but is still not prose at all",
      "",
      "> a blockquote that is quite long but is still not prose at all",
      "",
      "| a | b |",
      "| - | - |",
      "",
      "---"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("ignores tables without leading pipes and indented code", () => {
    const text = [
      "# t",
      "",
      "name | role",
      "--- | ---",
      "alpha | producer",
      "",
      "    const proseLookingName = 'this is code, not a paragraph'"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("ignores fenced code even when it contains blank lines and prose", () => {
    const text = [
      "# t",
      "",
      "```ts",
      "const a = 1",
      "",
      "// this comment is long enough to look like prose if it were counted",
      "```"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("closes a fence only with the same marker and sufficient length", () => {
    const text = [
      "# t",
      "",
      "````ts",
      "~~~",
      "this still belongs to the code block even though it looks like prose",
      "```",
      "this also belongs to the four-backtick code block",
      "````"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("keeps link text and drops link targets, images, and markers", () => {
    expect(DocsParity.summarize("# t\n\nSee [the plan](https://example.com/a/very/long/target).\n"))
      .toEqual({ title: "t", proseCharacters: "See the plan.".length })
    expect(DocsParity.summarize("# t\n\n`code` and *emphasis* and _more_.\n").proseCharacters)
      .toBe("code and emphasis and more.".length)
  })

  it("counts no prose in reference definitions or bare-link paragraphs", () => {
    const text = [
      "# t",
      "",
      "[build]: https://ci.example/a/very/long/path/that/is/not/documentation",
      "",
      "https://example.com/a/very/long/path/that/is/not/documentation"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })
})

describe("DocsParity", () => {
  const target = DocsParity.DocsParity({ readme: { _tag: "File", path: "README.md" }, deps: [], cwd: "packages/plan" })

  it("participates in the docs verb alone, never in build, test, or lint", () => {
    expect(Target.metadata(target).kinds).toEqual(["docs"])
    expect(DocsParity.DocsParity.kinds).toEqual(["docs"])
  })

  it("declares the README as a build input so editing it re-keys the target", () => {
    expect(Target.metadata(target).inputs).toContainEqual({ _tag: "File", path: "README.md" })
  })

  it("defaults the prose floor and stays cacheable", () => {
    const metadata = Target.metadata(target)
    expect((metadata.attrs as DocsParity.Attrs).minimumProseCharacters).toBe(
      DocsParity.defaultMinimumProseCharacters
    )
    expect(metadata.cacheable).toBe(true)
  })

  it("refuses a prose floor that would let an empty body pass", () => {
    expect(() =>
      DocsParity.DocsParity({
        readme: { _tag: "File", path: "README.md" },
        deps: [],
        minimumProseCharacters: 0,
        cwd: "packages/plan"
      })
    ).toThrow()
    expect(() =>
      DocsParity.DocsParity({
        readme: { _tag: "File", path: "README.md" },
        deps: [],
        minimumProseCharacters: DocsParity.maximumReadmeBytes + 1,
        cwd: "packages/plan"
      })
    ).toThrow()
  })
})

describe("StandardPackage", () => {
  const targets = StandardPackage({ packageManager, deps: [], cwd: "packages/plan" })

  it("emits a docs target beside lib, test, and lint", () => {
    expect(Target.metadata(targets.docs).target).toBe("DocsParity")
    expect(Target.metadata(targets.docs).kinds).toEqual(["docs"])
  })

  it("keeps docs as a separately planned target kind", () => {
    for (const target of [targets.lib, targets.test, targets.lint]) {
      expect(Target.metadata(target).kinds).not.toContain("docs")
    }
  })
})

describe("DocsParity execution", () => {
  it("confines and bounds README reads", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-read-")))
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-outside-")))
    const request = (path: string) =>
      DocsParity.checkDocs(
        { workspaceRoot: root },
        { path, minimumProseCharacters: 1 }
      )
    const failed = (path: string) =>
      Effect.runPromise(
        Effect.flip(request(path).pipe(Effect.mapError((error) => ({ message: error.message }))))
      )
    try {
      expect((await failed("../README.md")).message).toContain("escapes the workspace")
      await Fs.writeFile(NodePath.join(root, "large.bin"), Buffer.alloc(DocsParity.maximumReadmeBytes + 1, 0x20))
      expect((await failed("large.bin")).message).toContain(`larger than ${DocsParity.maximumReadmeBytes} bytes`)
      await Fs.writeFile(NodePath.join(outside, "README.md"), "# outside\n\nEnough prose.\n", "utf8")
      await Fs.symlink(NodePath.join(outside, "README.md"), NodePath.join(root, "README.md"))
      expect((await failed("README.md")).message).toContain("leaving the workspace")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("runs passing checks and reports failing packages across //...", async () => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-parity-"))
    const write = async (relative: string, text: string): Promise<void> => {
      const path = NodePath.join(root, relative)
      await Fs.mkdir(NodePath.dirname(path), { recursive: true })
      await Fs.writeFile(path, text, "utf8")
    }
    try {
      await write("BUILD.ts", "export const root = 1\n")
      await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
      const rulesModule = NodePath.resolve(import.meta.dirname, "../src/Smithers.ts")
      for (const name of ["complete", "stub"]) {
        await write(
          `packages/${name}/BUILD.ts`,
          `import { PackageManager, Runtime, StandardPackage } from "${rulesModule}"\n` +
            `const runtime = Runtime.Node({ version: ">=22.19.0" })\n` +
            `const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })\n` +
            `export const { docs } = StandardPackage({ packageManager, deps: [], cwd: "packages/${name}" })\n`
        )
      }
      await write(
        "packages/complete/README.md",
        "# complete\n\n" +
          "This package description is intentionally long enough to establish the package contract, " +
          "its role in the workspace, and the behavior consumers can rely on when they call it.\n"
      )
      await write("packages/stub/README.md", "# stub\n\n[reference]: https://example.com/not-prose\n")

      let workspace: Awaited<ReturnType<typeof Workspace.make>>
      let plan: Awaited<ReturnType<typeof Planner.make>>
      try {
        workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
        plan = await Planner.make(workspace, "docs", "//...")
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`docs planning rejected: ${message}`)
      }
      let summary: Awaited<ReturnType<typeof Executor.execute>>
      try {
        summary = await Executor.execute({
          workspace,
          verb: "docs",
          pattern: "//...",
          targets: plan.targets,
          jobs: 2,
          readCache: false,
          log: () => {}
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`docs execution rejected instead of reporting a target failure: ${message}`)
      }

      expect(summary.ok).toBe(false)
      expect(summary.results.find((entry) => entry.label === "//packages/complete:docs")?.status).toBe("ran")
      expect(summary.results.find((entry) => entry.label === "//packages/stub:docs")?.status).toBe("failed")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
