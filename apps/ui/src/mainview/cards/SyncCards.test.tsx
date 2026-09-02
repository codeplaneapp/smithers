import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { pillStatus } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { IssueCardBody } from "./IssueCards"
import { RepoImportCardBody } from "./RepoImportCard"
import { ConnectorSetupCardBody, rateLimitHeldUntil, SyncOpsCardBody } from "./SyncCards"

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

const buttonNamed = (host: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))
  if (button === undefined) throw new Error(`no button named ${text}`)
  return button
}

const click = (host: HTMLElement, text: string): void => {
  flushSync(() => buttonNamed(host, text).click())
}

/** An ISO stamp a number of minutes from now — the rate-limit line reads against the real clock. */
const minutesFromNow = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()

const renderWith = (controller: AppController, node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<ControllerTestProvider controller={controller}>{node}</ControllerTestProvider>)
  })
  return host
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
    expect(commands).toEqual([
      { name: "linear.sync", args: "7" },
      { name: "linear.activity", args: "7" }
    ])
  })

  test("Disconnect arms a confirm row; only its second click runs the flow, with the team key typed back", () => {
    /*
     * Review finding 4: one click on a ghost button deleted the integration.
     * The card-level confirm is the workspace card's rule — the act itself
     * carries the team key as its own input, so a slash cannot skip it either.
     */
    const { host, commands } = renderSetup(
      setupCard({
        phase: "connected",
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).not.toContain("Disconnect Linear ENG from will/smithers?")
    click(host, "Disconnect")
    expect(commands).toEqual([])
    expect(host.textContent).toContain("Disconnect Linear ENG from will/smithers?")

    click(host, "Disconnect ENG")
    expect(commands).toEqual([{ name: "linear.disconnect", args: "7 ENG" }])
  })
})

describe("the frame pill of a sync-ops card", () => {
  test("a null run state (no run DTO yet, plue#468/#470) is never done", () => {
    /* Review finding 3: null fell into "done", so a sync that had just started wore a finished pill. */
    expect(pillStatus(syncOpsCard({ runState: null, trigger: "sync started" }))).toBe("pending")
    expect(pillStatus(syncOpsCard({ runState: "running" }))).toBe("running")
    expect(pillStatus(syncOpsCard({ runState: "done" }))).toBe("done")
    expect(pillStatus(syncOpsCard({ runState: "failed" }))).toBe("failed")
    expect(pillStatus(syncOpsCard({ runState: null, error: "Starting the sync failed (500)" }))).toBe("failed")
  })
})

describe("IssueCardBody — the Linear link (lane sync)", () => {
  const issueCard = (url: string): Extract<Card, { kind: "issue" }> => ({
    id: "issue-will/smithers-90",
    kind: "issue",
    title: "#90",
    status: "acted",
    createdAt: 0,
    ordinal: 0,
    payload: {
      repo: "will/smithers",
      number: 90,
      title: "Flaky test",
      state: "open",
      author: "ana",
      issueBody: "",
      labels: [],
      comments: [],
      linear: { identifier: "ENG-482", url }
    }
  })

  test("an https linear.app URL off the DTO is the link; any other scheme or host renders the identifier as text", async () => {
    /* Review finding 10: the href was rendered straight off the DTO while the install URL was origin-vetted. */
    const controller = await controllerWithRepositories()
    const linked = renderWith(controller, <IssueCardBody card={issueCard("https://linear.app/acme/issue/ENG-482/flaky")} onRunCommand={() => {}} />)
    expect(linked.querySelector("a")?.getAttribute("href")).toBe("https://linear.app/acme/issue/ENG-482/flaky")
    expect(linked.textContent).toContain("Linear ENG-482")

    for (const hostile of ["javascript:alert(1)", "http://linear.app/acme/issue/ENG-482", "https://linear.app.evil.example/x", "not a url"]) {
      const host = renderWith(controller, <IssueCardBody card={issueCard(hostile)} onRunCommand={() => {}} />)
      expect(host.querySelector("a")).toBeNull()
      expect(host.textContent).toContain("Linear ENG-482")
    }
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

  test("the rate-limit line follows the ADR: a reset ahead reads as time ahead, never as an age", () => {
    /* Review finding 2: the age label clamped a future reset to "resets just now". */
    const ahead = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(12) } })
    )
    expect(ahead.host.textContent).toContain("GitHub rate limit reached · 0 of 5,000 · resets in 12 min · Retry after")
    expect(ahead.host.textContent).not.toContain("just now")

    const later = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(90) } })
    )
    expect(later.host.textContent).toMatch(/resets at \d{1,2}:\d{2}/)

    const behind = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-4) } })
    )
    expect(behind.host.textContent).toContain("reset 4 min ago")
  })

  test("a refused call holds Re-check and Reconcile until the reset, with the time on them", () => {
    /* Review finding 5: every retry stayed clickable through the window, re-posting and re-failing. */
    const resetAt = minutesFromNow(12)
    const held = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt }, error: "GitHub rate limit exhausted" })
    )
    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const recheck = buttonNamed(held.host, "Re-check")
    const reconcile = buttonNamed(held.host, "Reconcile")
    expect(recheck.disabled).toBe(true)
    expect(reconcile.disabled).toBe(true)
    expect(recheck.textContent).toContain(`Re-check after ${clock}`)
    expect(reconcile.textContent).toContain(`Reconcile after ${clock}`)
    flushSync(() => recheck.click())
    expect(held.commands).toEqual([])

    /* A low-but-positive budget shows the line and holds nothing; a reset behind us holds nothing. */
    const low = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 40, resetAt } })
    )
    expect(buttonNamed(low.host, "Re-check").disabled).toBe(false)
    const passed = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-1) } })
    )
    expect(buttonNamed(passed.host, "Re-check").disabled).toBe(false)
    expect(rateLimitHeldUntil({ limit: 5000, remaining: 0, resetAt: null })).toBeNull()
  })
})

describe("RepoImportCardBody — the rate-limited retry", () => {
  test("a structured 429 holds Try again until the reset, with the time on it", () => {
    const resetAt = minutesFromNow(12)
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={{
          id: "repo-import-will/flows",
          kind: "repo-import",
          title: "Import · will/flows",
          status: "error",
          createdAt: 0,
          ordinal: 0,
          payload: {
            repo: "will/flows",
            jobId: null,
            phase: "failed",
            detail: "GitHub rate limit exhausted",
            rateLimit: { limit: 5000, remaining: 0, resetAt }
          }
        }}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const retry = buttonNamed(host, "Try again")
    expect(retry.disabled).toBe(true)
    expect(retry.textContent).toContain(`Try again after ${clock}`)
    expect(host.textContent).toContain("resets in 12 min")
    flushSync(() => retry.click())
    expect(commands).toEqual([])
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
