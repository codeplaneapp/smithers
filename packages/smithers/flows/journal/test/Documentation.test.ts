import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("journal documentation contracts", () => {
  for (const guide of ["two-channels", "idempotency"]) {
    it(`${guide} distinguishes dedup lookup from cold allocation reads`, () => {
      const prose = read(`../docs/concepts/${guide}.md`).replace(/\s+/g, " ")
      expect(prose).not.toMatch(/issues no read|with no read at all/)
      expect(prose).toMatch(/warmed/)
      expect(prose).toContain("MAX(seq) + 1")
      expect(prose).toContain("MAX(source_seq) + 1")
    })
  }

  it("distinguishes compaction refusals from compacted read recovery", () => {
    const reference = read("../../../../../apps/site/src/content/docs/docs/reference/errors.mdx")
    const row = (code: string): Array<string> =>
      reference.split("\n").find((line) => line.startsWith(`| \`${code}\` |`))!.split("|").map((cell) => cell.trim())
    const reader = row("reader_behind")
    expect(reader[2]).toBe("`compact`")
    expect(reader[4]).toMatch(/catch up.*clos.*retry/i)
    expect(reader[4]).not.toContain("checkpointSeq")
    const checkpoint = row("checkpoint_invalid")
    expect(checkpoint[3]).toMatch(/missing or invalid checkpoint or sequence/i)
    expect(checkpoint[3]).toMatch(/`checkpointSeq` is optional/)
    expect(checkpoint[4]).not.toMatch(/resume/i)
    expect(row("compacted")[4]).toMatch(/latestCheckpoint.*state.*afterSequence/)
  })

  it("lists every Service operation, including optional members", () => {
    const service = read("../src/Journal.ts").split("export interface Service {")[1]!.split("\n}")[0]!
    const members = [...service.matchAll(/^  readonly (\w+)(\?)?:/gm)]
      .map((match) => `${match[1]}${match[2] ?? ""}`)
    const reference = read("../docs/api.md")
    const operations = reference.split("### Operations\n")[1]!.split("\n\n`owner`")[0]!
    const documented = [...operations.matchAll(/^\| `(\w+\??)`\s*\|/gm)].map((match) => match[1])
    expect(documented.sort()).toEqual(members.sort())
    for (const text of [reference, read("../README.md")]) {
      for (const count of text.matchAll(/its (\d+) operations/g)) {
        expect(Number(count[1])).toBe(members.filter((member) => !member.endsWith("?")).length)
      }
    }
  })
})
