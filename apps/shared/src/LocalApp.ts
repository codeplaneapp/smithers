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
 * the parsed contents of a repository's `.smithers/UI.json`. Strict at every
 * level — an additional root, group or entry key rejects the file — so a
 * hand-edited manifest fails loudly at open instead of rendering a guess.
 */
export const REPO_PLUGIN_GROUP_KINDS = ["recipe", "lint", "workflow", "check"] as const

/** A target label: `//pkg:name` (`//:name` for the root package). */
export const TARGET_LABEL = /^\/\/[^\s:]*:[^\s:]+$/

export const RepoPluginGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(REPO_PLUGIN_GROUP_KINDS)
  })
  .strict()
export type RepoPluginGroup = z.infer<typeof RepoPluginGroupSchema>

const entryShape = {
  id: z.string(),
  group: z.string(),
  workspace: z.string(),
  label: z.string().regex(TARGET_LABEL, "a label is `//pkg:name`"),
  title: z.string(),
  summary: z.string()
}

/*
 * The wire entry: approval and agentic are required so the schema's input
 * and output types agree (TanStack DB's persisted collections demand it).
 * The manifest FILE may omit them — parseRepoPlugin applies the defaults.
 */
export const RepoPluginEntrySchema = z
  .object({ ...entryShape, approval: z.boolean(), agentic: z.boolean() })
  .strict()
export type RepoPluginEntry = z.infer<typeof RepoPluginEntrySchema>

/* The manifest file's entry: approval/agentic optional, defaulting to false. */
const RepoPluginEntryFileSchema = z
  .object({ ...entryShape, approval: z.boolean().optional(), agentic: z.boolean().optional() })
  .strict()

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
  /** The parsed `.smithers/UI.json`; absent when the repo declares none (or an invalid one). */
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

export const PtySessionSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(["terminal", "harness"]),
  harnessId: z.enum(HARNESS_IDS).optional(),
  cwd: z.string(),
  pid: z.number(),
  alive: z.boolean()
})
export type PtySession = z.infer<typeof PtySessionSchema>

/*
 * One Smithers target as `smthrs query '//...' --format json` lists it
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
