/* The cloud-workspace terminal transport against a real WebSocket server. */
import { afterEach, expect, test } from "bun:test"
import { createCloudTerminalClient, pageCloudSocketUrl } from "./CloudTerminalClient"

interface Harness {
  readonly url: string
  readonly seen: Array<string | Buffer>
  readonly protocols: Array<string | null>
  readonly output: (data: string) => void
  readonly stop: () => void
}

const harnesses: Array<Harness> = []

const serve = (): Harness => {
  const seen: Array<string | Buffer> = []
  const protocols: Array<string | null> = []
  const open = new Set<{ send: (data: string | ArrayBuffer) => void }>()
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => {
      protocols.push(request.headers.get("sec-websocket-protocol"))
      return self.upgrade(request) ? undefined : new Response("no")
    },
    websocket: {
      open: (socket) => {
        open.add(socket as never)
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
    output: (data) => {
      for (const socket of open) socket.send(new TextEncoder().encode(data) as never)
    },
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not pass")
    await Bun.sleep(5)
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
})

const client = (server: Harness, reconnectMs = 20) =>
  createCloudTerminalClient({
    socketUrl: () => server.url,
    socketProtocol: () => "smithers.local.test",
    reconnectMs
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

test("pageCloudSocketUrl is undefined outside a browser", () => {
  expect(pageCloudSocketUrl("will/smithers", "sess-1")).toBeUndefined()
})
