import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentTurnFrame } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "smithers-shared/LocalSession"
import { createPtyManager } from "./Pty"
import { defaultDistDir, startLocalServer } from "./server"
import type { LocalServer } from "./server"

let dist = ""
let server: LocalServer
const logs: Array<string> = []

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
  return fetch(`${server.origin}${path}`, { ...init, headers })
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
  await writeFile(join(dist, "assets", "app.js"), "console.log('hi')")
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: "/fake/node", version: "v22.19.0" },
    home: "/fake/home",
    harnesses: async () => [
      {
        id: "claude",
        displayName: "Claude Code",
        binary: "/opt/homebrew/bin/claude",
        version: "2.1.0",
        status: "signed-in",
        account: { email: "will@codeplane.app" },
        launch: { argv: ["claude"] }
      }
    ],
    pty: (deps) =>
      createPtyManager({
        ...deps,
        // A plain shell with the sandbox off: the seatbelt profile is Sandbox.test.ts's subject.
        shell: "/bin/sh",
        home: tmpdir(),
        sandboxHost: { platform: "linux", disabled: true, log: () => {} },
        killGraceMs: 300,
        log: () => {}
      }),
    log: (line) => logs.push(line),
    allowManualRepositoryPaths: true
  })
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
})

const readFrames = async (response: Response): Promise<Array<AgentTurnFrame>> => {
  const text = await response.text()
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const parsed: unknown = JSON.parse(line)
    if (!isAgentTurnFrame(parsed)) throw new Error(`not a frame: ${line}`)
    return parsed
  })
}

describe("the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN when listening and binds 127.0.0.1", () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`)
    expect(logs).toContain(`SMITHERS_LOCAL_ORIGIN=${server.origin}`)
  })

  test("GET /api/health reports node and sandbox", async () => {
    const response = await fetch(`${server.origin}/api/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.pid).toBe(process.pid)
    expect(body.node).toEqual({ path: "/fake/node", version: "v22.19.0" })
    expect(body.home).toBe("/fake/home")
    expect(body.sandbox).toEqual({
      platform: process.platform,
      enforced: process.platform === "darwin" && Bun.env.SMITHERS_SANDBOX !== "off"
    })
  })

  test("serves the SPA with an index.html fallback and hashed assets", async () => {
    const root = await fetch(`${server.origin}/`)
    expect(root.status).toBe(200)
    const html = await root.text()
    expect(html).toContain("<div id=\"root\">")
    expect(html).toContain(`<meta name="${LOCAL_SESSION_META}" content="${server.sessionToken}">`)
    const deep = await fetch(`${server.origin}/some/client/route`)
    expect(deep.status).toBe(200)
    expect(deep.headers.get("content-type")).toContain("text/html")
    const asset = await fetch(`${server.origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toBe("console.log('hi')")
  })

  test("refuses path traversal out of dist", async () => {
    const response = await fetch(`${server.origin}/assets/..%2F..%2F..%2Fetc%2Fpasswd`)
    // Either the fallback document or nothing: never a file outside dist.
    expect(await response.text()).not.toContain("root:")
  })

  test("unknown /api paths answer a JSON 404, method mismatches a 405", async () => {
    const missing = await apiFetch("/api/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/nope." } })
    const wrongMethod = await apiFetch("/api/health", { method: "POST" })
    expect(wrongMethod.status).toBe(405)
  })

  test("privileged HTTP rejects missing capabilities, foreign origins, bad hosts, and non-JSON writes", async () => {
    expect((await fetch(`${server.origin}/api/repos`)).status).toBe(401)
    expect((await apiFetch("/api/repos", { headers: { origin: "https://evil.test" } })).status).toBe(403)
    expect((await fetch(`${server.origin}/`, { headers: { host: "evil.test" } })).status).toBe(421)
    const plain = await apiFetch("/api/repo/open", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ path: "/tmp" })
    })
    expect(plain.status).toBe(415)
  })

  test("GET /api/harnesses answers the detector's table", async () => {
    const body = (await (await apiFetch("/api/harnesses")).json()) as { harnesses: Array<{ id: string; status: string }> }
    expect(body.harnesses).toHaveLength(1)
    expect(body.harnesses[0]).toMatchObject({ id: "claude", status: "signed-in", account: { email: "will@codeplane.app" } })
  })

  test("both lanes' real routes replaced every placeholder: repos answers its empty state", async () => {
    expect(await (await apiFetch("/api/repos")).json()).toEqual({ repos: [] })
  })

  test("a lane replaces a placeholder by registering the same route", async () => {
    server.router.add("GET", "/api/repos", () => Response.json({ repos: [{ id: "force" }] }))
    expect(await (await apiFetch("/api/repos")).json()).toEqual({ repos: [{ id: "force" }] })
    server.router.add("GET", "/api/repos", () => Response.json({ repos: [] }))
  })

  test("the PTY routes open, list, resize, echo over /ws, and delete a session", async () => {
    const bad = await apiFetch("/api/pty", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "terminal" }) })
    expect(bad.status).toBe(400)
    const missingHarness = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24 })
    })
    expect(missingHarness.status).toBe(400)

    const created = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 })
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    expect(sessionId).toMatch(/^pty-/)
    const listed = (await (await apiFetch("/api/pty")).json()) as { sessions: Array<Record<string, unknown>> }
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([sessionId])
    expect(listed.sessions[0]).toMatchObject({ kind: "terminal", alive: true, cwd: tmpdir() })

    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("ws failed"))
    })
    const output: Array<string> = []
    let exit: unknown
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; data?: string }
      if (frame.type === "pty.output") output.push(frame.data ?? "")
      if (frame.type === "pty.exit") exit = frame
    }
    socket.send(JSON.stringify({ type: "subscribe", topic: `pty:${sessionId}` }))
    socket.send(JSON.stringify({ type: "pty.input", sessionId, data: "echo hi-from-pty\n" }))
    const deadline = Date.now() + 5000
    while (!/hi-from-pty\r?\n/.test(output.join("").replace(/echo hi-from-pty/g, ""))) {
      if (Date.now() > deadline) throw new Error(`no echo: ${JSON.stringify(output)}`)
      await Bun.sleep(25)
    }

    const resized = await apiFetch(`/api/pty/${sessionId}/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 120, rows: 40 })
    })
    expect(await resized.json()).toEqual({ ok: true })
    expect((await apiFetch("/api/pty/nope/resize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 1, rows: 1 })
    })).status).toBe(404)

    const deleted = await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })
    expect(await deleted.json()).toEqual({ ok: true })
    const exitDeadline = Date.now() + 5000
    while (exit === undefined) {
      if (Date.now() > exitDeadline) throw new Error("no exit frame")
      await Bun.sleep(25)
    }
    expect(exit).toMatchObject({ type: "pty.exit", sessionId })
    expect(((await (await apiFetch("/api/pty")).json()) as { sessions: Array<unknown> }).sessions).toEqual([])
    expect((await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })).status).toBe(404)
    socket.close()
  })

  test("the stub identity seam answers signed-out and nothing else", async () => {
    const session = await apiFetch("/api/auth/session")
    expect(await session.json()).toEqual({ status: "signed-out" })
    expect((await apiFetch("/api/auth/native/start", { method: "POST" })).status).toBe(501)
  })
})

describe("POST /api/chat/turn", () => {
  test("streams the stub's frames as NDJSON and ends on done", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        messages: [{ role: "user", content: "say ok" }],
        instructions: "Be brief."
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(await readFrames(response)).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "stub: thinking" },
      { runId: "run-1", type: "delta", kind: "text", text: "stub: say ok" },
      { runId: "run-1", type: "done", reason: "stop" }
    ])
  })

  test("a malformed body answers 400 with the error envelope", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "", messages: "no" })
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_request")
  })

  test("cancel answers ok and closes a live stream", async () => {
    const response = await apiFetch("/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3", messages: [{ role: "user", content: "x" }], instructions: "" })
    })
    const cancel = await apiFetch("/api/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(cancel.status).toBe(200)
    expect(((await cancel.json()) as { ok: boolean }).ok).toBe(true)
    // The stream ends (possibly with no done frame) instead of hanging.
    const frames = await readFrames(response)
    expect(frames.every((frame) => frame.runId === "run-3")).toBe(true)
    const late = await apiFetch("/api/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(await late.json()).toEqual({ ok: true, status: "not-found" })
  })
})

describe("/ws", () => {
  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
      socket.onopen = () => resolve(socket)
      socket.onerror = () => reject(new Error("ws failed"))
    })

  const nextMessage = (socket: WebSocket): Promise<unknown> =>
    new Promise((resolve) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
    })

  test("subscribe receives published frames; unsubscribe stops them", async () => {
    const socket = await connect()
    const ack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "subscribe", topic: "pty:abc" }))
    expect(await ack).toEqual({ type: "subscribed", topic: "pty:abc" })
    const frame = nextMessage(socket)
    server.publish("pty:abc", { type: "pty.output", sessionId: "abc", data: "hi" })
    expect(await frame).toEqual({ type: "pty.output", sessionId: "abc", data: "hi" })
    const unack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "unsubscribe", topic: "pty:abc" }))
    expect(await unack).toEqual({ type: "unsubscribed", topic: "pty:abc" })
    socket.close()
  })

  test("a registered message handler receives client frames by type", async () => {
    const received: Array<unknown> = []
    const off = server.onMessage("probe.ping", (message, socket) => {
      received.push(message)
      socket.send(JSON.stringify({ type: "echo", data: message.data }))
    })
    const socket = await connect()
    const reply = nextMessage(socket)
    socket.send(JSON.stringify({ type: "probe.ping", data: "ls\n" }))
    expect(await reply).toEqual({ type: "echo", data: "ls\n" })
    expect(received).toEqual([{ type: "probe.ping", data: "ls\n" }])
    off()
    const error = nextMessage(socket)
    socket.send(JSON.stringify({ type: "probe.ping", data: "x" }))
    expect(await error).toEqual({ type: "error", message: "No handler for probe.ping." })
    socket.close()
  })

  test("pty.input for an unknown session answers an error frame", async () => {
    const socket = await connect()
    const error = nextMessage(socket)
    socket.send(JSON.stringify({ type: "pty.input", sessionId: "nope", data: "x" }))
    expect(await error).toEqual({ type: "error", message: "No live PTY session nope." })
    socket.close()
  })
})

describe("defaultDistDir", () => {
  test("SMITHERS_DIST_DIR wins, then the bundled views, then apps/ui/dist", async () => {
    expect(defaultDistDir("/x/bun", { SMITHERS_DIST_DIR: "/explicit" })).toBe("/explicit")
    const app = await mkdtemp(join(tmpdir(), "smithers-app-"))
    await mkdir(join(app, "views", "mainview"), { recursive: true })
    await writeFile(join(app, "views", "mainview", "index.html"), "<html>")
    expect(defaultDistDir(join(app, "bun"), {})).toBe(join(app, "views", "mainview"))
    expect(defaultDistDir("/nowhere/src/bun", {})).toBe("/nowhere/dist")
    await rm(app, { recursive: true, force: true })
  })
})
