/*
 * Lane L3 routes (LOCAL-APP.md "HTTP and WebSocket API"): repositories and
 * targets. Registered on the shared router from server.ts with one call.
 */
import type { NodeSidecar } from "../Node"
import { createRepoStore } from "../Repos"
import type { RepoStore } from "../Repos"
import { json, jsonError, readJson } from "../routes"
import type { LocalServer } from "../server"
import { createTargetRunner, queryTargets } from "../Targets"
import type { TargetRunner } from "../Targets"
import { queryTargetGraph } from "../TargetGraph"
import { createTargetRunHistory } from "../TargetRunHistory"
import type { TargetRunHistory } from "../TargetRunHistory"

export interface RepoTargetRoutesOptions {
  readonly node: Promise<NodeSidecar | null>
  readonly cli?: string
  readonly log?: (line: string) => void
}

export interface RepoTargetRoutes {
  readonly repos: RepoStore
  readonly runner: TargetRunner
  readonly history: TargetRunHistory
  readonly stop: () => void
}

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
  const { router } = server

  router.add("POST", "/api/repo/open", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const path = stringField(parsed.body, "path")
    if (path === undefined) return jsonError(400, "invalid_request", "Body must be { path }.")
    const result = await repos.open(path)
    if (result.status === "error") return jsonError(400, result.code, result.message)
    return json({ repo: result.repo })
  })

  router.add("GET", "/api/repos", () => json({ repos: repos.list() }))

  router.add("POST", "/api/repo/close", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    if (!repos.close(repoId)) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
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
      node: await options.node,
      ...(options.cli === undefined ? {} : { cli: options.cli })
    })
    return json(result)
  })

  router.add("POST", "/api/targets/run", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    const label = stringField(parsed.body, "label")
    if (repoId === undefined || label === undefined) {
      return jsonError(400, "invalid_request", "Body must be { repoId, label }.")
    }
    const repo = repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const node = await options.node
    if (node === null) return jsonError(503, "node_missing", "No Node.js >= 22.19 was found for the smthrs CLI.")
    let edges: Awaited<ReturnType<typeof queryTargetGraph>>["edges"] = []
    try {
      edges = (await queryTargetGraph({ repoId, repo: repo.path, node, ...(options.cli === undefined ? {} : { cli: options.cli }) })).edges
    } catch (error) {
      options.log?.(`target-run graph unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const run = runner.start({ repoId, repo: repo.path, label, node, edges })
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
    stop: () => {
      unregister()
      runner.stop()
    }
  }
}
