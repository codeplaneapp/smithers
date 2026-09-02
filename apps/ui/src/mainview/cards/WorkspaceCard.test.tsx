import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { WorkspaceCardBody } from "./WorkspaceCard"

/*
 * The workspace card (lane citc): the header names the repo, the bookmark,
 * and the BOOKMARK's head — never a workspace head, never an uptime, never a
 * kind. The four facets render their facts or the ADR's empty state; every
 * act rides onRunCommand with a complete invocation; the delete act asks
 * for the workspace's name typed back.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const workspaceCard = (
  overrides: Partial<Extract<Card, { kind: "workspace" }>["payload"]> = {}
): Extract<Card, { kind: "workspace" }> => ({
  id: "workspace-ws-1",
  kind: "workspace",
  title: "review · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    suspendedAt: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
    snapshots: [],
    sessions: [],
    ...overrides
  }
})

const render = (card: Extract<Card, { kind: "workspace" }>) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <WorkspaceCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
    )
  })
  return { host, commands }
}

const click = (host: HTMLElement, testIdOrText: string): void => {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(testIdOrText) || candidate.getAttribute("aria-label") === testIdOrText)
  if (button === undefined) throw new Error(`no button named ${testIdOrText}`)
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("the workspace card", () => {
  test("the header names the repo, the bookmark, and the bookmark's head — labeled, never a workspace head", () => {
    const { host } = render(workspaceCard())
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · main")
    expect(text).toContain("bookmark main head @ qupxosqw")
    expect(text).not.toContain("uptime")
    expect(text).not.toContain("kind")
    host.remove()
  })

  test("a provisioning workspace states its stage; a suspended one its date", () => {
    const { host } = render(workspaceCard({ status: "starting", provisioningStage: "allocating" }))
    expect(host.textContent).toContain("Provisioning: allocating")
    host.remove()
    const suspended = render(workspaceCard({ status: "suspended", suspendedAt: "2026-08-30T10:00:00Z" }))
    expect(suspended.host.textContent).toContain("Suspended 2026-08-30")
    suspended.host.remove()
  })

  test("the terminal facet offers the open act and lists sessions with destroy", () => {
    const { host, commands } = render(
      workspaceCard({ sessions: [{ id: "sess-1", status: "running", createdAt: null }], terminalSessionId: "sess-1" })
    )
    expect(host.textContent).toContain("Attached to session sess-1")
    click(host, "Open terminal")
    expect(commands[0]).toEqual({ name: "workspace.terminal", args: "ws-1" })
    click(host, "Destroy session sess-1")
    expect(commands[1]).toEqual({ name: "workspace.session.destroy", args: "sess-1 ws-1" })
    host.remove()
  })

  test("files and services render the ADR's empty state — no routes, no invention", () => {
    const { host, commands } = render(workspaceCard({ facet: "files" }))
    expect(host.textContent).toContain("plue#449")
    click(host, "Services")
    expect(commands[0]).toEqual({ name: "workspace.facet", args: "ws-1 services" })
    host.remove()
  })

  test("the snapshots facet lists snapshots with template and delete acts", () => {
    const { host, commands } = render(
      workspaceCard({ facet: "snapshots", snapshots: [{ id: "snap-1", name: "golden", createdAt: "2026-08-01T00:00:00Z" }] })
    )
    expect(host.textContent).toContain("golden")
    click(host, "Make template")
    expect(commands[0]).toEqual({ name: "workspace.template", args: "snap-1 ws-1 --name golden" })
    click(host, "Delete snapshot golden")
    expect(commands[1]).toEqual({ name: "workspace.snapshot.delete", args: "snap-1 ws-1" })
    host.remove()
  })

  test("suspend shows on a running workspace, resume on a suspended one", () => {
    const running = render(workspaceCard())
    click(running.host, "Suspend")
    expect(running.commands[0]).toEqual({ name: "workspace.suspend", args: "ws-1" })
    running.host.remove()
    const suspended = render(workspaceCard({ status: "suspended" }))
    click(suspended.host, "Resume")
    expect(suspended.commands[0]).toEqual({ name: "workspace.resume", args: "ws-1" })
    suspended.host.remove()
  })

  test("the delete act asks for the workspace's name typed back", () => {
    const { host, commands } = render(workspaceCard())
    click(host, "Delete")
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete permanently"))
    expect(confirm?.disabled).toBe(true)
    const input = host.querySelector("input")
    expect(input).not.toBeNull()
    // React tracks the value through the native setter — assign through it or onChange never fires.
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "review")
      input!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const confirmNow = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete permanently"))
    expect(confirmNow?.disabled).toBe(false)
    click(host, "Delete permanently")
    expect(commands[0]).toEqual({ name: "workspace.delete", args: "ws-1" })
    host.remove()
  })

  test("an act's refusal stays on the card", () => {
    const { host } = render(workspaceCard({ error: "driver exploded" }))
    expect(host.textContent).toContain("driver exploded")
    host.remove()
  })

  test("a failed workspace shows where it failed and offers Retry through workspace.open", () => {
    const { host, commands } = render(workspaceCard({ status: "failed", provisioningStage: "boot" }))
    expect(host.textContent).toContain("Failed at boot.")
    click(host, "Retry")
    expect(commands[0]).toEqual({ name: "workspace.open", args: "main will/smithers" })
    host.remove()
  })

  test("the snapshots facet's fork-from act creates a workspace from the snapshot", () => {
    const { host, commands } = render(
      workspaceCard({ facet: "snapshots", snapshots: [{ id: "snap-1", name: "golden", createdAt: null }] })
    )
    click(host, "Fork a workspace from golden")
    expect(commands[0]).toEqual({ name: "workspace.snapshot.fork", args: "snap-1 ws-1" })
    host.remove()
  })
})
