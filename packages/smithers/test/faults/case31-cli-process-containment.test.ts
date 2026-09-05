import { isAlive, parentPid, waitFor } from "@smthrs/testing/Faults"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const executable = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
const preload = new URL("./fixtures/recorded-provider.mjs", import.meta.url).href

const containment = async (mode: "shell" | "mcp") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-cli-containment-")))
  const recording = join(root, "recording")
  mkdirSync(recording)
  let marker = join(recording, "child.pid")
  const mcpConfig = join(recording, "mcp.json")
  const environment: NodeJS.ProcessEnv = {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    SMITHERS_OPENAI_AUTH: "api-key",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  }
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const invoke = (...args: Array<string>) => {
    const result = spawnSync(process.execPath, [
      executable,
      ...args,
      ...(mode === "mcp" ? ["--mcp-config", mcpConfig] : []),
      "--json"
    ], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 1024 * 1024
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    return { pid: result.pid, value: JSON.parse(result.stdout) }
  }
  const processes = (): Array<{ pid: number; ppid: number; verb: string; event: string }> =>
    readFileSync(join(recording, "processes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const mcpProcesses = (): Array<{ pid: number; owner: number }> => {
    const path = join(recording, "mcp-pids.jsonl")
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  const ledger = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      return database.prepare(
        "SELECT event_type, payload_json FROM flows_journal_events WHERE event_type LIKE 'flows.host.process-%' ORDER BY emitted_at_ms, seq"
      ).all().map((row) => ({ kind: row.event_type, payload: JSON.parse(String(row.payload_json)) }))
    } finally {
      database.close()
    }
  }
  let owner: number | undefined
  let child: number | undefined
  try {
    expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    for (const name of ["busy", "done"]) {
      mkdirSync(join(root, "flows", name), { recursive: true })
      writeFileSync(
        join(root, "flows", name, "flow.mdx"),
        [
          "---",
          `name: ${name}`,
          "description: Recorded process containment exercise.",
          "model: openai:gpt-4o-mini",
          "---",
          "Perform the recorded exercise."
        ].join("\n")
      )
    }
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      "process.on(\"SIGTERM\", () => {})",
      "setInterval(() => {}, 1000)"
    ].join("\n")
    writeFileSync(
      mcpConfig,
      JSON.stringify([{
        server: "contained",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/contained-mcp.mjs", import.meta.url)), recording]
      }])
    )
    writeFileSync(
      join(recording, "cell.txt"),
      mode === "mcp"
        ? "await ctx.call(\"wait\", { seconds: 150, reason: \"MCP containment\" }); ctx.done(\"finished\")"
        : `await ctx.call("bash", ${
          JSON.stringify({
            mode: "unhermetic",
            interpreter: "node",
            script,
            cwd: root,
            timeoutMs: 120_000
          })
        })\nctx.done("finished")`
    )
    const launched = invoke("up", "busy", "-d")
    owner = processes().find((entry) => entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run")
      ?.pid
    expect(owner).toBeDefined()
    if (mode === "mcp") marker = join(recording, `${owner}.mcp.pid`)
    await waitFor(() => existsSync(marker), "the real child to announce itself", 30_000)
    child = Number(readFileSync(marker, "utf8"))
    expect(Number.isSafeInteger(child) && child > 1).toBe(true)
    expect(parentPid(child)).toBe(owner)
    expect(isAlive(child)).toBe(true)
    // Startup may inspect this child's record, but a living owner excludes it
    // from reaping. `plan` builds the full CLI composition without competing
    // for the workspace boundary the first agent is currently holding.
    invoke("plan", "done")
    expect(isAlive(owner!)).toBe(true)
    expect(isAlive(child)).toBe(true)
    // The completed commands' own MCP servers ignore TERM. Their exit proves
    // that normal scope shutdown escalates instead of hanging indefinitely.
    for (const process of mcpProcesses().filter((entry) => entry.owner !== owner)) {
      expect(isAlive(process.pid)).toBe(false)
    }
    const beforeCrash = ledger()

    process.kill(owner!, "SIGKILL")
    await waitFor(() => !isAlive(owner!), "the crashed CLI to disappear", 10_000)
    expect(isAlive(child)).toBe(true)
    await waitFor(() => parentPid(child!) !== owner, "the child to be reparented", 10_000)
    invoke("plan", "done")
    expect(isAlive(child), "A replacement CLI left the crashed CLI's child alive").toBe(false)
    expect(beforeCrash.filter((event) => event.kind === "flows.host.process-spawned.v1" && event.payload.pid === child))
      .toMatchObject([{ payload: { pid: child, pgid: child, ownerPid: owner } }])
    expect(ledger().filter((event) => event.kind === "flows.host.process-reaped.v1" && event.payload.pid === child))
      .toHaveLength(1)
  } finally {
    // Both identities came from this fixture's real child processes. No broad
    // process-name or process-group kill is used for cleanup.
    for (const pid of new Set([owner, child, ...mcpProcesses().map((entry) => entry.pid)])) {
      if (pid === undefined || !isAlive(pid)) continue
      process.kill(pid, "SIGKILL")
      await waitFor(() => !isAlive(pid), "test-owned child cleanup", 10_000)
    }
    rmSync(root, { recursive: true, force: true })
  }
}

it("reaps a crashed CLI's shell child without touching a live CLI's child", () => containment("shell"), 180_000)
it("contains configured MCP children during shutdown and after a CLI crash", () => containment("mcp"), 180_000)
