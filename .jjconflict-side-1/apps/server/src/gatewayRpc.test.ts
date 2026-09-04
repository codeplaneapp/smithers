/*
 * The RPC framing the relay speaks to the workspace gateway.
 *
 * The frame shapes here were read off a live rc.0 gateway
 * (packages/smithers/gateway `GatewayServer.test.ts` serves the same mounts), so a
 * change to the gateway's wire that this seam has not followed fails here
 * rather than in a browser.
 */
import { describe, expect, test } from "bun:test"
import {
  ALLOWED_GATEWAY_PROCEDURES,
  decodeGatewayResponse,
  encodeGatewayRequest,
  GATEWAY_PROCEDURE_MOUNTS,
  NON_REPLAYABLE_GATEWAY_PROCEDURES
} from "./gatewayRpc"

describe("the relayed procedure catalog", () => {
  test("is exactly the product floor, each on the mount that serves it", () => {
    expect(GATEWAY_PROCEDURE_MOUNTS).toEqual({
      Plan: "/rpc",
      Run: "/rpc",
      Cancel: "/rpc",
      Resume: "/rpc",
      Steer: "/rpc",
      Signal: "/rpc",
      List: "/rpc",
      "Projection.Snapshot": "/projections",
      "Approval.Submit": "/projections"
    })
    expect([...ALLOWED_GATEWAY_PROCEDURES].sort()).toEqual([
      "Approval.Submit",
      "Cancel",
      "List",
      "Plan",
      "Projection.Snapshot",
      "Resume",
      "Run",
      "Signal",
      "Steer"
    ])
  })

  test("relays no control procedure the product does not call", () => {
    // The relay holds the gateway credential on the product's behalf, so the
    // allowlist is the reach a compromised session gets. `Resume`, `Steer`,
    // and `Signal` earned their mounts beside the runs lane's callers
    // (apps/ui runs.resume / runs.steer / runs.signal); `Approve` and `Deny`
    // stay out because a decision crosses as the gateway's
    // `Approval.Submit`, payload unchanged.
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Approve")
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Deny")
  })

  test("relays no streaming procedure, which belongs on the gateway's socket mounts", () => {
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Watch")
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Projection.Subscribe")
  })

  test("names a launch as the one call a lost answer must not replay", () => {
    expect(NON_REPLAYABLE_GATEWAY_PROCEDURES).toEqual(["Run"])
  })
})

describe("encodeGatewayRequest", () => {
  test("writes one newline-terminated request frame", () => {
    const frame = encodeGatewayRequest("List", { _tag: "runs" })
    expect(frame.endsWith("\n")).toBe(true)
    expect(JSON.parse(frame)).toEqual({
      _tag: "Request",
      id: 1,
      tag: "List",
      payload: { _tag: "runs" },
      headers: []
    })
  })

  test("sends an empty payload for a procedure that takes none", () => {
    expect(JSON.parse(encodeGatewayRequest("Plan", undefined)).payload).toEqual({})
  })
})

describe("decodeGatewayResponse", () => {
  const exit = (outcome: unknown): string => `${JSON.stringify({ _tag: "Exit", requestId: 1, exit: outcome })}\n`

  test("unwraps a success into the value the client renders", () => {
    expect(decodeGatewayResponse(exit({ _tag: "Success", value: { runId: "run-1" } }))).toEqual({
      ok: true,
      payload: { runId: "run-1" }
    })
  })

  test("leads a failure with the cause's own message", () => {
    const decoded = decodeGatewayResponse(exit({ _tag: "Failure", cause: { message: "No run run-9" } }))
    expect(decoded).toMatchObject({ ok: false, error: { message: "No run run-9" } })
  })

  test("falls back to the failure's tag, then to a plain refusal", () => {
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: { _tag: "/control/RunNotFound" } }))).toMatchObject({
      ok: false,
      error: { message: "/control/RunNotFound" }
    })
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: { _tag: "" } }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: "nope" }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
  })

  test("reads a nested error message when the cause carries one", () => {
    expect(
      decodeGatewayResponse(exit({ _tag: "Failure", cause: { error: { message: "the plane is down" } } }))
    ).toMatchObject({ ok: false, error: { message: "the plane is down" } })
  })

  test("turns every malformed answer into a refusal a client can show", () => {
    for (const body of ["", "\n\n", "not json\n", '"a string"\n', '{"_tag":"Exit","requestId":1}\n']) {
      const decoded = decodeGatewayResponse(body)
      expect(decoded.ok).toBe(false)
      expect(decoded.ok === false && decoded.error.message.length).toBeGreaterThan(0)
    }
  })

  test("reads the first frame of a multi-line answer", () => {
    const body = `${exit({ _tag: "Success", value: 1 }).trim()}\n{"_tag":"Chunk"}\n`
    expect(decodeGatewayResponse(body)).toEqual({ ok: true, payload: 1 })
  })
})
