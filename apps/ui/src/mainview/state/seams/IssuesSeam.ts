/*
 * The issues seam: /api/repos/{owner}/{repo}/issues* through the product
 * Worker's platform proxy. List and detail render as cards ("issue-list",
 * "issue"); mutations re-fetch and re-surface the affected detail card so the
 * transcript states the new truth. Reference: multi src/smithersCloud/
 * issues.ts + issueComments.ts. Parsing is defensive: unknown JSON in, typed
 * card payload out, missing fields become null/empty, malformed rows drop.
 *
 * IMPORT-READINESS degradation (multi importReadiness.ts + githubIssues.ts):
 * a 404 off the imported namespace means "not imported", so the LIST falls
 * back to the GET-only GitHub-source read and the card says so in `body`;
 * detail has no source read and mutations never fall back — both answer
 * honest strings pointing at /repos.import.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface IssuesSeam {
  readonly listIssues: (filter: "open" | "closed" | "all", repo?: string) => Promise<string | void>
  readonly viewIssue: (number: number, repo?: string) => Promise<string | void>
  readonly createIssue: (title: string, repo?: string) => Promise<string | void>
  readonly setIssueState: (
    number: number,
    state: "open" | "closed",
    repo?: string
  ) => Promise<string | void>
  readonly commentOnIssue: (number: number, text: string, repo?: string) => Promise<string | void>
}

type IssueListPayload = Extract<Card, { kind: "issue-list" }>["payload"]
type IssueListRow = IssueListPayload["issues"][number]
type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
type IssueCommentRow = IssuePayload["comments"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const asInt = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) ? value : null

const asIssueState = (value: unknown): "open" | "closed" => value === "closed" ? "closed" : "open"

/** The author login off Plue's `author: { login }` shape, or null. */
const authorLogin = (value: unknown): string | null =>
  isRecord(value) && typeof value.login === "string" && value.login !== "" ? value.login : null

/** One list row; null when the entry carries no usable issue number. */
const parseListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value)) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comment_count)
  return {
    number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/*
 * One list row off GitHub's issue shape — the source-only fallback read
 * (`/api/user/github-repos/{o}/{r}/issues`; multi src/smithersCloud/
 * githubIssues.ts parseIssue). GitHub's issues endpoint includes pull
 * requests; presence of `pull_request`, not its shape, is the documented
 * discriminator, so those rows drop. Author sits under `user.login` and the
 * comment count under `comments` — different spellings, same card row.
 */
const parseGithubListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value) || "pull_request" in value) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comments)
  return {
    number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.user),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/** Label NAMES only — the card states labels as words, not colors. */
const parseLabels = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : [])
    : []

/** One comment off Plue's IssueCommentResponse shape; null when not a record. */
const parseComment = (value: unknown): IssueCommentRow | null => {
  if (!isRecord(value)) return null
  return {
    author: typeof value.commenter === "string" && value.commenter !== "" ? value.commenter : null,
    commentBody: typeof value.body === "string" ? value.body : "",
    createdAt: typeof value.created_at === "string" ? value.created_at : null
  }
}

/** The detail payload; null only when the body is not a record at all. */
const parseDetail = (
  value: unknown,
  repo: string,
  number: number,
  comments: ReadonlyArray<IssueCommentRow>
): IssuePayload | null => {
  if (!isRecord(value)) return null
  return {
    repo,
    number: asInt(value.number) ?? number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    issueBody: typeof value.body === "string" ? value.body : "",
    labels: parseLabels(value.labels),
    comments: [...comments]
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createIssuesSeam = (ctx: SeamContext): IssuesSeam => {
  const issuesPath = (repo: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`
  }

  /*
   * IMPORT-READINESS (multi src/smithersCloud/importReadiness.ts): the
   * `/api/repos/{o}/{r}/**` namespace only exists for repositories IMPORTED
   * into Smithers Cloud — for a source-only repo every request there answers
   * 404. The same repo's GitHub-source metadata still lists issues through
   * `GET /api/user/github-repos/{o}/{r}/issues` (GET-only through the
   * Worker), so reads degrade to the source list; mutations never fall back.
   */
  const githubSourceIssuesPath = (repo: string, filter: "open" | "closed" | "all"): string => {
    const [owner = "", name = ""] = repo.split("/")
    // GitHub accepts state=all (only Plue's imported namespace rejects it).
    return `${ctx.baseUrl}/api/user/github-repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(name)
    }/issues?state=${filter}`
  }

  const notImported = (repo: string): string => `${repo} isn't imported yet — run /repos.import ${repo} first`

  const upsert = (card: Card): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const unreachable = (what: string, error: unknown): string =>
    `Could not reach the backend to ${what}: ${errorText(error)}`

  /** The source-only list read; the card carries the degradation note in `body`. */
  const listFromGithubSource = async (
    repo: string,
    filter: "open" | "closed" | "all"
  ): Promise<string | void> => {
    let response: Response
    try {
      response = await ctx.http(githubSourceIssuesPath(repo, filter))
    } catch (error) {
      return unreachable(`list issues for ${repo} from its GitHub source`, error)
    }
    // A source 404 too: the repo is nowhere — the plain honest error, no card.
    if (!response.ok) {
      return readErrorMessage(response, `Listing issues for ${repo} failed (${response.status})`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) {
      return `The backend answered issues for ${repo} with an unreadable payload`
    }
    const issues = body.flatMap((entry) => {
      const parsed = parseGithubListRow(entry)
      return parsed === null ? [] : [parsed]
    })
    upsert({
      id: `issues-${repo}`,
      kind: "issue-list",
      title: `Issues · ${repo}`,
      body: `Read from GitHub — import for full features: /repos.import ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: { repo, filter, issues }
    })
  }

  /** Fetches the issue AND its comments, then upserts the detail card. */
  const showIssue = async (repo: string, number: number): Promise<string | void> => {
    let issueResponse: Response
    try {
      issueResponse = await ctx.http(`${issuesPath(repo)}/${number}`)
    } catch (error) {
      return unreachable(`load issue #${number} in ${repo}`, error)
    }
    if (!issueResponse.ok) {
      // No per-issue GitHub-source read exists (multi's github-repos
      // namespace serves issue LISTS only — githubIssues.ts,
      // githubRepoMetadata.ts), so the detail cannot degrade; state that.
      if (issueResponse.status === 404) {
        return (
          `Issue #${number} in ${repo} answered 404. If ${repo} isn't imported, ` +
          `only the issue list can read from GitHub — issue detail needs the ` +
          `import: run /repos.import ${repo}`
        )
      }
      return readErrorMessage(
        issueResponse,
        `Loading issue #${number} in ${repo} failed (${issueResponse.status})`
      )
    }
    const issueJson: unknown = await issueResponse.json().catch(() => null)

    let commentsResponse: Response
    try {
      commentsResponse = await ctx.http(`${issuesPath(repo)}/${number}/comments`)
    } catch (error) {
      return unreachable(`load comments for issue #${number} in ${repo}`, error)
    }
    if (!commentsResponse.ok) {
      return readErrorMessage(
        commentsResponse,
        `Loading comments for issue #${number} in ${repo} failed (${commentsResponse.status})`
      )
    }
    const commentsJson: unknown = await commentsResponse.json().catch(() => null)
    const comments = Array.isArray(commentsJson)
      ? commentsJson.flatMap((entry) => {
        const parsed = parseComment(entry)
        return parsed === null ? [] : [parsed]
      })
      : []

    const payload = parseDetail(issueJson, repo, number, comments)
    if (payload === null) {
      return `The backend answered issue #${number} in ${repo} with an unreadable payload`
    }
    upsert({
      id: `issue-${repo}-${number}`,
      kind: "issue",
      title: `Issue #${number} · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    })
  }

  /** Re-fetch after a successful mutation; a refresh failure still states the mutation happened. */
  const refreshDetail = async (
    done: string,
    repo: string,
    number: number
  ): Promise<string | void> => {
    const outcome = await showIssue(repo, number)
    if (typeof outcome === "string") return `${done}, but refreshing the card failed: ${outcome}`
  }

  return {
    listIssues: async (filter, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      // Plue 422s unknown states ("all" included) — omit the param to list every state.
      const query = filter === "all" ? "" : `?state=${filter}`
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}${query}`)
      } catch (error) {
        return unreachable(`list issues for ${repo}`, error)
      }
      if (!response.ok) {
        // The imported namespace 404s ⇔ the repo isn't imported: degrade to
        // the GitHub-source list instead of surfacing a broken 404.
        if (response.status === 404) return listFromGithubSource(repo, filter)
        return readErrorMessage(response, `Listing issues for ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      if (!Array.isArray(body)) {
        return `The backend answered issues for ${repo} with an unreadable payload`
      }
      const issues = body.flatMap((entry) => {
        const parsed = parseListRow(entry)
        return parsed === null ? [] : [parsed]
      })
      upsert({
        id: `issues-${repo}`,
        kind: "issue-list",
        title: `Issues · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, filter, issues }
      })
    },

    viewIssue: async (number, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      return showIssue(target.repo, number)
    },

    createIssue: async (title, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      let response: Response
      try {
        response = await ctx.http(issuesPath(repo), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title })
        })
      } catch (error) {
        return unreachable(`create an issue in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(response, `Creating the issue in ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      const created = isRecord(body) ? asInt(body.number) : null
      if (created === null) {
        return `The issue was created in ${repo}, but the backend answered with an unreadable payload`
      }
      return refreshDetail(`Issue #${created} was created in ${repo}`, repo, created)
    },

    setIssueState: async (number, state, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const verb = state === "closed" ? "close" : "reopen"
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state })
        })
      } catch (error) {
        return unreachable(`${verb} issue #${number} in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(
          response,
          `Could not ${verb} issue #${number} in ${repo} (${response.status})`
        )
      }
      // The re-fetch below states the new truth; the PATCH echo is not read.
      await response.body?.cancel()
      return refreshDetail(`Issue #${number} in ${repo} is now ${state}`, repo, number)
    },

    commentOnIssue: async (number, text, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text })
        })
      } catch (error) {
        return unreachable(`comment on issue #${number} in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(
          response,
          `Commenting on issue #${number} in ${repo} failed (${response.status})`
        )
      }
      // The re-fetch below re-lists the comments; the POST echo is not read.
      await response.body?.cancel()
      return refreshDetail(`The comment was posted to issue #${number} in ${repo}`, repo, number)
    }
  }
}
