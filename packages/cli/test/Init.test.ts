/**
 * `smithers init`, and the repository ignore rule it adds.
 *
 * The 0.x requirement carried forward (`apps/cli/tests/init-root-gitignore.test.js`
 * and `init.e2e.test.js`): run state must never reach a commit, the edit is
 * idempotent, and a directory that is not a repository is left alone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Init from "../src/Init.ts"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

const directory = (kind?: ".git" | ".jj"): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-init-"))
  staged.push(root)
  if (kind !== undefined) mkdirSync(join(root, kind))
  return root
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the ignore rule", () => {
  it("creates a .gitignore holding .flows/ in a repository without one", () => {
    const root = directory(".git")

    expect(Init.ensureIgnored(root)).toBe("created")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".flows/")
  })

  it("appends to an existing file exactly once", () => {
    const root = directory(".git")
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8")

    expect(Init.ensureIgnored(root)).toBe("updated")
    expect(Init.ensureIgnored(root)).toBe("unchanged")
    const contents = readFileSync(join(root, ".gitignore"), "utf8")
    expect(contents.startsWith("node_modules/\n")).toBe(true)
    expect(contents.match(/^\.flows\/$/gm)).toHaveLength(1)
  })

  it("adds a separating newline to a file that does not end in one", () => {
    const root = directory(".git")
    writeFileSync(join(root, ".gitignore"), "node_modules/", "utf8")

    expect(Init.ensureIgnored(root)).toBe("updated")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n# Smithers run state\n.flows/\n")
  })

  it("respects a rule that already covers the path, in any of its spellings", () => {
    for (const rule of [".flows", ".flows/", "/.flows", "/.flows/", "  .flows/  "]) {
      const root = directory(".git")
      writeFileSync(join(root, ".gitignore"), `${rule}\n`, "utf8")

      expect(Init.ensureIgnored(root)).toBe("unchanged")
    }
  })

  it("recognizes a jj-only repository", () => {
    expect(Init.ensureIgnored(directory(".jj"))).toBe("created")
  })

  it("writes nothing outside a repository", () => {
    // A .gitignore in a directory that is not a repository is litter.
    const root = directory()

    expect(Init.ensureIgnored(root)).toBe("skipped")
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
    expect(Init.isRepository(root)).toBe(false)
  })
})

describe("the scaffold", () => {
  it("writes flows/<name>/flow.mdx and ignores .flows/", () => {
    const root = directory(".git")

    const result = Init.scaffold(root, "review")

    expect(result).toMatchObject({ name: "review", created: true, gitignore: "created" })
    expect(result.flowFile).toBe(join(root, "flows", "review", "flow.mdx"))
    const body = readFileSync(result.flowFile, "utf8")
    expect(body).toContain("name: review")
    expect(body).toContain("# review")
  })

  it("never overwrites an existing flow", () => {
    const root = directory(".git")
    Init.scaffold(root, "review")
    writeFileSync(join(root, "flows", "review", "flow.mdx"), "mine\n", "utf8")

    const second = Init.scaffold(root, "review")

    expect(second.created).toBe(false)
    expect(readFileSync(second.flowFile, "utf8")).toBe("mine\n")
  })

  it("leaves behind the .flows/ anchor, so every subdirectory resolves one root", () => {
    const root = directory()
    const result = Init.scaffold(root, "review")
    const nested = join(root, "src", "deep")
    mkdirSync(nested, { recursive: true })

    expect(result.stateDirectory).toBe(join(root, ".flows"))
    expect(existsSync(result.stateDirectory)).toBe(true)
    expect(Project.root(undefined, nested)).toBe(root)
  })

  it("names a flow after the project directory when none is given", () => {
    expect(Init.defaultName("/work/My Project")).toBe("my-project")
    expect(Init.defaultName("/work/api-server/")).toBe("api-server")
    expect(Init.defaultName("/")).toBe("flow")
    expect(Init.defaultName("/work/___")).toBe("flow")
  })
})
