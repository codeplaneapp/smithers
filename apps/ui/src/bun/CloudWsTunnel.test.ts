import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "smithers-shared/LocalSession"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

/*
 * The `/api/cloud-ws/` workspace-terminal tunnel (lane citc): the local
 * session capability rides the subprotocol (a browser upgrade carries no
 * custom header), only plue's terminal route shape proxies, and Bun bridges
 * frames both ways with the Bun-held bearer and plue's `terminal`
 * subprotocol attached upstream — never anything the renderer sent. A
 * refused upstream reaches the renderer as a distinct close code it never
 * redials on; signed out, the tunnel never dials; sign-out ends every bridge.
 */

let dist = ""

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-cloudws-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
})

afterAll(async () => {
  await rm(dist, { recursive: true, force: true })
})

const TERMINAL_PATH = "/api/cloud-ws/repos/will/smithers/workspace/sessions/sess-1/terminal"

interface UpstreamRecord {
  protocols: string | null
  authorization: string | null
  origin: string | null
  /** Every request the upstream saw: the upgrade attempts and the tunnel's status re-reads alike. */
  hits: Array<{ readonly upgrade: boolean; readonly authorization: string | null; readonly origin: string | null }>
  /** Sockets the upstream currently holds open. */
  live: number
}

const newRecord = (): UpstreamRecord => ({ protocols: null, authorization: null, origin: null, hits: [], live: 0 })

/**
 * A cloud-API double: requires plue's `terminal` subprotocol, records the
 * upgrade, echoes frames. With `refuse`, it answers that HTTP status to every
 * request — the upgrade and the plain GET alike, as plue's pre-upgrade checks do.
 */
const startUpstream = (record: UpstreamRecord, received: Array<string | Buffer>, options: { readonly refuse?: number } = {}) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      record.protocols = request.headers.get("sec-websocket-protocol")
      record.authorization = request.headers.get("authorization")
      record.origin = request.headers.get("origin")
      record.hits.push({
        upgrade: request.headers.get("upgrade") !== null,
        authorization: record.authorization,
        origin: record.origin
      })
      if (options.refuse !== undefined) {
        return new Response(JSON.stringify({ message: `refused ${options.refuse}` }), {
          status: options.refuse,
          headers: { "content-type": "application/json" }
        })
      }
      if ((record.protocols ?? "").includes("terminal")) {
        const upgraded = server.upgrade(request, { headers: { "sec-websocket-protocol": "terminal" } })
        if (upgraded) return undefined
      }
      return new Response("terminal subprotocol required", { status: 400 })
    },
    websocket: {
      open: (socket) => {
        record.live += 1
        socket.send(new TextEncoder().encode("upstream says hello\r\n"))
      },
      close: () => {
        record.live -= 1
      },
      message: (socket, frame) => {
        received.push(frame)
        socket.send(frame)
      }
    }
  })

const startLocal = async (
  upstream: ReturnType<typeof startUpstream> | null,
  options: { readonly token?: string | undefined } = {}
): Promise<LocalServer> =>
  startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    ...(upstream === null
      ? {}
      : {
        cloudMode: "hybrid" as const,
        cloudApi: `http://127.0.0.1:${upstream.port}`,
        cloudAuth: {
          token: () => ("token" in options ? options.token : "smithers_test_token"),
          session: () => ({ state: "signed-in" as const, username: "will", expiresAt: null }),
          start: async () => ({ error: "already signed in" }),
          signOut: async () => {},
          stop: async () => {}
        }
      }),
    node: { path: "/fake/node", version: "v22.19.0" },
    home: "/fake/home",
    harnesses: async () => [],
    log: () => {}
  })

const waitFor = async (predicate: () => boolean, attempts = 100): Promise<void> => {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const connect = (
  local: LocalServer,
  path: string,
  options: { readonly protocol?: string; readonly headers?: Record<string, string> } = {}
): {
  readonly socket: WebSocket
  readonly opened: Promise<boolean>
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>
  readonly frames: Array<string>
} => {
  const frames: Array<string> = []
  const url = `ws://127.0.0.1:${local.port}${path}`
  const socket = options.headers !== undefined
    ? new WebSocket(url, { headers: options.headers } as never)
    : options.protocol === undefined
    ? new WebSocket(url)
    : new WebSocket(url, [options.protocol])
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true)
    socket.onerror = () => resolve(false)
  })
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
  void closed.then(() => {
    // A refusal before the handshake never opens.
    socket.onopen = null
  })
  const openedOrClosed = Promise.race([opened, closed.then(() => false)])
  socket.onmessage = (event) => {
    if (typeof event.data === "string") frames.push(event.data)
    else if (event.data instanceof ArrayBuffer) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Uint8Array) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Blob) void event.data.arrayBuffer().then((buffer) => frames.push(new TextDecoder().decode(buffer)))
  }
  return { socket, opened: openedOrClosed, closed, frames }
}

describe("the workspace terminal tunnel", () => {
  test("bridges frames both ways with the bearer and plue's subprotocol attached upstream, and no Origin by default", async () => {
    const record = newRecord()
    const received: Array<string | Buffer> = []
    const upstream = startUpstream(record, received)
    const previousOrigin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    delete Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      // The upstream's greeting arrives; the bearer and plue's subprotocol were attached HERE.
      await waitFor(() => frames.length > 0)
      expect(frames[0]).toBe("upstream says hello\r\n")
      expect(record.protocols).toBe("terminal")
      expect(record.authorization).toBe("Bearer smithers_test_token")
      // plue#475: a Bearer principal's upgrade is not origin-checked, so a desktop app sends none.
      expect(record.origin).toBeNull()
      // Binary keystrokes echo through the bridge; a text frame carries the resize.
      socket.send(new TextEncoder().encode("ls\r"))
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      await waitFor(() => frames.length >= 3)
      expect(frames[1]).toBe("ls\r")
      expect(frames[2]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      expect(received.length).toBe(2)
      socket.close()
    } finally {
      if (previousOrigin !== undefined) Bun.env.SMITHERS_CLOUD_WS_ORIGIN = previousOrigin
      await local.stop()
      upstream.stop(true)
    }
  })

  test("SMITHERS_CLOUD_WS_ORIGIN is the only source of an upstream Origin", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const previousOrigin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    Bun.env.SMITHERS_CLOUD_WS_ORIGIN = "https://strict.example"
    const local = await startLocal(upstream)
    try {
      const { socket, opened } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      // The renderer's side opens before the tunnel dials plue; the upstream's record fills on that dial.
      await waitFor(() => record.hits.length > 0)
      expect(record.origin).toBe("https://strict.example")
      socket.close()
    } finally {
      if (previousOrigin === undefined) delete Bun.env.SMITHERS_CLOUD_WS_ORIGIN
      else Bun.env.SMITHERS_CLOUD_WS_ORIGIN = previousOrigin
      await local.stop()
      upstream.stop(true)
    }
  })

  test("refuses a path that is not a workspace terminal", async () => {
    const upstream = startUpstream(newRecord(), [])
    const local = await startLocal(upstream)
    try {
      const refused = await fetch(`${local.origin}/api/cloud-ws/repos/will/smithers/workspace/sessions`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(404)
      // Not even a socket attempt: the refusal is an HTTP answer.
      const { opened } = connect(local, "/api/cloud-ws/api/user/repos", { protocol: local.websocketProtocol })
      expect(await opened).toBe(false)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("refuses a socket without the local-session subprotocol, and a foreign origin", async () => {
    const upstream = startUpstream(newRecord(), [])
    const local = await startLocal(upstream)
    try {
      const noProtocol = connect(local, TERMINAL_PATH)
      expect(await noProtocol.opened).toBe(false)
      const foreign = connect(local, TERMINAL_PATH, {
        headers: { origin: "http://evil.example", "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(await foreign.opened).toBe(false)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("answers 501 when the cloud seam is disabled", async () => {
    const local = await startLocal(null)
    try {
      const refused = await fetch(`${local.origin}${TERMINAL_PATH}`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(501)
    } finally {
      await local.stop()
    }
  })

  /*
   * Critique finding 4: signed out, the tunnel used to upgrade and dial plue
   * with no bearer. Now the refusal is a local 401 and plue is never dialed.
   */
  test("signed out, the tunnel answers 401 and never dials plue", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream, { token: undefined })
    try {
      const refused = await fetch(`${local.origin}${TERMINAL_PATH}`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(401)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("cloud_sign_in_required")
      const { opened } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(record.hits).toEqual([])
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("sign-out closes every live bridge, upstream included", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream)
    try {
      const first = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      const second = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await first.opened).toBe(true)
      expect(await second.opened).toBe(true)
      await waitFor(() => record.live === 2)
      const signedOut = await fetch(`${local.origin}/api/cloud-auth/sign-out`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: local.sessionToken, "content-type": "application/json" },
        body: "{}"
      })
      expect(signedOut.status).toBe(200)
      expect((await first.closed).code).toBe(4401)
      expect((await second.closed).code).toBe(4401)
      await waitFor(() => record.live === 0)
      expect(record.live).toBe(0)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  /*
   * Critique finding 2 (tunnel half): every upstream refusal used to reach
   * the renderer as 1011, the code it retries. Bun's client hides the HTTP
   * status of a failed upgrade, so the tunnel re-reads it with one plain GET
   * of the same route (same bearer) and closes with the status's own code.
   */
  test.each([
    [401, 4401],
    [403, 4403],
    [404, 4404],
    [409, 4409],
    [425, 4409],
    [429, 4429],
    [500, 1011]
  ])("an upstream %i closes the renderer with %i after exactly one re-read, never a redial", async (status, code) => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { refuse: status })
    const local = await startLocal(upstream)
    try {
      const { closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      const end = await closed
      expect(end.code).toBe(code)
      expect(end.reason).toBe(code === 1011 ? "cloud terminal upstream answered 500" : `refused ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      // The upgrade attempt and the one status re-read, both with the bearer; nothing after.
      expect(record.hits.map((hit) => hit.upgrade)).toEqual([true, false])
      expect(record.hits.every((hit) => hit.authorization === "Bearer smithers_test_token")).toBe(true)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("an upstream that drops after the handshake ends the renderer's socket", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream)
    try {
      const { opened, closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => record.live === 1)
      upstream.stop(true)
      const end = await closed
      // An abnormal upstream drop cannot be relayed as a code; the renderer sees its own abnormal close and may reconnect.
      expect([1001, 1006]).toContain(end.code)
    } finally {
      await local.stop()
    }
  })
})
