import { describe, expect, test } from "bun:test"
import {
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_CAP,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_CAP_CHARS,
  LSP_HOVER_PATH,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_LOCATIONS_CAP,
  LSP_SERVERS_PATH,
  LspDefinitionResponseSchema,
  LspDiagnosticSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspFileRequestSchema,
  LspHoverResponseSchema,
  LspPositionRequestSchema,
  LspServersResponseSchema,
  lspTopic,
  RepoSchema,
  TARGET_PATTERN,
  TargetSchema
} from "./LocalApp"

/*
 * The local-app wire model (apps/ui/docs/LOCAL-APP.md "Targets: load and
 * run"): a repository carries its detected workspaces, and a target carries
 * the workspace its loader ran in plus the presentation its declaration
 * stated. There is no repository manifest: a target's summary and featured
 * flag ride the PACKAGE.ts declaration and arrive through the loader listing.
 */

describe("multi-workspace repo wire model", () => {
  test("Repo.smithers carries the detected workspaces and the repo carries warnings", () => {
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
    expect("plugin" in repo).toBe(false)
  })

  test("a Target carries the workspace its loader ran in, and the declaration's summary and featured flag when stated", () => {
    const bare = TargetSchema.parse({
      id: "target-capability",
      label: "//src:lint",
      target: "Shell.Test",
      kinds: ["lint"],
      package: "//src",
      name: "lint",
      workspace: "aomi-sdk"
    })
    expect(bare.workspace).toBe("aomi-sdk")
    expect(bare.summary).toBeUndefined()
    expect(bare.featured).toBeUndefined()
    const annotated = TargetSchema.parse({ ...bare, summary: "ESLint over the sdk.", featured: true })
    expect(annotated.summary).toBe("ESLint over the sdk.")
    expect(annotated.featured).toBe(true)
    expect(TargetSchema.safeParse({ ...bare, summary: 7 }).success).toBe(false)
  })
})

/*
 * A pattern run is a verb over a pattern (`ci //...`, how CI runs
 * everything): the pattern is a label or a `//dir/...` subtree.
 */
test("the pattern grammar accepts labels and subtrees and refuses the rest", () => {
  for (const pattern of ["//...", "//packages/...", "//:ci", "//packages/smithers/flows/canonical:check"]) {
    expect(TARGET_PATTERN.test(pattern)).toBe(true)
  }
  for (const pattern of ["//packages", "//packages/...:lint", "//a b/...", "packages/..."]) {
    expect(TARGET_PATTERN.test(pattern)).toBe(false)
  }
})

/*
 * Code intelligence on the local origin (apps/ui/docs/code-intel/PLAN.md §3):
 * positions are 1-based on the wire, paths are repository-relative, and the
 * host's caps are the schemas' bounds, so an answer past them fails to parse
 * instead of rendering.
 */
describe("the code-intelligence wire model", () => {
  const position = { repoId: "r1", path: "src/index.ts", line: 12, character: 5 }
  const range = { line: 12, character: 5, endLine: 12, endCharacter: 9 }
  const diagnostic = { ...range, severity: "error" as const, message: "boom", source: "ts", code: "2551" }

  test("the routes hang off /api/lsp and a repository's diagnostics ride lsp:<repoId>", () => {
    expect([LSP_HOVER_PATH, LSP_DEFINITION_PATH, LSP_DIAGNOSTICS_PATH, LSP_SERVERS_PATH])
      .toEqual(["/api/lsp/hover", "/api/lsp/definition", "/api/lsp/diagnostics", "/api/lsp/servers"])
    expect(lspTopic("r1")).toBe("lsp:r1")
  })

  test("a position request is 1-based and carries nothing the routes did not ask for", () => {
    expect(LspPositionRequestSchema.parse(position)).toEqual(position)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, character: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 1.5 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, cwd: "/" }).success).toBe(false)
    expect(LspFileRequestSchema.parse({ repoId: "r1", path: "src/index.ts" })).toEqual({ repoId: "r1", path: "src/index.ts" })
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "" }).success).toBe(false)
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4097) }).success).toBe(false)
  })

  test("a hover is the server's markdown cut at the cap, or null when the server had nothing there", () => {
    expect(LspHoverResponseSchema.parse({ hover: null })).toEqual({ hover: null })
    const hover = { contents: "const x: number", range }
    expect(LspHoverResponseSchema.parse({ hover })).toEqual({ hover })
    expect(LspHoverResponseSchema.safeParse({ hover: { contents: "x".repeat(LSP_HOVER_CAP_CHARS + 1) } }).success).toBe(false)
  })

  test("definitions are repository-relative locations, at most the cap", () => {
    const location = { path: "src/lib.ts", ...range }
    expect(LspDefinitionResponseSchema.parse({ locations: [location] }).locations).toEqual([location])
    expect(LspDefinitionResponseSchema.safeParse({ locations: Array.from({ length: LSP_LOCATIONS_CAP + 1 }, () => location) }).success)
      .toBe(false)
  })

  test("diagnostics distinguish an empty publication from none within the wait", () => {
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic] }).items).toEqual([diagnostic])
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 2, items: [] }).items).toEqual([])
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: null, items: null }).items).toBeNull()
    expect(
      LspDiagnosticsResponseSchema.safeParse({
        path: "src/index.ts",
        version: 1,
        items: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic)
      }).success
    ).toBe(false)
    expect(LspDiagnosticSchema.safeParse({ ...diagnostic, severity: 1 }).success).toBe(false)
  })

  test("the bus frame and the server list carry the same shapes", () => {
    const frame = { type: "lsp.diagnostics" as const, repoId: "r1", path: "src/index.ts", version: 3, items: [diagnostic] }
    expect(LspDiagnosticsMessageSchema.parse(frame)).toEqual(frame)
    expect(LspServersResponseSchema.parse({ servers: [{ repoId: "r1", language: "typescript", state: "ready" }] }).servers[0]?.state)
      .toBe("ready")
    expect(LspServersResponseSchema.safeParse({ servers: [{ repoId: "r1", language: "cobol", state: "ready" }] }).success).toBe(false)
  })

  test("a failure names its code, and a missing server carries the install line verbatim", () => {
    const missing = LspErrorResponseSchema.parse({
      error: {
        code: LSP_LANGUAGE_SERVER_MISSING,
        message: "No TypeScript language server on this machine.",
        install: "npm i -g typescript-language-server typescript"
      }
    })
    expect(missing.error.code).toBe("language_server_missing")
    expect(missing.error.install).toBe("npm i -g typescript-language-server typescript")
    expect(LspErrorResponseSchema.parse({ error: { code: "timeout", message: "No answer within 5 s." } }).error.install).toBeUndefined()
  })
})
