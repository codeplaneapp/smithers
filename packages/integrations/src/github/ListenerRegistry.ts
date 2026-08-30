/**
 * Declared GitHub webhooks, and the reconciliation that makes a repository
 * match the declaration.
 *
 * The safety property this module exists for is **ownership**. A hook is owned
 * only when its numeric GitHub id appears in the workspace's own state file. A
 * matching callback URL is not proof of ownership, because anyone can point a
 * hook at any URL, so an unowned hook on a declared URL is reported as a
 * `conflict` and never modified. Deletes additionally require an explicit
 * `allowDelete`, and ownership is persisted after every remote mutation so a
 * failure halfway through a run leaves a state file the next run can converge
 * from.
 *
 * There is no `smithers listeners` verb at 1.0. This is library code an
 * application calls.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { IntegrationError } from "../core/IntegrationError.ts"
import { DEFAULT_API_BASE_URL, resolve as resolveConfig } from "./Config.ts"
import { type GitHubClient, make as makeClient } from "./GitHubClient.ts"

/**
 * Where the declaration lives, relative to the workspace root.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REGISTRY_PATH = ".smithers/listeners.json"

/**
 * Where the ownership state lives, relative to the workspace root.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_STATE_PATH = ".smithers/listeners.state.json"

/**
 * The GitHub events a listener may subscribe to.
 *
 * @category constants
 * @since 1.0.0
 */
export const LISTENER_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment"
] as const

/**
 * One event a listener may subscribe to.
 *
 * @category models
 * @since 1.0.0
 */
export type ListenerEvent = (typeof LISTENER_EVENTS)[number]

/**
 * One declared webhook.
 *
 * @category models
 * @since 1.0.0
 */
export interface Listener {
  readonly id: string
  readonly provider: "github"
  readonly repository: string
  readonly events: ReadonlyArray<ListenerEvent>
  readonly flowId: string
  readonly callbackUrl: string
  /** The environment variable holding this listener's signing secret. */
  readonly secretEnv: string
  readonly active: boolean
}

/**
 * A parsed declaration file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Registry {
  readonly version: 1
  readonly listeners: ReadonlyArray<Listener>
}

/**
 * One owned hook, as recorded in the state file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Ownership {
  readonly listenerId: string
  readonly repository: string
  readonly hookId: number
  readonly callbackUrl: string
  readonly secretDigest?: string | undefined
}

/**
 * The workspace's ownership state.
 *
 * @category models
 * @since 1.0.0
 */
export interface OwnershipState {
  readonly version: 1
  readonly github: ReadonlyArray<Ownership>
}

/**
 * A hook as GitHub reports it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RemoteHook {
  readonly id: number
  readonly active: boolean
  readonly events: ReadonlyArray<string>
  readonly config: {
    readonly url?: string | undefined
    readonly content_type?: string | undefined
    readonly insecure_ssl?: string | number | undefined
  }
}

/**
 * One entry of a reconciliation plan.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlanAction {
  readonly action: "create" | "update" | "delete" | "noop" | "leave" | "conflict"
  readonly listenerId: string | null
  readonly repository: string
  readonly hookId: number | null
  readonly reason: string
  readonly destructive: boolean
}

/**
 * A reconciliation plan.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcilePlan {
  readonly registryPath: string
  readonly statePath: string
  readonly actions: ReadonlyArray<PlanAction>
  readonly changes: number
  readonly destructiveChanges: number
}

const configError = (message: string, details?: Record<string, unknown>, cause?: unknown): IntegrationError =>
  new IntegrationError("invalid-config", message, details, cause === undefined ? undefined : { cause })

const ID = /^[a-z0-9][a-z0-9._-]*$/
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateCallbackUrl = (value: unknown, flowId: string, issues: Array<string>, at: string): void => {
  if (typeof value !== "string") {
    issues.push(`${at}.callbackUrl must be a string`)
    return
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push(`${at}.callbackUrl must be an absolute URL`)
    return
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    issues.push(`${at}.callbackUrl must be an HTTPS URL without embedded credentials, query parameters, or a fragment`)
    return
  }
  // Compared exactly. A tolerated trailing slash would produce a hook whose
  // deliveries the receiving route can only answer with a 404.
  const expected = `/webhooks/${encodeURIComponent(flowId)}`
  if (url.pathname !== expected) {
    issues.push(`${at}.callbackUrl path must be ${expected} for flow "${flowId}"`)
  }
}

const validateListener = (value: unknown, index: number, issues: Array<string>): Listener | undefined => {
  const at = `listeners[${index}]`
  const before = issues.length
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`)
    return undefined
  }
  const known = new Set(["id", "provider", "repository", "events", "flowId", "callbackUrl", "secretEnv", "active"])
  for (const key of Object.keys(value)) if (!known.has(key)) issues.push(`${at}.${key} is not a listener field`)
  const id = value["id"]
  if (typeof id !== "string" || !ID.test(id)) {
    issues.push(`${at}.id must use lowercase letters, numbers, dots, underscores, or hyphens`)
  }
  if (value["provider"] !== "github") issues.push(`${at}.provider must be "github"`)
  const repository = value["repository"]
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    issues.push(`${at}.repository must be owner/repository`)
  }
  const events = value["events"]
  if (
    !Array.isArray(events) || events.length === 0 ||
    events.some((event) => !LISTENER_EVENTS.includes(event as ListenerEvent))
  ) {
    issues.push(`${at}.events must be a non-empty array of ${LISTENER_EVENTS.join(", ")}`)
  }
  const flowId = value["flowId"]
  if (typeof flowId !== "string" || flowId.length === 0) issues.push(`${at}.flowId must be a non-empty string`)
  validateCallbackUrl(value["callbackUrl"], typeof flowId === "string" ? flowId : "", issues, at)
  const secretEnv = value["secretEnv"]
  if (typeof secretEnv !== "string" || !ENV_NAME.test(secretEnv)) {
    issues.push(`${at}.secretEnv must be an environment variable name`)
  }
  const active = value["active"]
  if (active !== undefined && typeof active !== "boolean") issues.push(`${at}.active must be a boolean`)
  if (issues.length > before) return undefined
  return {
    id: id as string,
    provider: "github",
    repository: repository as string,
    events: events as Array<ListenerEvent>,
    flowId: flowId as string,
    callbackUrl: value["callbackUrl"] as string,
    secretEnv: secretEnv as string,
    active: active === undefined ? true : (active as boolean)
  }
}

/**
 * Parses and validates a declaration.
 *
 * Accepts JSON text or an already-parsed value, and reports every problem it
 * finds rather than the first, because editing a declaration one error at a
 * time is miserable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parseRegistry = (input: unknown, source: string = DEFAULT_REGISTRY_PATH): Registry => {
  let value = input
  if (typeof input === "string") {
    try {
      value = JSON.parse(input)
    } catch (cause) {
      throw configError(`Listener registry ${source} is not valid JSON.`, { source }, cause)
    }
  }
  const issues: Array<string> = []
  if (!isRecord(value)) throw configError(`Listener registry ${source} must be an object.`, { source })
  if (value["version"] !== 1) issues.push("version must be 1")
  const rawListeners = value["listeners"]
  if (!Array.isArray(rawListeners)) issues.push("listeners must be an array")
  const listeners: Array<Listener> = []
  if (Array.isArray(rawListeners)) {
    for (const [index, raw] of rawListeners.entries()) {
      const listener = validateListener(raw, index, issues)
      if (listener !== undefined) listeners.push(listener)
    }
  }
  const seen = new Set<string>()
  const destinations = new Map<string, string>()
  for (const listener of listeners) {
    if (seen.has(listener.id)) issues.push(`duplicate listener id "${listener.id}"`)
    seen.add(listener.id)
    const destination = `${listener.callbackUrl} ${listener.secretEnv}`
    const existing = destinations.get(listener.flowId)
    if (existing !== undefined && existing !== destination) {
      issues.push(`listeners for flow "${listener.flowId}" must share callbackUrl and secretEnv`)
    }
    destinations.set(listener.flowId, destination)
  }
  if (issues.length > 0) {
    throw configError(
      `Listener registry ${source} failed validation: ${issues.join("; ")}`,
      { source, issues }
    )
  }
  return { version: 1, listeners }
}

/**
 * Reads and validates `.smithers/listeners.json` under `workspaceRoot`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readRegistry = (workspaceRoot: string = process.cwd()): Registry => {
  const path = resolvePath(workspaceRoot, DEFAULT_REGISTRY_PATH)
  if (!existsSync(path)) throw configError(`Listener registry not found at ${path}.`, { path })
  return parseRegistry(readFileSync(path, "utf8"), path)
}

const parseOwnership = (value: unknown, path: string): OwnershipState => {
  const bad = () =>
    configError(`Listener ownership state ${path} is invalid; refusing unsafe reconciliation.`, { path })
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["github"])) throw bad()
  const github: Array<Ownership> = []
  for (const entry of value["github"]) {
    if (
      !isRecord(entry) || typeof entry["listenerId"] !== "string" || typeof entry["repository"] !== "string" ||
      typeof entry["hookId"] !== "number" || !Number.isInteger(entry["hookId"]) || entry["hookId"] <= 0 ||
      typeof entry["callbackUrl"] !== "string" ||
      (entry["secretDigest"] !== undefined && typeof entry["secretDigest"] !== "string")
    ) {
      throw bad()
    }
    github.push({
      listenerId: entry["listenerId"],
      repository: entry["repository"],
      hookId: entry["hookId"],
      callbackUrl: entry["callbackUrl"],
      secretDigest: entry["secretDigest"]
    })
  }
  return { version: 1, github }
}

/**
 * Reads the ownership state, or an empty one when the workspace has never
 * reconciled.
 *
 * A state file that exists but cannot be parsed is fatal: reconciling without
 * knowing what this workspace owns is how somebody else's hook gets deleted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readOwnershipState = (workspaceRoot: string): OwnershipState => {
  const path = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
  if (!existsSync(path)) return { version: 1, github: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (cause) {
    throw configError(`Listener ownership state ${path} is invalid; refusing unsafe reconciliation.`, { path }, cause)
  }
  return parseOwnership(parsed, path)
}

const writeOwnershipState = (workspaceRoot: string, state: OwnershipState): void => {
  const path = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const normalizedEvents = (events: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(events)].sort()

const sameEvents = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  JSON.stringify(normalizedEvents(left)) === JSON.stringify(normalizedEvents(right))

const secretDigest = (secret: string): string => createHash("sha256").update(secret).digest("hex")

/**
 * What {@link plan} compares.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlanInput {
  readonly registry: Registry
  readonly state: OwnershipState
  readonly hooksByRepository: ReadonlyMap<string, ReadonlyArray<RemoteHook>>
  /** Digests of the current secrets, so a rotated secret shows as drift. */
  readonly secretDigests?: ReadonlyMap<string, string> | undefined
}

/**
 * Compares the declaration with what GitHub reports. Pure: it performs no
 * requests and writes nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const plan = (input: PlanInput): ReadonlyArray<PlanAction> => {
  const hooksFor = (repository: string): ReadonlyArray<RemoteHook> => input.hooksByRepository.get(repository) ?? []
  const desiredById = new Map(input.registry.listeners.map((listener) => [listener.id, listener]))
  const ownershipById = new Map(input.state.github.map((owned) => [owned.listenerId, owned]))
  const ownedHookKeys = new Set(input.state.github.map((owned) => `${owned.repository}:${owned.hookId}`))
  const actions: Array<PlanAction> = []

  for (const listener of input.registry.listeners) {
    const owned = ownershipById.get(listener.id)
    const hooks = hooksFor(listener.repository)
    const remote = owned === undefined ? undefined : hooks.find((hook) => hook.id === owned.hookId)
    if (owned === undefined) {
      const collision = hooks.find((hook) => hook.config.url === listener.callbackUrl)
      actions.push({
        action: collision === undefined ? "create" : "conflict",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: collision?.id ?? null,
        reason: collision === undefined
          ? "declared listener is missing"
          : "matching callback URL is not owned by this workspace",
        destructive: false
      })
      continue
    }
    if (owned.repository !== listener.repository) {
      actions.push({
        action: "delete",
        listenerId: listener.id,
        repository: owned.repository,
        hookId: owned.hookId,
        reason: "owned listener moved repositories",
        destructive: true
      })
      actions.push({
        action: "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: null,
        reason: "declared listener moved repositories",
        destructive: false
      })
      continue
    }
    if (remote === undefined) {
      actions.push({
        action: "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: null,
        reason: "owned GitHub hook was removed remotely",
        destructive: false
      })
      continue
    }
    const digest = input.secretDigests?.get(listener.id)
    const drifted = remote.config.url !== listener.callbackUrl ||
      remote.config.content_type !== "json" ||
      String(remote.config.insecure_ssl ?? "0") !== "0" ||
      remote.active !== listener.active ||
      !sameEvents(remote.events, listener.events) ||
      (digest !== undefined && owned.secretDigest !== digest)
    actions.push({
      action: drifted ? "update" : "noop",
      listenerId: listener.id,
      repository: listener.repository,
      hookId: remote.id,
      reason: drifted
        ? "owned GitHub hook drifted from the declaration"
        : "owned GitHub hook matches the declaration",
      destructive: false
    })
  }

  for (const owned of input.state.github) {
    if (desiredById.has(owned.listenerId)) continue
    if (!hooksFor(owned.repository).some((hook) => hook.id === owned.hookId)) continue
    actions.push({
      action: "delete",
      listenerId: owned.listenerId,
      repository: owned.repository,
      hookId: owned.hookId,
      reason: "owned listener was removed from the registry",
      destructive: true
    })
  }

  // Report each unowned hook once per repository, not once per declared
  // listener in it, and never alongside the `conflict` that already covers it.
  const conflictKeys = new Set(
    actions
      .filter((action) => action.action === "conflict" && action.hookId !== null)
      .map((action) => `${action.repository}:${action.hookId}`)
  )
  for (const repository of new Set(input.registry.listeners.map((listener) => listener.repository))) {
    for (const hook of hooksFor(repository)) {
      const key = `${repository}:${hook.id}`
      if (ownedHookKeys.has(key) || conflictKeys.has(key)) continue
      actions.push({
        action: "leave",
        listenerId: null,
        repository,
        hookId: hook.id,
        reason: "GitHub hook is not owned by this workspace",
        destructive: false
      })
    }
  }
  return actions
}

/**
 * What {@link reconcile} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcileOptions {
  readonly workspaceRoot?: string | undefined
  /** An in-memory declaration, instead of reading the workspace file. */
  readonly registry?: Registry | undefined
  /** Perform creates and updates. Without it, `reconcile` only plans. */
  readonly apply?: boolean | undefined
  /** Perform deletes. Required in addition to `apply`. */
  readonly allowDelete?: boolean | undefined
  readonly token?: string | undefined
  readonly apiBaseUrl?: string | undefined
  /**
   * Replaces the ambient environment outright, for both webhook secrets and
   * GitHub credentials. Reconciliation mutates a real repository, so an
   * explicit environment must never let an ambient `GITHUB_TOKEN` decide which
   * account the hooks are created under.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** An already-built client, for a caller that has one. */
  readonly client?: GitHubClient | undefined
}

/**
 * What {@link reconcile} did.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReconcileResult extends ReconcilePlan {
  readonly applied: ReadonlyArray<PlanAction>
  readonly skipped: ReadonlyArray<PlanAction>
}

const listenerConfig = (
  options: ReconcileOptions,
  env: Readonly<Record<string, string | undefined>>
): { readonly token: string | undefined; readonly apiBaseUrl: string } => {
  if (options.env === undefined) {
    const resolved = resolveConfig({ token: options.token, apiBaseUrl: options.apiBaseUrl })
    return { token: resolved.token, apiBaseUrl: resolved.apiBaseUrl }
  }
  const firstNonEmpty = (candidates: ReadonlyArray<string | undefined>): string | undefined =>
    candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0)?.trim()
  return {
    token: firstNonEmpty([options.token, env["SMITHERS_GITHUB_TOKEN"], env["GITHUB_TOKEN"]]),
    apiBaseUrl: firstNonEmpty([options.apiBaseUrl, env["SMITHERS_GITHUB_API_BASE_URL"]]) ?? DEFAULT_API_BASE_URL
  }
}

const permissionError = (repository: string, cause: IntegrationError): IntegrationError => {
  const status = cause.details?.["status"]
  if (status === 401 || status === 403 || status === 404) {
    return new IntegrationError(
      "permission-denied",
      `GitHub listener reconciliation cannot administer webhooks for ${repository}. The token needs fine-grained Webhooks read/write permission or classic admin:repo_hook access.`,
      { repository, status },
      { cause }
    )
  }
  return cause
}

const repositoryPath = (repository: string): string => repository.split("/").map(encodeURIComponent).join("/")

/**
 * Plans, and optionally applies, the declaration against GitHub.
 *
 * Ownership is written after every remote mutation, so a failure partway
 * through leaves a state file the next run converges from rather than a set of
 * hooks nothing claims.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reconcile = (options: ReconcileOptions = {}): Effect.Effect<ReconcileResult, IntegrationError> =>
  Effect.gen(function*() {
    const workspaceRoot = resolvePath(options.workspaceRoot ?? process.cwd())
    const registryPath = resolvePath(workspaceRoot, DEFAULT_REGISTRY_PATH)
    const statePath = resolvePath(workspaceRoot, DEFAULT_STATE_PATH)
    const registry = options.registry ?? readRegistry(workspaceRoot)
    const state = readOwnershipState(workspaceRoot)
    const env = options.env ?? process.env
    const resolved = listenerConfig(options, env)
    if (resolved.token === undefined) {
      return yield* Effect.fail(
        new IntegrationError(
          "credentials-missing",
          "GitHub listener reconciliation requires SMITHERS_GITHUB_TOKEN (or GITHUB_TOKEN) with fine-grained Webhooks read/write permission or classic admin:repo_hook access."
        )
      )
    }
    const secrets = new Map<string, string>()
    const digests = new Map<string, string>()
    for (const listener of registry.listeners) {
      const secret = env[listener.secretEnv]
      if (secret === undefined || secret.length === 0) {
        return yield* Effect.fail(
          new IntegrationError(
            "credentials-missing",
            `GitHub listener "${listener.id}" requires webhook secret environment variable ${listener.secretEnv}.`,
            { listenerId: listener.id, secretEnv: listener.secretEnv }
          )
        )
      }
      secrets.set(listener.id, secret)
      digests.set(listener.id, secretDigest(secret))
    }
    const client = options.client ?? makeClient({ token: resolved.token, apiBaseUrl: resolved.apiBaseUrl })
    const repositories = new Set([
      ...registry.listeners.map((listener) => listener.repository),
      ...state.github.map((owned) => owned.repository)
    ])
    const hooksByRepository = new Map<string, ReadonlyArray<RemoteHook>>()
    for (const repository of repositories) {
      const hooks = yield* client.paginate(`/repos/${repositoryPath(repository)}/hooks`, { maxPages: 10 }).pipe(
        Effect.mapError((cause) => permissionError(repository, cause))
      )
      hooksByRepository.set(repository, hooks as ReadonlyArray<RemoteHook>)
    }
    const actions = plan({ registry, state, hooksByRepository, secretDigests: digests })
    const summary: ReconcilePlan = {
      registryPath,
      statePath,
      actions,
      changes: actions.filter((action) => ["create", "update", "delete"].includes(action.action)).length,
      destructiveChanges: actions.filter((action) => action.action === "delete").length
    }
    if (options.apply !== true) {
      return {
        ...summary,
        applied: [],
        skipped: actions.filter((action) => action.action !== "noop" && action.action !== "leave")
      }
    }
    if (actions.some((action) => action.action === "conflict")) {
      return yield* Effect.fail(
        new IntegrationError(
          "listener-conflict",
          "GitHub listener apply refused because an unowned hook uses a declared callback URL. Adopt it manually or choose a different callback URL; Smithers will not modify it.",
          { conflicts: actions.filter((action) => action.action === "conflict") }
        )
      )
    }
    const desiredById = new Map(registry.listeners.map((listener) => [listener.id, listener]))
    // A move is a delete plus a create. Without `allowDelete` the delete is
    // skipped, so the create must be skipped too: applying it alone would
    // leave the repository with two live hooks for one listener.
    const blockedMoves = new Set(
      options.allowDelete === true ? [] : actions
        .filter((action) =>
          action.action === "delete" && action.listenerId !== null && desiredById.has(action.listenerId)
        )
        .map((action) => action.listenerId as string)
    )
    let github: Array<Ownership> = state.github.map((owned) => ({ ...owned }))
    const applied: Array<PlanAction> = []
    const skipped: Array<PlanAction> = []
    for (const action of actions) {
      if (action.action === "delete" && options.allowDelete !== true) {
        skipped.push(action)
        continue
      }
      if (!["create", "update", "delete"].includes(action.action)) continue
      if (action.action === "create" && action.listenerId !== null && blockedMoves.has(action.listenerId)) {
        skipped.push(action)
        continue
      }
      const path = repositoryPath(action.repository)
      if (action.action === "delete") {
        yield* client.request("DELETE", `/repos/${path}/hooks/${action.hookId}`)
        github = github.filter((owned) => !(owned.repository === action.repository && owned.hookId === action.hookId))
      } else {
        const listener = action.listenerId === null ? undefined : desiredById.get(action.listenerId)
        if (listener === undefined) {
          return yield* Effect.fail(
            configError(`Listener "${action.listenerId}" disappeared while applying the plan.`)
          )
        }
        const body = {
          name: "web",
          active: listener.active,
          events: normalizedEvents(listener.events),
          config: {
            url: listener.callbackUrl,
            content_type: "json",
            insecure_ssl: "0",
            secret: secrets.get(listener.id)
          }
        }
        const hook = action.action === "create"
          ? yield* client.request<{ readonly id?: unknown }>("POST", `/repos/${path}/hooks`, body)
          : yield* client.request<{ readonly id?: unknown }>("PATCH", `/repos/${path}/hooks/${action.hookId}`, body)
        const hookId = Number(hook?.id ?? action.hookId)
        if (!Number.isInteger(hookId) || hookId <= 0) {
          return yield* Effect.fail(
            new IntegrationError(
              "decode-failed",
              `GitHub did not return a valid hook id for listener "${listener.id}".`,
              { listenerId: listener.id }
            )
          )
        }
        github = github.filter((owned) => owned.listenerId !== listener.id)
        github.push({
          listenerId: listener.id,
          repository: listener.repository,
          hookId,
          callbackUrl: listener.callbackUrl,
          secretDigest: digests.get(listener.id)
        })
      }
      writeOwnershipState(workspaceRoot, { version: 1, github })
      applied.push(action)
    }
    writeOwnershipState(workspaceRoot, { version: 1, github })
    return { ...summary, applied, skipped }
  })
