import { describe, expect, test } from "vitest"
import {
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_LSP_REASSEMBLY_CAP_BYTES,
  CLOUD_LSP_ROOT_URI,
  CLOUD_LSP_SUBPROTOCOL,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_SESSION_KINDS,
  CloudLspFragmentSchema,
  CloudLspSessionSchema,
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
  lspLanguageFor,
  LspPositionRequestSchema,
  LspServersResponseSchema,
  lspTopic,
  RepoSchema,
  retryAfterOf,
  TARGET_PATTERN,
  TargetSchema,
  withRetryAfter
} from "../src/LocalApp.ts"

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
  const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

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
    expect(LspFileRequestSchema.parse({ repoId: "r1", path: "src/index.ts" })).toEqual({
      repoId: "r1",
      path: "src/index.ts"
    })
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "" }).success).toBe(false)
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4097) }).success).toBe(false)
  })

  test("a hover is the server's markdown cut at the cap and says when it was cut, or null when the server had nothing there", () => {
    expect(LspHoverResponseSchema.parse({ hover: null, digest })).toEqual({ hover: null, digest })
    const hover = { contents: "const x: number", truncated: false, range }
    expect(LspHoverResponseSchema.parse({ hover, digest })).toEqual({ hover, digest })
    expect(
      LspHoverResponseSchema.safeParse({
        hover: { contents: "x".repeat(LSP_HOVER_CAP_CHARS + 1), truncated: true },
        digest
      }).success
    ).toBe(false)
    // The cut is stated, never inferred from the length; an answer without a digest names no file.
    expect(LspHoverResponseSchema.safeParse({ hover: { contents: "x" }, digest }).success).toBe(false)
    expect(LspHoverResponseSchema.safeParse({ hover }).success).toBe(false)
  })

  test("definitions are repository-relative locations, at most the cap, with the server's total and the count outside the repository", () => {
    const location = { path: "src/lib.ts", ...range }
    expect(LspDefinitionResponseSchema.parse({ locations: [location], total: 1, omitted: 0, digest }).locations)
      .toEqual([location])
    // An empty list with omitted targets is a definition elsewhere, and the shape carries that fact.
    expect(LspDefinitionResponseSchema.parse({ locations: [], total: 1, omitted: 1, digest }).omitted).toBe(1)
    expect(LspDefinitionResponseSchema.safeParse({ locations: [], digest }).success).toBe(false)
    expect(
      LspDefinitionResponseSchema.safeParse({
        locations: Array.from({ length: LSP_LOCATIONS_CAP + 1 }, () => location),
        total: 21,
        omitted: 0,
        digest
      }).success
    )
      .toBe(false)
  })

  test("diagnostics distinguish an empty publication from none within the wait, and carry the total behind the cap", () => {
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 1, digest })
        .items
    ).toEqual([diagnostic])
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 2, items: [], total: 0, digest }).items)
      .toEqual([])
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: null, items: null, total: null, digest })
        .items
    ).toBeNull()
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 132, digest })
        .total
    ).toBe(132)
    expect(
      LspDiagnosticsResponseSchema.safeParse({ path: "src/index.ts", version: 1, items: [diagnostic], digest }).success
    ).toBe(false)
    expect(
      LspDiagnosticsResponseSchema.safeParse({
        path: "src/index.ts",
        version: 1,
        items: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic),
        total: LSP_DIAGNOSTICS_CAP + 1,
        digest
      }).success
    ).toBe(false)
    expect(LspDiagnosticSchema.safeParse({ ...diagnostic, severity: 1 }).success).toBe(false)
  })

  test("the language table names the extensions each server handles, so the renderer knows which cards code intelligence serves", () => {
    expect(lspLanguageFor("src/App.tsx")).toBe("typescript")
    expect(lspLanguageFor("lib/index.MJS")).toBe("typescript")
    expect(lspLanguageFor("README.md")).toBeNull()
    expect(lspLanguageFor("package.json")).toBeNull()
    expect(lspLanguageFor("Makefile")).toBeNull()
  })

  test("the bus frame and the server list carry the same shapes", () => {
    const frame = {
      type: "lsp.diagnostics" as const,
      repoId: "r1",
      path: "src/index.ts",
      version: 3,
      items: [diagnostic],
      total: 3,
      digest
    }
    expect(LspDiagnosticsMessageSchema.parse(frame)).toEqual(frame)
    expect(
      LspServersResponseSchema.parse({ servers: [{ repoId: "r1", language: "typescript", state: "ready" }] }).servers[0]
        ?.state
    )
      .toBe("ready")
    expect(
      LspServersResponseSchema.safeParse({ servers: [{ repoId: "r1", language: "cobol", state: "ready" }] }).success
    ).toBe(false)
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
    expect(LspErrorResponseSchema.parse({ error: { code: "timeout", message: "No answer within 5 s." } }).error.install)
      .toBeUndefined()
  })
})

/*
 * Lane L6: the cloud language-server relay through the tunnel (plue #505).
 * The renderer reads plue's fragments and the tunnel's close reasons; what
 * the two sides agree on is pinned here.
 */
describe("the cloud LSP relay contract", () => {
  test("the lsp branch has its own subprotocol, frame cap and reassembly cap, and the checkout is the root", () => {
    expect(CLOUD_WS_SESSION_KINDS).toEqual(["terminal", "lsp"])
    expect(CLOUD_LSP_SUBPROTOCOL).toBe("lsp")
    expect(CLOUD_TERMINAL_FRAME_CAP_BYTES).toBe(64 * 1024)
    expect(CLOUD_LSP_FRAME_CAP_BYTES).toBe(1024 * 1024)
    expect(CLOUD_LSP_REASSEMBLY_CAP_BYTES).toBe(16 * 1024 * 1024)
    expect(CLOUD_LSP_ROOT_URI).toBe("file:///home/developer/workspace")
  })

  test("a fragment is exactly { seq ≥ 1, last, data }; a session row is an lsp session with its language", () => {
    expect(CloudLspFragmentSchema.parse({ seq: 1, last: false, data: "{" })).toEqual({ seq: 1, last: false, data: "{" })
    expect(CloudLspFragmentSchema.safeParse({ seq: 0, last: true, data: "" }).success).toBe(false)
    expect(CloudLspFragmentSchema.safeParse({ seq: 1, last: true, data: "", extra: 1 }).success).toBe(false)
    expect(
      CloudLspSessionSchema.parse({
        id: "s1",
        workspace_id: "ws-1",
        status: "running",
        kind: "lsp",
        language: "typescript",
        idle_timeout_secs: 600
      })
    )
      .toEqual({ id: "s1", status: "running", kind: "lsp", language: "typescript" })
    expect(CloudLspSessionSchema.safeParse({ id: "s1", status: "running", kind: "terminal" }).success).toBe(false)
  })

  test("a refusal's Retry-After rides the close reason in words and reads back as seconds", () => {
    expect(CLOUD_WS_PENDING_CLOSE_CODE).toBe(4425)
    expect(CLOUD_WS_NOT_READY_CLOSE_CODE).toBe(4503)
    const reason = withRetryAfter("workspace_session_pending: session pending", 2)
    expect(reason).toBe("workspace_session_pending: session pending (retry after 2 s)")
    expect(retryAfterOf(reason)).toBe(2)
    expect(retryAfterOf("access revoked: token expired")).toBeNull()
    expect(retryAfterOf("guest_not_ready: activating (retry after 30 s) ")).toBe(30)
  })
})
