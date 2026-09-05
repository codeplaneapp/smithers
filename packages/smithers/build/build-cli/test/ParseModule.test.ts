import { describe, expect, it } from "vitest"
import { parseModule } from "../src/internal/ParseModule.ts"
import { extractSpecifiers } from "../src/Resolver.ts"

describe("native syntax parsing", () => {
  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "TSX"])(
    "parses %s and keeps the transferred tree usable after session closure",
    (extension) => {
      const text = `import "./first"; const load = () => import("./second")`
      const tree = parseModule(`entry.${extension}`, text)
      expect(tree.text).toBe(text)
      expect(tree.statements.map((statement) => statement.getText())).toEqual([
        `import "./first";`,
        `const load = () => import("./second")`
      ])
      expect(extractSpecifiers(`entry.${extension}`, text)).toEqual([
        { specifier: "./first", dynamic: false },
        { specifier: "./second", dynamic: false }
      ])
    }
  )

  it("preserves JSX expression imports without treating JSX text as code", () => {
    expect(extractSpecifiers("entry.tsx", `<div>require("fake"){import("./real")}</div>`)).toEqual([
      { specifier: "./real", dynamic: false }
    ])
  })

  it("does not confuse regexes, strings, comments, or template text with imports", () => {
    expect(extractSpecifiers(
      "entry.ts",
      [
        `const a = /require("fake")/`,
        `const b = 'import("fake")'`,
        `// require("fake")`,
        "const c = `import('fake') ${import('./real')}`"
      ].join("\n")
    )).toEqual([{ specifier: "./real", dynamic: false }])
  })

  it("retains the compiler's recovery of imports after malformed syntax", () => {
    expect(extractSpecifiers("entry.ts", `const broken = ;\nimport "./after"`)).toEqual([
      { specifier: "./after", dynamic: false }
    ])
  })

  it("never executes source text", () => {
    const tree = parseModule("entry.ts", `throw new Error("must not execute"); import "./absent"`)
    expect(tree.statements).toHaveLength(2)
  })
})
