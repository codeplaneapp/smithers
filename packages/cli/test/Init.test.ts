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

    const result = Init.scaffold(root, "review", {})

    expect(result).toMatchObject({ name: "review", created: true, gitignore: "created" })
    expect(result.flowFile).toBe(join(root, "flows", "review", "flow.mdx"))
    const body = readFileSync(result.flowFile, "utf8")
    expect(body).toContain("name: \"review\"")
    expect(body).toContain("# review")
  })

  it("never overwrites an existing flow", () => {
    const root = directory(".git")
    Init.scaffold(root, "review", {})
    writeFileSync(join(root, "flows", "review", "flow.mdx"), "mine\n", "utf8")

    const second = Init.scaffold(root, "review", {})

    expect(second.created).toBe(false)
    expect(readFileSync(second.flowFile, "utf8")).toBe("mine\n")
  })

  it("leaves behind the .flows/ anchor, so every subdirectory resolves one root", () => {
    const root = directory()
    const result = Init.scaffold(root, "review", {})
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

  it.each([
    ["traversal", "../outside"],
    ["absolute path", "/absolute"],
    ["slash separator", "a/b"],
    ["backslash separator", "a\\b"],
    ["YAML metacharacter", "a: b"],
    ["newline", "name\nmodel: evil"],
    ["empty name", ""],
    ["dot segment", "."]
  ])("refuses a %s before creating state", (_label, name) => {
    const root = directory(".git")
    const reason = `a flow name is one path segment of letters, digits, '-' and '_'; got ${JSON.stringify(name)}`

    expect(Init.nameProblem(name)).toBe(reason)
    expect(() => Init.scaffold(root, name, {})).toThrow(reason)
    expect(Init.isValidName(name)).toBe(false)
    expect(existsSync(join(root, "flows"))).toBe(false)
    expect(existsSync(join(root, "outside"))).toBe(false)
    expect(existsSync(join(root, ".flows"))).toBe(false)
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
  })

  it("accepts one segment made from the documented character set", () => {
    expect(Init.nameProblem("review_2-final")).toBeUndefined()
    expect(Init.isValidName("review_2-final")).toBe(true)
  })
})

describe("the seat the scaffold writes", () => {
  it("chooses the first provider key the environment sets, in the order doctor lists them", () => {
    expect(Init.defaultSeat({ ANTHROPIC_API_KEY: "k" })).toEqual({
      seat: "anthropic:claude-sonnet-4-5",
      variable: "ANTHROPIC_API_KEY",
      resolved: true
    })
    expect(Init.defaultSeat({ OPENAI_API_KEY: "k" })).toEqual({
      seat: "openai:gpt-5.6-sol",
      variable: "OPENAI_API_KEY",
      resolved: true
    })
    expect(Init.defaultSeat({ OPENROUTER_API_KEY: "k" })).toEqual({
      seat: "openrouter:anthropic/claude-sonnet-4.5",
      variable: "OPENROUTER_API_KEY",
      resolved: true
    })
    // Doctor's order decides when more than one key is present.
    expect(Init.defaultSeat({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }).seat)
      .toBe("anthropic:claude-sonnet-4-5")
  })

  it("counts the ChatGPT session as the openai credential, and an exported empty key as unset", () => {
    expect(Init.defaultSeat({ SMITHERS_OPENAI_AUTH: "chatgpt" })).toEqual({
      seat: "openai:gpt-5.6-sol",
      variable: "SMITHERS_OPENAI_AUTH",
      resolved: true
    })
    expect(Init.defaultSeat({ FLOWS_OPENAI_AUTH: "chatgpt" }).variable).toBe("SMITHERS_OPENAI_AUTH")
    expect(Init.defaultSeat({ ANTHROPIC_API_KEY: "" }).resolved).toBe(false)
  })

  it("names a seat even when nothing resolves, so the launch refuses by naming its key", () => {
    // `smithers up` on this scaffold answers `Set ANTHROPIC_API_KEY to run the
    // anthropic:claude-sonnet-4-5 seat`. A scaffold with no `model:` line
    // answers nothing an operator can act on.
    expect(Init.defaultSeat({})).toEqual({
      seat: "anthropic:claude-sonnet-4-5",
      variable: "ANTHROPIC_API_KEY",
      resolved: false
    })
  })

  it("skips a provider doctor lists and this host cannot route", () => {
    // `Doctor` names CEREBRAS_API_KEY a provider key and
    // `NodeControl.seatResolver` has no route for the provider, so a scaffold
    // that chose it would write a flow that cannot launch (Phase 7 S3).
    expect(Init.defaultSeat({ CEREBRAS_API_KEY: "k" }).seat).toBe("anthropic:claude-sonnet-4-5")
    expect(Init.defaultSeat({ CEREBRAS_API_KEY: "k" }).resolved).toBe(false)
  })

  it("writes the seat, and the sentence that says how to change it, into the frontmatter", () => {
    const body = Init.template("review", Init.defaultSeat({ OPENAI_API_KEY: "k" }))

    expect(body).toContain("\nmodel: openai:gpt-5.6-sol\n")
    expect(body).toContain("OPENAI_API_KEY")
    expect(body).toContain("smithers doctor")
    // The explanation is a YAML comment, not prose: every line of the body is
    // an instruction the agent is handed.
    const frontmatter = body.split("---")[1] ?? ""
    expect(frontmatter).toContain("# ")
    expect(body.slice(body.indexOf("# review"))).not.toContain("doctor")
  })

  it("round-trips the frontmatter name as a quoted YAML scalar", () => {
    const name = "review_2-final"
    const line = Init.template(name, Init.defaultSeat({})).split("\n")
      .find((candidate) => candidate.startsWith("name: "))

    expect(line).toBe(`name: ${JSON.stringify(name)}`)
    expect(JSON.parse(line!.slice("name: ".length))).toBe(name)
  })

  it("scaffolds the flow the environment can launch", () => {
    const root = directory(".git")

    const result = Init.scaffold(root, "review", { OPENAI_API_KEY: "k" })

    expect(result.seat).toBe("openai:gpt-5.6-sol")
    expect(readFileSync(result.flowFile, "utf8")).toContain("model: openai:gpt-5.6-sol")
  })
})
