/* The cloud-workspace terminal transport against a real WebSocket server. */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createCloudTerminalClient, pageCloudSocketUrl } from "./CloudTerminalClient"

// Real sockets on a loaded CI runner: the per-test ceiling follows the wait helper's.
setDefaultTimeout(60_000)

interface Harness {
  readonly url: string
  readonly seen: Array<string | Buffer>
  readonly protocols: Array<string | null>
  /** Sockets the server currently holds open. */
  readonly live: () => number
  readonly output: (data: string) => void
  readonly stop: () => void
}

interface ServeOptions {
  /** What the server does to each socket as it opens (close it with a code, say). */
  readonly onOpen?: (socket: { close: (code?: number, reason?: string) => void }) => void
}

const harnesses: Array<Harness> = []

const serve = (options: ServeOptions = {}): Harness => {
  const seen: Array<string | Buffer> = []
  const protocols: Array<string | null> = []
  const open = new Set<{ send: (data: string | ArrayBuffer) => void; close: (code?: number, reason?: string) => void }>()
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => {
      protocols.push(request.headers.get("sec-websocket-protocol"))
      return self.upgrade(request) ? undefined : new Response("no")
    },
    websocket: {
      open: (socket) => {
        open.add(socket as never)
        options.onOpen?.(socket as never)
      },
      close: (socket) => void open.delete(socket as never),
      message: (_socket, message) => {
        seen.push(message)
      }
    }
  })
  const harness: Harness = {
    url: `ws://127.0.0.1:${server.port}/tunnel`,
    seen,
    protocols,
    live: () => open.size,
    output: (data) => {
      for (const socket of open) socket.send(new TextEncoder().encode(data) as never)
    },
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

/*
 * Every wait here is on a real loopback WebSocket server, so the ceiling is
 * generous: a two-core CI runner under load takes 7-10x longer to spawn and
 * upgrade than this Mac (the "apps e2e" job timed three of these tests out at
 * exactly 4 s in run 33651343176). A passing test never waits longer than it
 * needs; only a failing one pays the ceiling.
 */
const until = async (predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not pass")
    await Bun.sleep(5)
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
})

const client = (server: Harness, reconnectMs = 20, extra: { readonly maxReconnectMs?: number; readonly maxReconnectsPerMinute?: number } = {}) =>
  createCloudTerminalClient({
    socketUrl: () => server.url,
    socketProtocol: () => "smithers.local.test",
    reconnectMs,
    ...extra
  })

const text = (frame: string | Buffer): string => typeof frame === "string" ? frame : new TextDecoder().decode(frame)

test("output reaches every attachment; input goes out binary; resize goes out as the control frame", async () => {
  const server = serve()
  const terminal = client(server)
  const first: Array<string> = []
  const second: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => first.push(data) })
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => second.push(data) })
  // The local-session capability rides the subprotocol (the tunnel's authorization).
  await until(() => server.protocols.length > 0)
  expect(server.protocols[0]).toBe("smithers.local.test")

  terminal.input("sess-1", "ls\r")
  terminal.resize("sess-1", 120, 40)
  await until(() => server.seen.length >= 2)
  expect(text(server.seen[0]!)).toBe("ls\r")
  expect(typeof server.seen[0]).not.toBe("string")
  expect(server.seen[1]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))

  server.output("total 0\r\n")
  await until(() => first.length === 1 && second.length === 1)
  expect(first).toEqual(["total 0\r\n"])
  expect(second).toEqual(first)
  terminal.dispose()
})

test("keystrokes sent before the socket opens flush on open", async () => {
  const server = serve()
  const terminal = client(server)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // Same tick as the attach: the socket cannot be open yet, so the input queues.
  terminal.input("sess-1", "early\r")
  await until(() => server.seen.length >= 1)
  expect(text(server.seen[0]!)).toBe("early\r")
  terminal.dispose()
})

test("a closed socket reconnects while an attachment lives", async () => {
  const first = serve()
  let url = first.url
  const terminal = createCloudTerminalClient({
    socketUrl: () => url,
    socketProtocol: () => "smithers.local.test",
    reconnectMs: 20
  })
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => first.protocols.length === 1)
  first.stop()
  const second = serve()
  url = second.url
  // The reconnect lands when the replacement sees the upgrade; output before that is nobody's to hear.
  await until(() => second.protocols.length > 0)
  second.output("back\r\n")
  await until(() => output.includes("back\r\n"))
  terminal.dispose()
})

/*
 * Critique finding 1: the last detach closed the socket, whose own onclose
 * redialed a tunnel nobody listened to and dispose could not reach.
 */
test("detaching the last attachment closes the socket for good: no redial, nothing left for dispose", async () => {
  const server = serve()
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length === 1 && server.live() === 1)
  detach()
  await until(() => server.live() === 0)
  await Bun.sleep(200)
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
  await Bun.sleep(50)
  expect(server.protocols.length).toBe(1)
  expect(server.live()).toBe(0)
})

test("detaching while the socket is still connecting aborts it and never redials (the abort reads as 1006)", async () => {
  const server = serve()
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // Same tick: the handshake is in flight, and closing a CONNECTING socket surfaces as an abnormal 1006 close.
  detach()
  await Bun.sleep(200)
  expect(server.protocols.length).toBeLessThanOrEqual(1)
  expect(server.live()).toBe(0)
  terminal.dispose()
})

test("a drop the server forces while nobody listens never redials either", async () => {
  // The server closes the socket the instant it opens (a 1001 "too slow" drop) — a redial would loop.
  const server = serve({ onOpen: (socket) => socket.close(1001, "terminal client too slow") })
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length >= 1)
  detach()
  const dials = server.protocols.length
  await Bun.sleep(150)
  // At most the one redial already in flight when the detach landed; never a stream of them.
  expect(server.protocols.length).toBeLessThanOrEqual(dials + 1)
  terminal.dispose()
})

test("dispose closes every socket, attached or reconnecting", async () => {
  const server = serve()
  const terminal = client(server, 10)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  terminal.attach("will/smithers", "sess-2", { onOutput: () => {} })
  await until(() => server.live() === 2)
  terminal.dispose()
  await until(() => server.live() === 0)
  await Bun.sleep(100)
  expect(server.protocols.length).toBe(2)
})

/*
 * Critique finding 2 (renderer half): a refusal the tunnel translated
 * (4401 … 4429), plue's 1008 and 1000 are final; 1011 retries once; 1001
 * and 1006 reconnect with a doubling, capped backoff under a client-wide
 * per-minute budget.
 */
test.each([
  [4401, "sign in to Smithers Cloud"],
  [4403, "this account can't open"],
  [4404, "the session is gone"],
  [4409, "isn't running"],
  [4429, "rate limiting"],
  [1008, "access revoked"],
  [1000, "session closed"]
])("close %i is final: no redial, the listener hears why", async (code, wording) => {
  const server = serve({ onOpen: (socket) => socket.close(code, code === 1008 ? "access revoked: token expired" : "") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain(wording)
  await Bun.sleep(120)
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
})

test("1011 retries once, then is final", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1011, "failed to attach terminal") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain("failed to attach terminal")
  await Bun.sleep(120)
  expect(server.protocols.length).toBe(2)
  terminal.dispose()
})

test("1001 reconnects with a doubling backoff capped at maxReconnectMs", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1001, "terminal client too slow") })
  const terminal = client(server, 25, { maxReconnectMs: 100, maxReconnectsPerMinute: 100 })
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length >= 2)
  await Bun.sleep(400)
  // Fixed 25 ms redials would have made ~16; 25 → 50 → 100 → 100 → 100 makes at most six (the first dial included).
  expect(server.protocols.length).toBeGreaterThanOrEqual(3)
  expect(server.protocols.length).toBeLessThanOrEqual(7)
  terminal.dispose()
})

test("reconnect dials across every session stay under the per-minute budget", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1001, "terminal client too slow") })
  const terminal = client(server, 5, { maxReconnectMs: 5, maxReconnectsPerMinute: 2 })
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  terminal.attach("will/smithers", "sess-2", { onOutput: () => {} })
  // Two first dials (the user's opens), then exactly two redials this minute; the third waits for the window.
  await until(() => server.protocols.length >= 4)
  await Bun.sleep(200)
  expect(server.protocols.length).toBe(4)
  terminal.dispose()
})

test("pageCloudSocketUrl is undefined outside a browser", () => {
  expect(pageCloudSocketUrl("will/smithers", "sess-1")).toBeUndefined()
})
