/**
 * The Bazel label grammar the CLI accepts: `:name` relative labels, `//pkg`,
 * `//pkg:name`, and `...` subtree patterns, plus the current-package
 * derivation from a working directory.
 */
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Label from "../src/Label.ts"

describe("Label.parse", () => {
  it("resolves a :name label against the normalized current package", () => {
    expect(Label.parse(":lint", "apps/web")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
    expect(Label.parse(":lint", "")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse(":lint", ".")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse(":lint", "/apps\\web/")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
  })

  it("refuses an empty or nested :name label", () => {
    expect(() => Label.parse(":", "")).toThrow(/invalid target label/)
    expect(() => Label.parse(":a:b", "")).toThrow(/invalid target label/)
  })

  it("parses subtree patterns", () => {
    expect(Label.parse("//...", "")).toEqual({ _tag: "Subtree", packagePath: "" })
    expect(Label.parse("//apps/web/...", "")).toEqual({ _tag: "Subtree", packagePath: "apps/web" })
  })

  it("parses exact labels with and without a target name", () => {
    expect(Label.parse("//apps/web", "")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: undefined })
    expect(Label.parse("//apps/web:lint", "")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
    expect(Label.parse("//:lint", "")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse("//", "")).toEqual({ _tag: "Exact", packagePath: "", target: undefined })
  })

  it("refuses labels outside the grammar", () => {
    expect(() => Label.parse("apps/web:lint", "")).toThrow(/label must start with/)
    expect(() => Label.parse("//apps:web:lint", "")).toThrow(/invalid target label/)
    expect(() => Label.parse("//apps:", "")).toThrow(/target name is empty/)
  })

  it("refuses package paths with empty, dot, or parent segments", () => {
    expect(() => Label.parse("//apps//web:lint", "")).toThrow(/invalid package path/)
    expect(() => Label.parse("//apps/../web:lint", "")).toThrow(/invalid package path/)
    expect(() => Label.parse("//apps/./web/...", "")).toThrow(/invalid package path/)
    expect(() => Label.parse(":lint", "apps/..")).toThrow(/invalid package path/)
  })
})

describe("Label.format", () => {
  it("normalizes the package path", () => {
    expect(Label.format("", "lint")).toBe("//:lint")
    expect(Label.format(".", "lint")).toBe("//:lint")
    expect(Label.format("/apps/web/", "lint")).toBe("//apps/web:lint")
  })
})

describe("Label.currentPackage", () => {
  const root = NodePath.resolve("/workspace")

  it("maps the root and nested directories to package paths", () => {
    expect(Label.currentPackageOrUndefined(root, root)).toBe("")
    expect(Label.currentPackageOrUndefined(root, NodePath.join(root, "apps", "web"))).toBe("apps/web")
    expect(Label.currentPackage(root, root)).toBe("")
    expect(Label.currentPackage(root, NodePath.join(root, "apps"))).toBe("apps")
  })

  it("reports directories outside the workspace", () => {
    const outside = NodePath.resolve("/elsewhere")
    expect(Label.currentPackageOrUndefined(root, outside)).toBeUndefined()
    expect(Label.currentPackageOrUndefined(root, NodePath.dirname(root))).toBeUndefined()
    expect(() => Label.currentPackage(root, outside)).toThrow(/outside workspace/)
  })
})
