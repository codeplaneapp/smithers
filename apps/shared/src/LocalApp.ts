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
  launch: z.object({ argv: z.array(z.string()) })
})
export type Harness = z.infer<typeof HarnessSchema>

/*
 * The repo plugin manifest (apps/ui/docs/LOCAL-APP.md "Plugin manifest"):
 * the parsed contents of a repository's `smithers-ui.json`. Strict at every
 * level — an additional root, group or entry key rejects the file — so a
 * hand-edited manifest fails loudly at open instead of rendering a guess.
 */
export const REPO_PLUGIN_GROUP_KINDS = ["recipe", "lint", "workflow", "check"] as const

/** A target label: `//pkg:name` (`//:name` for the root package). */
export const TARGET_LABEL = /^\/\/[^\s:]*:[^\s:]+$/

/**
 * The verbs `smithers-build` executes over a pattern (`smithers-build
 * --help`). A pattern run is `<verb> <pattern>`: the CLI resolves the
 * pattern to its targets and runs every one, which is what "run everything"
 * is (`ci '//packages/...'`); no single target does that.
 */
export const TARGET_RUN_VERBS = ["build", "ci", "docs", "lint", "run", "test"] as const
export const TargetRunVerbSchema = z.enum(TARGET_RUN_VERBS)
export type TargetRunVerb = z.infer<typeof TargetRunVerbSchema>

/** A pattern the CLI accepts: an exact label or a `//dir/...` subtree (`//...` for the whole workspace). */
export const TARGET_PATTERN = /^\/\/(?:(?:(?!\.\.\.\/)[^\s:/]+\/)*\.\.\.|(?!.*\.\.\.)[^\s:]*:[^\s:]+)$/

/** The verb and pattern of one pattern run; `title` reads `ci //packages/...`. */
export const patternRunTitle = (verb: string, pattern: string): string => `${verb} ${pattern}`

export const RepoPluginGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(REPO_PLUGIN_GROUP_KINDS),
    /** Every entry of a featured group leads the targets card's Featured view. */
    featured: z.boolean().optional()
  })
  .strict()
export type RepoPluginGroup = z.infer<typeof RepoPluginGroupSchema>

/*
 * An entry runs ONE target (`label`) or a whole pattern (`verb` + `pattern`,
 * e.g. `ci //packages/...`); `entryRun` refines that exactly one form is
 * present. The pattern form is how a manifest declares "run everything".
 */
const entryShape = {
  id: z.string(),
  group: z.string(),
  workspace: z.string(),
  label: z.string().regex(TARGET_LABEL, "a label is `//pkg:name`").optional(),
  verb: TargetRunVerbSchema.optional(),
  pattern: z.string().regex(TARGET_PATTERN, "a pattern is `//dir/...` or a label").optional(),
  title: z.string(),
  summary: z.string(),
  /** A featured entry leads the targets card's Featured view (the repository's essentials). */
  featured: z.boolean().optional()
}

const entryRun = (
  entry: { readonly id: string; readonly label?: string; readonly verb?: string; readonly pattern?: string },
  ctx: z.RefinementCtx
): void => {
  const asLabel = entry.label !== undefined
  const asPattern = entry.verb !== undefined || entry.pattern !== undefined
  if (asLabel === asPattern) {
    ctx.addIssue({ code: "custom", message: `entry ${entry.id} needs either a label or a verb and a pattern` })
  } else if (asPattern && (entry.verb === undefined || entry.pattern === undefined)) {
    ctx.addIssue({ code: "custom", message: `entry ${entry.id} needs both a verb and a pattern` })
  }
}

/*
 * The wire entry: approval and agentic are required so the schema's input
 * and output types agree (TanStack DB's persisted collections demand it).
 * The manifest FILE may omit them — parseRepoPlugin applies the defaults.
 */
export const RepoPluginEntrySchema = z
  .object({ ...entryShape, approval: z.boolean(), agentic: z.boolean() })
  .strict()
  .superRefine(entryRun)
export type RepoPluginEntry = z.infer<typeof RepoPluginEntrySchema>

/* The manifest file's entry: approval/agentic optional, defaulting to false. */
const RepoPluginEntryFileSchema = z
  .object({ ...entryShape, approval: z.boolean().optional(), agentic: z.boolean().optional() })
  .strict()
  .superRefine(entryRun)

/** `path: message`, or just the message for a root-level issue. */
const issueText = (issue: { readonly path: ReadonlyArray<PropertyKey>; readonly message: string }): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`

const groupRefs = (
  manifest: { readonly groups: ReadonlyArray<{ readonly id: string }>; readonly entries: ReadonlyArray<{ readonly id: string; readonly group: string }> },
  ctx: z.RefinementCtx
): void => {
  const groups = new Set(manifest.groups.map((group) => group.id))
  for (const entry of manifest.entries) {
    if (!groups.has(entry.group)) {
      ctx.addIssue({ code: "custom", message: `entry ${entry.id} names an undeclared group ${entry.group}` })
    }
  }
}

export const RepoPluginSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    groups: z.array(RepoPluginGroupSchema),
    entries: z.array(RepoPluginEntrySchema)
  })
  .strict()
  .superRefine(groupRefs)
export type RepoPlugin = z.infer<typeof RepoPluginSchema>

const RepoPluginFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    groups: z.array(RepoPluginGroupSchema),
    entries: z.array(RepoPluginEntryFileSchema)
  })
  .strict()
  .superRefine(groupRefs)

/**
 * The manifest validated against the repository's detected workspaces: every
 * entry's workspace must be one of them. Omitted approval/agentic flags
 * default to false. Shape failures and stray workspaces come back as issues
 * — the caller turns them into repo warnings, never a 500.
 */
export const parseRepoPlugin = (
  value: unknown,
  workspaces: ReadonlyArray<string>
): { readonly plugin: RepoPlugin } | { readonly issues: ReadonlyArray<string> } => {
  const file = RepoPluginFileSchema.safeParse(value)
  if (!file.success) {
    return { issues: file.error.issues.map(issueText) }
  }
  const normalized = {
    ...file.data,
    entries: file.data.entries.map((entry) => ({ ...entry, approval: entry.approval ?? false, agentic: entry.agentic ?? false }))
  }
  const parsed = RepoPluginSchema.safeParse(normalized)
  if (!parsed.success) {
    return { issues: parsed.error.issues.map(issueText) }
  }
  const known = new Set(workspaces)
  const stray = parsed.data.entries.filter((entry) => !known.has(entry.workspace))
  if (stray.length > 0) {
    return {
      issues: stray.map((entry) => `entry ${entry.id} names an undetected workspace ${entry.workspace}`)
    }
  }
  return { plugin: parsed.data }
}

/**
 * The labels a manifest marks featured (LOCAL-APP.md "Plugin manifest"): an
 * entry with `featured: true`, or any entry of a group with `featured: true`.
 * The targets card's Featured view leads with these.
 */
export const featuredLabels = (plugin: RepoPlugin): ReadonlyArray<string> => {
  const groups = new Set(plugin.groups.filter((group) => group.featured === true).map((group) => group.id))
  const labels: Array<string> = []
  for (const entry of plugin.entries) {
    if (entry.label === undefined) continue
    if ((entry.featured === true || groups.has(entry.group)) && !labels.includes(entry.label)) labels.push(entry.label)
  }
  return labels
}

/** One featured pattern run of a manifest (`ci //packages/...`), in manifest order. */
export interface FeaturedPatternRun {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly workspace: string
  readonly verb: TargetRunVerb
  readonly pattern: string
}

/** The pattern entries a manifest marks featured, by entry flag or featured group. */
export const featuredPatternRuns = (plugin: RepoPlugin): ReadonlyArray<FeaturedPatternRun> => {
  const groups = new Set(plugin.groups.filter((group) => group.featured === true).map((group) => group.id))
  const runs: Array<FeaturedPatternRun> = []
  for (const entry of plugin.entries) {
    if (entry.verb === undefined || entry.pattern === undefined) continue
    if (entry.featured !== true && !groups.has(entry.group)) continue
    runs.push({ id: entry.id, title: entry.title, summary: entry.summary, workspace: entry.workspace, verb: entry.verb, pattern: entry.pattern })
  }
  return runs
}

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
  /** Loader and manifest problems surfaced at open; empty when the open was clean. */
  warnings: z.array(z.string()),
  /** The parsed `smithers-ui.json`; absent when the repo declares none (or an invalid one). */
  plugin: RepoPluginSchema.optional(),
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
  workspace: z.string()
})
export type TargetDefinition = z.infer<typeof TargetDefinitionSchema>

/*
 * The browser receives an opaque id minted by the local repository authority.
 * Optional keeps previously persisted target cards readable; a legacy row has
 * no runnable capability until the repository is queried again.
 */
export const TargetSchema = TargetDefinitionSchema.extend({ id: z.string().min(1).optional() })
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
 * (smithers-shared/TargetGraph `TargetRunEvent.seq`): 0-based, gap-free, and
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
  /* The structured run frames (smithers-shared/TargetGraph TargetRunEvent). */
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
