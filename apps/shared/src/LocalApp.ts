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

export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  git: z.object({ branch: z.string().nullable(), remote: z.string().nullable() }).nullable(),
  smithers: z.object({
    detected: z.boolean(),
    workspaceFile: z.string().nullable(),
    declarationFiles: z.array(z.string()),
    reason: z.string()
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

export const TargetSchema = z.object({
  label: z.string(),
  target: z.string(),
  kinds: z.array(z.string()),
  package: z.string(),
  name: z.string()
})
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
