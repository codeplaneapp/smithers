import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Markdown from "../src/Markdown.ts"

const parse = (text: string): Markdown.SkillDocument => Result.getOrThrow(Markdown.parseSkill(text))

const errorCode = (text: string): Markdown.MarkdownErrorCode => {
  const result = Markdown.parseSkill(text)
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure.code : "skill_invalid_frontmatter"
}

describe("Skill", () => {
  it("parses quoted scalars and a whitespace-separated hyphenated allowed-tools key", () => {
    const skill = parse(
      "---\nname: 'pdf''s'\ndescription: \"Extract\\nfiles\"\nallowed-tools: Read Bash(pdfinfo:*)\n---\nPrompt"
    )

    expect(skill).toMatchObject({
      name: "pdf's",
      description: "Extract\nfiles",
      allowedTools: ["Read", "Bash(pdfinfo:*)"]
    })
  })

  it("parses flow sequences", () => {
    const skill = parse(
      "---\nname: pdf\ndescription: Extract files\nallowed-tools: [Read, \"Write\", 'Bash(qpdf:*)']\n---\nPrompt"
    )

    expect(skill.allowedTools).toEqual(["Read", "Write", "Bash(qpdf:*)"])
  })

  it("parses block sequences", () => {
    const skill = parse(
      "---\nname: pdf\ndescription: Extract files\nallowed-tools:\n  - Read\n  - 'Bash(pdfinfo:*)'\n---\nPrompt"
    )

    expect(skill.allowedTools).toEqual(["Read", "Bash(pdfinfo:*)"])
  })

  it("parses folded and literal YAML block scalars", () => {
    const skill = parse([
      "---",
      "name: document-review",
      "description: >-",
      "  Reviews a document for correctness,",
      "  clarity, and missing evidence.",
      "allowed-tools: >-",
      "  Read",
      "  Grep",
      "metadata:",
      "  instructions: |-",
      "    Keep citations.",
      "    Report uncertainty.",
      "---",
      "Review the supplied document."
    ].join("\n"))

    expect(skill.description).toBe("Reviews a document for correctness, clarity, and missing evidence.")
    expect(skill.allowedTools).toEqual(["Read", "Grep"])
    expect(skill.extra.metadata).toEqual({
      instructions: "Keep citations.\nReport uncertainty."
    })
  })

  it("accepts a UTF-8 BOM and CRLF fences without normalizing the body", () => {
    const skill = parse(
      "\uFEFF---\r\nname: pdf\r\ndescription: Extract files\r\nallowed-tools: [Read, Write]\r\n---\r\nLine one\r\n\r\nLine two"
    )

    expect(skill.allowedTools).toEqual(["Read", "Write"])
    expect(skill.body).toBe("Line one\r\n\r\nLine two")
  })

  it("fails when frontmatter is missing", () => {
    expect(errorCode("# PDF\n")).toBe("skill_missing_frontmatter")
  })

  it("fails when name is missing", () => {
    expect(errorCode("---\ndescription: Extract files\n---\nPrompt")).toBe("skill_missing_name")
  })

  it("fails when description is missing", () => {
    expect(errorCode("---\nname: pdf\n---\nPrompt")).toBe("skill_missing_description")
  })

  it("fails malformed frontmatter without throwing", () => {
    expect(errorCode("---\nname: 'pdf\ndescription: Extract files\n---\nPrompt")).toBe("skill_invalid_frontmatter")
  })

  it("retains unknown keys without treating them as errors", () => {
    const skill = parse([
      "---",
      "name: pdf",
      "description: Extract files",
      "license: Apache-2.0",
      "metadata:",
      "  author: document-tools",
      "  version: \"1.0\"",
      "---",
      "Prompt"
    ].join("\n"))

    expect(skill.extra).toEqual({
      license: "Apache-2.0",
      metadata: {
        author: "document-tools",
        version: "1.0"
      }
    })
  })

  it("preserves the markdown body exactly after removing frontmatter", () => {
    const body = "\n# PDF Processing\n\nUse `pdfinfo`.\n"
    const skill = parse(`---\nname: pdf\ndescription: Extract files\n---\n${body}`)

    expect(skill.body).toBe(body)
  })

  it("lowers a skill to the ordinary markdown flow shape", () => {
    const flow = Result.getOrThrow(Markdown.lowerSkill(
      "---\nname: pdf\ndescription: Extract files\nallowed-tools: Read Write\n---\nPrompt"
    ))
    const node = flow.body?.({ args: "" })

    expect(flow.name).toBe("pdf")
    expect(flow.description).toBe("Extract files")
    expect(node?.ast).toMatchObject({
      _tag: "Dynamic",
      model: "smart",
      flows: ["Read", "Write"],
      prompt: "Prompt"
    })
  })
})
