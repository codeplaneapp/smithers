/**
 * `smithers mcp add` and `smithers skills add`.
 *
 * The two things worth pinning: writing is additive and idempotent, so an
 * operator's own configuration survives, and the launch command registered is
 * this executable rather than a package runner — 0.x registered
 * `bunx smthrs --mcp`, which pointed every agent at the last published build
 * regardless of what the operator was running.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"

const staged: Array<string> = []

const home = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-agents-"))
  staged.push(directory)
  return directory
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the known agents", () => {
  it("is Claude Code and Codex, and nothing that moved to the plugins repository", () => {
    expect(Agents.agents.map((agent) => agent.id)).toEqual(["claude", "codex"])
    expect(Agents.find("claude")?.mcpConfig).toEqual([".claude.json"])
    expect(Agents.find("hermes")).toBeUndefined()
  })

  it("registers this executable, not a package runner", () => {
    const launch = Agents.launchCommand("/usr/bin/node", "/opt/smithers/bin/smithers.mjs")

    expect(launch).toEqual({ command: "/usr/bin/node", args: ["/opt/smithers/bin/smithers.mjs", "--mcp"] })
    expect(Agents.launchCommand().args).toContain("--mcp")
  })
})

describe("registering the MCP server", () => {
  it("writes the entry and leaves the rest of the configuration alone", () => {
    const directory = home()
    writeFileSync(join(directory, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: {} } }))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ agent: "claude", status: "written" })
    const document = JSON.parse(readFileSync(wired.path, "utf8")) as Record<string, any>
    expect(document.theme).toBe("dark")
    expect(document.mcpServers.other).toEqual({})
    expect(document.mcpServers.smithers.args).toContain("--mcp")
  })

  it("creates the file and its directory when the agent has none", () => {
    const directory = home()

    const wired = Agents.addMcp(Agents.find("codex")!, directory)

    expect(wired.status).toBe("written")
    expect(wired.path).toBe(join(directory, ".codex", "mcp.json"))
    expect(existsSync(wired.path)).toBe(true)
  })

  it("is idempotent", () => {
    const directory = home()
    Agents.addMcp(Agents.find("claude")!, directory)

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("unchanged")
  })

  it("replaces a stale entry that points somewhere else", () => {
    const directory = home()
    writeFileSync(
      join(directory, ".claude.json"),
      JSON.stringify({ mcpServers: { smithers: { command: "bunx", args: ["smthrs", "--mcp"] } } })
    )

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("written")
  })

  it("treats an unparseable configuration as empty rather than failing", () => {
    const directory = home()
    writeFileSync(join(directory, ".claude.json"), "{ not json")

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("written")
  })

  it("reports a configuration it cannot write", () => {
    const directory = home()
    // A directory where the file should be: the write fails, and the operator
    // gets the manual instructions instead of a silent success.
    mkdirSync(join(directory, ".claude.json"))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    expect(wired.reason).toBeDefined()
  })

  it("prints instructions with the separator an agent CLI needs", () => {
    const instructions = Agents.manualInstructions(["claude"])

    // Without `--` the agent's own parser reads `--mcp` as one of its flags
    // and rejects the registration.
    expect(instructions).toContain("claude mcp add smithers -- ")
    expect(instructions).toContain("\"mcpServers\"")
    expect(instructions).toContain("https://smithers.sh/integrations/mcp-server")
    expect(Agents.manualInstructions()).toContain("codex mcp add smithers -- ")
  })
})

describe("the smithers skill", () => {
  it("is the curated file this repository ships, not a rendering of the verb table", () => {
    const curated = Agents.skill()

    expect(curated._tag).toBe("found")
    if (curated._tag !== "found") return
    expect(curated.contents).toBe(readFileSync(curated.path, "utf8"))
    expect(curated.contents).toContain("name: smithers")
    // The curated skill teaches what a verb list cannot: the routing rules and
    // the verbs 1.0 removed. A generated stub carries neither.
    expect(curated.contents).toContain("SMITHERS_INSIDE_RUN")
    expect(curated.contents).toContain("### Removed in 1.0")
  })

  it("prefers the packaged copy, and falls back to the curated source in a checkout", () => {
    const directory = home()
    const docs = join(directory, "packages", "cli", "docs")
    mkdirSync(docs, { recursive: true })
    mkdirSync(join(directory, "skills", "smithers"), { recursive: true })
    writeFileSync(join(directory, "skills", "smithers", "SKILL.md"), "checkout", "utf8")

    expect(Agents.skill(docs)).toMatchObject({ _tag: "found", contents: "checkout" })

    writeFileSync(join(docs, "SKILL.md"), "packaged", "utf8")

    expect(Agents.skill(docs)).toMatchObject({ _tag: "found", contents: "packaged" })
  })

  it("reports a missing curated skill rather than installing something else", () => {
    const docs = join(home(), "packages", "cli", "docs")

    const curated = Agents.skill(docs)

    expect(curated._tag).toBe("missing")
    if (curated._tag !== "missing") return
    expect(curated.searched).toEqual(Agents.skillSources(docs))
    expect(Agents.skillMissing(curated.searched)).toContain("pnpm docs:llms")
  })

  it("installs, reports where, and is idempotent", () => {
    const directory = home()
    const contents = "the curated skill"

    const first = Agents.addSkill(Agents.find("claude")!, contents, directory)

    expect(first).toMatchObject({ agent: "claude", status: "written" })
    expect(first.path).toBe(join(directory, ".claude", "skills", "smithers", "SKILL.md"))
    expect(readFileSync(first.path, "utf8")).toBe(contents)
    expect(Agents.addSkill(Agents.find("claude")!, contents, directory).status).toBe("unchanged")
    expect(Agents.listSkills(directory)).toEqual([
      { agent: "claude", path: first.path, installed: true },
      { agent: "codex", path: join(directory, ".codex", "skills", "smithers", "SKILL.md"), installed: false }
    ])
  })

  it("reports a skill directory it cannot write", () => {
    const directory = home()
    mkdirSync(join(directory, ".claude", "skills", "smithers"), { recursive: true })
    mkdirSync(join(directory, ".claude", "skills", "smithers", "SKILL.md"))

    expect(Agents.addSkill(Agents.find("claude")!, "x", directory).status).toBe("failed")
  })
})
