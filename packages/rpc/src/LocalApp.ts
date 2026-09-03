import { z } from "zod"
import { NodeTimingSchema, RunSummarySchema } from "./TargetGraph"

/*
 * The local-app wire model (apps/ui/docs/LOCAL-APP.md "HTTP and WebSocket
 * API"): the harness, repository, and PTY session records the local server
 * answers and the SPA stores. Runtime-free zod, like Cards.ts, so the Bun
 * server, the SPA, and the Playwright doubles validate the same shapes.
 */

export const HARNESS_IDS = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "opencode-kimi",
  "opencode-cerebras",
  "crush",
  "amp",
  "cursor-agent",
  "hermes",
  "pi"
] as const

export const HarnessSchema = z.object({
  id: z.enum(HARNESS_IDS),
  displayName: z.string(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["signed-in", "api-key", "binary-only", "unavailable"]),
  account: z.object({ email: z.string().optional(), label: z.string().optional() }).nullable(),
  launch: z.object({ argv: z.array(z.string()) }),
  /**
   * How this harness takes a model (docs/workbench-lanes/custom-agents.md):
   * the table's verified suggestions and whether it has a list command
   * (`GET /api/harnesses/{id}/models` runs it). Absent when the binary's
   * `--help` names no model flag the app has verified — such a harness runs
   * only as itself, never as a custom agent. Optional so rows persisted
   * before custom agents parse.
   */
  models: z.object({ suggestions: z.array(z.string()), listable: z.boolean() }).optional()
})
export type Harness = z.infer<typeof HarnessSchema>

/** A target label: `//pkg:name` (`//:name` for the root package). */
export const TARGET_LABEL = /^\/\/[^\s:]*:[^\s:]+$/

/**
 * The verbs `smithers-build` executes over a pattern (`smithers-build
 * --help`). A pattern run is `<verb> <pattern>`: the CLI resolves the
 * pattern to its targets and runs every one, which is what "run everything"
 * is (`ci '//...'`); no single target does that.
 */
export const TARGET_RUN_VERBS = ["build", "ci", "docs", "lint", "run", "test"] as const
export const TargetRunVerbSchema = z.enum(TARGET_RUN_VERBS)
export type TargetRunVerb = z.infer<typeof TargetRunVerbSchema>

/** A pattern the CLI accepts: an exact label or a `//dir/...` subtree (`//...` for the whole workspace). */
export const TARGET_PATTERN = /^\/\/(?:(?:(?!\.\.\.\/)[^\s:/]+\/)*\.\.\.|(?!.*\.\.\.)[^\s:]*:[^\s:]+)$/

/** The verb and pattern of one pattern run; `title` reads `ci //packages/...`. */
export const patternRunTitle = (verb: string, pattern: string): string => `${verb} ${pattern}`

export const RepoWorkspaceSchema = z.object({
  /** Relative to the repo root; "." for the root itself. */
  path: z.string(),
  /** The last path segment, or the repo name for the root. */
  title: z.string()
})
export type RepoWorkspace = z.infer<typeof RepoWorkspaceSchema>

export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  git: z.object({ branch: z.string().nullable(), remote: z.string().nullable() }).nullable(),
  /*
   * The jj probe (lane piper): the checkout's own position — its change and
   * commit ids, how many commits it is ahead of trunk, and trunk's bookmark
   * name. Absent when the checkout is not a jj repo or the probe failed;
   * never a fake zero.
   */
  jj: z.object({
    changeId: z.string().nullable(),
    commitId: z.string().nullable(),
    ahead: z.number().int().nonnegative().nullable(),
    bookmark: z.string().nullable()
  }).optional(),
  /** Loader and manifest problems surfaced at open; empty when the open was clean. */
  warnings: z.array(z.string()),
  smithers: z.object({
    detected: z.boolean(),
    workspaceFile: z.string().nullable(),
    declarationFiles: z.array(z.string()),
    reason: z.string(),
    /** Root and child workspaces (LOCAL-APP.md "Repository detection"); detection is nonempty. */
    workspaces: z.array(RepoWorkspaceSchema)
  })
})
export type Repo = z.infer<typeof RepoSchema>

/*
 * Files in an open repository (LOCAL-APP.md "HTTP and WebSocket surface"):
 * one route answers a directory or a file, the way the Cloud contents route
 * does, so the files seam renders the same file-list / file cards for both.
 * Reads are bounded: the server stops at REPO_FILE_READ_CAP_BYTES and says
 * so with `truncated`; a NUL byte or undecodable UTF-8 answers `binary` with
 * no content.
 */
export const REPO_FILES_PATH = "/api/repo/files"
export const REPO_FILE_READ_CAP_BYTES = 256 * 1024
/** A directory answers at most this many entries (sorted by name), and says so with `truncated`. */
export const REPO_LISTING_CAP_ENTRIES = 2000
export const RepoFilesRequestSchema = z.object({
  repoId: z.string().min(1),
  /** Relative to the repository root; "" or absent is the root. */
  path: z.string().max(4096).optional()
}).strict()
export type RepoFilesRequest = z.infer<typeof RepoFilesRequestSchema>
export const RepoFileEntrySchema = z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })
export type RepoFileEntry = z.infer<typeof RepoFileEntrySchema>
export const RepoFilesResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dir"),
    path: z.string(),
    entries: z.array(RepoFileEntrySchema),
    /** True when the directory holds more than REPO_LISTING_CAP_ENTRIES; the entries are the first page by name. */
    truncated: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean()
  })
])
export type RepoFilesResponse = z.infer<typeof RepoFilesResponseSchema>

/*
 * Code intelligence on the local origin (apps/ui/docs/code-intel/PLAN.md §3):
 * one language server per (repository, language), owned by the Bun host and
 * reached over POST routes the way PTYs are; the renderer never names a
 * binary, an argv, or a cwd. Positions are 1-based on the wire and in flows
 * and converted once at the session. Paths are relative to the repository
 * root and pass the same segment check as REPO_FILES_PATH; access is a read.
 * The caps are what the host applies before answering, and the schemas
 * refuse anything past them, so an over-cap answer fails to parse instead of
 * rendering. A missing language server is stated with its install line and
 * never installed.
 */
export const LSP_PATH = "/api/lsp"
/** `POST`: the hover at a position. */
export const LSP_HOVER_PATH = `${LSP_PATH}/hover`
/** `POST`: the definitions of the symbol at a position. */
export const LSP_DEFINITION_PATH = `${LSP_PATH}/definition`
/** `POST`: the server's first publication for the file after it opens (bounded by LSP_REQUEST_TIMEOUT_MS). */
export const LSP_DIAGNOSTICS_PATH = `${LSP_PATH}/diagnostics`
/** `GET`: the language servers the host is running. */
export const LSP_SERVERS_PATH = `${LSP_PATH}/servers`
/** The `/ws` topic a repository's diagnostics stream rides; the renderer subscribes as it does to `pty:<sessionId>`. */
export const lspTopic = (repoId: string): string => `lsp:${repoId}`

/** v1 is TypeScript (`typescript-language-server --stdio`); the host's server table gains a row here first. */
export const LSP_LANGUAGE_IDS = ["typescript"] as const
export const LspLanguageIdSchema = z.enum(LSP_LANGUAGE_IDS)
export type LspLanguageId = z.infer<typeof LspLanguageIdSchema>

/** Hover text is cut here; the card and the model see the same text. */
export const LSP_HOVER_CAP_CHARS = 4 * 1024
export const LSP_DIAGNOSTICS_CAP = 50
export const LSP_LOCATIONS_CAP = 20
/** A request body past this answers 413. */
export const LSP_REQUEST_BODY_CAP_BYTES = 64 * 1024
/** One request's ceiling at the host and the client. */
export const LSP_REQUEST_TIMEOUT_MS = 5_000
/** The error code of the 409 whose `install` line the card prints. */
export const LSP_LANGUAGE_SERVER_MISSING = "language_server_missing"

const lspOrdinal = z.number().int().min(1)
const lspRepoId = z.string().min(1)
const lspRepoPath = z.string().min(1).max(4096)

/** A span, 1-based on both ends; `endCharacter` is exclusive, as the server's is. */
const lspRangeShape = { line: lspOrdinal, character: lspOrdinal, endLine: lspOrdinal, endCharacter: lspOrdinal }
export const LspRangeSchema = z.object(lspRangeShape)
export type LspRange = z.infer<typeof LspRangeSchema>

/** `POST /api/lsp/hover` and `/api/lsp/definition`. */
export const LspPositionRequestSchema = z.object({
  repoId: lspRepoId,
  /** Relative to the repository root. */
  path: lspRepoPath,
  line: lspOrdinal,
  character: lspOrdinal
}).strict()
export type LspPositionRequest = z.infer<typeof LspPositionRequestSchema>
/** `POST /api/lsp/diagnostics`. */
export const LspFileRequestSchema = z.object({ repoId: lspRepoId, path: lspRepoPath }).strict()
export type LspFileRequest = z.infer<typeof LspFileRequestSchema>

export const LSP_SEVERITIES = ["error", "warning", "information", "hint"] as const
export const LspSeveritySchema = z.enum(LSP_SEVERITIES)
export type LspSeverity = z.infer<typeof LspSeveritySchema>

/** One diagnostic as the card and the model see it; the session maps the server's numeric severity once. */
export const LspDiagnosticSchema = z.object({
  ...lspRangeShape,
  severity: LspSeveritySchema,
  message: z.string(),
  /** The producer as the server names it (`ts`); absent when it names none. */
  source: z.string().optional(),
  /** The server's code as text (`2551`); absent when it names none. */
  code: z.string().optional()
})
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>

/** A definition target. `path` is relative to the repository root; the host omits targets outside it. */
export const LspLocationSchema = z.object({ path: z.string().min(1), ...lspRangeShape })
export type LspLocation = z.infer<typeof LspLocationSchema>

export const LspHoverSchema = z.object({
  /** Markdown as the server wrote it, cut at LSP_HOVER_CAP_CHARS. */
  contents: z.string().max(LSP_HOVER_CAP_CHARS),
  /** The token the hover describes, when the server says. */
  range: LspRangeSchema.optional()
})
export type LspHover = z.infer<typeof LspHoverSchema>

/** `POST /api/lsp/hover`: `hover` is null when the server has nothing at the position. */
export const LspHoverResponseSchema = z.object({ hover: LspHoverSchema.nullable() })
export type LspHoverResponse = z.infer<typeof LspHoverResponseSchema>
/** `POST /api/lsp/definition` */
export const LspDefinitionResponseSchema = z.object({ locations: z.array(LspLocationSchema).max(LSP_LOCATIONS_CAP) })
export type LspDefinitionResponse = z.infer<typeof LspDefinitionResponseSchema>
/**
 * `POST /api/lsp/diagnostics`: `items` is what the server published for
 * `version`, or null when it published nothing within the wait. An unread
 * file has no count: the card states none until the stream carries one.
 */
export const LspDiagnosticsResponseSchema = z.object({
  path: z.string(),
  /** The server's document version the items belong to; null when it names none or has not published. */
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP).nullable()
})
export type LspDiagnosticsResponse = z.infer<typeof LspDiagnosticsResponseSchema>

/** One frame on the WS topic `lsp:<repoId>`: the server's publication for one file. */
export const LspDiagnosticsMessageSchema = z.object({
  type: z.literal("lsp.diagnostics"),
  repoId: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP)
})
export type LspDiagnosticsMessage = z.infer<typeof LspDiagnosticsMessageSchema>

export const LSP_SERVER_STATES = ["starting", "ready", "exited"] as const
export const LspServerStatusSchema = z.object({
  repoId: z.string(),
  language: LspLanguageIdSchema,
  state: z.enum(LSP_SERVER_STATES)
})
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>
/** `GET /api/lsp/servers` */
export const LspServersResponseSchema = z.object({ servers: z.array(LspServerStatusSchema) })
export type LspServersResponse = z.infer<typeof LspServersResponseSchema>

/**
 * A failed answer, the `{ error: { code, message } }` envelope the repository
 * routes use. `409 language_server_missing` carries the install line verbatim
 * in `install`; the card prints it and nothing installs it.
 */
export const LspErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), install: z.string().optional() })
})
export type LspErrorResponse = z.infer<typeof LspErrorResponseSchema>

export const PtySessionSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(["terminal", "harness"]),
  harnessId: z.enum(HARNESS_IDS).optional(),
  cwd: z.string(),
  pid: z.number(),
  alive: z.boolean(),
  /** The exit code once the process has exited (null when it died by signal); absent while alive. */
  exitCode: z.number().nullable().optional()
})
export type PtySession = z.infer<typeof PtySessionSchema>

/*
 * One Smithers target as `smithers-build query '//...' --format json` lists it
 * (LOCAL-APP.md "Targets: load and run"): the loader's `{ label, target,
 * kinds }` row plus the label split into its package and name.
 */
export const TARGET_KINDS = ["build", "test", "lint", "run", "docs"] as const

export const TargetDefinitionSchema = z.object({
  label: z.string(),
  target: z.string(),
  kinds: z.array(z.string()),
  package: z.string(),
  name: z.string(),
  /** The detected workspace the loader ran in ("." for the repo root). */
  workspace: z.string(),
  /** The declaration's one-line summary (PACKAGE.ts `summary: "..."`), shown under the label. */
  summary: z.string().optional(),
  /** The declaration marks the target featured (PACKAGE.ts `featured: true`): it leads the Featured view. */
  featured: z.boolean().optional()
})
export type TargetDefinition = z.infer<typeof TargetDefinitionSchema>

/** The browser receives an opaque id minted by the local repository authority. */
export const TargetSchema = TargetDefinitionSchema.extend({ id: z.string().min(1) })
export type Target = z.infer<typeof TargetSchema>

/** `POST /api/targets/query` */
export const TargetsQueryResponseSchema = z.object({
  targets: z.array(TargetSchema),
  warnings: z.array(z.string()),
  durationMs: z.number()
})
export type TargetsQueryResponse = z.infer<typeof TargetsQueryResponseSchema>

/** `POST /api/targets/run` */
export const TargetRunResponseSchema = z.object({ runId: z.string() })

/*
 * The run-local frame number the backend stamps on every frame it records
 * (@smthrs/rpc/TargetGraph `TargetRunEvent.seq`): 0-based, gap-free, and
 * the ONLY total order replay has, because stdout/stderr/exit/error frames
 * carry no `at` of their own.
 *
 * It has to be declared HERE too, not only on TargetRunEvent. This is the
 * schema the client parses every WebSocket frame with, and a zod object
 * strips what it does not declare — so while it was absent the ordering key
 * was silently deleted off every frame in flight. Optional, because frames
 * recorded before the backend numbered them have none.
 */
const frameSeq = { seq: z.number().int().nonnegative().optional() }

/** One frame on the WS topic `target-run:<runId>`. */
export const TargetRunFrameSchema = z.discriminatedUnion("type", [
  /* `label` attributes the chunk to one graph node when the backend can. */
  z.object({ type: z.literal("stdout"), data: z.string(), label: z.string().optional(), ...frameSeq }),
  z.object({ type: z.literal("stderr"), data: z.string(), label: z.string().optional(), ...frameSeq }),
  z.object({ type: z.literal("exit"), code: z.number().nullable(), ...frameSeq }),
  z.object({ type: z.literal("error"), message: z.string(), ...frameSeq }),
  /* The structured run frames (@smthrs/rpc/TargetGraph TargetRunEvent). */
  z.object({ type: z.literal("started"), runId: z.string(), label: z.string(), at: z.number(), labels: z.array(z.string()), ...frameSeq }),
  z.object({ type: z.literal("node"), node: NodeTimingSchema, at: z.number(), ...frameSeq }),
  z.object({ type: z.literal("summary"), summary: RunSummarySchema, at: z.number(), ...frameSeq })
])
export type TargetRunFrame = z.infer<typeof TargetRunFrameSchema>

/** The server -> client envelope carrying a run frame. */
export const TargetRunMessageSchema = z.object({
  type: z.literal("target-run"),
  runId: z.string(),
  frame: TargetRunFrameSchema
})
export type TargetRunMessage = z.infer<typeof TargetRunMessageSchema>

/** Splits a `//pkg/path:name` label into its package and name. */
export const splitLabel = (label: string): { readonly package: string; readonly name: string } => {
  const colon = label.lastIndexOf(":")
  if (colon < 0) return { package: label, name: label.replace(/^\/\//, "").split("/").pop() ?? label }
  return { package: label.slice(0, colon), name: label.slice(colon + 1) }
}

/*
 * The jjhub Cloud seam on the local origin (docs/decisions/0001-piper-one-truth.md):
 * `/api/cloud/*` proxies to the cloud API (SMITHERS_CLOUD_API, default
 * https://api.jjhub.tech) with the Bun-held bearer attached, and the
 * `/api/cloud-auth/*` routes run the CLI's browser login. The token NEVER
 * reaches the renderer: the session answer carries only what a person sees.
 */
export const CLOUD_ROUTE_PREFIX = "/api/cloud/"
/*
 * Lane citc: the workspace-terminal WebSocket tunnel. A browser upgrade can
 * carry no custom header, so this route authorizes like `/ws` — the local
 * session capability rides the subprotocol — and Bun bridges the socket to
 * the cloud API's terminal WebSocket with the Bun-held bearer and plue's
 * `terminal` subprotocol attached upstream.
 */
export const CLOUD_WS_ROUTE_PREFIX = "/api/cloud-ws/"
export const CLOUD_AUTH_START_PATH = "/api/cloud-auth/start"
export const CLOUD_AUTH_SESSION_PATH = "/api/cloud-auth/session"
export const CLOUD_AUTH_SIGN_OUT_PATH = "/api/cloud-auth/sign-out"
export const CloudSessionSchema = z.object({
  state: z.enum(["signed-out", "signing-in", "signed-in"]),
  username: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /**
   * Set when the post-sign-in scope probe (GET /api/user/workspaces) answered
   * 403 insufficient-scope: the legacy token set lacks workspace/agent/
   * approval scopes, so those acts must say "sign in again to enable".
   */
  scopes: z.literal("degraded").optional()
})
export type CloudSession = z.infer<typeof CloudSessionSchema>
/** `POST /api/cloud-auth/start` */
export const CloudAuthStartResponseSchema = z.object({ url: z.string() })
export type CloudAuthStartResponse = z.infer<typeof CloudAuthStartResponseSchema>

/*
 * Lane sync (ADR 0005): the Linear OAuth handoff on the local origin. The
 * backend's OAuth callback cannot redirect to the app (its redirect URI is
 * fixed at the API host), so the local origin runs the receiver the settled
 * team-pick flow needs: `start` listens on 127.0.0.1:<random> and answers
 * the OAuth start URL (through the `/api/cloud/*` proxy, so the Bun-held
 * bearer authenticates it) with `callback_port` attached — the same shape
 * the CLI login already speaks. `callback` records the `?setup=<key>` the
 * callback redirects with; `session` answers it to the renderer. The key is
 * an opaque, one-time, user-bound handle (plue#469) — never a token.
 */
export const LINEAR_AUTH_START_PATH = "/api/linear-auth/start"
export const LINEAR_AUTH_SESSION_PATH = "/api/linear-auth/session"
export const LinearAuthSessionSchema = z.object({
  state: z.enum(["idle", "waiting", "authorized"]),
  /** Present only in the authorized state. */
  setupKey: z.string().optional()
})
export type LinearAuthSession = z.infer<typeof LinearAuthSessionSchema>
/** `POST /api/linear-auth/start` */
export const LinearAuthStartResponseSchema = z.object({ url: z.string() })
export type LinearAuthStartResponse = z.infer<typeof LinearAuthStartResponseSchema>

/** `GET /api/harnesses` */
export const HarnessesResponseSchema = z.object({ harnesses: z.array(HarnessSchema) })
/** `GET /api/repos` */
export const ReposResponseSchema = z.object({ repos: z.array(RepoSchema) })
/** `POST /api/pty` */
export const PtyCreateResponseSchema = z.object({ sessionId: z.string() })

/** `GET /api/pty/:id/output`: the session's recent output (the tail of a bounded scrollback). */
export const PtyOutputResponseSchema = z.object({
  sessionId: z.string(),
  alive: z.boolean(),
  /** Plain text: ANSI escapes stripped, carriage returns dropped. */
  output: z.string(),
  /** True when older output fell out of the bounded buffer or was cut by `tail`. */
  truncated: z.boolean()
})
export type PtyOutputResponse = z.infer<typeof PtyOutputResponseSchema>
