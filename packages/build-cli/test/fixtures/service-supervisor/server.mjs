// Tiny HTTP fixture server for ServiceSupervisor tests.
//
// Flags:
//   --port N            port to listen on (required)
//   --delay-listen MS   wait MS before calling listen (readiness gating proof)
//   --ignore-sigterm    install a SIGTERM handler that refuses to exit
//   --marker TEXT       inert argv marker so pgrep -f can find this process
//
// Routes:
//   /health    200 "ok" (500 while wedged or flapping)
//   /instance  200 with this process's unique instance id (refcount proof)
//   /wedge     200, then every later request answers 500 forever
//   /flap?n=N  200, then the next N requests answer 500, then recover
import http from "node:http"

const arg = (name) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}
const has = (name) => process.argv.includes(name)

const port = Number(arg("--port"))
if (!Number.isInteger(port) || port < 1) {
  console.error("fixture server requires --port")
  process.exit(2)
}
const delayListen = Number(arg("--delay-listen") ?? "0")
const instance = `instance-${process.pid}-${Math.random().toString(36).slice(2)}`

if (has("--ignore-sigterm")) {
  process.on("SIGTERM", () => {
    console.log("ignoring SIGTERM")
  })
}

let wedged = false
let flapRemaining = 0

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
  if (url.pathname === "/wedge") {
    wedged = true
    console.log("wedged: answering 500 from now on")
    response.end("wedged")
    return
  }
  if (url.pathname === "/flap") {
    flapRemaining = Number(url.searchParams.get("n") ?? "1")
    console.log(`flapping for the next ${flapRemaining} requests`)
    response.end("flapping")
    return
  }
  if (wedged) {
    response.statusCode = 500
    response.end("wedged")
    return
  }
  if (flapRemaining > 0) {
    flapRemaining -= 1
    response.statusCode = 500
    response.end("flap")
    return
  }
  if (url.pathname === "/instance") {
    response.end(instance)
    return
  }
  response.end("ok")
})

setTimeout(() => {
  server.listen(port, "127.0.0.1", () => {
    console.log(`fixture server listening on ${port} as ${instance}`)
  })
}, delayListen)
