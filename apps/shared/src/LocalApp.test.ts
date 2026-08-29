import { describe, expect, test } from "bun:test"
import { parseRepoPlugin, RepoPluginSchema, RepoSchema, TargetSchema } from "./LocalApp"

/*
 * The repo plugin manifest (apps/ui/docs/LOCAL-APP.md "Plugin manifest"):
 * a repository's `.smithers/UI.json` declares the groups and entries the
 * repo-plugin card renders. The schema is strict — root, group and entry
 * objects reject additional keys — group references must resolve, labels
 * are `//pkg:name`, and every entry's workspace must be one of the
 * detected repo workspaces.
 */

const manifest = () => ({
  schemaVersion: 1,
  name: "aomi",
  title: "Aomi",
  summary: "Cross-repo workflows.",
  groups: [
    { id: "checks", title: "Checks", kind: "check" },
    { id: "recipes", title: "Recipes", kind: "recipe" }
  ],
  entries: [
    {
      id: "version-parity",
      group: "checks",
      workspace: ".",
      label: "//:versionParity",
      title: "Version parity",
      summary: "The pins must agree.",
      approval: false,
      agentic: false
    },
    {
      id: "clippy-fix",
      group: "recipes",
      workspace: "aomi-sdk",
      label: "//:clippyFix",
      title: "Clippy fix",
      summary: "Make clippy green.",
      approval: true,
      agentic: true
    }
  ]
})

/** The manifest as a hand-written file: the flags omitted so the defaults show. */
const fileManifest = () => {
  const value = manifest()
  const [first, ...rest] = value.entries
  const { approval: _approval, agentic: _agentic, ...stripped } = first ?? {}
  return { ...value, entries: [stripped, ...rest] }
}

describe("RepoPluginSchema", () => {
  test("the wire schema wants explicit flags; the file parse defaults them to false", () => {
    expect(RepoPluginSchema.parse(manifest()).entries[0]).toMatchObject({ approval: false, agentic: false })
    const parsed = parseRepoPlugin(fileManifest(), [".", "aomi-sdk"])
    expect("plugin" in parsed && parsed.plugin.entries[0]).toMatchObject({ approval: false, agentic: false })
    expect("plugin" in parsed && parsed.plugin.entries[1]).toMatchObject({ approval: true, agentic: true })
  })

  test("additional keys are rejected at the root, on groups and on entries", () => {
    const root = manifest() as Record<string, unknown>
    root.extra = 1
    expect(RepoPluginSchema.safeParse(root).success).toBe(false)
    const group = manifest()
    ;(group.groups[0] as Record<string, unknown>).extra = 1
    expect(RepoPluginSchema.safeParse(group).success).toBe(false)
    const entry = manifest()
    ;(entry.entries[0] as Record<string, unknown>).extra = 1
    expect(RepoPluginSchema.safeParse(entry).success).toBe(false)
  })

  test("a bad kind, a bad label and the wrong schemaVersion are rejected", () => {
    const kind = manifest()
    ;(kind.groups[0] as { kind: string }).kind = "nope"
    expect(RepoPluginSchema.safeParse(kind).success).toBe(false)
    const label = manifest()
    label.entries[0].label = "not-a-label"
    expect(RepoPluginSchema.safeParse(label).success).toBe(false)
    const version = manifest() as { schemaVersion: number }
    version.schemaVersion = 2
    expect(RepoPluginSchema.safeParse(version).success).toBe(false)
  })

  test("an entry naming a group the manifest does not declare is rejected", () => {
    const unknown = manifest()
    unknown.entries[0].group = "missing"
    expect(RepoPluginSchema.safeParse(unknown).success).toBe(false)
  })
})

describe("parseRepoPlugin", () => {
  const workspaces = [".", "aomi", "aomi-sdk"]

  test("every entry workspace must be one of the detected workspaces", () => {
    const parsed = parseRepoPlugin(manifest(), workspaces)
    expect("plugin" in parsed && parsed.plugin.name).toBe("aomi")
    const stray = manifest()
    stray.entries[1].workspace = "elsewhere"
    const rejected = parseRepoPlugin(stray, workspaces)
    expect("issues" in rejected && rejected.issues.join(" ")).toContain("elsewhere")
  })

  test("shape failures come back as issues, never a throw", () => {
    const parsed = parseRepoPlugin({ nope: true }, workspaces)
    expect("issues" in parsed && parsed.issues.length > 0).toBe(true)
    expect("issues" in parseRepoPlugin(undefined, workspaces)).toBe(true)
  })

  test("a root-level issue reads as a sentence, not a bare colon", () => {
    // The issues become Repo.warnings, which the repo card states verbatim.
    const unknown = manifest()
    unknown.entries[0].group = "missing"
    const rejected = parseRepoPlugin(unknown, workspaces)
    expect("issues" in rejected && rejected.issues[0]).toBe(
      "entry version-parity names an undeclared group missing"
    )
  })
})

describe("multi-workspace repo wire model", () => {
  test("Repo.smithers carries the detected workspaces; the repo carries warnings and an optional plugin", () => {
    const repo = RepoSchema.parse({
      id: "r1",
      path: "/work/aomi",
      name: "aomi",
      git: null,
      warnings: [],
      smithers: {
        detected: true,
        workspaceFile: ".smithers/WORKSPACE.ts",
        declarationFiles: [".smithers/WORKSPACE.ts"],
        reason: "2 workspaces detected",
        workspaces: [
          { path: ".", title: "aomi" },
          { path: "aomi-sdk", title: "aomi-sdk" }
        ]
      }
    })
    expect(repo.smithers.workspaces).toHaveLength(2)
    expect(repo.plugin).toBeUndefined()
    const withPlugin = RepoSchema.parse({ ...repo, plugin: manifest() })
    expect(withPlugin.plugin?.name).toBe("aomi")
  })

  test("a Target carries the workspace its loader ran in", () => {
    const target = TargetSchema.parse({
      label: "//src:lint",
      target: "Shell.Test",
      kinds: ["lint"],
      package: "//src",
      name: "lint",
      workspace: "aomi-sdk"
    })
    expect(target.workspace).toBe("aomi-sdk")
  })
})
