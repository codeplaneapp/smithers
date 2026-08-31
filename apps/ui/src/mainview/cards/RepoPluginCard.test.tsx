import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { RepoPluginCardBody } from "./RepoPluginCard"
import { RepoCardBody, TargetsCardBody } from "./TargetCards"

/*
 * The repo-plugin card and the multi-workspace targets card (LOCAL-APP.md
 * "Cards" / "Plugin manifest"): the plugin card renders the manifest's
 * title, summary, group sections and entries with workspace/approval/
 * agentic/kind badges, and every Run dispatches the existing target.run
 * flow with { repoId, workspace, label }. The targets card groups workspace
 * then package and offers the same Run per row.
 */

GlobalRegistrator.register()

afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const manifest = {
  schemaVersion: 1 as const,
  name: "aomi",
  title: "Aomi",
  summary: "Cross-repo workflows.",
  groups: [
    { id: "checks", title: "Checks", kind: "check" as const },
    { id: "recipes", title: "Recipes", kind: "recipe" as const }
  ],
  entries: [
    {
      id: "check",
      group: "checks",
      workspace: ".",
      label: "//:check",
      title: "Check everything",
      summary: "One gate.",
      approval: false,
      agentic: false
    },
    {
      id: "clippy-fix",
      group: "recipes",
      workspace: "aomi-sdk",
      label: "//:clippyFix",
      title: "Clippy fix",
      summary: "Make clippy green.",
      approval: true,
      agentic: true
    }
  ]
}

const pluginCard = (): Extract<Card, { kind: "repo-plugin" }> => ({
  id: "repo-plugin-r1",
  kind: "repo-plugin",
  title: "Aomi",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "r1", manifest }
})

const targetsCard = (): Extract<Card, { kind: "targets" }> => ({
  id: "targets-r1",
  kind: "targets",
  title: "aomi targets",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "r1",
    repoName: "aomi",
    status: "done",
    warnings: [],
    targets: [
      { id: "target-check", label: "//:check", target: "Shell.Test", kinds: ["test"], package: "//", name: "check", workspace: "." },
      { id: "target-clippy", label: "//:clippyFix", target: "Shell.Test", kinds: ["lint"], package: "//", name: "clippyFix", workspace: "aomi-sdk" }
    ]
  }
})

const render = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

describe("the repo-plugin card", () => {
  test("renders the manifest summary, group sections and entries with the four badges", () => {
    const host = render(<RepoPluginCardBody card={pluginCard()} onRunCommand={() => {}} />)
    expect(host.textContent).toContain("Cross-repo workflows.")
    const checks = host.querySelector("[data-group=\"checks\"]")
    expect(checks?.textContent).toContain("Checks")
    expect(checks?.textContent).toContain("Check everything")
    const entry = host.querySelector("[data-plugin-entry=\"clippy-fix\"]")
    expect(entry?.textContent).toContain("Make clippy green.")
    expect(entry?.querySelector("[data-badge=\"workspace\"]")?.textContent).toContain("aomi-sdk")
    expect(entry?.querySelector("[data-badge=\"kind\"]")?.textContent).toContain("recipe")
    expect(entry?.querySelector("[data-badge=\"approval\"]")).not.toBeNull()
    expect(entry?.querySelector("[data-badge=\"agentic\"]")).not.toBeNull()
  })

  test("approval and agentic are tinted, not four identical muted chips", () => {
    // StatusPill buckets a STATUS string through the shared vocabulary, so a
    // class name like "warn" falls through to muted and an approval-required
    // entry would look exactly like one that needs none.
    const host = render(<RepoPluginCardBody card={pluginCard()} onRunCommand={() => {}} />)
    const flagged = host.querySelector("[data-plugin-entry=\"clippy-fix\"]")
    const plain = host.querySelector("[data-plugin-entry=\"check\"]")
    expect(flagged?.querySelector("[data-badge=\"approval\"]")?.className).toContain("sui-badge-warning")
    expect(flagged?.querySelector("[data-badge=\"agentic\"]")?.className).toContain("sui-badge-default")
    expect(plain?.querySelector("[data-badge=\"approval\"]")?.className).toContain("sui-badge-muted")
    expect(plain?.querySelector("[data-badge=\"agentic\"]")?.className).toContain("sui-badge-muted")
    expect(flagged?.querySelector("[data-badge=\"workspace\"]")?.className).toContain("sui-badge-muted")
  })

  test("Run dispatches target.run with the repo id, workspace and label", () => {
    const ran: Array<string> = []
    const host = render(
      <RepoPluginCardBody card={pluginCard()} onRunCommand={(name, args) => ran.push(`${name} ${args ?? ""}`)} />
    )
    const button = host.querySelector("[data-testid=\"plugin-run-clippy-fix\"]") as HTMLElement | null
    expect(button).not.toBeNull()
    button?.click()
    expect(ran).toEqual(["target.run r1 aomi-sdk //:clippyFix"])
  })
})

describe("the targets card", () => {
  test("every row carries its workspace and runs with it", () => {
    const ran: Array<string> = []
    const host = render(<TargetsCardBody card={targetsCard()} onRunCommand={(name, args) => ran.push(`${name} ${args ?? ""}`)} />)
    expect(host.querySelector("[data-target-row][data-workspace=\".\"]")).not.toBeNull()
    const sdk = host.querySelector("[data-target-row=\"//:clippyFix\"][data-workspace=\"aomi-sdk\"]")
    expect(sdk?.textContent).toContain("//:clippyFix")
    const button = sdk?.querySelector("[data-testid=\"targets-run-//:clippyFix\"]") as HTMLElement | null
    expect(button).not.toBeNull()
    button?.click()
    expect(ran).toEqual(["target.run r1 aomi-sdk //:clippyFix"])
  })

  test("names the root workspace by the repository, never by the raw \".\" path token", () => {
    // Copy rule (apps/DESIGN.md §9): no internal path tokens in user-facing copy.
    const host = render(<TargetsCardBody card={targetsCard()} onRunCommand={() => {}} />)
    const root = host.querySelector("[data-target-row][data-workspace=\".\"] .targets-table-workspace")
    expect(root?.textContent).toBe("aomi")
    const option = host.querySelector("[data-testid=\"targets-filter-workspace\"] option[value=\".\"]")
    expect(option?.textContent).toBe("aomi")
  })

  test("a single-workspace repo shows no workspace column or select", () => {
    const card = targetsCard()
    const single = {
      ...card,
      payload: { ...card.payload, targets: card.payload.targets.filter((target) => target.workspace === ".") }
    }
    const host = render(<TargetsCardBody card={single} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-target-row][data-workspace=\".\"]")).not.toBeNull()
    expect(host.querySelector(".targets-table-workspace")).toBeNull()
    expect(host.querySelector("[data-testid=\"targets-filter-workspace\"]")).toBeNull()
  })
})

describe("the repo card", () => {
  /*
   * A manifest the loader refused (bad JSON, a stray workspace, an extra key)
   * leaves `plugin` undefined and the reason in `Repo.warnings`. Without a
   * home on the repo card the repository simply grows no plugin card and the
   * app never says why.
   */
  const repo = (warnings: ReadonlyArray<string>): Extract<Card, { kind: "repo" }> => ({
    id: "repo-r1",
    kind: "repo",
    title: "aomi",
    status: "acted",
    createdAt: 0,
    ordinal: 0,
    payload: {
      repo: {
        id: "r1",
        path: "/work/aomi",
        name: "aomi",
        git: null,
        warnings: [...warnings],
        smithers: {
          detected: true,
          workspaceFile: ".smithers/WORKSPACE.ts",
          declarationFiles: [],
          reason: "1 workspace detected",
          workspaces: [{ path: ".", title: "aomi" }]
        }
      }
    }
  })

  test("states the manifest problems the open reported", () => {
    const host = render(<RepoCardBody card={repo(["smithers-ui.json is not valid JSON."])} />)
    const alert = host.querySelector("[role=\"alert\"]")
    expect(alert?.textContent).toContain("smithers-ui.json is not valid JSON.")
  })

  test("a clean open shows no warning row at all", () => {
    const host = render(<RepoCardBody card={repo([])} />)
    expect(host.querySelector("[role=\"alert\"]")).toBeNull()
  })
})

/* A pattern entry (`ci //packages/...`) runs through target.run.pattern; a label entry through target.run. */
test("a pattern entry's Run dispatches target.run.pattern with the workspace, verb and pattern", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const card = pluginCard()
  const manifestWithPattern = {
    ...card.payload.manifest,
    entries: [
      ...card.payload.manifest.entries,
      { id: "everything", group: "checks", workspace: ".", verb: "ci" as const, pattern: "//packages/...", title: "Run everything", summary: "The CI step.", approval: false, agentic: false }
    ]
  }
  flushSync(() => {
    createRoot(host).render(
      <RepoPluginCardBody
        card={{ ...card, payload: { ...card.payload, manifest: manifestWithPattern } }}
        onRunCommand={(name, args) => calls.push([name, args])}
      />
    )
  })
  const row = host.querySelector('[data-plugin-entry="everything"]')!
  expect(row.textContent).toContain("ci //packages/...")
  flushSync(() => (host.querySelector('[data-testid="plugin-run-everything"]') as HTMLButtonElement).click())
  flushSync(() => (host.querySelector('[data-testid="plugin-run-check"]') as HTMLButtonElement).click())
  expect(calls).toEqual([
    ["target.run.pattern", "r1 . ci //packages/..."],
    ["target.run", "r1 . //:check"]
  ])
})
