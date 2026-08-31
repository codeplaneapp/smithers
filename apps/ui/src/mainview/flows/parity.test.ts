import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * The launch-law gate: every interactive affordance in the app routes through
 * the command registry (`runCommand` / `runCommandArgs`), never a direct
 * controller call. This test enumerates the action props in every surface
 * file and asserts each one either dispatches through the registry itself or
 * is a delegated prop whose binding site does. Adding a button without a
 * command behind it fails this test.
 */

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/**
 * Every component file under src/mainview, discovered rather than listed: a new
 * surface added with a command-less button has to fail this gate, and a
 * hand-maintained list would silently exempt it.
 */
const surfaceFiles = (): Array<string> => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .map((entry) => `../${entry.split("\\").join("/")}`)
    .sort()
}

const ACTION_PROPS = ["onClick", "onSubmit", "onStop", "onConfirm", "onDecide", "onSelect", "onClose"] as const

interface HandlerRef {
  readonly prop: string
  /** The line the action prop appears on. */
  readonly line: string
  readonly context: string
}

/** Every action-prop occurrence with the following lines (handlers can wrap). */
const handlers = (source: string): Array<HandlerRef> => {
  const lines = source.split("\n")
  const found: Array<HandlerRef> = []
  lines.forEach((line, index) => {
    for (const prop of ACTION_PROPS) {
      const pattern = new RegExp(`\\b${prop}=`)
      if (!pattern.test(line)) continue
      found.push({ prop, line, context: lines.slice(index, index + 4).join("\n") })
    }
  })
  return found
}

/**
 * Handlers that legitimately do NOT dispatch a command, with the reason each
 * is not a launch-law violation. Anything not listed here MUST route through
 * the registry.
 */
const PRESENTATION_ONLY = [
  "setSlashMenu", // slash-menu hover highlight: local presentation state
  "setCopied", // copy feedback flash; the clipboard write routes via onCopy
  "toggleConnectMenu", // opens the composer's connect origins menu; every entry inside dispatches its own command
  "setSelectedPath", // world card doc selection: which note the embedded editor shows — local presentation state
  "onDismissDrawer(", // graph card detail drawer close: local presentation state (which node is focused)
  "setOpenLog(", // run timeline log panel: which row's log is open — local presentation state
  "onRunCommand(", // delegated: App.tsx binds it to the registry's runCommand/runCommandArgs
  // Card maximize/minimize: each calls the delegated onMaximize/onMinimize (bound to card.maximize /
  // card.minimize at the App.tsx and CardTabBody binding sites) and then hands focus to the button
  // that replaces the one pressed, so Escape keeps a shell to land on.
  "maximizeThenFocus",
  "minimizeThenFocus",
  // C-1 (wave 13): these two are NOT local state — calling either dispatches
  // runCommand("surfaces"). The old "local presentation state" reason here is
  // what let a command-less affordance ship; the wrappers stay listed only
  // because the registry call is one indirection away from the onClick.
  "openNamespace", // slash-menu tree: opening a namespace rewrites the draft to `/ns.` — a draft edit, never a command
  "openMenu", // dispatches runCommand("chat.surfaces") — the /chat.surfaces command
  "closeMenu", // dispatches runCommand("surfaces"); the entry itself runs its own command
  "onCopy(", // delegated: App.tsx binds it to runCommandArgs("chat.copy-message", ...)
  "onDecideApproval(", // delegated: App.tsx binds it to approval.approve / approval.deny
  "onRecoAction(", // delegated: App.tsx binds it to reco.accept / reco.edit / reco.dismiss
  "onGrantConfirm(", // delegated: App.tsx binds it to admin.grant.confirm
  "onGrantCancel(", // delegated: App.tsx binds it to admin.grant.cancel
  "onQueueApprove(", // delegated: App.tsx binds it to admin.queue.approve
  "onDismiss(", // delegated: App.tsx binds it to runCommandArgs("toast.dismiss", ...)
  "onRepoToggle(", // delegated: App.tsx binds it to runCommandArgs("repos.watch.toggle", ...)
  "onReposSelectAll(", // delegated: App.tsx binds it to repos.watch.all
  "onReposSelectNone(", // delegated: App.tsx binds it to repos.watch.none
  "onReposConfirm(", // delegated: App.tsx binds it to repos.watch.confirm
  "onMaximize(", // delegated: App.tsx binds it to runCommandArgs("card.maximize", ...)
  "onMinimize(", // delegated: App.tsx binds it to card.minimize
  "onFrameBack", // delegated: App.tsx binds it to frame.back
  "onFrameForward", // delegated: App.tsx binds it to frame.forward
  "onForkFrame", // delegated: App.tsx binds it to frame.fork
  "onOpenInTab(", // delegated: App.tsx and tabs/CardTabBody.tsx bind it to runCommandArgs("tab.card", ...)
  "onConnectGitHub(", // delegated: App.tsx binds it to auth.sign-in
  "onConnectLocal(", // delegated: App.tsx binds it to runCommandArgs("connector.add", ...)
  "onRunWorkflow(", // delegated: App.tsx binds it to runCommandArgs("flow.run", ...)
  "onStopRun(", // delegated: App.tsx binds it to runCommandArgs("flow.run.stop", ...)
  "onRetryRun(", // delegated: App.tsx binds it to runCommandArgs("flow.run.retry", ...)
  "onChooseWorkflowRepo(", // delegated: App.tsx binds it to runCommandArgs("flow.repo.choose", ...)
  "onConfirm}", // SurfaceChrome delegates to its binding site
  "onCancel}", // dismissing a dialog changes no application state
  "onClose}" // SurfaceChrome delegates to its binding site
] as const

const routesThroughRegistry = (context: string): boolean =>
  context.includes("runCommand") || context.includes("runSlashCommand")

describe("launch-law parity: every affordance is a command", () => {
  const files = Object.fromEntries(surfaceFiles().map((file) => [file, read(file)]))

  test("the discovered surface set covers every component file", () => {
    // A new .tsx under src/mainview joins the scan automatically; this pins that
    // discovery actually found the known surfaces (a broken glob fails loudly).
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "../App.tsx",
        "../ChatCards.tsx",
        "../ConnectorsSurface.tsx",
        "../SurfaceChrome.tsx"
      ])
    )
  })

  test("every action prop routes through the registry or is allowlisted", () => {
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const handler of handlers(source)) {
        if (routesThroughRegistry(handler.context)) continue
        // The allowlist exempts the handler that NAMES the token, not any
        // handler that happens to sit near one: a complete one-line
        // handler matches against its own line only, so it can no longer
        // ride a neighbour's exemption through the four-line window. A
        // handler that opens a multi-line body may name its token on the
        // body's own lines.
        const opensBody = /=>\s*\{?\s*$/.test(handler.line)
        const allowance = opensBody ? handler.context : handler.line
        if (PRESENTATION_ONLY.some((token) => allowance.includes(token))) continue
        violations.push(`${file}: ${handler.prop} → ${handler.context.split("\n")[0]?.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("the expected affordances are all present (removal fails loudly too)", () => {
    // Files with no affordances at all (the composition root) are not pinned;
    // the moment one grows a handler it appears here and must be accounted for.
    const counts = Object.fromEntries(
      Object.entries(files)
        .map(([file, source]) => [file, handlers(source).length] as const)
        .filter(([, count]) => count > 0)
    )
    expect(counts).toEqual({
      /*
       * The chrome Sign in button (LOCAL-APP.md: sign-in is an option in the
       * chrome, never a gate on the chat) is one of ChromeBar's nine below.
       *
       * Shell bindings stay here; composer bindings are pinned independently
       * now that the hot path is its own module.
       */
      // 15 − the corner balance chip: the balance is one act away (/balance), never main-page chrome.
      "../App.tsx": 13,
      "../Composer.tsx": 10,
      // 6 = 5 + the empty state's own import affordance (§11.6): with nothing
      // connected the pane stated a fact and offered no move.
      "../ConnectorsSurface.tsx": 6,
      // 23 − the three recommendation-card affordances the deleted reco
      // feature carried (accept / edit / dismiss), + the maximized card's
      // "Open in tab" (docs/LOCAL-APP.md "Cards").
      "../ChatCards.tsx": 17,
      "../DevtoolsPanel.tsx": 1,
      "../SurfaceChrome.tsx": 3,
      "../ToastStack.tsx": 1,
      /* The multi-parity domain cards: every handler routes through onRunCommand. */
      "../cards/IssueCards.tsx": 2,
      "../cards/LandingCards.tsx": 4,
      "../cards/FileCards.tsx": 2,
      "../cards/KeysCard.tsx": 1,
      /* Mark-all-read, plus the empty state's named next step (§28.2). */
      "../cards/NotificationsCard.tsx": 2,
      "../cards/RepoImportCard.tsx": 1,
      /* The /theme picker: nine swatches, one shared handler through onRunCommand. */
      "../cards/ThemePickerCard.tsx": 1,
      /*
       * The target-graph cards: the graph drawer's close/copy/open/run acts
       * (4), the timeline row's log toggle (1), the history row's replay
       * select and the affected row's show-in-graph (1 each, both
       * onRunCommand).
       */
      "../cards/GraphCard.tsx": 4,
      "../cards/RunTimelineCard.tsx": 1,
      "../cards/RunHistoryCard.tsx": 1,
      "../cards/AffectedCard.tsx": 1,
      /* Repo chooser, connection, world and browser card interactions. */
      "../cards/ConversationCards.tsx": 8,
      /*
       * The local-app target cards (docs/LOCAL-APP.md "Cards"): one shared
       * Run handler per file through onRunCommand — the plugin card's per-entry
       * Run and the targets card's per-row Run both ride target.run.
       */
      "../cards/RepoPluginCard.tsx": 2,
      /*
       * The targets table: History in the toolbar, the view, kind and state
       * chips (target.filter), each row's star (target.star / unstar),
       * select / Run / Timeline, the drawer's
       * close, Open source, Replay, Run, Graph, Explain, and the target-run
       * card's Explain — all through onRunCommand.
       */
      "../cards/TargetCards.tsx": 26,
      /*
       * The sidebar (docs/LOCAL-APP.md "Tabs"): the list's select and close
       * per tab, the Repos section's empty "Select a repo" row, each repo
       * row's select, `+`, and unpin, the `+` trigger, its backdrop, the
       * Terminal row, the available and unavailable harness rows, Sign in,
       * the admin reset, and the theme toggle (chrome that stays visible on
       * every tab).
       */
      "../tabs/ChromeBar.tsx": 15,
      /* The live-process close question: confirm through tab.close.confirm. */
      "../tabs/TabBodies.tsx": 1
    })
  })

  test("delegated props are bound to commands at their call sites", () => {
    const app = files["../App.tsx"]
    expect(app).toContain("runCommandArgs(\"chat.copy-message\"")
    expect(app).toContain("runCommandArgs(\"toast.dismiss\"")
    expect(app).toContain("runCommandArgs(\n")
    expect(app).toContain("\"approval.approve\"")
    expect(app).toContain("\"approval.deny\"")
    expect(app).toContain("runCommandArgs(\"repos.watch.toggle\"")
    expect(app).toContain("\"repos.watch.confirm\"")
    expect(app).toContain("runCommandArgs(\"card.maximize\"")
    expect(app).toContain("runCommand(\"frame.back\"")
    expect(app).toContain("runCommand(\"frame.forward\"")
    expect(app).toContain("runCommand(\"frame.fork\"")
    expect(app).toContain("runCommandArgs(\"tab.card\"")
    expect(files["../tabs/CardTabBody.tsx"]).toContain("runCommandArgs(\"tab.card\"")
    expect(app).toContain("runCommandArgs(\"connector.add\"")
    expect(app).toContain("runCommandArgs(\"flow.run\"")
    const connectors = files["../ConnectorsSurface.tsx"]
    expect(connectors).toContain("runCommandArgs(\"connector.downgrade\"")
    expect(connectors).toContain("runCommandArgs(\"connector.remove\"")
  })

  /*
   * §2a/§2f — no fabricated prompt pills, ever. A pill is a command
   * BINDING; a pill carrying free text for the model is a violation unless
   * it is explicitly a composer-prefill affordance (none exist). The banned
   * literals are the slop will named verbatim; the `suggest` command was
   * the fabricated-prompt mechanism and is deleted; the suggestion set is
   * derived in App.tsx from live state (empty is correct).
   */
  test("no pill carries a prompt string for the model, and no banned generic pill exists", () => {
    const bannedLiterals = [
      "Build my work queue",
      "Build a work queue",
      "Plan my day",
      "Help me plan my day",
      "Help me connect GitHub",
      "What should I do next?"
    ]
    for (const [, source] of Object.entries(files)) {
      for (const literal of bannedLiterals) {
        expect(source).not.toContain(literal)
      }
      // The prompt-pill shape itself: a suggestion carrying prompt text.
      expect(source).not.toContain("prompt: action.prompt")
      expect(source).not.toContain("suggestion.prompt")
    }
    const registrySource = read("./Flows.ts")
    expect(registrySource).not.toContain("\"suggest\"")
    // The pill row binds commands directly (§2a): the suggestion markup
    // carries the command, and the click invokes it — never send().
    const app = files["../App.tsx"] ?? ""
    expect(app).toContain("data-flow={suggestion.flow}")
    expect(app).not.toContain("data-flow=\"suggest\"")
    // No standing composer status chrome (§2g): calm is the budget.
    expect(app).not.toContain("statusText=")
  })

  /*
   * Wave 13 C-1 — the gap the live sweep found: the static gate verified
   * data-flow bindings and allowlisted presentation-only handlers, but a
   * button with NEITHER (the "Surfaces" menu trigger, whose open/close was
   * allowlisted as local state) shipped unbound. This is the live C-1 rule
   * applied to the source: a button without a data-flow binding must have
   * a static label whose words resolve to a registered command's name or
   * summary — exactly what the launch checklist checks against the DOM.
   */
  test("a button with no data-flow binding has a label that resolves to a registered command", () => {
    const registrySource = read("./Flows.ts")
    const names = [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    const summaries = [...registrySource.matchAll(/\bsummary:\s*"([^"]+)"/g)].map((match) =>
      (match[1] as string).toLowerCase()
    )
    const resolves = (label: string): boolean => {
      const words = label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2)
      if (words.length === 0) return true
      // EVERY word must resolve: the old any-word rule passed a label on a
      // single common word ("open", "run") no matter what the rest of it
      // promised, which is exactly the fuzz a mis-bound button hides in.
      return words.every(
        (word) =>
          names.some((name) => name.includes(word) || word.includes(name)) ||
          summaries.some((summary) => summary.includes(word))
      )
    }
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      const lines = source.split("\n")
      lines.forEach((line, index) => {
        const label = /(?:aria-label|title)="([^"]+)"/.exec(line)?.[1]
        if (label === undefined) return
        // The element the label belongs to: the nearest enclosing tag start.
        let start = index
        while (start > 0 && !/^\s*<[A-Za-z]/.test(lines[start] ?? "")) start -= 1
        if (!/^\s*<(?:button|Button)\b/.test(lines[start] ?? "")) return
        const chunk = lines.slice(start, Math.min(lines.length, index + 12)).join("\n")
        if (chunk.includes("data-flow")) return
        if (!resolves(label)) {
          violations.push(`${file}: button "${label}" has no data-flow and resolves to no registered command`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test("every data-flow binding names a registered command, and the app exposes the registry manifest", () => {
    // The launch checklist reads the DOM, not the source: `.app-shell`
    // carries the live registry manifest (data-flows) and every
    // machine-legible affordance declares its command (data-flow). A
    // binding naming a command the registry does not have is a lie both
    // gates can catch here.
    const app = files["../App.tsx"]
    expect(app).toContain("data-flows={controller.commands.all()")
    // Registry names from the registry source itself — the same file the
    // runtime registers — so a renamed command fails this gate.
    const registrySource = read("./Flows.ts")
    const declared = new Set(
      [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    )
    expect(declared.size).toBeGreaterThan(0)
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const match of source.matchAll(/data-flow="([^"]+)"/g)) {
        const name = match[1]
        if (name !== undefined && !declared.has(name)) {
          violations.push(`${file}: data-flow="${name}" is not a registered command`)
        }
      }
      // SurfaceHeader renders its close affordance's data-flow from
      // closeCommand, so the literal lives at the call site and is gated here.
      for (const match of source.matchAll(/closeCommand="([^"]+)"/g)) {
        const name = match[1]
        if (name !== undefined && !declared.has(name)) {
          violations.push(`${file}: closeCommand="${name}" is not a registered command`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("every embedded pane closes back to the conversation, not to some other surface", () => {
    // The chat-first contract: a pane's only exit is /chat. A pane wired to
    // close into another takeover would pass the registry gate above and still
    // break the contract, so the target itself is pinned.
    const panes = ["../App.tsx", "../ConnectorsSurface.tsx"] as const
    for (const pane of panes) {
      const source = files[pane] ?? ""
      expect(source).toContain("closeCommand=\"chat\"")
      const targets = [...source.matchAll(/closeCommand="([^"]+)"/g)].map((match) => match[1])
      expect(targets.every((target) => target === "chat")).toBe(true)
    }
    // Every SurfaceHeader mounted anywhere declares one (a pane with an
    // unnamed close is exactly the affordance this gate exists to catch).
    for (const [file, source] of Object.entries(files)) {
      if (file === "../SurfaceChrome.tsx") continue
      const mounts = source.split("<SurfaceHeader").length - 1
      const declared = source.split("closeCommand=").length - 1
      expect(`${file}: ${mounts} SurfaceHeader / ${declared} closeCommand`).toBe(
        `${file}: ${mounts} SurfaceHeader / ${mounts} closeCommand`
      )
    }
  })

  /*
   * The two look-and-feel axes, at their binding sites: the corner button IS
   * the light/dark toggle (/dark-mode), and /theme is the palette command
   * that takes its key as an argument. Both are model-invocable now — every
   * listed flow is a tool call (flows/invocable.test.ts) — so this test
   * guards the binding sites and the args hint, not the trigger axis.
   */
  test("the light/dark toggle and the color theme are separate commands the model can call", () => {
    // The toggle lives in the sidebar's bottom chrome, so it is on screen in every tab.
    const chrome = files["../tabs/ChromeBar.tsx"] ?? ""
    expect(chrome).toContain("runCommand(\"appearance.dark-mode\")")
    expect(chrome).not.toContain("runCommand(\"appearance.theme\")")
    expect(files["../App.tsx"] ?? "").not.toContain("runCommand(\"appearance.dark-mode\")")
    const registrySource = read("./Flows.ts")
    // A canonical declaration is a const literal (`const THEME = { ... }`) so its
    // bare alias cannot drift from it; the slice ends at the literal's close.
    const entry = (name: string): string => {
      const start = registrySource.indexOf(`name: "${name}"`)
      expect(start).toBeGreaterThan(-1)
      return registrySource.slice(start, registrySource.indexOf("\n  }\n", start))
    }
    // Listed flows are model-invocable (Will's rule; flows/invocable.test.ts
    // pins the invariant); the args hint is what makes
    // `/appearance.theme <palette>` parse as an invocation.
    expect(entry("appearance.theme")).not.toContain("userOnly")
    expect(entry("appearance.theme")).toContain("args:")
    expect(entry("appearance.dark-mode")).not.toContain("userOnly")
    // The toggle is its own flow, not a hidden alias of the palette flow; the
    // bare `/dark-mode` is the alias, declared beside it.
    expect(entry("appearance.dark-mode")).not.toContain("aliasOf")
    expect(entry("appearance.dark-mode")).not.toContain("hidden")
    expect(registrySource).toContain('alias("dark-mode", DARK_MODE)')
  })

  test("the slash menu wrapper dispatches through the registry", () => {
    const composer = files["../Composer.tsx"]
    const wrapper = composer.slice(
      composer.indexOf("const runSlashCommand"),
      composer.indexOf("const onComposerKeyDown")
    )
    expect(wrapper).toContain("controller.runCommand")
  })
})
