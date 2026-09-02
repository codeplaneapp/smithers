/*
 * The RPC framing the relay speaks to the workspace gateway.
 *
 * The browser cannot hold the gateway credential, so every call goes through
 * this Worker. The Worker takes the product's own envelope — a repo, a
 * procedure name, and a payload — and writes the gateway's newline-delimited
 * RPC frame for it. That keeps the browser free of the wire format and keeps
 * the procedure visible on this side, which is what makes the allowlist and
 * the replay decision possible at all: a Worker that forwarded an opaque body
 * could not tell a run listing from a launch.
 *
 * Frame shapes, read off a live rc.0 gateway:
 *
 *   request  {"_tag":"Request","id":1,"tag":"List","payload":{…},"headers":[]}
 *   success  {"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":…}}
 *   failure  {"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":…}}
 */

/**
 * Where each relayed procedure is mounted on the gateway.
 *
 * `Plan`, `Run`, `Cancel`, `Resume`, `Steer`, `Signal`, and `List` are
 * `@smthrs/control` `ControlRpcs` at `/rpc`. `Projection.Snapshot` and
 * `Approval.Submit` are `@smthrs/gateway` `GatewayRpcs` at `/projections`.
 *
 * This is the product floor and no more: every procedure here has a caller in
 * `apps/ui`, and the relay carries the server-held gateway credential, so
 * mounting a procedure before a product call needs it widens what a
 * compromised browser session can reach for nothing. `Approve` and `Deny`
 * stay out — a decision crosses as the gateway's `Approval.Submit`, which
 * carries the payload the projection published back unchanged.
 *
 * The two streaming procedures (`Watch`, `Projection.Subscribe`) are
 * deliberately absent for a different reason: a stream belongs on the
 * gateway's own WebSocket mounts, which a path-prefixed relay proxies
 * directly, not on a request/response Worker route that would have to buffer
 * it.
 */
export const GATEWAY_PROCEDURE_MOUNTS: Readonly<Record<string, "/rpc" | "/projections">> = {
  Plan: "/rpc",
  Run: "/rpc",
  Cancel: "/rpc",
  Resume: "/rpc",
  Steer: "/rpc",
  Signal: "/rpc",
  List: "/rpc",
  "Projection.Snapshot": "/projections",
  "Approval.Submit": "/projections"
}

/** The gateway procedures the product relays. Nothing else crosses this seam. */
export const ALLOWED_GATEWAY_PROCEDURES: ReadonlyArray<string> = Object.keys(GATEWAY_PROCEDURE_MOUNTS)

/**
 * The one relayed procedure a repeat could duplicate.
 *
 * Every other allowlisted call is a read, or carries an idempotency key the
 * engine deduplicates on, so landing it twice lands one effect. `Run` is the
 * exception because the key belongs to the caller: a client that regenerates
 * it per attempt would start a second run, and the relay cannot see that it
 * did.
 */
export const NON_REPLAYABLE_GATEWAY_PROCEDURES: ReadonlyArray<string> = ["Run"]

/** Encodes one call as the gateway's newline-delimited request frame. */
export const encodeGatewayRequest = (procedure: string, payload: unknown): string =>
  `${JSON.stringify({ _tag: "Request", id: 1, tag: procedure, payload: payload ?? {}, headers: [] })}\n`

/** What the relay answers the browser: the gateway's own outcome, unwrapped. */
export type GatewayRpcFrame =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: { readonly message: string; readonly detail?: unknown } }

const failure = (message: string, detail?: unknown): GatewayRpcFrame => ({
  ok: false,
  error: detail === undefined ? { message } : { message, detail }
})

/**
 * The first sentence of a gateway failure. Effect encodes a typed error as the
 * cause's payload, so the tag and message are read off it where they exist and
 * the whole cause is carried as the detail either way — a refusal the seam
 * cannot summarize is still a refusal the client can show.
 */
const describeCause = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) return "The workspace refused the call."
  const record = cause as Record<string, unknown>
  const message = record.message ?? (record.error as Record<string, unknown> | undefined)?.message
  if (typeof message === "string" && message !== "") return message
  const tag = record._tag ?? record.code
  return typeof tag === "string" && tag !== "" ? tag : "The workspace refused the call."
}

/**
 * Decodes the gateway's answer to one call.
 *
 * Total on purpose: a body that is not a frame at all becomes a refusal the
 * client can render, never a throw inside the Worker's fetch handler.
 *
 * @param text the gateway's response body
 */
export const decodeGatewayResponse = (text: string): GatewayRpcFrame => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "")
  if (line === undefined) return failure("The workspace answered with nothing.")
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    return failure("The workspace answered in a shape the seam did not understand.", line.slice(0, 200))
  }
  if (typeof frame !== "object" || frame === null) {
    return failure("The workspace answered in a shape the seam did not understand.")
  }
  const exit = (frame as { exit?: unknown }).exit
  if (typeof exit !== "object" || exit === null) {
    return failure("The workspace answered without an outcome.", frame)
  }
  const outcome = exit as { _tag?: unknown; value?: unknown; cause?: unknown }
  if (outcome._tag === "Success") return { ok: true, payload: outcome.value }
  return failure(describeCause(outcome.cause), outcome.cause)
}
