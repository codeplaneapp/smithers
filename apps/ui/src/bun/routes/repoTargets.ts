/*
 * Lane L3 routes (LOCAL-APP.md "HTTP and WebSocket API"): repositories and
 * targets. Registered on the shared router from server.ts with one call.
 */
import type { NodeSidecar } from "../Node"
import type { Target } from "smithers-shared/LocalApp"
import type { RepositoryAccess } from "smithers-shared/NativeRepository"
import { z } from "zod"
import { createRepoStore } from "../Repos"
import type { RepoStore } from "../Repos"
import type { RepositoryAuthority } from "../RepositoryAuthority"
import { json, jsonError, readJson } from "../routes"
import type { LocalServer } from "../server"
import { createTargetRunner, queryTargets, TargetRunCapacityError, workspaceCwd } from "../Targets"
import type { TargetRunner } from "../Targets"
import { queryTargetGraph } from "../TargetGraph"
import { createTargetRunHistory } from "../TargetRunHistory"
import type { TargetRunHistory } from "../TargetRunHistory"

export interface RepoTargetRoutesOptions {
  readonly node: Promise<NodeSidecar | null>
  readonly authority: RepositoryAuthority
  /** Explicitly enabled only by the headless/dev host. Native mode is grant-only. */
  readonly allowManualRepositoryPaths?: boolean
  readonly cli?: string
  readonly log?: (line: string) => void
}

export interface RepoTargetRoutes {
  readonly repos: RepoStore
  readonly runner: TargetRunner
  readonly history: TargetRunHistory
  readonly resolveRepo: (
    repoId: string,
    requiredAccess: RepositoryAccess
  ) => { readonly status: "ok"; readonly path: string } | { readonly status: "not-found" | "permission-denied" }
  readonly stop: () => void
}

interface TargetGrant {
  readonly id: string
  readonly label: string
  readonly workspace: string
}

const RepoOpenRequestSchema = z.union([
  z.object({ authorizationId: z.string().min(1) }).strict(),
  z.object({ path: z.string().min(1) }).strict()
])

const stringField = (body: unknown, field: string): string | undefined => {
  if (typeof body !== "object" || body === null || !(field in body)) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

export const registerRepoTargetRoutes = (
  server: Pick<LocalServer, "router" | "publish" | "onMessage">,
  options: RepoTargetRoutesOptions
): RepoTargetRoutes => {
  const repos = createRepoStore()
  const history = createTargetRunHistory()
  const runner = createTargetRunner({
    publish: server.publish,
    onEvent: (run, event) => history.event(run, event),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.log === undefined ? {} : { log: options.log })
  })
  /*
   * A query mints a fresh opaque grant per target. Runs accept only one of
   * these ids and resolve the label server-side; the browser never supplies
   * an unchecked command label to the process boundary.
   */
  const targetGrants = new Map<string, Map<string, TargetGrant>>()
  const repoAccess = new Map<string, RepositoryAccess>()
  const { router } = server

  const resolveRepo: RepoTargetRoutes["resolveRepo"] = (repoId, requiredAccess) => {
    const repo = repos.get(repoId)
    if (repo === undefined) return { status: "not-found" }
    const access = repoAccess.get(repoId)
    if (access === undefined || (requiredAccess === "read-write" && access !== "read-write")) {
      return { status: "permission-denied" }
    }
    return { status: "ok", path: repo.path }
  }

  router.add("POST", "/api/repo/open", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = RepoOpenRequestSchema.safeParse(parsed.body)
    if (!body.success) {
      return jsonError(400, "invalid_request", "Body must contain exactly one repository authorization.")
    }
    let path: string
    let access: RepositoryAccess
    if ("authorizationId" in body.data) {
      const grant = options.authority.claim(body.data.authorizationId)
      if (grant === undefined) {
        return jsonError(403, "repository_authorization_invalid", "The repository authorization is invalid or expired. Choose the folder again.")
      }
      path = grant.path
      access = grant.access
    } else {
      if (options.allowManualRepositoryPaths !== true) {
        return jsonError(403, "manual_repository_paths_disabled", "Choose repositories through the native folder picker.")
      }
      path = body.data.path
      access = "read-write"
    }
    const result = await repos.open(path)
    if (result.status === "error") return jsonError(400, result.code, result.message)
    repoAccess.set(result.repo.id, access)
    return json({ repo: result.repo })
  })

  router.add("GET", "/api/repos", () => json({ repos: repos.list() }))

  router.add("POST", "/api/repo/close", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    if (!repos.close(repoId)) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    targetGrants.delete(repoId)
    repoAccess.delete(repoId)
    return json({ ok: true })
  })

  router.add("POST", "/api/targets/query", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    const repo = repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const result = await queryTargets({
      repo: repo.path,
      workspaces: repo.smithers.workspaces,
      node: await options.node,
      ...(options.cli === undefined ? {} : { cli: options.cli })
    })
    const grants = new Map<string, TargetGrant>()
    const targets: Array<Target> = result.targets.map((target) => {
      const id = crypto.randomUUID()
      grants.set(id, { id, label: target.label, workspace: target.workspace })
      return { ...target, id }
    })
    targetGrants.set(repoId, grants)
    return json({ ...result, targets })
  })

  router.add("POST", "/api/targets/run", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    const targetId = stringField(parsed.body, "targetId")
    if (repoId === undefined || targetId === undefined) {
      return jsonError(400, "invalid_request", "Body must be { repoId, targetId }.")
    }
    const repo = repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    if (resolveRepo(repoId, "read-write").status !== "ok") {
      return jsonError(403, "repository_read_only", "Running a target requires read-write repository access.")
    }
    const grant = targetGrants.get(repoId)?.get(targetId)
    if (grant === undefined) {
      return jsonError(404, "target_not_found", "That target is not in the current repository target snapshot.")
    }
    const workspace = grant.workspace
    if (!repo.smithers.workspaces.some((entry) => entry.path === workspace)) {
      targetGrants.get(repoId)?.delete(targetId)
      return jsonError(409, "target_stale", "That target workspace is no longer open.")
    }
    const node = await options.node
    if (node === null) return jsonError(503, "node_missing", "No Node.js >= 22.19 was found for the smthrs CLI.")
    let graph: Awaited<ReturnType<typeof queryTargetGraph>>
    try {
      graph = await queryTargetGraph({
        repoId,
        repo: workspaceCwd(repo.path, workspace),
        node,
        ...(options.cli === undefined ? {} : { cli: options.cli })
      })
    } catch (error) {
      options.log?.(`target-run graph unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return jsonError(503, "target_graph_unavailable", "The target graph could not be revalidated before execution.")
    }
    if (!graph.nodes.some((candidate) => candidate.label === grant.label)) {
      targetGrants.get(repoId)?.delete(targetId)
      return jsonError(409, "target_stale", "That target is no longer declared by the repository.")
    }
    let run
    try {
      run = runner.start({
        repoId,
        repo: repo.path,
        workspace,
        label: grant.label,
        node,
        edges: graph.edges
      })
    } catch (error) {
      if (error instanceof TargetRunCapacityError) {
        return jsonError(429, error.code, error.message)
      }
      throw error
    }
    await history.start(run)
    return json({ runId: run.runId })
  })

  router.add("POST", "/api/targets/cancel", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = stringField(parsed.body, "runId")
    if (runId === undefined) return jsonError(400, "invalid_request", "Body must be { runId }.")
    if (runner.get(runId) === undefined) return jsonError(404, "run_not_found", `No target run with id ${runId}.`)
    return json({ ok: runner.cancel(runId) })
  })

  // A subscriber announces itself so the child starts once someone listens
  // (frames published before the subscription would be lost).
  const unregister = server.onMessage("target-run.attach", (message, socket) => {
    const runId = typeof message.runId === "string" ? message.runId : ""
    if (!runner.attach(runId)) {
      socket.send(JSON.stringify({ type: "error", message: `No target run with id ${runId}.` }))
    }
  })

  return {
    repos,
    runner,
    history,
    resolveRepo,
    stop: () => {
      unregister()
      runner.stop()
      repoAccess.clear()
    }
  }
}
