// A real stdio MCP server that deliberately survives stdin closure and TERM.
// This proves both deadline escalation and crash recovery without a vendor.
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const directory = process.argv[2]
if (!directory) throw new Error("Missing MCP fixture directory")
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
appendFileSync(join(directory, "mcp-pids.jsonl"), `${JSON.stringify({ pid: process.pid, owner: process.ppid })}\n`)
writeFileSync(join(directory, `${process.ppid}.mcp.pid`), String(process.pid))
process.stdin.setEncoding("utf8")
let buffered = ""
process.stdin.on("data", (chunk) => {
  buffered += chunk
  for (;;) {
    const end = buffered.indexOf("\n")
    if (end < 0) return
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "contained", version: "1" } }
      : { tools: [] }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
  }
})
