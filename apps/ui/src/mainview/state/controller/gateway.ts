/*
 * The workspace gateway, as this app calls it.
 *
 * Every call goes to the product Worker's relay, which holds the per-user
 * gateway credential a browser can never hold and writes the gateway's own RPC
 * frame. The names here are the gateway's names — `Plan`, `Run`, `Cancel`,
 * `Resume`, `Steer`, `Signal`, `List`, `Projection.Snapshot`,
 * `Approval.Submit` — so there is one vocabulary between this file, the
 * Worker, and the engine.
 *
 * The row types are imported from `@smthrs/gateway`, type-only, so a change to
 * a served projection fails this app's typecheck instead of reaching a user as
 * an undefined field.
 */
import type { ControlEvent, SteerMessage } from "@smthrs/control/ControlSchema"
import type { ApprovalRow, NodeOutputRow, RunSummaryRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import { WORKFLOW_RPC_PATH } from "smithers-shared/AgentApiRoutes"

/** What one relayed call answered. */
export type GatewayResult<A> =
  | { readonly status: "ok"; readonly value: A }
  | { readonly status: "error"; readonly message: string }

/** The rc.0 run statuses a card may render. */
export type RunStatus = RunSummaryRow["status"]

/** One discovered flow, as the flow list renders it. */
export interface FlowSummary {
  readonly flowId: string
  readonly description: string | null
}

export type { ApprovalRow, ControlEvent, NodeOutputRow, RunSummaryRow, TranscriptRow }

/** How the seam reaches the relay. */
export interface GatewayTransport {
  readonly baseUrl: string
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly errorMessageOf: (response: Response, fallback: string) => Promise<string>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * The Plue floor, as this app's own seam: list flows and runs, launch, read a
 * run, list and decide approvals (one run's or the workspace inbox), resume,
 * steer, signal, read a node's output or a run's transcript and events,
 * explain a run, and cancel it.
 *
 * @param transport how to reach the relay
 */
export const createGatewaySeam = (transport: GatewayTransport) => {
  const { baseUrl, errorMessageOf } = transport

  /** One relayed gateway procedure. */
  const call = async (
    repo: string,
    procedure: string,
    payload: unknown
  ): Promise<GatewayResult<unknown>> => {
    let body: { ok?: unknown; payload?: unknown; error?: unknown; message?: unknown } | undefined
    try {
      const response = await transport.fetch(`${baseUrl}${WORKFLOW_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, procedure, payload })
      })
      if (!response.ok) {
        return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer.") }
      }
      body = (await response.json().catch(() => undefined)) as typeof body
    } catch {
      return { status: "error", message: "The workspace didn't answer — the workflow service is unreachable." }
    }
    if (body?.ok === true) return { status: "ok", value: body.payload }
    if (body?.ok === false) {
      const message = asRecord(body.error).message
      return {
        status: "error",
        message: typeof message === "string" && message !== "" ? message : "The workspace refused the call."
      }
    }
    if (typeof body?.message === "string") return { status: "error", message: body.message }
    return { status: "error", message: "The workspace answered in a shape I didn't understand." }
  }

  const rowsOf = (value: unknown): ReadonlyArray<unknown> => {
    const rows = asRecord(value).rows
    return Array.isArray(rows) ? rows : []
  }

  const map = <A>(result: GatewayResult<unknown>, project: (value: unknown) => A): GatewayResult<A> =>
    result.status === "ok" ? { status: "ok", value: project(result.value) } : result

  /** One projection snapshot, by selector. */
  const projection = (repo: string, selector: unknown): Promise<GatewayResult<unknown>> =>
    call(repo, "Projection.Snapshot", { selector })

  return {
    call,

    /** Every flow the workspace has discovered. */
    listFlows: async (repo: string): Promise<GatewayResult<ReadonlyArray<FlowSummary>>> =>
      map(await call(repo, "List", { _tag: "flows" }), (value) => {
        const items = asRecord(value).items
        return (Array.isArray(items) ? items : [])
          .map((entry) => asRecord(entry))
          .filter((entry) => typeof entry.flowId === "string")
          .map((entry): FlowSummary => ({
            flowId: entry.flowId as string,
            description: typeof entry.description === "string" && entry.description.trim() !== ""
              ? entry.description
              : null
          }))
      }),

    /**
     * Start a flow: plan it, approve the plan, and run it.
     *
     * Three calls because they are three decisions, and the middle one is the
     * approval a human or a policy grants. The relay never replays a `Run`, so
     * a lost answer here is reported rather than retried into a second run.
     */
    launch: async (
      repo: string,
      flowId: string,
      input: Record<string, unknown>
    ): Promise<GatewayResult<{ readonly runId: string }>> => {
      const planned = await call(repo, "Plan", { flowId, input })
      if (planned.status !== "ok") return planned
      const card = asRecord(planned.value)
      const planId = typeof card.planId === "string" ? card.planId : undefined
      const digest = typeof card.digest === "string" ? card.digest : undefined
      if (planId === undefined || digest === undefined) {
        return { status: "error", message: "The workspace planned the run but didn't name the plan." }
      }
      const approved = await call(repo, "Approval.Submit", {
        target: { _tag: "Plan", planId, digest, envelope: card.envelope },
        scope: "run",
        idempotencyKey: `approve:${planId}`,
        decision: "approve"
      })
      if (approved.status !== "ok") return approved
      const started = await call(repo, "Run", {
        _tag: "Plan",
        planId,
        digest,
        envelope: card.envelope,
        idempotencyKey: `run:${planId}`
      })
      if (started.status !== "ok") return started
      const runId = asRecord(started.value).runId
      return typeof runId === "string"
        ? { status: "ok", value: { runId } }
        : { status: "error", message: "The run started but the workspace didn't name it — ask me to check." }
    },

    /** One run's summary, including its diagnosis. */
    run: async (repo: string, runId: string): Promise<GatewayResult<RunSummaryRow | undefined>> =>
      map(
        await projection(repo, { _tag: "run-summary", runId }),
        (value) => rowsOf(value)[0] as RunSummaryRow | undefined
      ),

    /** Every gate this run has asked for, decided ones included. */
    approvals: async (repo: string, runId: string): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      map(await projection(repo, { _tag: "approvals", runId }), (value) => rowsOf(value) as ReadonlyArray<ApprovalRow>),

    /**
     * Decide one gate.
     *
     * The payload the projection published goes back unchanged, so the client
     * never reconstructs authority. One call records the decision AND resumes
     * the run it unblocked: there is no second resume for a lost answer to
     * strand.
     */
    submitApproval: (
      repo: string,
      approval: ApprovalRow["payload"],
      decision: "approve" | "deny"
    ): Promise<GatewayResult<unknown>> => call(repo, "Approval.Submit", { ...approval, decision }),

    /** What one node produced. */
    nodeOutput: async (
      repo: string,
      runId: string,
      nodeId: string
    ): Promise<GatewayResult<NodeOutputRow | undefined>> =>
      map(
        await projection(repo, { _tag: "node-output", runId, nodeId }),
        (value) => rowsOf(value)[0] as NodeOutputRow | undefined
      ),

    /** What happened to a run, in words: the run summary's diagnosis. */
    explain: async (repo: string, runId: string): Promise<GatewayResult<string | undefined>> =>
      map(await projection(repo, { _tag: "run-summary", runId }), (value) => {
        const row = rowsOf(value)[0] as RunSummaryRow | undefined
        return row?.verdict
      }),

    /** Stop a run. Durable: the next read of it says cancelled. */
    cancel: (repo: string, runId: string, reason?: string): Promise<GatewayResult<unknown>> =>
      call(repo, "Cancel", {
        runId,
        idempotencyKey: `cancel:${runId}`,
        reason: reason === undefined || reason.trim() === "" ? "the human stopped it" : reason
      }),

    /*
     * Lane runs — the run lifecycle beyond launch and cancel.
     *
     * Every mutation mints one idempotency key per invocation: the relay may
     * replay a lost answer with the same frame, and the engine deduplicates
     * on the key, so a repeat lands one effect and two deliberate clicks land
     * two (a second resume of a live run is the gateway's own ClaimLost).
     */

    /** Restart a parked run (or tell the run's owner to). */
    resume: (repo: string, runId: string, reason?: string): Promise<GatewayResult<unknown>> =>
      call(repo, "Resume", {
        runId,
        idempotencyKey: `resume:${runId}:${Date.now()}`,
        ...(reason === undefined ? {} : { reason })
      }),

    /** Deliver a named signal to a run parked on a wait. */
    signal: (repo: string, runId: string, name: string, payload: unknown): Promise<GatewayResult<unknown>> =>
      call(repo, "Signal", {
        runId,
        signal: { name, payload: payload ?? {} },
        idempotencyKey: `signal:${runId}:${name}:${Date.now()}`
      }),

    /**
     * Steer a running agent. The steer envelope's principal is the server's
     * to stamp (`ControlServer` overwrites it with the authenticated one on
     * every steer that arrives over RPC), so the placeholder here never
     * reaches a journal as authority.
     */
    steer: (
      repo: string,
      runId: string,
      item:
        | { readonly kind: "Message"; readonly body: string }
        | { readonly kind: "Seat"; readonly seat: string }
        | { readonly kind: "Thinking"; readonly thinking: string }
        | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> }
    ): Promise<GatewayResult<unknown>> => {
      const now = Date.now()
      const envelope = {
        messageId: `steer-${runId}-${now}`,
        runId,
        principal: { id: "app-operator", kind: "user", stampedAt: now },
        createdAt: now
      }
      const message = (
        item.kind === "Message"
          ? { ...envelope, kind: "Message", body: item.body }
          : item.kind === "Seat"
          ? { ...envelope, kind: "Seat", seat: item.seat }
          : item.kind === "Thinking"
          ? { ...envelope, kind: "Thinking", thinking: item.thinking }
          : { ...envelope, kind: "Tools", toolNames: [...item.toolNames] }
      ) as SteerMessage
      return call(repo, "Steer", { runId, message, idempotencyKey: `steer:${runId}:${now}` })
    },

    /** Every run on the workspace, one summary row each (the run inbox's read). */
    workspaceRuns: async (repo: string): Promise<GatewayResult<ReadonlyArray<RunSummaryRow>>> =>
      map(
        await projection(repo, { _tag: "workspace-runs" }),
        (value) => rowsOf(value) as ReadonlyArray<RunSummaryRow>
      ),

    /** The approvals inbox: every pending gate across the workspace's runs. */
    approvalsInbox: async (repo: string): Promise<GatewayResult<ReadonlyArray<ApprovalRow>>> =>
      map(
        await projection(repo, { _tag: "approvals" }),
        (value) => rowsOf(value) as ReadonlyArray<ApprovalRow>
      ),

    /** One run's turn-by-turn transcript. */
    transcript: async (repo: string, runId: string): Promise<GatewayResult<ReadonlyArray<TranscriptRow>>> =>
      map(
        await projection(repo, { _tag: "transcript", runId }),
        (value) => rowsOf(value) as ReadonlyArray<TranscriptRow>
      ),

    /** One run's raw control events, in journal order. */
    runEvents: async (repo: string, runId: string): Promise<GatewayResult<ReadonlyArray<ControlEvent>>> =>
      map(
        await projection(repo, { _tag: "run-events", runId }),
        (value) => rowsOf(value) as ReadonlyArray<ControlEvent>
      )
  }
}

/** The gateway seam this app's controller holds. */
export type GatewaySeam = ReturnType<typeof createGatewaySeam>
