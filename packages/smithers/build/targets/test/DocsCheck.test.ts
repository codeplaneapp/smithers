/**
 * The pure half of `Docs.Check`: the closure key, the stamp sidecar, and the
 * verdict.
 *
 * The key is the planner's own per-input encoding rather than a second hash
 * beside it, so the case asserting that equality is the one that keeps the
 * verdict and the node's cache key computed from the same bytes.
 */
import { describe, expect, it } from "vitest"
import * as DocsCheck from "../src/DocsCheck.ts"
import { Smithers as S } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

const brief = { path: "apps/site/pages/intro/brief.md", digest: "a".repeat(64) }
const style = { path: "apps/site/prompts/style.md", digest: "b".repeat(64) }
const source = { path: "packages/flow/src/Flow.ts", digest: "c".repeat(64) }
const page = { path: "apps/site/src/content/docs/docs/intro.mdx", digest: "d".repeat(64) }
const stampPath = "apps/site/pages/intro/stamp.json"

const fresh = (): DocsCheck.Stamp =>
  DocsCheck.makeStamp({ producer: "claude-opus-5 prompts/reference.md", output: page, inputs: [source, brief, style] })

const judge = (
  overrides: Partial<Parameters<typeof DocsCheck.judge>[0]>
): DocsCheck.StaleError | undefined =>
  DocsCheck.judge({
    page: page.path,
    stampPath,
    stamp: fresh(),
    output: page,
    inputs: [brief, style, source],
    ...overrides
  })

describe("DocsCheck.closureDigest", () => {
  it("is the planner's own per-input encoding over the sorted, deduplicated rows", () => {
    // `expandInputs` keys each declared input as digestText(JSON.stringify(files)).
    // Computing the stamp any other way would let the verdict and the cache
    // key disagree; asserting the exact bytes is what forbids that.
    expect(DocsCheck.closureDigest([source, brief, style, brief])).toBe(
      Input.digestText(JSON.stringify([brief, style, source]))
    )
  })

  it("is independent of the order the inputs were listed in", () => {
    expect(DocsCheck.closureDigest([brief, style, source])).toBe(DocsCheck.closureDigest([source, style, brief]))
  })

  it("moves when any input's content moves, and when an input is added or removed", () => {
    const base = DocsCheck.closureDigest([brief, style])
    expect(DocsCheck.closureDigest([brief, { ...style, digest: "e".repeat(64) }])).not.toBe(base)
    expect(DocsCheck.closureDigest([brief, style, source])).not.toBe(base)
    expect(DocsCheck.closureDigest([brief])).not.toBe(base)
  })

  it("keys a declared-but-absent input as absence, not as an empty file", () => {
    expect(DocsCheck.closureDigest([{ path: brief.path, digest: undefined }])).not.toBe(
      DocsCheck.closureDigest([{ path: brief.path, digest: Input.digestText("") }])
    )
    expect(DocsCheck.closureDigest([{ ...brief, digest: undefined }])).not.toBe(DocsCheck.closureDigest([brief]))
  })

  it("refuses two entries for one path rather than hashing an ambiguous closure", () => {
    expect(() => DocsCheck.closureDigest([brief, { ...brief, digest: "f".repeat(64) }])).toThrow(/twice/)
  })
})

describe("DocsCheck stamp rendering", () => {
  it("round-trips through the rendered JSON with the inputs sorted by path", () => {
    const stamp = fresh()
    expect(stamp.inputs.map((file) => file.path)).toEqual([brief.path, style.path, source.path])
    expect(stamp.closure).toBe(DocsCheck.closureDigest([brief, style, source]))
    expect(DocsCheck.parseStamp(DocsCheck.renderStamp(stamp))).toEqual(stamp)
    expect(DocsCheck.renderStamp(stamp).endsWith("\n")).toBe(true)
  })

  it("renders the same bytes for the same closure however it was listed", () => {
    const listed = DocsCheck.makeStamp({ producer: null, output: page, inputs: [style, source, brief] })
    const reversed = DocsCheck.makeStamp({ producer: null, output: page, inputs: [brief, source, style] })
    expect(DocsCheck.renderStamp(listed)).toBe(DocsCheck.renderStamp(reversed))
  })

  it("records an absent input as null and keeps it in the closure", () => {
    const stamp = DocsCheck.makeStamp({ producer: null, output: page, inputs: [{ ...brief, digest: undefined }] })
    expect(stamp.inputs).toEqual([{ path: brief.path, digest: null }])
    expect(DocsCheck.parseStamp(DocsCheck.renderStamp(stamp))?.closure).toBe(stamp.closure)
  })

  it("reads no stamp out of text that is not one", () => {
    expect(DocsCheck.parseStamp("not json")).toBeUndefined()
    expect(DocsCheck.parseStamp("{}")).toBeUndefined()
    expect(DocsCheck.parseStamp(JSON.stringify({ ...fresh(), format: 2 }))).toBeUndefined()
  })
})

describe("DocsCheck.judge", () => {
  it("passes a page whose stamp matches its inputs and its own bytes", () => {
    expect(judge({})).toBeUndefined()
  })

  it("reports `missing` when there is no stamp, naming the stamp path", () => {
    const verdict = judge({ stamp: undefined })
    expect(verdict?.reason).toBe("missing")
    expect(verdict?.path).toBe(stampPath)
    expect(verdict?.page).toBe(page.path)
  })

  it("reports `missing` when the page itself is gone", () => {
    const verdict = judge({ output: { ...page, digest: undefined } })
    expect(verdict?.reason).toBe("missing")
    expect(verdict?.path).toBe(page.path)
  })

  it("reports `stale` naming the first input whose content moved", () => {
    const verdict = judge({
      inputs: [brief, { ...style, digest: "e".repeat(64) }, { ...source, digest: "f".repeat(64) }]
    })
    expect(verdict?.reason).toBe("stale")
    expect(verdict?.path).toBe(style.path)
    expect(verdict?.message).toContain(style.path)
    expect(verdict?.message).toContain(page.path)
  })

  it("reports `stale` for an input that was added since the stamp", () => {
    const added = { path: "packages/flow/src/Action.ts", digest: "e".repeat(64) }
    const verdict = judge({ inputs: [brief, style, source, added] })
    expect(verdict?.reason).toBe("stale")
    expect(verdict?.path).toBe(added.path)
    expect(verdict?.message).toContain("added")
  })

  it("reports `stale` for an input that was removed since the stamp", () => {
    const verdict = judge({ inputs: [brief, style] })
    expect(verdict?.reason).toBe("stale")
    expect(verdict?.path).toBe(source.path)
    expect(verdict?.message).toContain("removed")
  })

  it("reports `modified` when only the page was edited after the stamp", () => {
    const verdict = judge({ output: { ...page, digest: "e".repeat(64) } })
    expect(verdict?.reason).toBe("modified")
    expect(verdict?.path).toBe(page.path)
  })

  it("prefers `stale` over `modified` when both hold, since regeneration answers both", () => {
    const verdict = judge({
      output: { ...page, digest: "e".repeat(64) },
      inputs: [brief, style, { ...source, digest: "f".repeat(64) }]
    })
    expect(verdict?.reason).toBe("stale")
  })

  it("reports `stale` naming the page when the stamp itself names one input twice", () => {
    // The closure key has to disagree for the naming pass to run at all; the
    // duplicated rows are what would throw out of it without the guard.
    const corrupt: DocsCheck.Stamp = {
      ...fresh(),
      closure: "f".repeat(64),
      inputs: [{ path: brief.path, digest: brief.digest }, { path: brief.path, digest: "e".repeat(64) }]
    }
    const verdict = judge({ stamp: corrupt })
    expect(verdict?.reason).toBe("stale")
    expect(verdict?.path).toBe(page.path)
    expect(verdict?.message).toContain("key has moved")
  })

  it("ignores the producer string: it is provenance, not key material", () => {
    const stamp = DocsCheck.makeStamp({ producer: "another model", output: page, inputs: [brief, style, source] })
    expect(judge({ stamp })).toBeUndefined()
  })
})

describe("Docs.Check attrs", () => {
  const declare = (extra: Record<string, unknown> = {}) =>
    S.Docs.Check({
      stamp: S.file("//apps/site/pages/intro/stamp.json"),
      output: S.file("//apps/site/src/content/docs/docs/intro.mdx"),
      inputs: [S.file("//apps/site/pages/intro/brief.md"), S.glob("//packages/flow/src/**/*.ts")],
      ...extra
    } as never)

  it("is reachable on the namespace with the rule identity", () => {
    expect(S.Docs.Check.id).toBe("Docs.Check")
    expect(S.Docs.Check.kinds).toEqual(["lint", "docs"])
  })

  it("declares the stamp, the output, and every input as key material, and is cacheable", () => {
    const filegroup = S.Filegroup({ srcs: [S.glob("//apps/site/references/**")] })
    const target = declare({ inputs: [S.file("//apps/site/pages/intro/brief.md"), filegroup] })
    const metadata = Target.metadata(target)
    expect(metadata.cacheable).toBe(true)
    expect(metadata.dependencies).toEqual([filegroup])
    expect(metadata.inputs.map((input) => (input as Input.File).path).sort()).toEqual([
      "//apps/site/pages/intro/brief.md",
      "//apps/site/pages/intro/stamp.json",
      "//apps/site/src/content/docs/docs/intro.mdx"
    ])
  })

  it("accepts an optional producer string", () => {
    const target = declare({ producer: "claude-opus-5 prompts/reference.md" })
    expect((Target.metadata(target).attrs as DocsCheck.Attrs).producer).toBe("claude-opus-5 prompts/reference.md")
    expect((Target.metadata(declare()).attrs as DocsCheck.Attrs).producer).toBeUndefined()
  })

  it("rejects a missing stamp or output, an unknown attr, and a git diff input", () => {
    expect(() => declare({ stamp: undefined })).toThrow(/Docs\.Check declaration/)
    expect(() => declare({ output: undefined })).toThrow(/Docs\.Check declaration/)
    expect(() => declare({ input: [] })).toThrow(/Docs\.Check declaration/)
    expect(() => declare({ inputs: [S.gitDiff("origin/main")] })).toThrow(/Docs\.Check declaration/)
  })

  it("rejects a stamp that is its own input, and a stamp that is the page", () => {
    expect(() => declare({ inputs: [S.file("//apps/site/pages/intro/stamp.json")] })).toThrow(/its own input/)
    expect(() => declare({ inputs: [S.file("//apps/site/src/content/docs/docs/intro.mdx")] })).toThrow(/its own input/)
    expect(() => declare({ output: S.file("//apps/site/pages/intro/stamp.json") })).toThrow(/same file/)
  })
})
