import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { describe, expect, it } from "vitest"
import { agentArguments, formattedLogArguments, legacyArguments } from "../src/cli/Compatibility.ts"
import * as Presentation from "../src/cli/Presentation.ts"

const fixture = (audience: "human" | "agent", tty = true, silent = false) => {
  const output: Array<string> = []
  const progress: Array<string> = []
  const presentation = Audience.resolve({ audience, env: {}, stdout: tty, stderr: tty, stdin: tty, silent })
  const runtime: RuntimeConfig = {
    environment: {},
    presentation,
    stdout: {
      write: (text) => {
        output.push(text)
      },
      isTTY: tty,
      columns: 80
    },
    stderr: {
      write: (text) => {
        progress.push(text)
      },
      isTTY: tty,
      columns: 80
    }
  }
  return { runtime, output, progress }
}
const ok = (data: unknown, meta?: unknown): never => ({ data, meta }) as never

describe("shared command presentation", () => {
  it("keeps agent PTY output structured with bounded contextual Incur CTAs", async () => {
    const host = fixture("agent")
    let result: unknown
    await Presentation.scope({ command: "flow start", globals: { audience: "auto" } }, host.runtime, async () => {
      result = Presentation.finish({ ok, options: { root: "/project", credential: "never-echo-this" } }, {
        runId: "run-1",
        _tag: "Accepted"
      })
    })
    expect(host.output).toEqual([])
    expect(host.progress).toEqual([])
    expect(result).toMatchObject({
      data: { runId: "run-1" },
      meta: {
        cta: {
          commands: [
            { command: "runs show run-1 --root /project" },
            { command: "runs logs run-1 --format jsonl --root /project" }
          ]
        }
      }
    })
    expect(JSON.stringify(result)).not.toContain("never-echo-this")
  })
  it("renders human results even when silent, without returning a second Incur document", async () => {
    const host = fixture("human", true, true)
    let result: unknown
    await Presentation.scope({ command: "runs show" }, host.runtime, async () => {
      result = Presentation.finish({ ok }, { runId: "run-1", status: "completed" })
    })
    expect(host.output.join("")).toContain("status: completed")
    expect(host.output.join("")).not.toContain("\u001b")
    expect(host.progress).toEqual([])
    expect(result).toMatchObject({ data: undefined })
  })
  it("never changes explicit JSON data or array response shapes", async () => {
    const host = fixture("human")
    const list = [{ key: "hello", value: "world" }]
    await Presentation.scope({ command: "memory facts list", formatExplicit: true }, host.runtime, async () => {
      expect(Presentation.finish({ ok }, list)).toBe(list)
    })
    expect(host.output).toEqual([])
  })
  it("isolates concurrent invocations without mutating terminal or environment state", async () => {
    const human = fixture("human", true, true)
    const agent = fixture("agent")
    await Promise.all([
      Presentation.scope({ command: "doctor" }, human.runtime, async () => {
        await Promise.resolve()
        expect(Presentation.current()?.policy.audience).toBe("human")
        Presentation.finish({ ok }, { root: "/human", checks: [] })
      }),
      Presentation.scope({ command: "flow list" }, agent.runtime, async () => {
        await Promise.resolve()
        expect(Presentation.current()?.policy.audience).toBe("agent")
        Presentation.finish({ ok }, { items: [] })
      })
    ])
    expect(Presentation.current()).toBeUndefined()
    expect(human.output.join("")).toContain("/human")
    expect(agent.output).toEqual([])
  })
  it("does not put credentials or whole approval payloads in next actions", () => {
    const actions = Presentation.nextActions("flow plan", { approval: { secret: "private" } }, {
      options: { remote: "https://user:secret@example.invalid/?token=secret", credential: "private" }
    })
    expect(actions).toHaveLength(2)
    expect(JSON.stringify(actions)).not.toMatch(/secret|private|example/)
  })

  it.each(
    [
      ["flow list", { items: [{ flowId: "review" }] }, ["flow show review", "flow plan --help"]],
      ["flow list", { items: [] }, ["flow plan --help"]],
      ["runs list", {}, ["runs list"]],
      ["init", {}, ["targets", "flow list"]],
      ["generate package", {}, ["targets", "flow list"]],
      ["triggers create", {}, ["triggers list", "triggers show --help"]],
      ["approvals approve", {}, ["runs list"]],
      ["doctor", {}, ["info"]],
      ["credentials set", {}, ["credentials list"]],
      ["eval run", {}, ["eval compare --help"]],
      ["memory remember", {}, ["memory recall --help"]],
      ["integrations add", {}, ["integrations list"]],
      ["info", {}, []]
    ] as const
  )("provides usable next actions after %s", (command, result, expected) => {
    expect(Presentation.nextActions(command, result).map((action) => action.command)).toEqual(expected)
  })

  it("quotes run and connection arguments without exposing authenticated URLs", () => {
    const actions = Presentation.nextActions("runs show", { status: "waiting-approval" }, {
      args: { run: "run one's" },
      options: { root: "/a project", remote: "https://example.invalid/api" }
    })
    expect(actions.map((action) => action.command)).toEqual([
      "runs logs 'run one'\\''s' --format jsonl --root '/a project' --remote https://example.invalid/api",
      "approvals list --root '/a project' --remote https://example.invalid/api"
    ])
    for (const remote of ["not a url", "https://example.invalid/#secret", "https://example.invalid/?key=secret"]) {
      expect(Presentation.nextActions("runs show", { runId: "run-1" }, { options: { remote } }))
        .toEqual([{ command: "runs logs run-1 --format jsonl", description: "Read detailed events only when needed" }])
    }
  })

  it("retains bounded approval guidance for a parked run and ignores non-record results", () => {
    expect(Presentation.nextActions("flow start", { runId: "run-1", _tag: "Parked" }).map((action) => action.command))
      .toEqual(["runs show run-1", "runs logs run-1 --format jsonl", "approvals list"])
    for (const value of [null, undefined, [], "run-1", 0]) {
      expect(Presentation.nextActions("info", value)).toEqual([])
    }
  })

  it("preserves raw results outside a rendering invocation or without an ok adapter", async () => {
    const value = { runId: "run-1" }
    expect(Presentation.finish({ ok }, value)).toBe(value)
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "runs show" }, host.runtime, async () => {
      expect(Presentation.finish({}, value)).toBe(value)
      expect(Presentation.finish({ ok }, undefined)).toBeUndefined()
    })
    expect(host.output).toEqual([])
  })

  it("keeps structured results intact when no continuation applies", async () => {
    const host = fixture("agent")
    const value = { version: "1.0.0" }
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      expect(Presentation.finish({ ok }, value)).toBe(value)
    })
    expect(host.output).toEqual([])
  })

  it("limits human summaries by entry count and depth while retaining complete JSON results", async () => {
    const host = fixture("human", true, true)
    const details = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, index]))
    const value = { details, empty: [], nested: { deeper: { leaf: { secret: "not-rendered" }, array: [1, 2] } } }
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, value)
    })
    expect(host.output.join("")).toBe(
      "info\ndetails\n" +
        Array.from({ length: 18 }, (_, index) => `  key${index}: ${index}`).join("\n") +
        "\n  … 2 more; use --json for full details\nempty: none\nnested\n  deeper\n    leaf\n" +
        "      Use --json for full details\n    array\n      2 items\n"
    )
    expect(value.details["key19"]).toBe(19)
    expect(value.nested.deeper.array).toEqual([1, 2])
  })

  it("sanitizes terminal controls and limits a primitive result to 500 characters", async () => {
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, "\u001b[31mred\u001b[0m\u0007\u202e" + "x".repeat(600))
    })
    expect(host.output.join("")).toBe(`info\nred ${"x".repeat(496)}\n`)
  })

  it("renders an empty result as Done and formats top-level arrays consistently", async () => {
    const host = fixture("human", true, true)
    await Presentation.scope({ command: "info" }, host.runtime, async () => {
      Presentation.finish({ ok }, {})
      Presentation.finish({ ok }, ["first", null])
    })
    expect(host.output.join("")).toBe("info\nDone\ninfo\n1: first\n2: null\n")
  })

  it("normalizes MCP command names and releases context after a failed invocation", async () => {
    const host = fixture("human")
    const failure = new Error("command failed")
    await expect(Presentation.scope({ command: "runs_show", request: {} }, host.runtime, async () => {
      expect(Presentation.current()?.command).toBe("runs show")
      expect(Presentation.current()?.policy.structured).toBe(true)
      throw failure
    })).rejects.toBe(failure)
    expect(Presentation.current()).toBeUndefined()
    expect(host.output).toEqual([])
  })
})

describe("agent-friendly compatibility spellings", () => {
  it("routes familiar bot commands to canonical results", () => {
    expect(agentArguments(["up", "hello", "--silent"])).toEqual(["flow", "start", "hello", "--silent"])
    expect(formattedLogArguments(["logs", "run-1", "--format", "jsonl", "--after", "4", "--limit", "2"]))
      .toEqual(["runs", "logs", "run-1", "--format", "jsonl", "--after", "4", "--limit", "2"])
    expect(formattedLogArguments(["--audience", "human", "--format=jsonl", "logs", "run-1"]))
      .toEqual(["runs", "logs", "--audience", "human", "--format=jsonl", "run-1"])
    expect(formattedLogArguments(["logs", "run-1"])).toBeUndefined()
    expect(formattedLogArguments(["logs", "run-1", "--json"])).toBeUndefined()
    expect(formattedLogArguments(["logs", "run-1", "--format", "jsonl", "--backend=sqlite"])).toBeUndefined()
    expect(formattedLogArguments(["--backend", "sqlite", "logs", "run-1", "--format", "jsonl"])).toBeUndefined()
    expect(legacyArguments(["init", "change", "--global"]))
      .toEqual(["init", "change", "--global"])
    expect(agentArguments(["--audience", "agent", "ps"])).toEqual(["runs", "list", "--audience", "agent"])
    expect(legacyArguments(["--audience", "human", "up", "hello", "--silent"])).toBeDefined()
  })
  it("preserves explicit legacy machine contracts and removed-option diagnostics", () => {
    expect(agentArguments(["up", "hello", "--json"])).toBeUndefined()
    expect(agentArguments(["ps", "--quiet"])).toBeUndefined()
    expect(agentArguments(["up", "hello", "--serve"])).toBeUndefined()
    expect(agentArguments(["internal", "claude", "tick"])).toBeUndefined()
    expect(agentArguments(["up", "--help"])).toBeUndefined()
  })
})
