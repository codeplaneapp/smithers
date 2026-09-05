/*
 * The repositories seam (lane piper step 2, ADR 0001 "Settled with the
 * backend"): the Smithers Cloud inventory behind the `/api/cloud/*` proxy.
 *
 *   GET /api/user/repos                  — owner (bare login), name, full_name,
 *                                          default_bookmark, NO head
 *   GET /api/user/orgs                   — once, to classify owners
 *   GET /api/repos/{owner}/{repo}/bookmarks — per repo, the default bookmark's
 *                                          { target_change_id, target_commit_id }
 *   GET /api/user/workspaces             — the cloud working copies (a 403
 *                                          degraded token answers empty, honestly)
 *
 * plue#445 adds `owner_type` and `default_bookmark_head { change_id,
 * commit_id }` to the repo row; the row is read so those fields REPLACE the
 * per-repo bookmarks call the moment they land. Nothing is invented: a repo
 * whose head could not be read carries `head: null`, and a failed bookmarks
 * call is an absent answer, not a fact.
 */
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface RepositoriesSeam {
  /** Refresh the repositories collection and the cloud working copies. */
  readonly loadRepositories: () => Promise<string | void>
}

interface RepoWire {
  readonly id: string
  readonly org: string
  readonly name: string
  readonly ownerType: "user" | "org" | undefined
  readonly defaultBookmark: string | null
  readonly wireHead: { readonly changeId: string | null; readonly commitId: string | null } | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The list a user-scoped route answers: a bare array, or one under a named key. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  return []
}

const ownerLogin = (value: unknown): string | null => {
  if (typeof value === "string" && value !== "") return value
  if (isRecord(value) && typeof value.login === "string" && value.login !== "") return value.login
  return null
}

/** One repo row off the wire; malformed rows drop. */
const parseRepo = (value: unknown): RepoWire | null => {
  if (!isRecord(value)) return null
  const fullName = typeof value.full_name === "string" ? value.full_name : null
  const org = ownerLogin(value.owner) ?? fullName?.split("/")[0] ?? null
  const name = typeof value.name === "string" && value.name !== "" ? value.name : fullName?.split("/")[1] ?? null
  if (org === null || name === null) return null
  const ownerType = value.owner_type === "Organization" || value.owner_type === "org"
    ? "org" as const
    : value.owner_type === "User" || value.owner_type === "user"
    ? "user" as const
    : undefined
  const wireHead = isRecord(value.default_bookmark_head)
    ? {
      changeId: typeof value.default_bookmark_head.change_id === "string" ? value.default_bookmark_head.change_id : null,
      commitId: typeof value.default_bookmark_head.commit_id === "string" ? value.default_bookmark_head.commit_id : null
    }
    : undefined
  return {
    id: fullName ?? `${org}/${name}`,
    org,
    name,
    ownerType,
    defaultBookmark: typeof value.default_bookmark === "string" && value.default_bookmark !== "" ? value.default_bookmark : null,
    wireHead
  }
}

/** One bookmark row off the wire; malformed rows drop. */
const parseBookmark = (value: unknown): { readonly name: string; readonly changeId: string | null; readonly commitId: string | null } | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null
  return {
    name: value.name,
    changeId: typeof value.target_change_id === "string" ? value.target_change_id : null,
    commitId: typeof value.target_commit_id === "string" ? value.target_commit_id : null
  }
}

/** One workspace row off the wire (ADR 0002's DTO); malformed rows drop. */
const parseWorkspace = (value: unknown): { readonly id: string; readonly repoId: string; readonly label: string; readonly state: string | null } | null => {
  if (!isRecord(value)) return null
  const id = typeof value.id === "string" && value.id !== "" ? value.id : null
  const repoId = typeof value.repo_full_name === "string" && value.repo_full_name !== "" ? value.repo_full_name : null
  const label = typeof value.name === "string" && value.name !== "" ? value.name : typeof value.slug === "string" ? value.slug : null
  if (id === null || repoId === null || label === null) return null
  return { id, repoId, label, state: typeof value.status === "string" ? value.status : null }
}

export const createRepositoriesSeam = (ctx: SeamContext): RepositoriesSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`

  const getJson = async (path: string): Promise<{ readonly response: Response; readonly body: unknown } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(path))
    } catch (error) {
      return { error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!response.ok) return { error: await readErrorMessage(response, `Reading ${path} failed (${response.status})`) }
    return { response, body: await response.json().catch(() => null) }
  }

  /** The default bookmark's head for one repo: the wire field when plue#445 lands it, else the per-repo call. */
  const headOf = async (repo: RepoWire): Promise<{ readonly bookmark: string; readonly changeId: string | null; readonly commitId: string | null } | null> => {
    if (repo.defaultBookmark === null) return null
    if (repo.wireHead !== undefined) {
      return { bookmark: repo.defaultBookmark, changeId: repo.wireHead.changeId, commitId: repo.wireHead.commitId }
    }
    const answer = await getJson(`/repos/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.name)}/bookmarks`)
    if ("error" in answer) return null
    const bookmark = arrayOf(answer.body, "bookmarks")
      .flatMap((entry) => {
        const parsed = parseBookmark(entry)
        return parsed === null ? [] : [parsed]
      })
      .find((entry) => entry.name === repo.defaultBookmark)
    return bookmark === undefined
      ? { bookmark: repo.defaultBookmark, changeId: null, commitId: null }
      : { bookmark: bookmark.name, changeId: bookmark.changeId, commitId: bookmark.commitId }
  }

  return {
    loadRepositories: async () => {
      const [reposAnswer, orgsAnswer] = await Promise.all([getJson("/user/repos"), getJson("/user/orgs")])
      if ("error" in reposAnswer) return reposAnswer.error
      const repos = arrayOf(reposAnswer.body, "repos").flatMap((entry) => {
        const parsed = parseRepo(entry)
        return parsed === null ? [] : [parsed]
      })
      const orgLogins = new Set(
        "error" in orgsAnswer
          ? []
          : arrayOf(orgsAnswer.body, "orgs").flatMap((entry) => {
            const login = isRecord(entry) ? ownerLogin(entry) : ownerLogin(entry)
            return login === null ? [] : [login]
          })
      )
      const heads = await Promise.all(repos.map((repo) => headOf(repo)))
      ctx.dispatch({
        type: "repositories.loaded",
        actor: "system",
        repositories: repos.map((repo, index) => ({
          id: repo.id,
          org: repo.org,
          ownerKind: repo.ownerType ?? (orgLogins.has(repo.org) ? "org" : "user"),
          name: repo.name,
          head: heads[index] ?? null
        }))
      })

      /*
       * The cloud working copies. A degraded token (the legacy scope set,
       * ADR 0001) answers 403 here — that IS the probe the Bun side ran —
       * and the honest answer is no workspace rows. Other failures leave the
       * rows alone: a transient error is not a fact about the inventory.
       */
      let workspacesResponse: Response
      try {
        workspacesResponse = await ctx.http(cloud("/user/workspaces"))
      } catch {
        return
      }
      if (workspacesResponse.ok || workspacesResponse.status === 403) {
        const body: unknown = workspacesResponse.ok ? await workspacesResponse.json().catch(() => null) : null
        ctx.dispatch({
          type: "workingcopies.workspaces.loaded",
          actor: "system",
          copies: arrayOf(body, "workspaces").flatMap((entry) => {
            const parsed = parseWorkspace(entry)
            return parsed === null
              ? []
              : [{
                id: `workspace:${parsed.id}`,
                repoId: parsed.repoId,
                kind: "workspace" as const,
                label: parsed.label,
                workspaceId: parsed.id,
                ...(parsed.state === null ? {} : { state: parsed.state })
              }]
          })
        })
      }
    }
  }
}
