/**
 * A stand-in sandbox runtime: a real OS process that answers a ping over
 * loopback TCP.
 *
 * A fault suite needs a sandbox it can stop, kill, and restart for real. A
 * provider object in the test process cannot be SIGSTOPped, so the thing under
 * the probe is this process. It prints its port on stdout and then serves
 * `pong` to every connection until it is signalled.
 *
 * Usage: `node pingSandboxChild.mjs`
 */
import { createServer } from "node:net"

const server = createServer((socket) => {
  socket.on("data", () => {
    socket.write("pong\n")
  })
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  process.stdout.write(`${JSON.stringify({ phase: "ready", port: address.port })}\n`)
})
