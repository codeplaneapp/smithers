import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
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
const processState = (pid: number) => {
  const result = spawnSync("/bin/ps", ["-o", "pgid=,stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000
  })
  if (result.status !== 0) return undefined
  const [group, state] = result.stdout.trim().split(/\s+/)
  return { group: Number(group), stopped: state?.startsWith("T") === true }
}

const containment = async (mode: "shell" | "mcp", recovery: "automatic" | "reaper") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-cli-containment-")))
  const recording = join(root, "recording")
  mkdirSync(recording)
  const marker = join(recording, "child.pid")
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
  const mcpProcesses = (): Array<{ pid: number; supervisor: number }> => {
    const path = join(recording, "mcp-pids.jsonl")
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  // Capture OS start times while the fixture identities are alive. Teardown
  // rechecks that identity before signalling each test-owned PID.
  const owned = new Map<number, number>()
  const remember = (pid: number) => {
    const started = ProcessReaper.posixSystem.startedAtMs(pid)
    expect(started._tag, `start time for fixture PID ${pid}`).toBe("started")
    if (started._tag === "started") owned.set(pid, started.startedAtMs)
    return pid
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
    const owner = processes().find((entry) =>
      entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run"
    )
      ?.pid
    expect(owner).toBeDefined()
    remember(owner!)
    const ownedMcp = () => {
      const spawned = ledger().filter((event) =>
        event.kind === "flows.host.process-spawned.v1" && event.payload.ownerPid === owner
      )
      return mcpProcesses().find((entry) => spawned.some((event) => event.payload.pid === entry.supervisor))
    }
    await waitFor(
      () => mode === "mcp" ? ownedMcp() !== undefined : existsSync(marker),
      "the real child to announce itself under its recorded supervisor",
      30_000
    )
    const child = remember(mode === "mcp" ? ownedMcp()!.pid : Number(readFileSync(marker, "utf8")))
    expect(Number.isSafeInteger(child) && child > 1).toBe(true)
    const supervisor = remember(parentPid(child)!)
    expect(supervisor).not.toBe(owner)
    expect(parentPid(supervisor)).toBe(owner)
    expect(processState(child)?.group).toBe(supervisor)
    expect(processState(supervisor)?.group).toBe(supervisor)
    expect(isAlive(child)).toBe(true)
    const childEvents = () =>
      ledger().filter((event) => event.payload.pid === supervisor && event.payload.ownerPid === owner)
    expect(childEvents()).toMatchObject([
      { kind: "flows.host.process-spawned.v1", payload: { pid: supervisor, pgid: supervisor, ownerPid: owner } }
    ])
    // Startup may inspect this child's record, but a living owner excludes it
    // from reaping. `plan` builds the full CLI composition without competing
    // for the workspace boundary the first agent is currently holding.
    invoke("plan", "done")
    expect(isAlive(owner!)).toBe(true)
    expect(parentPid(child)).toBe(supervisor)
    expect(parentPid(supervisor)).toBe(owner)
    expect(isAlive(child)).toBe(true)
    // The completed commands' own MCP servers ignore TERM. Their exit proves
    // that normal scope shutdown escalates instead of hanging indefinitely.
    for (const process of mcpProcesses().filter((entry) => entry.supervisor !== supervisor)) {
      if (isAlive(process.pid)) remember(process.pid)
      if (isAlive(process.supervisor)) remember(process.supervisor)
      expect(isAlive(process.pid)).toBe(false)
      expect(isAlive(process.supervisor)).toBe(false)
    }
    expect(childEvents()).toHaveLength(1)

    if (recovery === "reaper") {
      // Stop only the recorded supervisor, leaving its target running. This
      // deliberately prevents the automatic parent-EOF cleanup so replacement
      // startup must exercise the durable reaper against a real owned group.
      process.kill(supervisor, "SIGSTOP")
      await waitFor(() => processState(supervisor)?.stopped === true, "the supervisor to stop before its owner crashes")
    }
    process.kill(owner!, "SIGKILL")
    await waitFor(() => !isAlive(owner!), "the crashed CLI to disappear", 10_000)
    if (recovery === "automatic") {
      // No replacement CLI has started: the private channel's EOF must make
      // the supervisor terminate even a TERM-ignoring target by itself.
      await waitFor(() => !isAlive(child) && !isAlive(supervisor), "automatic crash cleanup", 10_000)
    } else {
      expect(isAlive(child)).toBe(true)
      expect(isAlive(supervisor)).toBe(true)
      expect(parentPid(child)).toBe(supervisor)
      await waitFor(() => parentPid(supervisor) !== owner, "the stopped supervisor to be reparented", 10_000)
    }
    invoke("plan", "done")
    expect(isAlive(child), "A replacement CLI left the crashed CLI's child alive").toBe(false)
    expect(isAlive(supervisor), "A replacement CLI left the crashed CLI's supervisor alive").toBe(false)
    expect(childEvents()).toMatchObject([
      { kind: "flows.host.process-spawned.v1", payload: { pid: supervisor, pgid: supervisor, ownerPid: owner } },
      recovery === "automatic"
        ? { kind: "flows.host.process-reap-skipped.v1", payload: { reason: "process-gone" } }
        : { kind: "flows.host.process-reaped.v1" }
    ])
  } finally {
    // Every identity was observed in this fixture while alive. No broad
    // process-name or process-group kill is used for teardown.
    for (const [pid, startedAtMs] of owned) {
      const current = ProcessReaper.posixSystem.startedAtMs(pid)
      if (current._tag !== "started" || current.startedAtMs !== startedAtMs) continue
      try {
        process.kill(pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
      await waitFor(() => !isAlive(pid), "test-owned child cleanup", 10_000)
    }
    rmSync(root, { recursive: true, force: true })
  }
}

it(
  "automatically contains a crashed CLI's shell child and retires its durable record on replacement startup",
  () => containment("shell", "automatic"),
  180_000
)
it(
  "automatically contains a crashed CLI's mcp child and retires its durable record on replacement startup",
  () => containment("mcp", "automatic"),
  180_000
)
it(
  "reaps a crashed CLI's shell group when its supervisor cannot perform automatic cleanup",
  () => containment("shell", "reaper"),
  180_000
)
it(
  "reaps a crashed CLI's mcp group when its supervisor cannot perform automatic cleanup",
  () => containment("mcp", "reaper"),
  180_000
)
