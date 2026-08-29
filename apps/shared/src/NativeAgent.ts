import { z } from "zod"
import type { AgentRuntimeContext } from "./AgentContext"
import { CardPatchSchema, CardSchema } from "./Cards"

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

/*
 * The chat turn message contract, matching the landed chat worker
 * (flows/ui workers/chat/src/index.ts validateBody): plain role messages,
 * plus the function_call / function_call_output items a tool-loop
 * continuation turn carries.
 */
export type AgentChatMessage =
  | { readonly role: "user" | "assistant"; readonly content: string }
  | {
    readonly type: "function_call"
    readonly call_id: string
    readonly name: string
    readonly arguments: string
  }
  | {
    readonly type: "function_call_output"
    readonly call_id: string
    readonly output: string
  }

/** The OpenAI JSON-schema function tool spec the chat worker passes upstream. */
export interface AgentToolSpec {
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface StartAgentTurnRequest {
  readonly runId: string
  readonly messages: ReadonlyArray<AgentChatMessage>
  readonly instructions: string
  /** The tool specs offered this turn; the worker forwards them untouched. */
  readonly tools?: ReadonlyArray<AgentToolSpec>
  /**
   * The freshly-derived runtime context for THIS turn (AgentContext.ts). Hidden
   * context: it rides the wire to the server boundary, which renders it into the
   * upstream instructions — it is never persisted into the visible transcript.
   */
  readonly context?: AgentRuntimeContext
}

export type StartAgentTurnResult =
  | { readonly status: "started" }
  | { readonly status: "error"; readonly message: string }

/*
 * Why a turn's stream ended, per the chat tool-loop contract. `cancelled` is
 * the product Worker's own terminal reason: a server-side kill through
 * /api/agent/turn/cancel ends the turn's stream with it so the client renders
 * the kill honestly instead of watching the stream silently stop.
 */
export const AgentTurnDoneReasonSchema = z.enum(["stop", "tool_call", "tool_limit", "cancelled"])

/*
 * The chain frame vocabulary (DESIGN.md §14). These schemas MIRROR the
 * `@smthrs/chain` journal event union — they never import it: src/shared stays
 * runtime-free zod so the Worker and both bridges can speak the envelope
 * without pulling effect. On a chain turn `runId` is the lineage id.
 */

/** The chain's gate observations, plus the two execution-produced kinds. */
export const ChainGateKindSchema = z.enum([
  "shape",
  "fuel",
  "catalog",
  "denied",
  "call_failed",
  "script_failed"
])

/** Why a lineage parked — the chain's suspension reason vocabulary. */
export const ChainParkCodeSchema = z.enum(["approval", "event", "timer", "quota", "plugin"])

/** How a settled call resolved: executed live, cache hit, or replayed prefix. */
export const ChainCallVerdictSchema = z.enum(["run", "hit", "replay"])

/** How a link ended: the three trampoline outcomes. */
export const ChainLinkOutcomeSchema = z.enum(["done", "to", "park"])

/*
 * One frame of a streamed agent turn — the single contract the native Electrobun
 * bridge, the pure-web `/api/agent` boundary, and the Cloudflare Worker all speak.
 * `card` / `card.update` carry the structured surfaces (plan, approval, status)
 * the client renders from its store with zero UI change (DESIGN.md §5).
 * `tool_call` is the chat worker's tool-loop frame (Wave 3b): the client
 * executes it against the command registry and POSTs a continuation turn; it
 * retires with the client tool loop when the chain backend reaches parity.
 * The `link.*` / `call.*` / `gate.rejected` / `steering.drained` / `park`
 * family streams a chain turn (DESIGN.md §14): frames carry what live
 * rendering needs; the chainEvents journal remains the full evidence.
 */
export const AgentTurnFrameSchema = z.discriminatedUnion("type", [
  z.object({
    runId: z.string(),
    type: z.literal("delta"),
    kind: z.enum(["reasoning", "text"]),
    text: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("done"),
    reason: AgentTurnDoneReasonSchema.optional(),
    error: z.string().optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("card"),
    card: CardSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("card.update"),
    id: z.string(),
    patch: CardPatchSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("link.authored"),
    link: z.number().int().nonnegative(),
    scriptDigest: z.string(),
    script: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("call.started"),
    link: z.number().int().nonnegative(),
    ordinal: z.number().int().nonnegative(),
    name: z.string()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("call.settled"),
    link: z.number().int().nonnegative(),
    ordinal: z.number().int().nonnegative(),
    name: z.string(),
    verdict: ChainCallVerdictSchema,
    resultDigest: z.string().optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("gate.rejected"),
    link: z.number().int().nonnegative(),
    kind: ChainGateKindSchema,
    message: z.string().optional()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("link.ended"),
    link: z.number().int().nonnegative(),
    outcome: ChainLinkOutcomeSchema
  }),
  z.object({
    runId: z.string(),
    type: z.literal("steering.drained"),
    link: z.number().int().nonnegative(),
    count: z.number().int().positive()
  }),
  z.object({
    runId: z.string(),
    type: z.literal("park"),
    code: ChainParkCodeSchema,
    card: CardSchema.optional()
  })
])
export type AgentTurnFrame = z.infer<typeof AgentTurnFrameSchema>

export const isAgentTurnFrame = (value: unknown): value is AgentTurnFrame =>
  AgentTurnFrameSchema.safeParse(value).success
