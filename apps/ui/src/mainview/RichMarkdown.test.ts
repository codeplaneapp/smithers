import { describe, expect, test } from "bun:test"
import { segments } from "./RichMarkdown"

/*
 * §4.2: the library's markdown renderer has no table rule, so a model that
 * answered with a table put every `|` and every `---|---` on the screen as
 * literal text. The host splits table blocks out; everything else still goes
 * to the library unchanged.
 */

describe("markdown tables are found, and nothing else is disturbed", () => {
  test("a GFM table becomes a table block with its header, alignment and rows", () => {
    const parts = segments(
      ["| repo | issues |", "| :--- | -----: |", "| flows | 6 |", "| mvp | 12 |"].join("\n")
    )
    expect(parts).toHaveLength(1)
    const table = parts[0]
    expect(table?.kind).toBe("table")
    if (table?.kind !== "table") return
    expect(table.header).toEqual(["repo", "issues"])
    expect(table.align).toEqual(["left", "right"])
    expect(table.rows).toEqual([
      ["flows", "6"],
      ["mvp", "12"]
    ])
  })

  test("prose around a table stays prose, in order", () => {
    const parts = segments(
      ["Here is what I found.", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "That is all."].join("\n")
    )
    expect(parts.map((part) => part.kind)).toEqual(["markdown", "table", "markdown"])
    expect(parts[0]?.kind === "markdown" && parts[0].text).toContain("Here is what I found.")
    expect(parts[2]?.kind === "markdown" && parts[2].text).toContain("That is all.")
  })

  test("a pipe inside a fence is data, never a table", () => {
    const source = ["```sh", "ls | grep x", "a | b", "- | -", "```"].join("\n")
    const parts = segments(source)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.kind).toBe("markdown")
    expect(parts[0]?.kind === "markdown" && parts[0].text).toBe(source)
  })

  test("a lone pipe line is not a table — a delimiter row is required", () => {
    const parts = segments("this | that")
    expect(parts.map((part) => part.kind)).toEqual(["markdown"])
  })

  test("a delimiter with a different column count is not a table", () => {
    const parts = segments(["| a | b |", "| --- |", "| 1 | 2 |"].join("\n"))
    expect(parts.map((part) => part.kind)).toEqual(["markdown"])
  })

  test("a short row is padded, never dropped — it is still the author's row", () => {
    const parts = segments(["| a | b | c |", "| - | - | - |", "| 1 |"].join("\n"))
    const table = parts[0]
    expect(table?.kind === "table" && table.rows).toEqual([["1", "", ""]])
  })

  test("plain markdown with no table is passed through whole", () => {
    const source = "# Heading\n\nSome **bold** text.\n\n- one\n- two"
    expect(segments(source)).toEqual([{ kind: "markdown", text: source }])
  })
})
