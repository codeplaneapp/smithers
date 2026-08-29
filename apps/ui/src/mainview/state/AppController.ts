import type { FetchLike } from "smithers-shared/NativeAgent"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import type { RepositoryAccess } from "smithers-shared/NativeRepository"
import { createCommandRegistry } from "../flows/Commands"
import type { CommandRegistry } from "../flows/Commands"
import type { CatalogItem } from "../flows/Commands"
import type { SlashItem } from "../flows/registry"
import { flowRequirements } from "../flows/registry"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { localSocketProtocols } from "../runtime/LocalSession"
import type { FrameHistoryPort } from "../runtime/FrameHistory"
import type { AppStore } from "./AppStore"
import { createPtyClient, pageSocketUrl } from "./PtyClient"
import type { PtyClient } from "./PtyClient"
import { createTargetRunClient } from "./TargetRunClient"
import { createAuthBillingController } from "./controller/auth-billing"
import { createConnectorController } from "./controller/connectors"
import { createControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { createFramesController } from "./controller/frames"
import { createPresentationController } from "./controller/presentation"
import { createTabsController } from "./controller/tabs"
import type { TabsController } from "./controller/tabs"
import { createTargetsController } from "./controller/targets"
import type { TargetsController } from "./controller/targets"
import { createTargetGraphController } from "./controller/targetGraph"
import type { TargetGraphController } from "./controller/targetGraph"
import { createTargetGraphDevFixtures } from "../dev/fixtureRunStream"
import { createTurnController } from "./controller/turns"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import { createWorkflowController } from "./controller/workflows"
import { createWorldController } from "./controller/world"
import { createAppStatusSeam } from "./seams/AppStatusSeam"
import type { AppStatusSeam } from "./seams/AppStatusSeam"
import { createBillingSeam } from "./seams/BillingSeam"
import type { BillingSeam } from "./seams/BillingSeam"
import { createBookmarksSeam } from "./seams/BookmarksSeam"
import type { BookmarksSeam } from "./seams/BookmarksSeam"
import { createEnvironmentSeam } from "./seams/EnvironmentSeam"
import type { EnvironmentSeam } from "./seams/EnvironmentSeam"
import { createFilesSeam } from "./seams/FilesSeam"
import type { FilesSeam } from "./seams/FilesSeam"
import { createIssuesSeam } from "./seams/IssuesSeam"
import type { IssuesSeam } from "./seams/IssuesSeam"
import { createKeysSeam } from "./seams/KeysSeam"
import type { KeysSeam } from "./seams/KeysSeam"
import { createLandingsSeam } from "./seams/LandingsSeam"
import type { LandingsSeam } from "./seams/LandingsSeam"
import { createNotificationsSeam } from "./seams/NotificationsSeam"
import type { NotificationsSeam } from "./seams/NotificationsSeam"
import { createRepoImportSeam } from "./seams/RepoImportSeam"
import type { RepoImportSeam } from "./seams/RepoImportSeam"
import type { SeamContext } from "./seams/SeamContext"

export interface AppController {
  readonly store: AppStore
  readonly bootstrap: AppBootstrap | undefined
  readonly nativeAgentAvailable: boolean
  readonly nativeRepositoriesAvailable: boolean
  /** The command registry: every interactive affordance routes through it. */
  readonly commands: CommandRegistry
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  readonly changeDraft: (draft: string) => void
  readonly reset: () => void
  readonly stop: () => void
  readonly send: (text: string) => void
  readonly showChat: () => void
  readonly showWorld: () => void
  readonly showConnectors: () => void
  readonly askReset: () => void
  readonly cancelReset: () => void
  readonly runCommand: (name: string) => boolean
  readonly runCommandArgs: (name: string, args: string) => boolean
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => void
  readonly createWorldDocument: () => void
  /** Ask whether to delete a note; the answer is `world.delete.confirm|cancel`. */
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
  readonly decideApproval: (id: string, decision: "approved" | "denied") => void
  readonly retryLastTurn: () => void
  readonly toggleTheme: () => void
  /** Wear a color theme (/theme) — the axis orthogonal to light/dark. */
  readonly setPalette: (args: string) => string | void
  /* Wave 10 — the onboarding chooser (repos.watch) and the watched set. */
  readonly openRepoChooser: (preselect?: string) => Promise<string | void>
  readonly toggleWatchedRepo: (fullName: string) => string | void
  readonly selectAllWatchedRepos: () => void
  readonly selectNoWatchedRepos: () => void
  readonly confirmWatchedRepos: () => Promise<string | void>
  /* /clear (§2h): sweep the transcript into world notes, THEN clear. */
  readonly clearConversation: () => Promise<string | void>
  /* The browser tool + surface (§2d/§2d′). */
  readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>
  /*
   * Wave 11 — workflows in the conversation. Create/list/run through the
   * per-user gateway seam; runs render as embedded run cards tracked live.
   */
  readonly createWorkflow: (
    description: string,
    repo?: string
  ) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §2 — the answer to "which watched repository?" (one act). */
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §3 — the two acts a run that has gone quiet offers. */
  readonly stopWatchingRun: (cardId: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  /** Boot reconciliation: resume the event pump for any run card still live. */
  readonly resumeWorkflowRuns: () => void
  /* Card maximize/minimize — the user's presentation transition (§2d′). */
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly frameBack: () => void
  readonly frameForward: () => void
  readonly forkFrame: () => string | void
  /* The local-app tabs (docs/LOCAL-APP.md "Tabs"); see controller/tabs.ts. */
  readonly openTerminalTab: TabsController["openTerminalTab"]
  readonly openHarnessTab: TabsController["openHarnessTab"]
  readonly openCardTab: TabsController["openCardTab"]
  readonly selectTab: TabsController["selectTab"]
  readonly closeTab: TabsController["closeTab"]
  readonly confirmTabClose: TabsController["confirmTabClose"]
  readonly cancelTabClose: TabsController["cancelTabClose"]
  readonly toggleTabMenu: TabsController["toggleTabMenu"]
  readonly openLocalRepo: TabsController["openLocalRepo"]
  readonly loadHarnesses: TabsController["loadHarnesses"]
  readonly loadRepos: TabsController["loadRepos"]
  readonly notePtyExit: TabsController["notePtyExit"]
  /** The PTY transport the terminal tabs attach to (docs/LOCAL-APP.md "/ws"). */
  readonly pty: PtyClient
  /* Lane L3 (docs/LOCAL-APP.md "Auto-load flow"); see controller/targets.ts. */
  readonly openRepo: TargetsController["openRepo"]
  readonly runTarget: TargetsController["runTarget"]
  readonly openTarget: TargetsController["openTarget"]
  /* The target-graph cards (docs/LOCAL-APP.md "Cards: target graph"); see controller/targetGraph.ts. */
  readonly showGraph: TargetGraphController["showGraph"]
  readonly focusGraphNode: TargetGraphController["focusGraph"]
  readonly showRunTimeline: TargetGraphController["showTimeline"]
  readonly showRunHistory: TargetGraphController["showHistory"]
  readonly selectRunReplay: TargetGraphController["selectRun"]
  readonly scrubRunReplay: TargetGraphController["scrubRun"]
  readonly showAffected: TargetGraphController["showAffected"]
  readonly showCiMatrix: TargetGraphController["showCi"]
  readonly openTargetSource: TargetGraphController["openSource"]
  /* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
  readonly toggleDevtools: () => void
  /** Report what drives a turn (admin /debug.backend; DESIGN.md §14). */
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  /* The composer surfaces menu — the /surfaces command's open state. */
  readonly toggleSurfacesMenu: () => void
  /*
   * The composer connect menu's open state. Not a command — the chip is a
   * pointer affordance, not a registry entry — but the state is still the
   * store's, reached through the dispatcher with the actor recorded.
   */
  readonly toggleConnectMenu: () => void
  readonly closeConnectMenu: () => void
  readonly debugSnapshot: () => { readonly value: string }
  readonly debugEvents: () => { readonly value: string }
  readonly debugSeams: () => Promise<string | void | { readonly value: string }>
  /** The chain x-ray (DESIGN.md §14 debug mode): the journal fold, as data. */
  readonly debugChain: () => { readonly value: string }
  /** The wire tap: the controller's fetch ring, newest first. */
  readonly debugNet: () => { readonly value: string }
  /**
   * The same ring, read WITHOUT surfacing it.
   *
   * `debugNet` is the flow: it renders the read for the human who typed it.
   * The dev-tools panel reads the ring while rendering, so it needs the pure
   * read — dispatching from a render is a re-render loop.
   */
  readonly netTap: () => string
  /** Drop every chain grant and pending denial (admin /debug.grants.reset). */
  readonly resetGrants: () => Promise<string | { readonly value: string }>
  /**
   * The tapped fetch, exposed so the chain runtime's model-relay traffic
   * records into the same ring as every controller seam.
   */
  readonly tappedFetch: FetchLike
  /** Adopt an identity answer already resolved by the server renderer. */
  readonly adoptSession: (session: import("./controller/auth-billing").ResolvedSession) => Promise<void>
  /** Load the identity session record from the identity seam (actor: system). */
  readonly loadSession: () => Promise<void>
  /** Redirect to the identity seam's GitHub OAuth start. */
  readonly signIn: () => void
  readonly signOut: () => Promise<string | void>
  readonly requestAccess: () => Promise<string | void>
  /**
   * Consume a `?auth=failed` return from a failed OAuth redirect: the failure
   * renders as a Smithers message in the chat (honest error + retry action),
   * never a bare page. Answers whether the search string carried one.
   */
  readonly handleAuthReturn: (search: string) => boolean
  /*
   * The requirement axis (registry.ts commandRequirements): park a
   * user-invoked command on an unmet requirement, and resume it when the
   * requirement's predicate flips true. Deferral is durable (the session
   * row) because sign-in is a full OAuth redirect; every seam that can
   * SATISFY a requirement calls resumeDeferredCommand after it settles.
   */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  readonly resumeDeferredCommand: () => void
  /** Record a visible command run for the slash menu's recency ranking. */
  readonly noteCommandRun: (name: string) => void
  /** Render the full visible-flow catalog into the chat (the /flows answer). */
  readonly showCommandCatalog: () => void
  /** Render the sign-in step into the chat (auth.prompt — the agent's door to login). */
  readonly promptSignIn: () => void
  /** Reload the app window — the /reload affordance (dev loop, stuck states). */
  readonly reloadApp: () => void
  /*
   * The multi-parity domain seams (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * PRs/landings, billing checkout, BYOK keys, notifications, the agent
   * environment, and repo import. One method per command; each seam owns its
   * backend domain in state/seams/*.
   */
  readonly listIssues: IssuesSeam["listIssues"]
  readonly viewIssue: IssuesSeam["viewIssue"]
  readonly createIssue: IssuesSeam["createIssue"]
  readonly setIssueState: IssuesSeam["setIssueState"]
  readonly commentOnIssue: IssuesSeam["commentOnIssue"]
  readonly listLandings: LandingsSeam["listLandings"]
  readonly viewLanding: LandingsSeam["viewLanding"]
  readonly createLanding: LandingsSeam["createLanding"]
  readonly landLanding: LandingsSeam["landLanding"]
  readonly reviewLanding: LandingsSeam["reviewLanding"]
  readonly startCheckout: BillingSeam["startCheckout"]
  readonly openBillingPortal: BillingSeam["openBillingPortal"]
  readonly listKeys: KeysSeam["listKeys"]
  readonly removeKey: KeysSeam["removeKey"]
  readonly listNotifications: NotificationsSeam["listNotifications"]
  readonly markNotificationsRead: NotificationsSeam["markNotificationsRead"]
  readonly viewEnvironment: EnvironmentSeam["viewEnvironment"]
  readonly setEnvironmentVar: EnvironmentSeam["setEnvironmentVar"]
  readonly importRepository: RepoImportSeam["importRepository"]
  readonly listBookmarks: BookmarksSeam["listBookmarks"]
  readonly listFiles: FilesSeam["listFiles"]
  readonly readFile: FilesSeam["readFile"]
  readonly checkGitHubApp: AppStatusSeam["checkGitHubApp"]
  /** Dismiss one toast on the shared corner stack (the toast.dismiss command). */
  readonly dismissToast: (id: string) => void
  /** Refresh the billing record from the billing seam (actor: system). */
  readonly refreshBalance: () => Promise<void>
  /** Refresh the balance and surface it as a card in the transcript. */
  readonly showBalance: () => Promise<string | { readonly value: string }>
  /** Beat 5: read the watched-repos selection; never-chosen opens the repo chooser. */
  readonly openFirstRunRepos: () => Promise<void>
  /* The admin plugin's controller half — registered as commands only for admin sessions. */
  readonly adminAllowlist: (action: "add" | "remove", login: string) => Promise<string | void>
  readonly adminGrant: (amountUsd: number, login: string) => string | void
  readonly adminGrantConfirm: (cardId: string) => Promise<string | void>
  readonly adminGrantCancel: (cardId: string) => string | void
  readonly adminRequests: () => Promise<string | void>
  readonly adminQueueApprove: (login: string) => Promise<string | void>
  readonly adminHealth: () => Promise<string | void>
  /**
   * Close the controller's scope: stop the workflow pumps and release
   * everything the controllers opened (the agent subscription, the
   * cross-tab identity listeners, the identity BroadcastChannel). Nothing a
   * controller opened outlives it.
   */
  readonly dispose: () => void
}
/**
 * The product-Worker backend seams the controller talks to. Injectable so tests
 * bind honest doubles instead of a network; production uses same-origin fetch.
 */
export interface AppServices {
  readonly fetchImpl?: FetchLike
  readonly bootstrap?: AppBootstrap
  readonly frameHistory?: FrameHistoryPort
  readonly baseUrl?: string
  /** The toast debounce (the 300ms law); injectable so tests pin both sides of it. */
  readonly toastDebounceMs?: number
  /**
   * Open a URL in the system browser (the native shell's door). Present =
   * the sign-in handoff runs OAuth outside the webview, where passkeys
   * work; absent = pure web keeps the same-page navigation.
   */
  readonly openExternal?: (url: string) => Promise<boolean>
  /** The handoff claim poll cadence; tests shorten it. */
  readonly handoffPollMs?: number
  /** How long a settled-ok toast states its result before dismissing itself. */
  readonly toastAutoDismissMs?: number
  /**
   * Wave 11 — the run card's event-pump cadence (the floor under the relay's
   * SSE pokes) and the provision poll gap. Injectable so tests drive a whole
   * run journey without waiting out real seconds.
   */
  readonly workflowPollMs?: number
  /**
   * Wave 12 §3 — how long a run may make no progress before the card states
   * that it has gone quiet and the pump stops (10 minutes in production).
   */
  readonly workflowQuietMs?: number
  /**
   * How long a request/response seam may take before it is an honest failure
   * (§22.6). Streaming paths carry no deadline; tests shorten this one.
   */
  readonly seamTimeoutMs?: number
}

/**
 * Environment-agnostic: the native bridge is injected by the composition root so this
 * module never pulls the Electrobun runtime into pure-web or test contexts.
 */
export const createAppController = (
  store: AppStore,
  repositories: NativeRepositories,
  agent: NativeAgent,
  services: AppServices = {}
): AppController => {
  const ctx = createControllerContext(store, repositories, agent, services)
  if (store.dispose !== undefined) ctx.onDispose(store.dispose)
  const { baseUrl, http } = ctx
  const { withToast, dismissToast, surfaceCommandFailure } = createFailureController(ctx)
  ctx.withToast = withToast

  const nextTranscriptOrdinal = (): number => {
    let highest = -1
    for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    return highest + 1
  }

  /*
   * The multi-parity domain seams: each owns one backend domain behind the
   * platform proxy, constructed on the shared seam context (the tapped
   * fetch, the store, the transcript-ordinal door).
   */
  /*
   * The domain seams ride boundedFetch (Ruling B): every request/response
   * seam call carries the seam deadline, and the tap plus 401 recovery still
   * apply because boundedFetch wraps the tapped http.
   */
  const seamCtx: SeamContext = {
    http: (input, init) => ctx.boundedFetch(input, init),
    baseUrl,
    store,
    dispatch: store.dispatch,
    actor: () => ctx.commandActor,
    nextOrdinal: nextTranscriptOrdinal
  }
  const issuesSeam = createIssuesSeam(seamCtx)
  const landingsSeam = createLandingsSeam(seamCtx)
  const billingSeam = createBillingSeam(seamCtx)
  const keysSeam = createKeysSeam(seamCtx)
  const notificationsSeam = createNotificationsSeam(seamCtx)
  const environmentSeam = createEnvironmentSeam(seamCtx)
  const repoImportSeam = createRepoImportSeam(seamCtx)
  const bookmarksSeam = createBookmarksSeam(seamCtx)
  const filesSeam = createFilesSeam(seamCtx)
  const appStatusSeam = createAppStatusSeam(seamCtx)

  const {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    refreshBalance,
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    settleTurnBilling,
    watchIdentityAcrossTabs
  } = createAuthBillingController(ctx, nextTranscriptOrdinal)

  const {
    showChat,
    showWorld,
    showConnectors,
    toggleDevtools,
    toggleSurfacesMenu,
    toggleConnectMenu,
    closeConnectMenu,
    askReset,
    cancelReset,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    netTap,
    debugNet,
    resetGrants,
    debugSeams,
    openBrowser,
    toggleTheme,
    setPalette
  } = createPresentationController(ctx, adminHealth)

  const {
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame
  } = createFramesController(ctx, services.frameHistory)

  const {
    openTerminalTab,
    openHarnessTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    installKeyboard
  } = createTabsController(ctx)
  const pty = createPtyClient({ http, baseUrl, socketUrl: pageSocketUrl, socketProtocols: localSocketProtocols })
  ctx.onDispose(pty.dispose)
  const targetRuns = createTargetRunClient({ socketUrl: pageSocketUrl, socketProtocols: localSocketProtocols })
  ctx.onDispose(targetRuns.dispose)
  const targetGraph = createTargetGraphController(ctx, {
    nextOrdinal: nextTranscriptOrdinal,
    runs: targetRuns,
    devFixtures: createTargetGraphDevFixtures()
  })
  const { openRepo, runTarget, openTarget } = createTargetsController(ctx, {
    nextOrdinal: nextTranscriptOrdinal,
    loadRepos,
    runs: targetRuns,
    onRunStarted: targetGraph.noteRunStarted
  })
  ctx.openRepo = openRepo

  const {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns
  } = createWorkflowPumpController(ctx, nextTranscriptOrdinal)

  const {
    createWorkflow,
    listWorkspaceWorkflows,
    runWorkflow,
    chooseWorkflowRepo,
    forwardApprovalDecision
  } = createWorkflowController(ctx, nextTranscriptOrdinal, pumpWorkflowRun)
  const {
    subscribeToAgent,
    send,
    reset,
    stop,
    decideApproval,
    retryLastTurn
  } = createTurnController(ctx, {
    settleTurnBilling,
    surfaceCommandFailure,
    forwardApprovalDecision
  })
  const {
    clearConversation,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete
  } = createWorldController(ctx)

  const changeDraft = (draft: string): void => {
    store.dispatch({ type: "composer.changed", actor: "user", draft })
  }

  /*
   * The requirement axis (registry.ts commandRequirements): the registry's
   * run path parks a user-invoked command here when a requirement is unmet,
   * and the seams that can satisfy one (identity load, watched-repos
   * confirm) resume it. Durable in the session row because sign-in is a
   * full OAuth redirect. One parking spot, latest wins.
   */
  const deferCommand = (name: string, args: string | null, requirement: string): void => {
    store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement })
  }

  const noteCommandRun = (name: string): void => {
    store.dispatch({ type: "command.ran", actor: "user", name })
  }

  /*
   * auth.prompt: the agent cannot navigate the user to OAuth (auth.sign-in
   * is user-only — a model must not yank the page mid-turn), but it CAN
   * hand the step over: one message whose action IS the sign-in button.
   * Every identity state answers honestly, including a build with no seam.
   */
  const promptSignIn = (): void => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state === "signed-in") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `GitHub is already connected as ${identity.login ?? "you"}.`
      })
      return
    }
    if (identity === undefined || identity.state === "unavailable") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text:
          "Sign-in isn't available on this build — no identity service is configured here. Use the deployed app to sign in."
      })
      return
    }
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "One step connects GitHub: sign in, and Smithers can read the repositories you choose.",
      action: { flow: "auth.sign-in", label: "Sign in with GitHub" }
    })
  }

  /*
   * The /flows answer: the LIVE visible catalog as one chat message —
   * the slash menu caps at 8 for calm, so this is where "all of it" lives.
   * Referenced before `commands` initializes; only ever called after.
   */
  const showCommandCatalog = (): void => {
    const lines = commands
      .all()
      .filter((command) => command.hidden !== true)
      .map((command) => `- \`/${command.name}\` — ${command.summary}`)
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: `Everything Smithers can do right now:\n\n${
        lines.join("\n")
      }\n\nType \`/\` in the composer to filter these as you type.`
    })
  }

  const reloadApp = (): void => {
    if (typeof window !== "undefined") window.location.reload()
  }

  /** A deferral older than this resumes nothing: firing it would surprise, not continue. */
  const deferralMaxAgeMs = 15 * 60 * 1000

  const resumeDeferredCommand = (): void => {
    const pending = store.session().pendingCommand
    if (pending === undefined || pending === null) return
    const requirement = flowRequirements.find((candidate) => candidate.id === pending.requirement)
    // Still waiting (or the requirement id no longer exists): leave it parked.
    if (requirement !== undefined && !requirement.satisfied(commands.state())) return
    store.dispatch({ type: "command.deferral.cleared", actor: "system" })
    if (requirement === undefined || Date.now() - pending.requestedAt > deferralMaxAgeMs) return
    // The app acting on its own is announced (300ms law does not apply: this
    // IS the act, not its latency) — then the command re-enters the one run
    // path, where the NEXT unmet requirement, if any, parks it again.
    const key = `command.resume.${pending.name}`
    store.dispatch({ type: "toast.shown", actor: "system", key, title: `Continuing /${pending.name}` })
    void commands.run(pending.name, pending.args ?? undefined).then((outcome) => {
      store.dispatch({
        type: "toast.resolved",
        actor: "system",
        key,
        status: outcome.status === "failed" ? "failed" : "ok",
        detail: outcome.status === "failed"
          ? outcome.error
          : outcome.status === "unknown-command"
          ? `/${pending.name} is no longer a command`
          : `/${pending.name} continued`
      })
    })
  }
  ctx.resumeDeferredCommand = resumeDeferredCommand

  const {
    openRepoChooser,
    toggleWatchedRepo,
    selectAllWatchedRepos,
    selectNoWatchedRepos,
    confirmWatchedRepos,
    openFirstRunRepos,
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  } = createConnectorController(ctx, promptSignIn)
  ctx.openRepoChooser = openRepoChooser

  /*
   * The agent's entry point ALWAYS runs as actor smithers (wired through
   * withAgentActor below) — whether it arrives through the streaming tool
   * loop or a direct executeForAgent call — so agent invocations render
   * embedded cards and record via:"agent", never user chrome.
   */
  const commands = createCommandRegistry({
    bootstrap: services.bootstrap,
    changeDraft,
    withAgentActor: async <T>(work: () => Promise<T>): Promise<T> => {
      ctx.commandActor = "smithers"
      try {
        return await work()
      } finally {
        ctx.commandActor = "user"
      }
    },
    reset,
    askReset,
    cancelReset,
    stop,
    send,
    showChat,
    showWorld,
    showConnectors,
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    decideApproval,
    retryLastTurn,
    openRepoChooser,
    toggleWatchedRepo,
    selectAllWatchedRepos,
    selectNoWatchedRepos,
    confirmWatchedRepos,
    clearConversation,
    openBrowser,
    createWorkflow,
    listWorkspaceWorkflows,
    runWorkflow,
    chooseWorkflowRepo,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame,
    openTerminalTab,
    openHarnessTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    pty,
    openRepo,
    runTarget,
    openTarget,
    showGraph: targetGraph.showGraph,
    focusGraphNode: targetGraph.focusGraph,
    showRunTimeline: targetGraph.showTimeline,
    showRunHistory: targetGraph.showHistory,
    selectRunReplay: targetGraph.selectRun,
    scrubRunReplay: targetGraph.scrubRun,
    showAffected: targetGraph.showAffected,
    showCiMatrix: targetGraph.showCi,
    openTargetSource: targetGraph.openSource,
    toggleDevtools,
    toggleSurfacesMenu,
    toggleConnectMenu,
    closeConnectMenu,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    debugNet,
    netTap,
    resetGrants,
    debugSeams,
    toggleTheme,
    setPalette,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    handleAuthReturn,
    deferCommand,
    resumeDeferredCommand,
    noteCommandRun,
    showCommandCatalog,
    promptSignIn,
    reloadApp,
    listIssues: issuesSeam.listIssues,
    viewIssue: issuesSeam.viewIssue,
    createIssue: issuesSeam.createIssue,
    setIssueState: issuesSeam.setIssueState,
    commentOnIssue: issuesSeam.commentOnIssue,
    listLandings: landingsSeam.listLandings,
    viewLanding: landingsSeam.viewLanding,
    createLanding: landingsSeam.createLanding,
    landLanding: landingsSeam.landLanding,
    reviewLanding: landingsSeam.reviewLanding,
    startCheckout: billingSeam.startCheckout,
    openBillingPortal: billingSeam.openBillingPortal,
    listKeys: keysSeam.listKeys,
    removeKey: keysSeam.removeKey,
    listNotifications: notificationsSeam.listNotifications,
    markNotificationsRead: notificationsSeam.markNotificationsRead,
    viewEnvironment: environmentSeam.viewEnvironment,
    setEnvironmentVar: environmentSeam.setEnvironmentVar,
    importRepository: repoImportSeam.importRepository,
    listBookmarks: bookmarksSeam.listBookmarks,
    listFiles: filesSeam.listFiles,
    readFile: filesSeam.readFile,
    checkGitHubApp: appStatusSeam.checkGitHubApp,
    dismissToast,
    refreshBalance,
    showBalance,
    openFirstRunRepos,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    snapshot: () => {
      const identity = store.collections.identitySessions.get("identity")
      const watched = store.collections.watchedRepos.get("watched")
      const signedIn = identity?.state === "signed-in"
      return {
        surface: store.session().surface,
        typing: store.session().phase === "responding",
        // Sign-in IS the GitHub connector (§2a′): a valid session means
        // work IS connected, so "connect" stops leading the next actions.
        hasConnectors: signedIn || [...store.collections.connectors.values()].length > 0,
        // A Vite dev build unlocks the admin plugin (devtools, debug reads)
        // without a session — dev has no identity seam to grant admin, and
        // the machinery panel is exactly what dev needs. Vite serves DEV as
        // the boolean true; production builds and bun tests see
        // undefined/"" (tsc types the field string, hence the cast).
        admin: (signedIn && identity.admin) ||
          (import.meta.env?.DEV as boolean | string | undefined) === true,
        needsSelection: signedIn && identity.allowlisted && (watched === undefined || watched.selected === null),
        signedOut: identity?.state === "signed-out",
        recent: store.session().recentCommands ?? [],
        identity: identity === undefined
          ? "unknown"
          : identity.state === "signed-in"
          ? `signed-in as ${identity.login ?? "?"}`
          : identity.state
      }
    }
  })
  ctx.commands = commands

  subscribeToAgent()
  watchIdentityAcrossTabs()
  // Cmd+T / Cmd+W / Cmd+1..9 on the document, released with the controller.
  if (typeof document !== "undefined") ctx.onDispose(installKeyboard(document))
  const dispose = (): void => {
    // The pumps first (they hold EventSources and timers), then the
    // registered finalizers (the agent subscription, identity listeners,
    // the BroadcastChannel). Both halves are idempotent.
    ctx.stopWorkflowPumps()
    ctx.dispose()
  }

  const runCommand = (name: string): boolean => {
    if (commands.find(name) === undefined) return false
    void commands.run(name).then((outcome) => surfaceCommandFailure(name, outcome))
    return true
  }

  const runCommandArgs = (name: string, args: string): boolean => {
    if (commands.find(name) === undefined) return false
    void commands.run(name, args).then((outcome) => surfaceCommandFailure(name, outcome))
    return true
  }

  return {
    store,
    bootstrap: services.bootstrap,
    nativeAgentAvailable: agent.available,
    nativeRepositoriesAvailable: repositories.available,
    tappedFetch: http,
    commands,
    slashItems: (needle) => commands.slashItems(needle),
    changeDraft,
    reset,
    askReset,
    cancelReset,
    stop,
    send,
    showChat,
    showWorld,
    showConnectors,
    runCommand,
    runCommandArgs,
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    decideApproval,
    retryLastTurn,
    openRepoChooser,
    toggleWatchedRepo,
    selectAllWatchedRepos,
    selectNoWatchedRepos,
    confirmWatchedRepos,
    clearConversation,
    openBrowser,
    createWorkflow,
    listWorkspaceWorkflows,
    runWorkflow,
    chooseWorkflowRepo,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame,
    openTerminalTab,
    openHarnessTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    pty,
    openRepo,
    runTarget,
    openTarget,
    showGraph: targetGraph.showGraph,
    focusGraphNode: targetGraph.focusGraph,
    showRunTimeline: targetGraph.showTimeline,
    showRunHistory: targetGraph.showHistory,
    selectRunReplay: targetGraph.selectRun,
    scrubRunReplay: targetGraph.scrubRun,
    showAffected: targetGraph.showAffected,
    showCiMatrix: targetGraph.showCi,
    openTargetSource: targetGraph.openSource,
    toggleDevtools,
    toggleSurfacesMenu,
    toggleConnectMenu,
    closeConnectMenu,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    debugNet,
    netTap,
    resetGrants,
    debugSeams,
    toggleTheme,
    setPalette,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    handleAuthReturn,
    deferCommand,
    resumeDeferredCommand,
    noteCommandRun,
    showCommandCatalog,
    promptSignIn,
    reloadApp,
    listIssues: issuesSeam.listIssues,
    viewIssue: issuesSeam.viewIssue,
    createIssue: issuesSeam.createIssue,
    setIssueState: issuesSeam.setIssueState,
    commentOnIssue: issuesSeam.commentOnIssue,
    listLandings: landingsSeam.listLandings,
    viewLanding: landingsSeam.viewLanding,
    createLanding: landingsSeam.createLanding,
    landLanding: landingsSeam.landLanding,
    reviewLanding: landingsSeam.reviewLanding,
    startCheckout: billingSeam.startCheckout,
    openBillingPortal: billingSeam.openBillingPortal,
    listKeys: keysSeam.listKeys,
    removeKey: keysSeam.removeKey,
    listNotifications: notificationsSeam.listNotifications,
    markNotificationsRead: notificationsSeam.markNotificationsRead,
    viewEnvironment: environmentSeam.viewEnvironment,
    setEnvironmentVar: environmentSeam.setEnvironmentVar,
    importRepository: repoImportSeam.importRepository,
    listBookmarks: bookmarksSeam.listBookmarks,
    listFiles: filesSeam.listFiles,
    readFile: filesSeam.readFile,
    checkGitHubApp: appStatusSeam.checkGitHubApp,
    dismissToast,
    refreshBalance,
    showBalance,
    openFirstRunRepos,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    dispose
  }
}
