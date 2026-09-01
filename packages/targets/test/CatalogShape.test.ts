/**
 * One shape for the whole catalog.
 *
 * Every rule a BUILD.ts file can declare exposes the same three things: the
 * rule id, the attrs schema, and the verbs it participates in. Half the
 * catalog used to export a hand-written wrapper annotated `Target.AnyTarget`
 * that carried none of them, so a tool reading a rule's attrs schema for
 * validation, documentation, or editor support worked for one arbitrary half.
 */
import { describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Target from "../src/Target.ts"

/**
 * Sugar and combinators, which take something other than one rule's attrs and
 * are therefore not rules: `Alias` and `Materialize` take a target, and `Ci`
 * expands to a `Github.CiGen` declaration.
 */
const notRules = new Set(["Alias", "Materialize", "Ci"])

const isDefinitionLike = (value: unknown): boolean =>
  typeof value === "function" && "id" in value && "attrs" in value && "kinds" in value

const walk = (
  namespace: Readonly<Record<string, unknown>>,
  prefix: string,
  seen: Set<unknown>,
  found: Array<{ readonly path: string; readonly value: unknown }>
): void => {
  for (const [key, value] of Object.entries(namespace)) {
    if (key.startsWith("_") || seen.has(value)) continue
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (isDefinitionLike(value)) {
      found.push({ path, value })
      continue
    }
    // Only the small rule namespaces are walked: Cargo, Docker, Github, and
    // the like. Everything else on Smithers is a schema or a declaration
    // constructor and has no rule identity to check.
    if (typeof value === "object" && value !== null && prefix === "" && ruleNamespaces.has(key)) {
      seen.add(value)
      walk(value as Record<string, unknown>, path, seen, found)
    }
  }
}

const ruleNamespaces = new Set([
  "Agent",
  "Api",
  "Bundler",
  "Cargo",
  "Changesets",
  "Docker",
  "Files",
  "Foundry",
  "Git",
  "Github",
  "Go",
  "Markdown",
  "Memory",
  "Npm",
  "Repo",
  "Shell",
  "Size"
])

describe("every catalog rule exports one shape", () => {
  const found: Array<{ readonly path: string; readonly value: unknown }> = []
  walk(Smithers as unknown as Record<string, unknown>, "", new Set(), found)

  it("finds the whole catalog rather than a handful", () => {
    expect(found.length).toBeGreaterThan(60)
  })

  it.each(found.map((entry) => entry.path))("%s carries id, attrs, and kinds", (path) => {
    const entry = found.find((candidate) => candidate.path === path)!
    const rule = entry.value as { id: unknown; attrs: unknown; kinds: unknown }
    expect(typeof rule.id).toBe("string")
    expect(rule.id).not.toBe("")
    expect(rule.attrs).toBeDefined()
    expect(typeof (rule.attrs as { readonly make?: unknown }).make).toBe("function")
    expect(Array.isArray(rule.kinds)).toBe(true)
  })

  it("keeps the guarded rules callable and still refusing", () => {
    expect(Smithers.Cargo.Build.id).toBe("Cargo.Build")
    expect(() => Smithers.Cargo.Build({ locked: true } as never))
      .toThrow(/Cargo\.Build requires exactly one of/)
  })

  it("reports the rule id of a rule that was a bare wrapper", () => {
    expect(Smithers.Docker.Build.id).toBe("Docker.Build")
    expect(Smithers.Generate.id).toBe("Generate")
    expect(Smithers.Github.Pr.id).toBe("Github.Pr")
    expect(Smithers.Typecheck.id).toBe("Typecheck")
  })

  it("names only sugar and combinators as exceptions", () => {
    for (const name of notRules) {
      const value = name === "Ci"
        ? (Smithers.Github as unknown as Record<string, unknown>)["Ci"]
        : (Smithers as unknown as Record<string, unknown>)[name]
      expect(typeof value).toBe("function")
      expect(isDefinitionLike(value)).toBe(false)
    }
  })

  it("still constructs a target from a guarded rule", () => {
    const target = Smithers.Cargo.Deny({
      config: Smithers.file("//deny.toml")
    })
    expect(Target.metadata(target).target).toBe("Cargo.Deny")
  })
})
