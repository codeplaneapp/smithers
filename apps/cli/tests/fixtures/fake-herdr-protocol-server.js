import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.env.FAKE_HERDR_SOCKET_PATH;
const readyPath = process.env.FAKE_HERDR_READY_PATH;
const callsPath = process.env.FAKE_HERDR_CALLS_PATH;
const protocol = Number(process.env.FAKE_HERDR_PROTOCOL);

if (!socketPath || !readyPath || !callsPath || !Number.isFinite(protocol)) {
  throw new Error("fake Herdr protocol server requires socket, ready, calls, and protocol env values");
}

rmSync(socketPath, { force: true });

const server = createServer((socket) => {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    const line = pending.slice(0, newline);
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ error: { code: "invalid_request", message: "invalid JSON" } })}\n`);
      return;
    }
    appendFileSync(callsPath, `${JSON.stringify({ method: request.method, params: request.params })}\n`, "utf8");
    const result =
      request.method === "ping"
        ? { type: "pong", version: "fake-protocol-server", protocol, capabilities: {} }
        : { type: "ok" };
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  });
});

server.listen(socketPath, () => {
  writeFileSync(readyPath, "ready\n", "utf8");
});

function shutdown() {
  server.close(() => {
    rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
