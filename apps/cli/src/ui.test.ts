import { describe, expect, test } from "bun:test"

import { buildUiPath, buildUiUrl, shouldSuppressAutoOpen } from "./ui"

describe("ui deep link helpers", () => {
  test("builds dashboard path", () => {
    expect(buildUiPath({ kind: "dashboard" })).toBe("/runs")
  })

  test("builds run deep link path", () => {
    expect(buildUiPath({ kind: "run", runId: "run-123" })).toBe("/runs/run-123")
  })

  test("builds node deep link path", () => {
    expect(buildUiPath({ kind: "node", runId: "run-123", nodeId: "deploy" })).toBe(
      "/runs/run-123/nodes/deploy"
    )
  })

  test("builds approvals deep link path", () => {
    expect(buildUiPath({ kind: "approvals" })).toBe("/approvals")
  })

  test("builds URL from base and target", () => {
    expect(buildUiUrl("http://127.0.0.1:4173", { kind: "run", runId: "run-123" })).toBe(
      "http://127.0.0.1:4173/runs/run-123?tab=runs&runId=run-123"
    )
  })

  test("builds dashboard URL with query fallback", () => {
    expect(buildUiUrl("http://127.0.0.1:4173", { kind: "dashboard" })).toBe(
      "http://127.0.0.1:4173/runs?tab=runs"
    )
  })

  test("builds node URL with query fallback", () => {
    expect(
      buildUiUrl("http://127.0.0.1:4173", {
        kind: "node",
        runId: "run-123",
        nodeId: "deploy",
      })
    ).toBe("http://127.0.0.1:4173/runs/run-123/nodes/deploy?tab=runs&runId=run-123&nodeId=deploy")
  })

  test("builds approvals URL with query fallback", () => {
    expect(buildUiUrl("http://127.0.0.1:4173", { kind: "approvals" })).toBe(
      "http://127.0.0.1:4173/approvals?tab=approvals"
    )
  })
})

describe("shouldSuppressAutoOpen", () => {
  test("suppresses browser open in CI", () => {
    expect(shouldSuppressAutoOpen({ CI: "1" } as NodeJS.ProcessEnv, "darwin")).toBe(true)
  })

  test("suppresses browser open in linux without display", () => {
    expect(shouldSuppressAutoOpen({} as NodeJS.ProcessEnv, "linux")).toBe(true)
  })

  test("allows browser open in linux with display", () => {
    expect(shouldSuppressAutoOpen({ DISPLAY: ":0" } as NodeJS.ProcessEnv, "linux")).toBe(false)
  })

  test("suppresses browser open over ssh without display", () => {
    expect(
      shouldSuppressAutoOpen({ SSH_CONNECTION: "host", DISPLAY: "" } as NodeJS.ProcessEnv, "darwin")
    ).toBe(true)
  })
})
