/*
 * The workspace gateway seam, against a relay double: every projection and
 * operation lane runs added rides the one relay envelope, and the payload each
 * sends is the gateway's own procedure shape — a drift between this file and
 * the allowlisted procedures fails here, not in a browser.
 */
import { describe, expect, test } from "bun:test"
import { createGatewaySeam } from "./gateway"

interface RecordedCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: unknown
}

/** A relay double: records the envelope, answers one scripted payload (or refusal) per procedure. */
const relay = (answers: Readonly<Record<string, unknown>> = {}) => {
  const calls: Array<RecordedCall> = []
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    fetch: async (url, init) => {
      expect(url).toBe("https://app.test/api/workflow/rpc")
      const body = JSON.parse(String(init?.body ?? "{}")) as RecordedCall
      calls.push(body)
      const answer = answers[body.procedure] ?? { ok: true, payload: {} }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  return { calls, seam }
}

const rowsAnswer = (rows: ReadonlyArray<unknown>) => ({
  ok: true,
  payload: { cursor: { projection: "test", runId: null, value: 0 }, rows }
})

describe("the run lifecycle operations", () => {
  test("cancel carries the human's reason, defaulting to the standing one", async () => {
    const { calls, seam } = relay()
    expect((await seam.cancel("o/r", "run-1")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "it hung")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "  ")).status).toBe("ok")
    expect(calls.map((call) => call.payload)).toEqual([
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "it hung" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" }
    ])
    expect(calls.every((call) => call.procedure === "Cancel" && call.repo === "o/r")).toBe(true)
  })

  test("resume sends the control mutation with an idempotency key and optional reason", async () => {
    const { calls, seam } = relay()
    expect((await seam.resume("o/r", "run-1", "nothing was driving it")).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Resume")
    expect(payload.runId).toBe("run-1")
    expect(payload.reason).toBe("nothing was driving it")
    expect(String(payload.idempotencyKey)).toMatch(/^resume:run-1:\d+$/)
  })

  test("signal sends the named signal with its JSON payload", async () => {
    const { calls, seam } = relay()
    expect((await seam.signal("o/r", "run-1", "deploy-done", { ok: true })).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Signal")
    expect(payload.runId).toBe("run-1")
    expect(payload.signal).toEqual({ name: "deploy-done", payload: { ok: true } })
    expect(String(payload.idempotencyKey)).toMatch(/^signal:run-1:deploy-done:\d+$/)
  })

  test("a signal without a payload sends the empty object", async () => {
    const { calls, seam } = relay()
    await seam.signal("o/r", "run-1", "deploy-done", undefined)
    expect((calls[0]?.payload as { signal: unknown }).signal).toEqual({ name: "deploy-done", payload: {} })
  })

  test("a refusal crosses as the seam's error, message first", async () => {
    const { seam } = relay({ Signal: { ok: false, error: { message: "NoMatchingWait: no wait named deploy-done" } } })
    const result = await seam.signal("o/r", "run-1", "deploy-done", {})
    expect(result).toEqual({ status: "error", message: "NoMatchingWait: no wait named deploy-done" })
  })
})

describe("steer", () => {
  const envelopeOf = (payload: unknown): Record<string, unknown> =>
    (payload as { message: Record<string, unknown> }).message

  test("an operator message carries the steer envelope and the body", async () => {
    const { calls, seam } = relay()
    expect((await seam.steer("o/r", "run-1", { kind: "Message", body: "use the smaller diff" })).status).toBe("ok")
    expect(calls[0]?.procedure).toBe("Steer")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(payload.runId).toBe("run-1")
    expect(String(payload.idempotencyKey)).toMatch(/^steer:run-1:\d+$/)
    const message = envelopeOf(calls[0]?.payload)
    expect(message.kind).toBe("Message")
    expect(message.body).toBe("use the smaller diff")
    expect(message.runId).toBe("run-1")
    expect(String(message.messageId)).toMatch(/^steer-run-1-\d+$/)
    // The placeholder principal the server overwrites with the authenticated one.
    expect(message.principal).toMatchObject({ kind: "user" })
    expect(typeof message.createdAt).toBe("number")
  })

  test("the seat, thinking, and tools variants carry their own fields", async () => {
    const { calls, seam } = relay()
    await seam.steer("o/r", "run-1", { kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    await seam.steer("o/r", "run-1", { kind: "Thinking", thinking: "high" })
    await seam.steer("o/r", "run-1", { kind: "Tools", toolNames: ["bash", "edit"] })
    expect(envelopeOf(calls[0]?.payload)).toMatchObject({ kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    expect(envelopeOf(calls[1]?.payload)).toMatchObject({ kind: "Thinking", thinking: "high" })
    expect(envelopeOf(calls[2]?.payload)).toMatchObject({ kind: "Tools", toolNames: ["bash", "edit"] })
  })
})

describe("the run projections", () => {
  /** A complete run summary, as the workspace-runs projection answers it. */
  const summaryRow = {
    runId: "run-1",
    flowId: "review-pr",
    status: "running" as const,
    createdAt: 1000,
    updatedAt: 2000,
    turns: 3,
    calls: 5,
    callsFailed: 0,
    editsAttempted: 1,
    editsSucceeded: 1,
    inputTokens: 100,
    outputTokens: 50,
    verdict: "running",
    diagnosis: "The run is moving."
  }
  /** A complete approval, as the approvals projection answers it. */
  const approvalRow = {
    runId: "run-1",
    requestId: "req-1",
    title: "Run the deploy script?",
    request: { question: "Run the deploy script?" },
    payload: {
      target: {
        _tag: "Node" as const,
        runId: "run-1",
        requestId: "req-1",
        digest: "sha256:test",
        envelope: { capabilities: [], flows: [], budget: { milliseconds: undefined, tokens: undefined } }
      },
      scope: "run" as const,
      idempotencyKey: "approve:req-1"
    },
    requestedAt: 1500,
    status: "pending" as const
  }

  test("workspaceRuns selects workspace-runs and answers the summary rows", async () => {
    const rows = [summaryRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.workspaceRuns("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "workspace-runs" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("approvalsInbox selects approvals WITHOUT a run id", async () => {
    const rows = [approvalRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.approvalsInbox("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("a run's approvals still select with its run id", async () => {
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    await seam.approvals("o/r", "run-1")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals", runId: "run-1" } })
  })

  test("transcript and runEvents select their projections for the run", async () => {
    const event = { kind: "control.run.accepted", payload: {}, sequence: 1, occurredAt: 1000 }
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer([event]) })
    const transcript = await seam.transcript("o/r", "run-1")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "transcript", runId: "run-1" } })
    expect(transcript.status).toBe("ok")
    const events = await seam.runEvents("o/r", "run-1")
    expect(calls[1]?.payload).toEqual({ selector: { _tag: "run-events", runId: "run-1" } })
    expect(events).toEqual({ status: "ok", value: [event] })
  })

  test("a missing rows envelope answers an empty listing, never a throw", async () => {
    const { seam } = relay({ "Projection.Snapshot": { ok: true, payload: { cursor: {} } } })
    expect(await seam.workspaceRuns("o/r")).toEqual({ status: "ok", value: [] })
  })
})
