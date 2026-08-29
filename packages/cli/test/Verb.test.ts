/**
 * The rc.0 command surface, pinned.
 *
 * rc-contract section 4 is a closed list in both directions: section 4.1 names
 * every verb that ships and section 4.2 names every verb that was removed. A
 * verb that appears in neither, or in both, is a contract change, and this
 * suite is where it has to be made deliberately.
 */
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const subcommandNames = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
const listed = cli.subcommands.flatMap((group) =>
  group.commands.filter((command) => !command.unlisted).map((command) => command.name)
)

describe("the shipped surface", () => {
  it("is exactly rc-contract section 4.1", () => {
    expect(Verb.shipped.map((verb) => verb.name)).toEqual([
      "plan",
      "run",
      "up",
      "approve",
      "deny",
      "cancel",
      "signal",
      "steer",
      "ls",
      "ps",
      "status",
      "logs",
      "output",
      "down",
      "serve",
      "init",
      "doctor",
      "docs",
      "migrate",
      "gc",
      "memory",
      "claude",
      "mcp",
      "skills",
      "update",
      "bug",
      "completions"
    ])
  })

  it("registers every shipped verb as a subcommand, except the built-in one", () => {
    // `completions` is `effect/unstable/cli`'s own `--completions <shell>`
    // global flag, not a subcommand of ours.
    expect(Verb.subcommands.map((verb) => verb.name)).toEqual(
      Verb.shipped.filter((verb) => verb.name !== "completions").map((verb) => verb.name)
    )
    for (const verb of Verb.subcommands) expect(subcommandNames).toContain(verb.name)
  })

  it("shows only section 4.1 verbs in --help", () => {
    // Aliases and every removed verb are registered but unlisted, so the help
    // surface is the contract's list and nothing else.
    expect(listed.slice().sort()).toEqual(Verb.subcommands.map((verb) => verb.name).slice().sort())
  })

  it("keeps exactly the six surviving aliases", () => {
    expect(Verb.shipped.flatMap((verb) => verb.aliases)).toEqual([
      "resume",
      "workflow list",
      "inspect",
      "why",
      "events",
      "gateway"
    ])
  })

  it("names the reserved system flow for every verb the control catalog reserves", () => {
    expect(Verb.find("plan")?.flowId).toBe("system/plan")
    expect(Verb.find("serve")?.flowId).toBe("system/serve")
    // `gc` and `memory` are Phase 4 verbs with no reserved flow at all.
    expect(Verb.find("gc")?.flowId).toBeUndefined()
    expect(Verb.find("nonexistent")).toBeUndefined()
  })
})

describe("the removed surface", () => {
  it("is exactly rc-contract section 4.2", () => {
    expect(Unsupported.removedVerbs.map((verb) => verb.name)).toEqual([
      "replay",
      "rewind",
      "fork",
      "timetravel",
      "snapshots",
      "restore",
      "snapshot-hook",
      "revert",
      "retry-task",
      "tree",
      "graph",
      "timeline",
      "diff",
      "worktrees",
      "hijack",
      "pause",
      "ui",
      "gui",
      "monitor",
      "supervise",
      "supervisor",
      "top",
      "eval",
      "optimize",
      "scores",
      "chat",
      "chat-create",
      "what",
      "ask",
      "agents",
      "usage",
      "claude-shell",
      "hermes",
      "listeners",
      "observability",
      "alerts",
      "herdr",
      "openapi",
      "token",
      "cron",
      "make-workflow",
      "starters",
      "share",
      "add",
      "remove",
      "eject",
      "upgrade",
      "packs",
      "human",
      "ask-human",
      "node",
      "tail",
      "review",
      "release",
      "test",
      "docs-full",
      "list-runs",
      "runs",
      "list",
      "workflows",
      "stop",
      "kill",
      "start",
      "exec",
      "show",
      "log",
      "help"
    ])
  })

  it("registers every removed verb, hidden, and never as a shipped one", () => {
    const shipped = new Set(Verb.shipped.map((verb) => verb.name))
    for (const verb of Unsupported.removedVerbs) {
      // `workflows` is answered by the `workflow` command, which keeps
      // `workflow list` alive as the `ls` alias.
      const registered = verb.name === "workflows" ? "workflow" : verb.name
      expect(subcommandNames).toContain(registered)
      expect(listed).not.toContain(registered)
      expect(shipped.has(verb.name)).toBe(false)
    }
  })

  it("gives every removal a reason and a migration link", () => {
    for (const verb of Unsupported.removedVerbs) {
      const message = Unsupported.verbError(verb).message
      expect(message).toContain(`smithers ${verb.name} was removed in 1.0.0-rc.0`)
      expect(message).toContain(verb.reason)
      expect(message).toContain(`${Unsupported.migrationUrl}#${verb.name}`)
    }
  })

  it("names the sub-verb in a group's message and anchors on the group", () => {
    const worktrees = Unsupported.removedVerbs.find((verb) => verb.name === "worktrees")!

    expect(worktrees.subcommands).toEqual(["list", "prune"])
    expect(Unsupported.verbError(worktrees, "prune").message).toContain("smithers worktrees prune was removed")
    expect(Unsupported.verbError(worktrees, "prune").message).toContain("#worktrees")
  })

  it("keeps `ls` and `status` out of the removed set: they are real rc.0 verbs", () => {
    const removed = new Set(Unsupported.removedVerbs.map((verb) => verb.name))

    expect(removed.has("ls")).toBe(false)
    expect(removed.has("status")).toBe(false)
  })
})
