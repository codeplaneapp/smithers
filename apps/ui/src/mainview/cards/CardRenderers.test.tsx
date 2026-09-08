import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import type { Card } from "@smthrs/rpc/Cards"
import { CardView } from "../ChatCards"
import { CARD_FAMILIES, CARD_RENDERERS, pillStatus } from "./CardRenderers"

/*
 * The renderer map replaced ChatCards.tsx's render switch and pill switch.
 * These tests prove the map covers exactly the wire's card kinds with no kind
 * claimed twice, that the shared error rule still leads the family's pill,
 * and that a card body reaches the shell through its family's entry.
 */

/** Every card kind the wire declares, read off the discriminated union itself. */
const wireKinds = (): ReadonlyArray<string> =>
  CardSchema.options.map((option) => option.shape.kind.value)

const base = { id: "card-x", title: "Card", createdAt: 1, ordinal: 1 } as const

const handlers = {
  maximized: false,
  onDecideApproval: () => {},
  onGrantConfirm: () => {},
  onGrantCancel: () => {},
  onQueueApprove: () => {},
  onMaximize: () => {},
  onMinimize: () => {},
  onOpenInTab: () => {},
  onConnectGitHub: () => {},
  onConnectLocal: () => {},
  onRunWorkflow: () => {},
  onStopRun: () => {},
  onRetryRun: () => {},
  onChooseWorkflowRepo: () => {},
  worldDocuments: [],
  onChangeWorldDocument: () => {},
  onRunCommand: () => {}
}

describe("CardRenderers", () => {
  test("every wire card kind has exactly one family entry", () => {
    const kinds = wireKinds()
    expect([...Object.keys(CARD_RENDERERS)].sort()).toEqual([...kinds].sort())
    const claimed = CARD_FAMILIES.flatMap((family) => Object.keys(family))
    expect(claimed.length).toBe(kinds.length)
    expect(new Set(claimed).size).toBe(claimed.length)
    for (const entry of Object.values(CARD_RENDERERS)) {
      expect(typeof entry.render).toBe("function")
      expect(typeof entry.pill).toBe("function")
    }
  })

  test("an error card wears failed before its family is asked", () => {
    const completed: Card = {
      ...base,
      kind: "run-trace",
      status: "error",
      payload: { repo: "o/r", runId: "run-1", workflow: "review", phase: "completed", steps: [], result: null, lastSeq: 0 }
    }
    expect(pillStatus(completed)).toBe("failed")
    expect(pillStatus({ ...completed, status: "active" })).toBe("done")
  })

  test("the family's pill rule answers for a non-error card", () => {
    const denied: Card = {
      ...base,
      kind: "approval",
      status: "acted",
      payload: { capability: "deploy:production", decision: "denied" }
    }
    expect(pillStatus(denied)).toBe("denied")
    expect(pillStatus({ ...denied, status: "active", payload: { capability: "deploy:production" } })).toBe(
      "waiting-approval"
    )

    const syncing: Card = {
      ...base,
      kind: "sync-ops",
      status: "active",
      payload: { subject: "Mirror · o/r", source: "github-mirror", runState: null, ops: [] }
    }
    expect(pillStatus(syncing)).toBe("pending")
    expect(pillStatus({ ...syncing, payload: { ...syncing.payload, runState: "succeeded" } })).toBe("succeeded")

    const form: Card = {
      ...base,
      kind: "flow-form",
      status: "active",
      payload: { flow: "repo.open", via: "user", fields: [], draft: {}, given: {} }
    }
    expect(pillStatus(form)).toBe("pending")
    expect(pillStatus({ ...form, status: "acted" })).toBe("done")

    const halfway: Card = { ...base, kind: "status", status: "active", payload: { progress: 0.5 } }
    expect(pillStatus(halfway)).toBe("running")
    expect(pillStatus({ ...halfway, payload: { progress: 1 } })).toBe("done")
  })

  test("a kind without a family rule is done once acted on and pending until then", () => {
    const chooser: Card = {
      ...base,
      kind: "workflow-repo",
      status: "active",
      payload: { intent: "create", description: "Which repository?", repos: ["o/r"], chosen: null }
    }
    expect(pillStatus(chooser)).toBe("pending")
    expect(pillStatus({ ...chooser, status: "acted" })).toBe("done")
  })

  test("the shell mounts the body from the kind's family entry", () => {
    const notifications: Card = {
      ...base,
      kind: "notifications",
      status: "active",
      payload: {
        unread: 1,
        items: [{ id: "n1", title: "Review requested on #12", repo: "o/r", reason: "review_requested", createdAt: null, read: false }]
      }
    }
    const markup = renderToStaticMarkup(<CardView card={notifications} {...handlers} />)
    expect(markup).toContain("data-kind=\"notifications\"")
    expect(markup).toContain("Review requested on #12")

    /* A kind the chat has never drawn renders the shell and an empty body, as the switch did. */
    const serviceLog: Card = {
      ...base,
      kind: "service-log",
      status: "active",
      payload: { workspaceId: "ws-1", repo: "o/r", service: "web", lines: ["ready"], follow: false }
    }
    const shell = renderToStaticMarkup(<CardView card={serviceLog} {...handlers} />)
    expect(shell).toContain("data-kind=\"service-log\"")
    expect(shell).toContain("<div class=\"smithers-card-body\"></div>")
  })
})
