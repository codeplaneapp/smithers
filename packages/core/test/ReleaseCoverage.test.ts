import { describe, expect, it, vi } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Markdown from "../src/Markdown.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

describe("release coverage", () => {
  it("reports exact unnamed-flow errors for calls and graph builds", () => {
    const flow = Flow.make({})
    Object.defineProperty(flow, "name", { configurable: true, value: undefined })

    for (
      const [operation, message] of [
        [() => flow(undefined), "Cannot call a flow without a body"],
        [() => Graph.build(flow), "Cannot build a flow without a body"]
      ] as const
    ) {
      try {
        operation()
        throw new Error("expected the declaration-only flow to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(Flow.FlowError)
        expect(error).toMatchObject({ code: "missing_body", message })
      }
    }
  })

  it("rebinds a dynamic flow that omits both optional prompt fields", () => {
    const rebound = Flow.withFlows(Flow.make({ flows: ["old"] }), ["new"])
    const ast = rebound.body?.(undefined).ast

    expect(ast).toMatchObject({ _tag: "Dynamic", flows: ["new"] })
    expect(ast === undefined || "model" in ast).toBe(false)
    expect(ast === undefined || "prompt" in ast).toBe(false)
  })

  it("uses the empty read set when markdown effects omit reads", () => {
    const flow = Markdown.lowerMarkdown({ effects: {} }, "Prompt")

    expect(flow.effects).toMatchObject({ reads: [], writes: [] })
  })

  it.each(
    [
      ["remote", Placement.remote()],
      ["client", Placement.client()],
      ["local", Placement.local()]
    ] as const
  )("lowers the %s markdown placement", (placement, expected) => {
    const flow = Markdown.lowerMarkdown({ placement }, "Prompt")

    expect(Graph.placements(Graph.build(flow))).toEqual([{ nodeId: "root", placement: expected }])
  })

  it("rejects a non-scalar allowed-tools value with the exact public error", () => {
    const result = Markdown.parseSkill(
      "---\nname: example\ndescription: Example\nallowed-tools:\n  nested: value\n---\nPrompt"
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_invalid_allowed_tools",
        message: "SKILL.md allowed-tools must be a space-separated scalar"
      }
    })
  })

  it("treats an unclosed fence as missing frontmatter", () => {
    const result = Markdown.parseSkill("---\nname: example\ndescription: Example\nPrompt")

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_missing_frontmatter",
        message: "SKILL.md requires leading frontmatter"
      }
    })
  })

  it("rejects sequence frontmatter as a non-mapping", () => {
    const result = Markdown.parseSkill("---\n- example\n- description\n---\nPrompt")

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_invalid_frontmatter",
        message: "Skill frontmatter must be a YAML mapping"
      }
    })
  })

  it("detects a Node.all object whose keys change during construction", () => {
    const source = { retained: Node.succeed(1) }
    let enumerations = 0
    const unstable = new Proxy(source, {
      ownKeys: () => ++enumerations === 1 ? ["retained"] : ["retained", "appeared"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "appeared"
          ? { configurable: true, enumerable: true, value: Node.succeed(2), writable: true }
          : Reflect.getOwnPropertyDescriptor(target, key)
    })

    try {
      Node.all(unstable)
      throw new Error("expected changing keys to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(Node.NodeBuildError)
      expect(error).toMatchObject({
        code: "invalid_all_member",
        member: "*",
        message: "Node.all could not retain every member"
      })
    }
  })
})
