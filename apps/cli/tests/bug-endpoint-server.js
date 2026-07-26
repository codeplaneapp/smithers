// Real local bug-endpoint fixture for bug-command.e2e.test.js (no mocks): a
// Bun.serve implementing the bug.smithers.sh worker contract
// (`POST /api/bugs` -> `{ id, url }`). Runs as its own process because on some
// dev machines the local firewall drops connections from child processes to a
// listener owned by the test process, while a child-owned listener is fine
// (same shape as the gateway command tests).
//
// Usage: bun bug-endpoint-server.js <payload-log-file>
// Prints `{"port": <n>}` on stdout once listening; appends each received
// payload to the log file as one JSON line.
import { appendFileSync } from "node:fs";

const payloadLogFile = process.argv[2];
if (!payloadLogFile) {
  console.error("usage: bun bug-endpoint-server.js <payload-log-file>");
  process.exit(2);
}

let received = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/bugs") {
      const payload = await request.json();
      appendFileSync(payloadLogFile, `${JSON.stringify(payload)}\n`, "utf8");
      received += 1;
      const id = `bug-${received}`;
      return Response.json({ id, url: `https://bug.smithers.sh/api/bugs/${id}` });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(JSON.stringify({ port: server.port }));
