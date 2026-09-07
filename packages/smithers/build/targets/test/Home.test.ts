/**
 * `Smithers.Factory.Home`, its blocks, and the `HomePane` projection.
 *
 * The properties that matter: every block is a declared value and a string
 * carrying HTML is refused where it is written and again when the projected
 * file is read back; the projection round-trips; and the target checks by
 * default, writes only when asked, and never writes under the lint verb.
 */
import { describe, expect, it } from "vitest"
import * as Home from "../src/Home.ts"
import type * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const describeInput = (input: Input.Declared): string =>
  input._tag === "Glob" ? input.pattern : input._tag === "File" ? input.path : input._tag

describe("the home blocks", () => {
  it("declare frozen plain values that carry their type", () => {
    const text = Home.Text({ title: "About", text: "Smithers builds itself with Smithers." })
    expect(text).toEqual({ type: "text", title: "About", text: "Smithers builds itself with Smithers." })
    expect(Object.isFrozen(text)).toBe(true)
    expect("title" in Home.Text({ text: "No title." })).toBe(false)

    const links = Home.Links({ links: [{ label: "Source", url: "https://github.com/smithersai/smithers" }] })
    expect(links).toEqual({ type: "links", links: [{ label: "Source", url: "https://github.com/smithersai/smithers" }] })
    expect(Object.isFrozen(links.links)).toBe(true)
    expect(Object.isFrozen(links.links[0])).toBe(true)

    expect(Home.Flows()).toEqual({ type: "flows" })
    expect(Home.Flows({ title: "Try first" })).toEqual({ type: "flows", title: "Try first" })
  })

  it("refuse raw HTML in text, titles, and labels, and keep plain comparisons", () => {
    expect(() => Home.Text({ text: "<b>bold</b>" })).toThrow(/must not contain HTML/)
    expect(() => Home.Text({ text: "note <!-- hidden -->" })).toThrow(/must not contain HTML/)
    expect(() => Home.Text({ title: "<h1>Title</h1>", text: "fine" })).toThrow(/must not contain HTML/)
    expect(() => Home.Links({ links: [{ label: "<a>x</a>", url: "https://example.com" }] })).toThrow(
      /must not contain HTML/
    )
    expect(() => Home.Flows({ title: "</script>" })).toThrow(/must not contain HTML/)
    expect(Home.Text({ text: "a < b and b > c" }).text).toBe("a < b and b > c")
  })

  it("refuse empty strings, multi-line titles, and non-http links", () => {
    expect(() => Home.Text({ text: "" })).toThrow()
    expect(() => Home.Text({ title: "two\nlines", text: "x" })).toThrow()
    expect(() => Home.Links({ links: [] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "javascript:alert(1)" }] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "/relative" }] })).toThrow()
    expect(() => Home.Text({ text: "x", html: "<div/>" } as never)).toThrow(/unknown option "html"/)
    expect(() => Home.Text(null as never)).toThrow(/plain object/)
  })

  it("the CI benchmark names every measure by default and refuses others", () => {
    expect(Home.CiBenchmark()).toEqual({ type: "ci-benchmark", measures: ["cold", "incremental", "cache-hit-rate"] })
    expect(Home.CiBenchmark({ title: "CI", measures: ["cold"] })).toEqual({
      type: "ci-benchmark",
      title: "CI",
      measures: ["cold"]
    })
    expect(() => Home.CiBenchmark({ measures: [] })).toThrow()
    expect(() => Home.CiBenchmark({ measures: ["p99"] as never })).toThrow()
  })
})

describe("Smithers.Factory.Home", () => {
  const blocks = [
    Home.Text({ text: "Smithers builds itself with Smithers." }),
    Home.Flows({ title: "Try first" }),
    Home.CiBenchmark({ title: "CI on Smithers" })
  ]

  it("declares a frozen, tagged declaration over declared blocks", () => {
    const home = Home.Home({ blocks })
    expect(home).toEqual({ _tag: "HomeDeclaration", blocks })
    expect(Object.isFrozen(home)).toBe(true)
    expect(Home.isHomeDeclaration(home)).toBe(true)
    expect(Home.isHomeDeclaration({ blocks })).toBe(false)
  })

  it("refuses a raw string, markup, or an unknown block shape, naming the block", () => {
    expect(() => Home.Home({ blocks: ["<h1>Hello</h1>"] as never })).toThrow(/block 0 must be a declared block.*not a string/)
    expect(() => Home.Home({ blocks: [blocks[0]!, "# Hello"] as never })).toThrow(/block 1 must be a declared block/)
    expect(() => Home.Home({ blocks: [{ type: "html", html: "<div/>" }] as never })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ blocks: [{ type: "text", text: "<em>x</em>" }] })).toThrow(/must not contain HTML/)
    expect(() => Home.Home({ blocks: [] })).toThrow()
    expect(() => Home.Home({ blocks: "text" as never })).toThrow(/array of declared blocks/)
  })

  it("renders a stable two-space document that parses back, and refuses HTML on the way back in", () => {
    const home = Home.Home({ blocks })
    const text = Home.render(home)
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toBe(`${JSON.stringify({ blocks }, null, 2)}\n`)
    expect(Home.parse(text)).toEqual({ blocks })
    expect(Home.parse("{")).toMatch(/not JSON/)
    expect(Home.parse(JSON.stringify({ blocks: [{ type: "text", text: "<b>x</b>" }] }))).toMatch(/must not contain HTML/)
    expect(Home.parse(JSON.stringify({ blocks: [{ type: "prose", markdown: "x" }] }))).toMatch(/shape/)
  })
})

describe("HomePane target", () => {
  const home = Home.Home({ blocks: [Home.Flows()] })

  it("checks by default, writes only when asked, and plans one generated-file action", () => {
    const checking = Home.HomePane({ home })
    const metadata = Target.metadata(checking)
    expect(metadata.attrs).toEqual({ home, output: "flows/home.json", mode: "check" })
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: ".", paths: [] })
    expect(metadata.inputs.map(describeInput)).toEqual(["//flows/home.json"])
    expect(plannedCalls(checking)).toEqual([{
      action: "smithers-build/check-file",
      payload: { path: "flows/home.json", contents: Home.render(home) }
    }])

    const writing = Home.HomePane({ home, mode: "write", output: "//.smithers/home.json" })
    const written = Target.metadata(writing)
    expect(written.cacheable).toBe(false)
    expect(written.inputs).toEqual([])
    expect(written.outputs).toEqual({ cwd: ".", paths: [".smithers/home.json"] })
    expect(plannedCalls(writing)).toEqual([{
      action: "smithers-build/write-file",
      payload: { path: ".smithers/home.json", contents: Home.render(home) }
    }])
  })

  it("forces the non-writing view under the lint verb and keeps build as declared", () => {
    const metadata = Target.metadata(Home.HomePane({ home, mode: "write" }))
    expect((metadata.forKind("lint").attrs as Home.Attrs).mode).toBe("check")
    expect((metadata.forKind("build").attrs as Home.Attrs).mode).toBe("write")
  })

  it("refuses a home that is not a Smithers.Factory.Home value", () => {
    expect(() => Home.HomePane({ home: { blocks: [] } as never })).toThrow()
    expect(() => Home.HomePane({ home: "<main>hi</main>" as never })).toThrow()
  })
})
