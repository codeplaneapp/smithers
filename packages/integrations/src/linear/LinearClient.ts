/**
 * The Linear GraphQL client.
 *
 * Plain `fetch` over raw GraphQL rather than `@linear/sdk`: the behaviors
 * worth keeping are lookup caching, name resolution, and rate-limit handling,
 * and all three are a few dozen lines each once the SDK is not in the way.
 *
 * - **Names, not ids.** Linear's mutations take ids. Humans and workflows
 *   write `ENG`, `In Progress`, `bug`, and `ENG-123`. Every lookup that turns
 *   one into an id is cached per client, so a workflow that touches ten issues
 *   on one team resolves its team, states, and labels once.
 * - **Rate limits.** A 429 or 5xx is retried up to five attempts, waiting the
 *   server's `Retry-After` or `X-RateLimit-Requests-Reset`, capped at 30 s,
 *   and falling back to exponential backoff when neither header is present.
 * - **Key hygiene.** The API key reaches the `Authorization` header and
 *   nothing else.
 *
 * One `AbortController` spans each attempt's request *and* its body read, so
 * interrupting the fiber during either tears the exchange down.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import { type LinearConfig, resolve } from "./Config.ts"

/**
 * A Linear priority: `0` none, `1` urgent, `2` high, `3` normal, `4` low, or
 * the name of one.
 *
 * @category models
 * @since 1.0.0
 */
export type Priority = number | "none" | "urgent" | "high" | "normal" | "medium" | "low"

/**
 * A team, by id and optionally by key.
 *
 * @category models
 * @since 1.0.0
 */
export interface TeamRef {
  readonly id: string
  readonly key?: string | undefined
  readonly name?: string | undefined
}

/**
 * An issue, as the mutations and lookups return it.
 *
 * @category models
 * @since 1.0.0
 */
export interface IssueResult {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly team?: { readonly id: string; readonly key?: string | undefined } | null | undefined
}

/**
 * A comment, as `commentOnIssue` returns it.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommentResult {
  readonly id: string
  readonly body: string
  readonly issue?: { readonly id: string; readonly identifier?: string | undefined } | null | undefined
}

/**
 * The name-or-id fields an issue mutation accepts.
 *
 * @category models
 * @since 1.0.0
 */
export interface IssueFields {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly priority?: Priority | undefined
  /** Label names, resolved per team and cached. */
  readonly labels?: ReadonlyArray<string> | undefined
  /** Raw label ids, which skip resolution. */
  readonly labelIds?: ReadonlyArray<string> | undefined
  /** A workflow-state name such as `In Progress`, resolved per team. */
  readonly stateName?: string | undefined
  readonly stateId?: string | undefined
  readonly assigneeId?: string | undefined
  readonly projectId?: string | undefined
  readonly estimate?: number | undefined
  readonly dueDate?: string | undefined
}

/**
 * What `createIssue` needs beyond {@link IssueFields}.
 *
 * @category models
 * @since 1.0.0
 */
export interface CreateIssueInput extends IssueFields {
  /** A team key such as `ENG`, resolved to an id. */
  readonly teamKey?: string | undefined
  /** A team id, which skips the lookup. One of the two is required. */
  readonly teamId?: string | undefined
  readonly title: string
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface LinearClient {
  /** A raw GraphQL request, resolving with the `data` payload. */
  readonly query: (
    gql: string,
    variables?: Record<string, unknown>
  ) => Effect.Effect<Record<string, any>, IntegrationError>
  /** Resolves a team by key, or passes an explicit id through. Cached. */
  readonly resolveTeam: (
    ref: { readonly teamId?: string | undefined; readonly teamKey?: string | undefined }
  ) => Effect.Effect<TeamRef, IntegrationError>
  /** Resolves a workflow-state name to its id for a team. Cached. */
  readonly resolveStateId: (teamId: string, stateName: string) => Effect.Effect<string, IntegrationError>
  /** Resolves label names to ids for a team. Cached. */
  readonly resolveLabelIds: (
    teamId: string,
    names: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<string>, IntegrationError>
  /** Fetches an issue by UUID or by `ENG-123` identifier. */
  readonly getIssue: (idOrIdentifier: string) => Effect.Effect<IssueResult, IntegrationError>
  readonly createIssue: (input: CreateIssueInput) => Effect.Effect<IssueResult, IntegrationError>
  readonly updateIssue: (idOrIdentifier: string, fields: IssueFields) => Effect.Effect<IssueResult, IntegrationError>
  readonly commentOnIssue: (idOrIdentifier: string, body: string) => Effect.Effect<CommentResult, IntegrationError>
}

/**
 * Service tag for the Linear GraphQL client.
 *
 * @category services
 * @since 1.0.0
 */
export const LinearClient: Context.Service<LinearClient, LinearClient> = Context.Service(
  "@smthrs/integrations/LinearClient"
)

// Linear's priority vocabulary: 1 urgent, 2 high, 3 normal, 4 low.
const PRIORITY_BY_NAME: Readonly<Record<string, number>> = {
  none: 0,
  urgent: 1,
  high: 2,
  normal: 3,
  medium: 3,
  low: 4
}

/** An issue identifier such as `ENG-123`, as opposed to a UUID. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/

const MAX_ATTEMPTS = 5
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Normalizes a priority name or number onto Linear's 0-4 scale.
 *
 * @category constructors
 * @since 1.0.0
 */
export const normalizePriority = (priority: Priority | undefined): number | undefined => {
  if (priority === undefined) return undefined
  if (typeof priority === "number") {
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new IntegrationError("decode-failed", `Invalid Linear priority number: ${priority} (expected 0-4).`, {
        priority
      })
    }
    return priority
  }
  const mapped = PRIORITY_BY_NAME[String(priority).toLowerCase()]
  if (mapped === undefined) {
    throw new IntegrationError("decode-failed", `Unknown Linear priority name: "${priority}".`, { priority })
  }
  return mapped
}

/**
 * How long to wait before retrying, from `Retry-After` (seconds) or
 * `X-RateLimit-Requests-Reset` (epoch milliseconds), capped at 30 seconds.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryDelayMs = (headers: Headers, nowMs: number = Date.now()): number | undefined => {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null && retryAfter.length > 0) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
  }
  const reset = headers.get("x-ratelimit-requests-reset")
  if (reset !== null && reset.length > 0) {
    const resetMs = Number(reset)
    if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(Math.max(resetMs - nowMs, 0), MAX_RETRY_DELAY_MS)
  }
  return undefined
}

const ISSUE_FIELDS = "id identifier title url team { id key }"

const TEAM_BY_KEY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name } }
}`
const WORKFLOW_STATES = `query WorkflowStates($teamId: ID!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name type } }
}`
const ISSUE_LABELS = `query IssueLabels($teamId: ID!) {
  issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name } }
}`
const ISSUE = `query Issue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`
const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`
const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`
const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body issue { id identifier } } }
}`

interface NamedNode {
  readonly id: string
  readonly name?: string | undefined
}

/**
 * Builds a Linear client bound to `config`.
 *
 * `env` is the fallback source for anything `config` omits. Passing one
 * replaces the ambient environment rather than layering over it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: LinearConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): LinearClient => {
  const { apiBaseUrl, apiKey } = resolve(config, env)

  const teamByKey = new Map<string, TeamRef>()
  const statesByTeam = new Map<string, ReadonlyArray<NamedNode>>()
  const labelsByTeam = new Map<string, ReadonlyArray<NamedNode>>()

  const query: LinearClient["query"] = (gql, variables) =>
    Effect.gen(function*() {
      if (apiKey === undefined) {
        return yield* Effect.fail(
          new IntegrationError(
            "credentials-missing",
            "Linear API key is not configured. Pass config.apiKey or set SMITHERS_LINEAR_API_KEY.",
            { apiBaseUrl }
          )
        )
      }
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        // One controller spans the request and its body: aborting it cancels
        // an in-flight fetch and tears down the connection under a pending
        // `response.json()`. Effect aborts the signal it hands each step when
        // the fiber is interrupted, so forwarding it makes both interruptible.
        const controller = new AbortController()
        const abortWith = (signal: AbortSignal) => {
          if (signal.aborted) controller.abort(signal.reason)
          else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
        }
        const response = yield* Effect.tryPromise({
          try: (signal) => {
            abortWith(signal)
            return fetch(apiBaseUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                // Personal API keys go raw; OAuth tokens arrive pre-prefixed.
                Authorization: apiKey
              },
              body: JSON.stringify({ query: gql, variables: variables ?? {} }),
              signal: controller.signal
            })
          },
          catch: (cause) =>
            new IntegrationError("delivery-failed", "Linear API request failed (network error).", { apiBaseUrl }, {
              cause
            })
        })
        if (response.status === 429 || response.status >= 500) {
          if (attempt >= MAX_ATTEMPTS) {
            return yield* Effect.fail(
              new IntegrationError(
                "delivery-failed",
                `Linear API responded ${response.status} after ${attempt} attempts.`,
                { status: response.status, apiBaseUrl }
              )
            )
          }
          const delayMs = retryDelayMs(response.headers) ??
            Math.min(250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
          yield* Effect.sleep(`${delayMs} millis`)
          continue
        }
        const json = yield* Effect.tryPromise({
          try: (signal) => {
            // The fetch step's signal settles once headers arrive, so re-link
            // to keep an interrupt during the body read effective.
            abortWith(signal)
            return response.json() as Promise<Record<string, any>>
          },
          catch: (cause) =>
            new IntegrationError(
              "decode-failed",
              `Linear API returned a non-JSON response (status ${response.status}).`,
              { status: response.status },
              { cause }
            )
        })
        const errors = Array.isArray(json?.["errors"]) ? (json["errors"] as Array<{ message?: unknown }>) : []
        if (!response.ok) {
          return yield* Effect.fail(
            new IntegrationError("delivery-failed", `Linear API responded ${response.status}.`, {
              status: response.status,
              errors: errors.map((error) => error?.message)
            })
          )
        }
        if (errors.length > 0) {
          return yield* Effect.fail(
            new IntegrationError(
              "delivery-failed",
              `Linear GraphQL error: ${errors.map((error) => error?.message ?? "unknown").join("; ")}`,
              { errors: errors.map((error) => error?.message) }
            )
          )
        }
        return (json?.["data"] ?? {}) as Record<string, any>
      }
      // Unreachable: the loop returns or fails on every path.
      return yield* Effect.fail(
        new IntegrationError("delivery-failed", "Linear API retry loop exhausted.", { apiBaseUrl })
      )
    })

  const resolveTeam: LinearClient["resolveTeam"] = (ref) =>
    Effect.gen(function*() {
      if (ref.teamId !== undefined) return { id: ref.teamId, key: ref.teamKey }
      const key = ref.teamKey?.trim()
      if (key === undefined || key.length === 0) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", "Linear team is required: pass teamId or teamKey.")
        )
      }
      const cached = teamByKey.get(key.toUpperCase())
      if (cached !== undefined) return cached
      const data = yield* query(TEAM_BY_KEY, { key })
      const team = data?.["teams"]?.nodes?.[0]
      if (team?.id === undefined) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", `Linear team with key "${key}" not found.`, { teamKey: key })
        )
      }
      const found: TeamRef = { id: team.id, key: team.key, name: team.name }
      teamByKey.set(key.toUpperCase(), found)
      return found
    })

  const listStates = (teamId: string): Effect.Effect<ReadonlyArray<NamedNode>, IntegrationError> =>
    Effect.gen(function*() {
      const cached = statesByTeam.get(teamId)
      if (cached !== undefined) return cached
      const data = yield* query(WORKFLOW_STATES, { teamId })
      const states = (data?.["workflowStates"]?.nodes ?? []) as ReadonlyArray<NamedNode>
      statesByTeam.set(teamId, states)
      return states
    })

  const resolveStateId: LinearClient["resolveStateId"] = (teamId, stateName) =>
    Effect.gen(function*() {
      const states = yield* listStates(teamId)
      const match = states.find((state) => state.name?.toLowerCase() === stateName.toLowerCase())
      if (match === undefined) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", `Linear workflow state "${stateName}" not found for team.`, {
            teamId,
            stateName,
            known: states.map((state) => state.name)
          })
        )
      }
      return match.id
    })

  const resolveLabelIds: LinearClient["resolveLabelIds"] = (teamId, names) =>
    Effect.gen(function*() {
      let labels = labelsByTeam.get(teamId)
      if (labels === undefined) {
        const data = yield* query(ISSUE_LABELS, { teamId })
        labels = (data?.["issueLabels"]?.nodes ?? []) as ReadonlyArray<NamedNode>
        labelsByTeam.set(teamId, labels)
      }
      const ids: Array<string> = []
      const missing: Array<string> = []
      for (const name of names) {
        const match = labels.find((label) => label.name?.toLowerCase() === name.toLowerCase())
        if (match === undefined) missing.push(name)
        else ids.push(match.id)
      }
      if (missing.length > 0) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", `Linear label(s) not found for team: ${missing.join(", ")}.`, {
            teamId,
            missing
          })
        )
      }
      return ids
    })

  const getIssue: LinearClient["getIssue"] = (idOrIdentifier) =>
    Effect.gen(function*() {
      const data = yield* query(ISSUE, { id: idOrIdentifier })
      const issue = data?.["issue"]
      if (issue?.id === undefined) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", `Linear issue "${idOrIdentifier}" not found.`, { idOrIdentifier })
        )
      }
      return issue as IssueResult
    })

  const buildIssueInput = (
    teamId: string | undefined,
    fields: IssueFields
  ): Effect.Effect<Record<string, unknown>, IntegrationError> =>
    Effect.gen(function*() {
      const input: Record<string, unknown> = {}
      if (fields.title !== undefined) input["title"] = fields.title
      if (fields.description !== undefined) input["description"] = fields.description
      if (fields.assigneeId !== undefined) input["assigneeId"] = fields.assigneeId
      if (fields.projectId !== undefined) input["projectId"] = fields.projectId
      if (fields.estimate !== undefined) input["estimate"] = fields.estimate
      if (fields.dueDate !== undefined) input["dueDate"] = fields.dueDate
      const priority = normalizePriority(fields.priority)
      if (priority !== undefined) input["priority"] = priority
      if (fields.stateId !== undefined) {
        input["stateId"] = fields.stateId
      } else if (fields.stateName !== undefined) {
        if (teamId === undefined) {
          return yield* Effect.fail(
            new IntegrationError("decode-failed", "Resolving a Linear state name requires the issue's team.", {
              stateName: fields.stateName
            })
          )
        }
        input["stateId"] = yield* resolveStateId(teamId, fields.stateName)
      }
      if (fields.labelIds !== undefined) {
        input["labelIds"] = fields.labelIds
      } else if (fields.labels !== undefined && fields.labels.length > 0) {
        if (teamId === undefined) {
          return yield* Effect.fail(
            new IntegrationError("decode-failed", "Resolving Linear label names requires the issue's team.", {
              labels: fields.labels
            })
          )
        }
        input["labelIds"] = yield* resolveLabelIds(teamId, fields.labels)
      }
      return input
    })

  const createIssue: LinearClient["createIssue"] = (input) =>
    Effect.gen(function*() {
      const team = yield* resolveTeam({ teamId: input.teamId, teamKey: input.teamKey })
      const issueInput = yield* buildIssueInput(team.id, input)
      issueInput["teamId"] = team.id
      const data = yield* query(ISSUE_CREATE, { input: issueInput })
      const payload = data?.["issueCreate"]
      if (payload?.success !== true || payload.issue === undefined) {
        return yield* Effect.fail(
          new IntegrationError("delivery-failed", "Linear issueCreate did not return an issue.", {
            success: payload?.success ?? false
          })
        )
      }
      return payload.issue as IssueResult
    })

  const updateIssue: LinearClient["updateIssue"] = (idOrIdentifier, fields) =>
    Effect.gen(function*() {
      const needsTeam = (fields.stateName !== undefined && fields.stateId === undefined) ||
        (fields.labels !== undefined && fields.labelIds === undefined)
      let issueId = idOrIdentifier
      let teamId: string | undefined
      if (IDENTIFIER.test(idOrIdentifier) || needsTeam) {
        const issue = yield* getIssue(idOrIdentifier)
        issueId = issue.id
        teamId = issue.team?.id
      }
      const input = yield* buildIssueInput(teamId, fields)
      const data = yield* query(ISSUE_UPDATE, { id: issueId, input })
      const payload = data?.["issueUpdate"]
      if (payload?.success !== true || payload.issue === undefined) {
        return yield* Effect.fail(
          new IntegrationError("delivery-failed", "Linear issueUpdate did not return an issue.", {
            success: payload?.success ?? false,
            idOrIdentifier
          })
        )
      }
      return payload.issue as IssueResult
    })

  const commentOnIssue: LinearClient["commentOnIssue"] = (idOrIdentifier, body) =>
    Effect.gen(function*() {
      // Mutations need the UUID; lookups accept an `ENG-123` identifier.
      const issueId = IDENTIFIER.test(idOrIdentifier)
        ? (yield* getIssue(idOrIdentifier)).id
        : idOrIdentifier
      const data = yield* query(COMMENT_CREATE, { input: { issueId, body } })
      const payload = data?.["commentCreate"]
      if (payload?.success !== true || payload.comment === undefined) {
        return yield* Effect.fail(
          new IntegrationError("delivery-failed", "Linear commentCreate did not return a comment.", {
            success: payload?.success ?? false,
            idOrIdentifier
          })
        )
      }
      return payload.comment as CommentResult
    })

  return LinearClient.of({
    query,
    resolveTeam,
    resolveStateId,
    resolveLabelIds,
    getIssue,
    createIssue,
    updateIssue,
    commentOnIssue
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: LinearConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): Layer.Layer<LinearClient> => Layer.sync(LinearClient, () => make(config, env))
