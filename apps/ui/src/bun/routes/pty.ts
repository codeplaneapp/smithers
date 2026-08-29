/*
 * The PTY routes and the `pty.input` frame (LOCAL-APP.md, "HTTP and
 * WebSocket API"): POST /api/pty opens a session, GET lists them, resize and
 * DELETE address one by id, and typed text arrives over `/ws` as
 * `{ type: "pty.input", sessionId, data }`. Output leaves through the
 * manager's publish on `pty:<sessionId>`.
 */
import { HARNESS_IDS } from "smithers-shared/LocalApp"
import { z } from "zod"
import type { PtyManager } from "../Pty"
import { json, jsonError, readJson, Router } from "../routes"
import type { WsMessageHandler } from "../server"

export const PTY_PATH = "/api/pty"

const geometry = z.number().int().min(1).max(1000)

export const PtyCreateRequestSchema = z.object({
  kind: z.enum(["terminal", "harness"]),
  cwd: z.string(),
  cols: geometry,
  rows: geometry,
  harnessId: z.enum(HARNESS_IDS).optional()
})

export const PtyResizeRequestSchema = z.object({ cols: geometry, rows: geometry })

export interface PtyRouteHost {
  readonly router: Router
  readonly onMessage: (type: string, handler: WsMessageHandler) => () => void
}

export const registerPtyRoutes = (host: PtyRouteHost, manager: PtyManager): void => {
  const { router } = host

  router.add("GET", PTY_PATH, () => json({ sessions: manager.list() }))

  router.add("POST", PTY_PATH, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = PtyCreateRequestSchema.safeParse(parsed.body)
    if (!body.success) {
      return jsonError(400, "invalid_request", "Body must be { kind, cwd, cols, rows } with an optional harnessId.")
    }
    if (body.data.kind === "harness" && body.data.harnessId === undefined) {
      return jsonError(400, "invalid_request", "A harness session needs a harnessId.")
    }
    const result = await manager.create(body.data)
    if (result.status === "error") {
      const status = result.code === "spawn_failed" ? 500 : result.code === "unknown_harness" ? 404 : 400
      return jsonError(status, result.code, result.message)
    }
    return json({ sessionId: result.session.sessionId }, 201)
  })

  router.add("POST", `${PTY_PATH}/:id/resize`, async ({ request, params }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = PtyResizeRequestSchema.safeParse(parsed.body)
    if (!body.success) return jsonError(400, "invalid_request", "Body must be { cols, rows }.")
    const id = params.id ?? ""
    if (manager.get(id) === undefined) return jsonError(404, "not_found", `No PTY session ${id}.`)
    return json({ ok: manager.resize(id, body.data.cols, body.data.rows) })
  })

  router.add("DELETE", `${PTY_PATH}/:id`, async ({ params }) => {
    const id = params.id ?? ""
    const killed = await manager.kill(id)
    return killed ? json({ ok: true }) : jsonError(404, "not_found", `No PTY session ${id}.`)
  })

  host.onMessage("pty.input", (message, socket) => {
    const { sessionId, data } = message
    if (typeof sessionId !== "string" || typeof data !== "string") {
      socket.send(JSON.stringify({ type: "error", message: "pty.input needs a sessionId and data." }))
      return
    }
    if (!manager.write(sessionId, data)) {
      socket.send(JSON.stringify({ type: "error", message: `No live PTY session ${sessionId}.` }))
    }
  })
}
