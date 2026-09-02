import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { ConnectorSetupCardBody, SyncOpsCardBody } from "./SyncCards"

/*
 * The lane-sync cards (ADR 0005): the Linear wizard renders its steps, the
 * team pick, the repository pick, and the Connect act; the SAME card turned
 * connected offers Sync now / Activity / Disconnect; the GitHub card offers
 * the install and reconcile acts; the sync-ops card renders the ops it was
 * given, the plue#468 degraded note, and the ADR's rate-limit line. Every
 * act rides onRunCommand with a complete invocation.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

type SetupPayload = Extract<Card, { kind: "connector-setup" }>["payload"]
type SyncOpsPayload = Extract<Card, { kind: "sync-ops" }>["payload"]

const setupCard = (overrides: Partial<SetupPayload> = {}): Extract<Card, { kind: "connector-setup" }> => ({
  id: "connector-setup-linear-will/smithers",
  kind: "connector-setup",
  title: "Connect Linear · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    connector: "linear",
    repo: "will/smithers",
    phase: "setup",
    steps: [
      { id: "authorize", label: "Authorize in your browser", state: "done", detail: "authorized as Will" },
      { id: "team", label: "Team", state: "active", detail: null },
      { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
      { id: "confirm", label: "Confirm", state: "pending", detail: null }
    ],
    setupKey: "sk-123",
    teams: [
      { id: "team-eng", name: "Engineering", key: "ENG" },
      { id: "team-design", name: "Design", key: "DES" }
    ],
    ...overrides
  }
})

const syncOpsCard = (overrides: Partial<SyncOpsPayload> = {}): Extract<Card, { kind: "sync-ops" }> => ({
  id: "sync-ops-linear-7",
  kind: "sync-ops",
  title: "Sync · Linear ENG ↔ will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    subject: "Linear ENG ↔ will/smithers",
    source: "linear",
    integrationId: "7",
    repo: "will/smithers",
    runState: null,
    ops: [],
    ...overrides
  }
})

const render = (node: React.ReactNode) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<>{node}</>)
  })
  return { host, commands }
}

const renderSetup = (
  card: Extract<Card, { kind: "connector-setup" }>,
  controller?: AppController
) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  const body = <ConnectorSetupCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
  flushSync(() => {
    createRoot(host).render(
      controller === undefined ? body : <ControllerTestProvider controller={controller}>{body}</ControllerTestProvider>
    )
  })
  return { host, commands }
}

const click = (host: HTMLElement, text: string): void => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))
  if (button === undefined) throw new Error(`no button named ${text}`)
  flushSync(() => button.click())
}

const controllerWithRepositories = async (): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null },
      { id: "acme/flows", org: "acme", ownerKind: "org", name: "flows", head: null }
    ]
  })
  return createAppController(store, unavailableRepositories, silentAgent, {
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
  })
}

describe("ConnectorSetupCardBody — the Linear wizard", () => {
  test("the steps render; the active team step lists the teams one click each", () => {
    const { host, commands } = renderSetup(setupCard())

    expect(host.textContent).toContain("Authorize in your browser")
    expect(host.textContent).toContain("authorized as Will")
    click(host, "ENG · Engineering")
    expect(commands).toEqual([{ name: "linear.connect.team", args: "team-eng will/smithers" }])
  })

  test("the authorize step's Open Linear runs the handoff act", () => {
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "active", detail: null },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        setupKey: undefined,
        teams: undefined
      })
    )

    click(host, "Open Linear")
    expect(commands).toEqual([{ name: "linear.connect.open", args: "will/smithers" }])
  })

  test("a failed step renders the server error verbatim", () => {
    const { host } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "error", detail: null, error: "authorization expired · Open Linear again" },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ]
      })
    )

    expect(host.textContent).toContain("authorization expired · Open Linear again")
  })

  test("the repository pick lists the loaded repositories", async () => {
    const controller = await controllerWithRepositories()
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "done", detail: "authorized" },
          { id: "team", label: "Team", state: "done", detail: "ENG · Engineering" },
          { id: "repository", label: "Repository", state: "active", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        teamId: "team-eng"
      }),
      controller
    )

    click(host, "acme/flows")
    expect(commands).toEqual([{ name: "linear.connect.repo", args: "will/smithers acme/flows" }])
  })

  test("setup key and team picked renders the Connect act", () => {
    const { host, commands } = renderSetup(setupCard({ teamId: "team-eng" }))

    click(host, "Connect")
    expect(commands).toEqual([{ name: "linear.connect.confirm", args: "will/smithers" }])
  })

  test("the connected state offers Sync now, Activity, and Disconnect", () => {
    const { host, commands } = renderSetup(
      setupCard({
        phase: "connected",
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).toContain("ENG · Engineering → will/smithers")
    click(host, "Sync now")
    click(host, "Activity")
    click(host, "Disconnect")
    expect(commands).toEqual([
      { name: "linear.sync", args: "7" },
      { name: "linear.activity", args: "7" },
      { name: "linear.disconnect", args: "7" }
    ])
  })
})

describe("ConnectorSetupCardBody — the GitHub card", () => {
  test("not installed offers Open GitHub and Re-check; installed offers Reconcile", () => {
    const missing = renderSetup(
      setupCard({
        connector: "github",
        phase: "setup",
        steps: [],
        installUrl: "https://github.com/apps/smithers/installations/new"
      })
    )
    expect(missing.host.textContent).toContain("The Smithers GitHub App is not installed")
    click(missing.host, "Open GitHub")
    click(missing.host, "Re-check")
    expect(missing.commands).toEqual([
      { name: "github.app.open", args: "will/smithers" },
      { name: "github.app", args: "will/smithers" }
    ])

    const installed = renderSetup(
      setupCard({ connector: "github", phase: "connected", steps: [], installationId: 5511, configured: true })
    )
    expect(installed.host.textContent).toContain("installation 5511 · configured")
    click(installed.host, "Reconcile")
    expect(installed.commands).toEqual([{ name: "github.reconcile", args: "will/smithers" }])
  })

  test("the rate-limit line follows the ADR", () => {
    const { host } = renderSetup(
      setupCard({
        connector: "github",
        steps: [],
        rateLimit: { limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" }
      })
    )

    expect(host.textContent).toContain("GitHub rate limit reached · 0 of 5,000")
    expect(host.textContent).toContain("Retry after")
  })
})

describe("SyncOpsCardBody", () => {
  test("the degraded note renders when the feed does not exist; no op is faked", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({ opsNote: "The sync ops feed isn't recorded yet (plue#468) — each sync's ops appear here once the backend records them.", trigger: "sync started" })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("Linear ENG ↔ will/smithers")
    expect(host.textContent).toContain("sync started")
    expect(host.textContent).toContain("plue#468")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("a failed retryable op carries the error verbatim and the Retry act", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          ops: [
            { id: "op-3", source: "linear", target: "smithers", entity: "issue", entityId: "ENG-482", action: "updated", status: "failed", error: "remote rejected", retryable: true, at: null }
          ]
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("linear → smithers issue ENG-482 updated")
    expect(host.textContent).toContain("remote rejected")
    click(host, "Retry")
    expect(commands).toEqual([{ name: "sync.retry", args: "op-3" }])
  })

  test("past the cut, Show more widens the window", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const ops = Array.from({ length: 12 }, (_, index) => ({
      id: `op-${index}`,
      source: "linear",
      target: "smithers",
      entity: "issue",
      entityId: `ENG-${index}`,
      action: "updated",
      status: "done" as const,
      retryable: false,
      at: null
    }))
    const { host } = render(
      <SyncOpsCardBody card={syncOpsCard({ ops })} onRunCommand={(name, args) => commands.push({ name, args })} />
    )

    expect(host.textContent).not.toContain("ENG-11")
    click(host, "Show more")
    expect(commands).toEqual([{ name: "sync.ops.show-more", args: "sync-ops-linear-7" }])
  })
})
