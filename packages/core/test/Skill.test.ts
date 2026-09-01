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

  it("redacts source text from bounded YAML parser diagnostics", () => {
    const result = Markdown.parseSkill(
      "---\nname: n\ndescription: d\nmetadata: [sk-live-SECRETVALUE\n---\nPrompt"
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) return
    expect(result.failure.code).toBe("skill_invalid_frontmatter")
    expect(result.failure.message).not.toContain("sk-live-SECRETVALUE")
    expect(result.failure.message).toContain("line 4")
    expect(result.failure.message.length).toBeLessThanOrEqual(200)
  })

  it("keeps the stable code for a second malformed YAML document", () => {
    expect(errorCode("---\nname: n\ndescription: d\nmetadata: {unterminated\n---\nPrompt")).toBe(
      "skill_invalid_frontmatter"
    )
  })

  it("retains hostile unknown keys as frozen own data properties", () => {
    const skill = parse([
      "---",
      "name: guarded",
      "description: Guard hostile keys",
      "__proto__:",
      "  admin: yes",
      "constructor: construct",
      "prototype:",
      "  enabled: true",
      "---",
      "Prompt"
    ].join("\n"))

    expect(Object.keys(skill.extra)).toEqual(["__proto__", "constructor", "prototype"])
    expect(Object.getOwnPropertyDescriptor(skill.extra, "__proto__")).toEqual({
      value: { admin: "yes" },
      enumerable: true,
      writable: false,
      configurable: false
    })
    expect(Object.getOwnPropertyDescriptor(skill.extra, "constructor")?.value).toBe("construct")
    expect(Object.getOwnPropertyDescriptor(skill.extra, "prototype")?.value).toEqual({ enabled: "true" })
    expect(Object.getPrototypeOf(skill.extra)).toBeNull()
    expect(Object.isFrozen(skill.extra)).toBe(true)
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
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

    expect(Object.keys(skill.extra)).toEqual(["license", "metadata"])
    expect(Object.hasOwn(skill.extra, "license")).toBe(true)
    expect(Object.hasOwn(skill.extra, "metadata")).toBe(true)
    expect({ ...skill.extra }).toEqual({
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
