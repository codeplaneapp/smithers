import assert from "node:assert/strict"
import test from "node:test"
import {
  cell,
  mdxText,
  contractProse,
  errorTags,
  exitCodes,
  frontmatter,
  isOptional,
  regionEnd,
  regionStart,
  renderAst,
  replaceRegion,
  variantRows,
  variantTag
} from "./docs-render.mjs"

test("escapes an angle-bracket placeholder MDX would read as a tag", () => {
  assert.equal(mdxText("Scaffold flows/<name>/flow.mdx"), "Scaffold flows/&lt;name&gt;/flow.mdx")
  assert.equal(mdxText("Close a </div>"), "Close a &lt;/div&gt;")
})

test("leaves a code span and a comparison alone", () => {
  assert.equal(mdxText("run `smithers init <name>` first"), "run `smithers init <name>` first")
  assert.equal(mdxText("when a < b"), "when a < b")
})

test("a cell is both pipe-safe and MDX-safe", () => {
  assert.equal(cell("flows/<name>|x"), "flows/&lt;name&gt;\\|x")
})

test("escapes a pipe so a cell cannot end its column", () => {
  assert.equal(cell("a|b"), "a\\|b")
  assert.equal(cell("first\n  second"), "first second")
})

test("keeps contract prose and drops the sentences that address the migration", () => {
  const behavior =
    "Run listing; `--status` is validated. At the import reference `Command.ts:241` declares a string. The Phase 4 CLI port row changes it."
  assert.equal(contractProse(behavior), "Run listing; `--status` is validated.")
})

test("turns a section sign into a word and unescapes a cell pipe", () => {
  assert.equal(contractProse("Hosts the control server (§10) for `a\\|b`."), "Hosts the control server (section 10) for `a|b`.")
})

test("writes frontmatter as one quoted key", () => {
  assert.equal(frontmatter('He said "no"'), '---\ndescription: "He said \\"no\\""\n---\n')
})

test("replaces a generated region and keeps the prose around it", () => {
  const page = `before\n\n${regionStart("x")}\n\nold\n\n${regionEnd("x")}\n\nafter\n`
  const next = replaceRegion(page, "x", "new")
  assert.match(next, /before/)
  assert.match(next, /after/)
  assert.match(next, /\nnew\n/)
  assert.doesNotMatch(next, /old/)
})

test("refuses a page with no region", () => {
  assert.throws(() => replaceRegion("nothing", "x", "new"), /region x is missing/)
})

test("renders the primitives, literals, and unions of a schema AST", () => {
  assert.equal(renderAst({ _tag: "String" }), "string")
  assert.equal(renderAst({ _tag: "Literals", literals: ["a", "b"] }), '"a" | "b"')
  assert.equal(
    renderAst({ _tag: "Union", types: [{ _tag: "String" }, { _tag: "Undefined" }] }),
    "string"
  )
  assert.equal(renderAst({ _tag: "Never" }), "never")
})

test("names a declaration by its identifier once it is nested", () => {
  const ast = { _tag: "Declaration", annotations: { identifier: "/control/RunId" } }
  assert.equal(renderAst(ast, 1), "RunId")
})

test("treats a union with undefined as optional", () => {
  assert.equal(isOptional({ _tag: "Union", types: [{ _tag: "String" }, { _tag: "Undefined" }] }), true)
  assert.equal(isOptional({ _tag: "String" }), false)
})

test("reads the tag of a tagged object and the variants of a union", () => {
  const accepted = {
    _tag: "Objects",
    propertySignatures: [
      { name: "_tag", type: { _tag: "Literal", literal: "Accepted" } },
      { name: "runId", type: { _tag: "String" } }
    ]
  }
  assert.equal(variantTag(accepted), "Accepted")
  assert.deepEqual(variantRows({ _tag: "Union", types: [accepted] }), [{ tag: "Accepted", fields: ["runId"] }])
  assert.equal(variantRows({ _tag: "String" }), undefined)
})

test("reads an error union as tags with their codes", () => {
  const ast = {
    _tag: "Union",
    types: [
      {
        _tag: "Declaration",
        annotations: {
          identifier: "/control/RunNotFound",
          "~sentinels": [
            { key: "_tag", literal: "/control/RunNotFound" },
            { key: "code", literal: "run_not_found" }
          ]
        }
      }
    ]
  }
  assert.deepEqual(errorTags(ast), [{ tag: "RunNotFound", code: "run_not_found" }])
})

test("reads the exit codes out of the contract sentence and stops at its prose", () => {
  const rows = exitCodes()
  assert.deepEqual(rows.map((row) => row.code), ["0", "1", "2", "3", "130", "143"])
  assert.equal(rows[0].meaning, "success")
})
