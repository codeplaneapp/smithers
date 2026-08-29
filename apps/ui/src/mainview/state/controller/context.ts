import { Effect } from "effect"
import type { AgentChatMessage, FetchLike } from "smithers-shared/NativeAgent"
import type { CommandRegistry } from "../../flows/Commands"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import type { AppServices } from "../AppController"
import type { AppStore } from "../AppStore"
import type { ImpossibleAskClass } from "../Instructions"
import type { WorkflowRpcResult } from "./workflows"

export interface PendingToolCall {
  readonly callId: string
  readonly name: string
  readonly args: string
}

export interface ActiveTurn {
  readonly id: string
  receivedText: boolean
  /** Executed tool legs of this logical turn (capped at MAX_TOOL_LEGS). */
  toolLegs: number
  /** The function_call / function_call_output items accumulated across legs. */
  readonly toolItems: AgentChatMessage[]
  pendingCall: PendingToolCall | undefined
  /*
   * Wave 12 §1: the run-launch command this turn actually executed, if any.
   * Once set, the model's remaining text for the turn is held back and only
   * rendered if it claims nothing about run state (see RunClaims.ts).
   */
  runLaunch: string | undefined
  /*
   * Wave 13c: the impossible-ask class the user's message asked for, if any
   * (detected from the ask alone at send time). Once set, the model's text
   * for the turn is held back like a launch turn's and only rendered if it
   * offers the act the class names — never for ordinary conversation.
   */
  askClass: ImpossibleAskClass | undefined
  /** Text deltas withheld from the transcript while a claim check is pending. */
  claimBuffer: string
}

export interface NetEntry {
  readonly at: number
  readonly method: string
  readonly url: string
  readonly status: number | "error"
  readonly ms: number
}

export interface ControllerContext {
  readonly store: AppStore
  readonly repositories: NativeRepositories
  readonly agent: NativeAgent
  readonly services: AppServices
  readonly baseUrl: string
  readonly rawHttp: FetchLike
  http: FetchLike
  boundedFetch: (url: string, init?: RequestInit) => Promise<Response>
  errorMessageOf: (response: Response, fallback: string) => Promise<string>
  readonly unref: (timer: ReturnType<typeof setTimeout>) => void
  /**
   * Register a finalizer for something this controller opened (a
   * subscription, a host listener, a channel). Everything registered runs
   * when the controller's scope closes via `dispose` — nothing a controller
   * opened outlives it.
   */
  readonly onDispose: (finalizer: () => void) => void
  /** Close the controller's scope: run every registered finalizer, once. */
  readonly dispose: () => void
  readonly toastDebounceMs: number
  readonly toastAutoDismissMs: number
  readonly workflowPollMs: number
  readonly netRing: NetEntry[]
  readonly toastRuns: Map<string, number>
  readonly runStreams: Map<string, EventSource>
  readonly pumpPokes: Map<string, () => void>
  readonly runPumps: Map<string, { stopped: boolean }>
  activeTurn: ActiveTurn | undefined
  commandActor: "user" | "smithers"
  accountEpoch: number
  identityChanged: () => void
  authReprobeAt: number
  loadSession: () => Promise<void>
  openFirstRunRepos: () => Promise<void>
  resumeWorkflowRuns: () => void
  resumeDeferredCommand: () => void
  stopWorkflowPumps: () => void
  contextMessages: () => ReadonlyArray<AgentChatMessage>
  openRepoChooser: (preselect?: string) => Promise<string | void>
  /** Open a repository by path on the local origin (controller/targets.ts binds it). */
  openRepo: (path: string) => Promise<string | void>
  workflowRpc: (repo: string, method: string, params: unknown) => Promise<WorkflowRpcResult>
  commands: CommandRegistry
  withToast: <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>
  ) => Promise<T | string>
}

/**
 * Allocate the controller's one shared mutable context. Transport construction
 * order is deliberate: ring, recorder, raw fetch, late-bound unauthorized
 * door, tapped fetch, then bounded fetch.
 */
export const createControllerContext = (
  store: AppStore,
  repositories: NativeRepositories,
  agent: NativeAgent,
  services: AppServices
): ControllerContext => {
  /*
   * The wire tap (DESIGN.md §14 debug mode): a bounded in-memory ring around
   * the one fetch seam every controller call flows through. Records method,
   * url, status, and duration. Never persisted. This is the only capture
   * debug mode adds beyond what the app already stores.
   */
  const netRing: NetEntry[] = []
  const recordNet = (entry: NetEntry): void => {
    netRing.push(entry)
    if (netRing.length > 100) netRing.shift()
  }
  const rawHttp: FetchLike = services.fetchImpl ?? fetch.bind(globalThis)
  const unref = (timer: ReturnType<typeof setTimeout>): void => {
    // Bun/Node timers hold the process open (e2e scripts); browser timers don't.
    ;(timer as { unref?: () => void }).unref?.()
  }
  /*
   * The controller's disposal scope (Ruling B, docs/persistence.md): the
   * acquisition half lives where the resource is opened (the agent
   * subscription in turns.ts, the cross-tab identity listeners in
   * auth-billing.ts, the workflow pumps), and closing the scope releases
   * all of it. Previously the agent unsubscribe was discarded and the
   * identity listeners and BroadcastChannel leaked for the page lifetime.
   */
  const finalizers: Array<() => void> = []
  let disposed = false
  const ctx = {
    store,
    repositories,
    agent,
    services,
    baseUrl: services.baseUrl ?? "",
    rawHttp,
    toastDebounceMs: services.toastDebounceMs ?? 300,
    toastAutoDismissMs: services.toastAutoDismissMs ?? 4000,
    workflowPollMs: services.workflowPollMs ?? 2500,
    netRing,
    toastRuns: new Map<string, number>(),
    runStreams: new Map<string, EventSource>(),
    pumpPokes: new Map<string, () => void>(),
    runPumps: new Map<string, { stopped: boolean }>(),
    activeTurn: undefined,
    commandActor: "user",
    accountEpoch: 0,
    identityChanged: () => {},
    authReprobeAt: 0,
    loadSession: async () => {},
    openFirstRunRepos: async () => {},
    resumeWorkflowRuns: () => {},
    resumeDeferredCommand: () => {},
    stopWorkflowPumps: () => {},
    contextMessages: () => [],
    openRepoChooser: async () => {},
    openRepo: async () => "Opening a repository is not wired.",
    workflowRpc: async () => ({ status: "error", message: "Workflow RPC is not wired." }),
    commands: undefined as unknown as CommandRegistry,
    withToast: undefined as unknown as ControllerContext["withToast"],
    unref,
    onDispose: (finalizer) => {
      // Registering after disposal runs the finalizer at once, so a late
      // acquisition never leaks either.
      if (disposed) {
        finalizer()
        return
      }
      finalizers.push(finalizer)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const finalizer of finalizers.splice(0)) finalizer()
    },
    http: undefined as unknown as FetchLike,
    boundedFetch: undefined as unknown as ControllerContext["boundedFetch"],
    errorMessageOf: undefined as unknown as ControllerContext["errorMessageOf"]
  } satisfies ControllerContext

  /*
   * Mid-session 401 recovery (multi's AUTH_REQUIRED discipline, one seam):
   * a 401 off any /api call while the app believes it is signed in means the
   * cookie expired — bursts collapse into ONE identity re-probe, and the
   * definitive answer drives the auth conversation state (loadSession never
   * 401s itself: the Worker restates signed-out as 200). A 401 while
   * signed-out is the expected state and probes nothing.
   */
  const noteUnauthorized = (url: string): void => {
    if (!url.includes("/api/") || url.includes("/api/auth/")) return
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") return
    const now = Date.now()
    if (now - ctx.authReprobeAt < 10_000) return
    ctx.authReprobeAt = now
    void ctx.loadSession()
  }
  ctx.http = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now()
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    try {
      const response = await rawHttp(input, init)
      recordNet({ at: started, method, url, status: response.status, ms: Date.now() - started })
      if (response.status === 401) noteUnauthorized(url)
      return response
    } catch (error) {
      recordNet({ at: started, method, url, status: "error", ms: Date.now() - started })
      throw error
    }
  }
  const seamTimeoutMs = services.seamTimeoutMs ?? 30_000
  /*
   * A request that never answers has to become an answer.
   *
   * §22.6 / A.18: `POST /api/workflow/provision` never replied, so
   * "Preparing your … workspace…" stood past 120s with no run card, no
   * timeout and no error — the silent-failure family with a spinner on top.
   * A bounded wait turns it into an honest refusal. It rides only on the
   * request/response seams; the streaming paths (the turn, the model relay)
   * carry no deadline, because a long stream is not a hang.
   */
  /**
   * One request, with a deadline on it.
   *
   * The deadline is Effect's timeout (Ruling B, docs/persistence.md): when
   * it wins, the request fiber is interrupted and tryPromise aborts the
   * fetch's signal — cancellation is interruption, not a manual
   * AbortController, and a settled request clears its own clock, so nothing
   * dangles per request. The public shape is unchanged: a promise of the
   * response, rejecting with plain Errors, and the deadline still rejects
   * with `seam timeout`. `Effect.timeout` alone would reject with a
   * `TimeoutError` whose `message` is undefined, so the fallback is explicit.
   */
  ctx.boundedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    Effect.runPromise(
      Effect.tryPromise({
        try: (signal) => ctx.http(url, { ...init, signal }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error)))
      }).pipe(
        Effect.timeoutOrElse({
          duration: seamTimeoutMs,
          orElse: () => Effect.fail(new Error("seam timeout"))
        })
      )
    )
  ctx.errorMessageOf = async (response: Response, fallback: string): Promise<string> => {
    const body = (await response.text().catch(() => "")).trim()
    try {
      const parsed: unknown = JSON.parse(body)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
      ) {
        return parsed.message
      }
    } catch {
      // A non-JSON error body carries no better message than the fallback.
    }
    return body === "" ? fallback : `${fallback} (${body.slice(0, 200)})`
  }
  return ctx
}
