import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Owners from "../src/Owners.ts"
import { metadata, Package } from "../src/Package.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Shell from "../src/Shell.ts"
import { Smithers } from "../src/index.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const lint = Shell.Test({
  bin: { _tag: "NodeModuleBin", package: "@biomejs/biome" },
  data: [Input.glob(["**"])]
})

const workspaceOptions = (extra: Partial<WorkspaceDeclaration.WorkspaceOptions> = {}): WorkspaceDeclaration.WorkspaceOptions => {
  const packageJson = Input.file("//package.json")
  return {
    repository: "git+https://example.invalid/fixture.git",
    cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
    runtime: Runtime.Node({ version: "26" }),
    packageManager: PackageManager.Yarn({ manifest: packageJson, lockfile: Input.file("//yarn.lock") }),
    nodeModules: WorkspaceDeclaration.NodeModules({ packageJson }),
    ...extra
  }
}

describe("Owners.declare", () => {
  it("normalizes owners, per-file rules, noparent, agents, and upstream", () => {
    const declaration = Owners.declare({
      owners: ["will", "team:platform", "will"],
      perFile: { "*.sql": "team:data", "migrations/**": ["will", "erik"] },
      noparent: true,
      agents: { default: "human-approve", "auto-land": ["*.md", "docs/**"], deny: ["migrations/**"] },
      upstream: { mode: "approve", packages: ["//lib", "//packages/..."] }
    })
    expect(Owners.isDeclaration(declaration)).toBe(true)
    expect(declaration.owners).toEqual(["will", "team:platform"])
    expect(declaration.perFile).toEqual([
      { pattern: "*.sql", owners: ["team:data"] },
      { pattern: "migrations/**", owners: ["will", "erik"] }
    ])
    expect(declaration.noparent).toBe(true)
    expect(declaration.agents).toEqual({
      default: "human-approve",
      overrides: [
        { pattern: "*.md", policy: "auto-land" },
        { pattern: "docs/**", policy: "auto-land" },
        { pattern: "migrations/**", policy: "deny" }
      ]
    })
    expect(declaration.upstream).toEqual({ mode: "approve", packages: ["//lib", "//packages/..."] })
    expect(Owners.teamReferences(declaration)).toEqual(["data", "platform"])
    expect(Owners.declare(declaration)).toBe(declaration)
  })

  it("accepts the short forms and defaults", () => {
    const short = Owners.declare({ owners: ["will"], agents: "deny", upstream: "review" })
    expect(short.noparent).toBe(false)
    expect(short.perFile).toEqual([])
    expect(short.agents).toEqual({ default: "deny", overrides: [] })
    expect(short.upstream).toEqual({ mode: "review" })
    expect(Owners.declare({ owners: ["will"], upstream: "none" }).upstream).toBeUndefined()
    expect(Owners.declare({ owners: ["will"], agents: { deny: ["a/**"] } }).agents).toEqual({
      default: "human-approve",
      overrides: [{ pattern: "a/**", policy: "deny" }]
    })
  })

  it("rejects malformed owners, patterns, policies, and claims", () => {
    expect(() => Owners.declare({ owners: ["not a login"] })).toThrow(/not a login or team:<name>/)
    expect(() => Owners.declare({ owners: ["team:"] })).toThrow(/not a login or team:<name>/)
    expect(() => Owners.declare({ owners: "will" as never })).toThrow(/array of logins/)
    expect(() => Owners.declare({ perFile: { "/abs/*.ts": ["will"] } })).toThrow(/relative to the package/)
    expect(() => Owners.declare({ perFile: { "../*.ts": ["will"] } })).toThrow(/relative to the package/)
    expect(() => Owners.declare({ perFile: { "*.ts": [] } })).toThrow(/names no owner/)
    expect(() => Owners.declare({ noparent: true })).toThrow(/noparent requires at least one owner/)
    expect(() => Owners.declare({ owners: ["will"], agents: "maybe" as never })).toThrow(/auto-land, human-approve, or deny/)
    expect(() => Owners.declare({ owners: ["will"], agents: { approve: ["x"] } as never })).toThrow(/unknown key/)
    expect(() => Owners.declare({ owners: ["will"], upstream: "all" as never })).toThrow(/none, review, approve/)
    expect(() => Owners.declare({ owners: ["will"], upstream: { mode: "review", packages: [] } })).toThrow(/non-empty array/)
    expect(() => Owners.declare({ owners: ["will"], upstream: { mode: "review", packages: ["lib"] } })).toThrow(/\/\/package label/)
    expect(() => Owners.declare({ owners: ["will"], extra: 1 } as never)).toThrow(/unknown option/)
  })
})

describe("Owners.Teams", () => {
  it("normalizes and sorts the roster", () => {
    const teams = Owners.Teams({ platform: ["will", "erik", "will"], data: ["chungyi"] })
    expect(Owners.isTeamsDeclaration(teams)).toBe(true)
    expect(teams.teams).toEqual({ data: ["chungyi"], platform: ["erik", "will"] })
    expect(Owners.Teams(teams)).toBe(teams)
  })

  it("rejects bad names and members", () => {
    expect(() => Owners.Teams({ "bad name": ["will"] })).toThrow(/portable identifier/)
    expect(() => Owners.Teams({ platform: "will" as never })).toThrow(/array of member logins/)
    expect(() => Owners.Teams({ platform: ["team:x"] })).toThrow(/not a login/)
  })
})

describe("owners on Package and Workspace", () => {
  it("carries the validated declaration in the Package metadata", () => {
    const value = Package({ targets: { lint }, owners: { owners: ["will"], upstream: "review" } })
    expect(metadata(value).owners).toEqual({
      _tag: "Owners",
      owners: ["will"],
      perFile: [],
      noparent: false,
      upstream: { mode: "review" }
    })
    expect(metadata(Package({ targets: { lint } })).owners).toBeUndefined()
    expect(() => Package({ targets: { lint }, owners: { owners: ["nope nope"] } })).toThrow(/not a login/)
  })

  it("carries workspace owners and the team roster, validated", () => {
    const workspace = WorkspaceDeclaration.Workspace(
      "fixture",
      workspaceOptions({ owners: { owners: ["team:platform"], agents: "deny" }, teams: { platform: ["will"] } })
    )
    expect(workspace.owners?.owners).toEqual(["team:platform"])
    expect(workspace.owners?.agents).toEqual({ default: "deny", overrides: [] })
    expect(workspace.teams?.teams).toEqual({ platform: ["will"] })
    expect([...WorkspaceDeclaration.teamNames(workspace)]).toEqual(["platform"])
    expect(WorkspaceDeclaration.Workspace("fixture", workspaceOptions()).teams).toBeUndefined()
    expect(() => WorkspaceDeclaration.Workspace("fixture", workspaceOptions({ teams: { "x y": [] } }))).toThrow(
      /portable identifier/
    )
  })
})

describe("the generated-file rules", () => {
  it("report their rule ids and default to check-capable kinds", () => {
    expect(Smithers.Owners.Codeowners.id).toBe("Owners.Codeowners")
    expect(Smithers.Owners.Tree.id).toBe("Owners.Tree")
    expect(Smithers.Owners.declare).toBe(Owners.declare)
    expect(Smithers.Teams).toBe(Owners.Teams)
    const codeowners = Smithers.Owners.Codeowners({ org: "artsy" })
    expect(Target.metadata(codeowners).target).toBe("Owners.Codeowners")
    expect(Target.metadata(codeowners).kinds).toEqual(["build", "lint"])
    const tree = Smithers.Owners.Tree({})
    expect(Target.metadata(tree).kinds).toEqual(["build", "lint"])
    expect(() => Smithers.Owners.Codeowners({ org: "not an org" } as never)).toThrow()
  })
})
