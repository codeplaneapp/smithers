import { describe, expect, it } from "vitest"
import * as MarkdownCodeBlocks from "../src/MarkdownCodeBlocks.ts"

const page = [
  "# Tutorial",
  "",
  "```ts title=\"greeting.ts\"",
  "export const Greet = 1",
  "```",
  "",
  "```bash",
  "node greeting.ts",
  "```",
  "",
  "```ts",
  "const answer: number = 42",
  "```",
  "",
  "```ts title=\"greeting.ts\"",
  "export const Greeting = Greet + 1",
  "```",
  "",
  "```ts fragment",
  "    return { result }",
  "```",
  "",
  "```ts title='src/run.ts'",
  "import { Greeting } from \"../greeting.ts\"",
  "console.log(Greeting)",
  "```",
  "",
  "```tsx",
  "const ignored = <div />",
  "```",
  ""
].join("\n")

describe("MarkdownCodeBlocks.extract", () => {
  it("concatenates same-title fences in document order and keeps untitled fences standalone", () => {
    const extracted = MarkdownCodeBlocks.extract(page, ["ts"])
    expect(extracted.files).toEqual([
      { path: "greeting.ts", content: "export const Greet = 1\n\nexport const Greeting = Greet + 1\n" },
      { path: "block-1.ts", content: "const answer: number = 42\n" },
      { path: "src/run.ts", content: "import { Greeting } from \"../greeting.ts\"\nconsole.log(Greeting)\n" }
    ])
    expect(extracted.blocks).toBe(5)
    expect(extracted.standalone).toBe(1)
    expect(extracted.titled).toBe(2)
    expect(extracted.fragments).toBe(1)
  })

  it("accepts the typescript alias and a bare title", () => {
    const extracted = MarkdownCodeBlocks.extract("```typescript title=a.ts\nexport {}\n```\n", ["ts"])
    expect(extracted.files).toEqual([{ path: "a.ts", content: "export {}\n" }])
  })

  it("refuses a title that escapes the scratch directory", () => {
    expect(() => MarkdownCodeBlocks.extract("```ts title=\"../a.ts\"\nexport {}\n```\n", ["ts"])).toThrow(
      /title "\.\.\/a\.ts"/
    )
    expect(() => MarkdownCodeBlocks.extract("```ts title=\"/a.ts\"\nexport {}\n```\n", ["ts"])).toThrow(
      /title "\/a\.ts"/
    )
  })

  it("refuses a titled file that collides with a standalone block name", () => {
    expect(() =>
      MarkdownCodeBlocks.extract("```ts\nexport {}\n```\n```ts title=\"block-0.ts\"\nexport {}\n```\n", ["ts"])
    ).toThrow(/block-0\.ts/)
  })
})
