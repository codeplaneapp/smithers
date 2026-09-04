import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Markdown from "../src/Markdown.ts"
import * as Placement from "../src/Placement.ts"

describe("Markdown", () => {
  it("lowers markdown to an ordinary callable flow without executing its body", () => {
    const flow = Markdown.lowerMarkdown({}, "Summarize the supplied arguments.")

    expect(typeof flow).toBe("function")
    expect(flow({ args: "hello" }).ast._tag).toBe("FlowCall")
    expect(flow.effects).toBeUndefined()
  })

  it("forwards the markdown body as the dynamic prompt and applies defaults", () => {
    const flow = Markdown.lowerMarkdown({}, "The markdown prompt.")
    const node = flow.body?.({ args: "" })

    expect(node?.ast).toMatchObject({
      _tag: "Dynamic",
      model: "smart",
      flows: [],
      prompt: "The markdown prompt."
    })
    expect(flow.implementation).toEqual({
      _tag: "Dynamic",
      model: "smart",
      flows: [],
      prompt: "The markdown prompt."
    })
  })

  it("normalizes capability and effect declarations", () => {
    const flow = Markdown.lowerMarkdown({
      capabilities: ["shell", "shell", "git"],
      effects: {
        reads: ["src", "src"],
        writes: ["dist", "dist"],
        mode: "expected",
        onConflict: "lane"
      }
    }, "Prompt")

    expect(flow.capabilities).toEqual(["git", "shell"])
    expect(flow.effects).toEqual(Effects.make({
      reads: ["src", "src"],
      writes: ["dist", "dist"],
      mode: "expected",
      onConflict: "lane"
    }))
  })

  it("places the lowered flow using its ordinary placement annotation", () => {
    const flow = Markdown.lowerMarkdown({ placement: "sandbox" }, "Prompt")

    expect(Option.getOrThrow(Annotations.getOption(flow.annotations, Annotations.Placement))).toEqual(
      Placement.sandbox()
    )
  })

  it("has the same structure as an equivalent hand-written flow", () => {
    const markdown = Markdown.lowerMarkdown({
      name: "markdown-flow",
      description: "A markdown flow",
      model: "small",
      flows: ["search"],
      capabilities: ["network"],
      effects: { reads: ["docs"] }
    }, "Prompt")
    const handwritten = Flow.make({
      name: "markdown-flow",
      description: "A markdown flow",
      input: Schema.Struct({ args: Schema.String }),
      output: Schema.String,
      capabilities: ["network"],
      effects: Effects.make({
        reads: ["docs"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize"
      }),
      model: "small",
      flows: ["search"],
      prompt: "Prompt"
    })

    expect(Graph.nodes(Graph.build(markdown))).toEqual(Graph.nodes(Graph.build(handwritten)))
  })

  it("returns a stable code when SKILL.md frontmatter is incomplete", () => {
    const result = Markdown.parseSkill("---\nname: example\n---\n")

    expect(Result.isFailure(result) && result.failure.code).toBe("skill_missing_description")
  })

  it("keeps untyped skill extras out of lowering and uses the smart default seat", () => {
    const flow = Result.getOrThrow(Markdown.lowerSkill(
      "---\nname: example\ndescription: Example skill\nmodel: fast\nplacement: remote\n---\nPrompt"
    ))

    // lowerSkill's JSDoc keeps untyped extras at the parse boundary, so lowerMarkdown supplies its documented default.
    expect(flow.implementation).toMatchObject({ _tag: "Dynamic", model: "smart" })
  })
})
