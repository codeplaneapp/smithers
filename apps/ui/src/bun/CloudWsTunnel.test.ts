import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

/*
 * The `/api/cloud-ws/` workspace-terminal tunnel (lane citc): the local
 * session capability rides the subprotocol (a browser upgrade carries no
 * custom header), only plue's terminal route shape proxies, and Bun bridges
 * frames both ways with the Bun-held bearer and plue's `terminal`
 * subprotocol attached upstream — never anything the renderer sent.
 */

let dist = ""

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-cloudws-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html", ), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
})

afterAll(async () => {
  await rm(dist, { recursive: true, force: true })
})

const TERMINAL_PATH = "/api/cloud-ws/repos/will/smithers/workspace/sessions/sess-1/terminal"

interface UpstreamRecord {
  protocols: string | null
  authorization: string | null
}

/** A cloud-API double: requires plue's `terminal` subprotocol, records the upgrade, echoes frames. */
const startUpstream = (record: UpstreamRecord, received: Array<string | Buffer>) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      record.protocols = request.headers.get("sec-websocket-protocol")
      record.authorization = request.headers.get("authorization")
      if ((record.protocols ?? "").includes("terminal")) {
        const upgraded = server.upgrade(request, { headers: { "sec-websocket-protocol": "terminal" } })
        if (upgraded) return undefined
      }
      return new Response("terminal subprotocol required", { status: 400 })
    },
    websocket: {
      open: (socket) => {
        socket.send(new TextEncoder().encode("upstream says hello\r\n"))
      },
      message: (socket, frame) => {
        received.push(frame)
        socket.send(frame)
      }
    }
  })

const startLocal = async (upstream: ReturnType<typeof startUpstream> | null): Promise<LocalServer> =>
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
          token: () => "smithers_test_token",
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
): { readonly socket: WebSocket; readonly opened: Promise<boolean>; readonly frames: Array<string> } => {
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
    socket.onclose = () => resolve(false)
  })
  socket.onmessage = (event) => {
    if (typeof event.data === "string") frames.push(event.data)
    else if (event.data instanceof ArrayBuffer) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Uint8Array) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Blob) void event.data.arrayBuffer().then((buffer) => frames.push(new TextDecoder().decode(buffer)))
  }
  return { socket, opened, frames }
}

describe("the workspace terminal tunnel", () => {
  test("bridges frames both ways with the bearer and plue's subprotocol attached upstream", async () => {
    const record: UpstreamRecord = { protocols: null, authorization: null }
    const received: Array<string | Buffer> = []
    const upstream = startUpstream(record, received)
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      // The upstream's greeting arrives; the bearer and plue's subprotocol were attached HERE.
      await waitFor(() => frames.length > 0)
      expect(frames[0]).toBe("upstream says hello\r\n")
      expect(record.protocols).toBe("terminal")
      expect(record.authorization).toBe("Bearer smithers_test_token")
      // Binary keystrokes echo through the bridge; a text frame carries the resize.
      socket.send(new TextEncoder().encode("ls\r"))
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      await waitFor(() => frames.length >= 3)
      expect(frames[1]).toBe("ls\r")
      expect(frames[2]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      expect(received.length).toBe(2)
      socket.close()
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("refuses a path that is not a workspace terminal", async () => {
    const upstream = startUpstream({ protocols: null, authorization: null }, [])
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
    const upstream = startUpstream({ protocols: null, authorization: null }, [])
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
})
