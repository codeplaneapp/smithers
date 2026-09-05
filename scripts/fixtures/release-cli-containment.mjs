// Runs entirely from the external consumer: no workspace imports or source loader.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const format = process.argv[2]
assert.ok(format === "esm" || format === "cjs")
const require = createRequire(import.meta.url)
const executable = format === "esm"
  ? fileURLToPath(import.meta.resolve("@smthrs/cli/bin"))
  : require.resolve("@smthrs/cli/bin")
assert.ok(executable.replaceAll("\\", "/").endsWith(`/dist/${format}/bin.js`), executable)
const preload = new URL("./release-recorded-provider.mjs", import.meta.url).href
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
const parentPid = (pid) => {
  try { return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()) }
  catch { return undefined }
}
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Installed ${format}: timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

for (const kind of ["shell", "mcp"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `smthrs-installed-${format}-${kind}-`)))
  const recording = join(root, "recording")
  mkdirSync(recording)
  let marker = join(recording, "child.pid")
  const mcpConfig = join(recording, "mcp.json")
  const environment = {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    SMITHERS_OPENAI_AUTH: "api-key",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  }
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const records = (file) => existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  const mcpProcesses = () => records(join(recording, "mcp-pids.jsonl"))
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [executable, ...args,
      ...(kind === "mcp" ? ["--mcp-config", mcpConfig] : []), "--json"], {
      cwd: root, env: environment, encoding: "utf8", timeout: 45_000, maxBuffer: 1024 * 1024
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${format} ${kind}: ${result.stderr}\n${result.stdout}`)
    return { pid: result.pid, value: JSON.parse(result.stdout) }
  }
  const ledger = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      return database.prepare(
        "SELECT event_type, payload_json FROM flows_journal_events WHERE event_type LIKE 'flows.host.process-%' ORDER BY emitted_at_ms, seq"
      ).all().map((row) => ({ kind: row.event_type, payload: JSON.parse(row.payload_json) }))
    } finally { database.close() }
  }
  let owner
  let child
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    for (const name of ["busy", "done"]) {
      mkdirSync(join(root, "flows", name), { recursive: true })
      writeFileSync(join(root, "flows", name, "flow.mdx"), [
        "---", `name: ${name}`, "description: Installed containment exercise.",
        "model: openai:gpt-4o-mini", "---", "Perform the recorded exercise."
      ].join("\n"))
    }
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      'process.on("SIGTERM", () => {})', "setInterval(() => {}, 1000)"
    ].join("\n")
    writeFileSync(mcpConfig, JSON.stringify([{
      server: "contained", command: process.execPath,
      args: [fileURLToPath(new URL("./release-contained-mcp.mjs", import.meta.url)), recording]
    }]))
    writeFileSync(join(recording, "cell.txt"), kind === "mcp"
      ? 'await ctx.call("wait", { seconds: 150, reason: "Installed MCP containment" }); ctx.done("finished")'
      : `await ctx.call("bash", ${JSON.stringify({
        mode: "unhermetic", interpreter: "node", script, cwd: root, timeoutMs: 120_000
      })}); ctx.done("finished")`)
    const launched = invoke("up", "busy", "-d")
    assert.equal(launched.value.detached, true)
    owner = records(join(recording, "processes.jsonl"))
      .find((entry) => entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run")?.pid
    assert.ok(Number.isSafeInteger(owner) && owner > 1)
    if (kind === "mcp") marker = join(recording, `${owner}.mcp.pid`)
    await waitFor(() => existsSync(marker), "the real child", 30_000)
    child = Number(readFileSync(marker, "utf8"))
    assert.ok(Number.isSafeInteger(child) && child > 1)
    assert.equal(parentPid(child), owner)
    invoke("plan", "done")
    assert.ok(isAlive(owner) && isAlive(child), "A live owner's child was reaped")
    for (const entry of mcpProcesses().filter((entry) => entry.owner !== owner)) assert.equal(isAlive(entry.pid), false)
    const spawned = ledger().filter((entry) => entry.kind === "flows.host.process-spawned.v1" && entry.payload.pid === child)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].payload.ownerPid, owner)
    assert.equal(spawned[0].payload.pgid, child)
    process.kill(owner, "SIGKILL")
    await waitFor(() => !isAlive(owner), "the crashed owner to disappear")
    assert.equal(isAlive(child), true, "The crash did not leave a live child")
    await waitFor(() => parentPid(child) !== owner, "reparenting")
    invoke("plan", "done")
    assert.equal(isAlive(child), false, "Installed CLI left the orphan alive")
    assert.equal(ledger().filter((entry) => entry.kind === "flows.host.process-reaped.v1" && entry.payload.pid === child).length, 1)
    assert.equal(records(join(recording, "requests.jsonl")).length, 1)
    console.log(`Installed ${format} CLI ${kind} containment passed`)
  } finally {
    for (const pid of new Set([owner, child, ...mcpProcesses().map((entry) => entry.pid)])) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || !isAlive(pid)) continue
      process.kill(pid, "SIGKILL")
      await waitFor(() => !isAlive(pid), "test-owned child cleanup")
    }
    rmSync(root, { recursive: true, force: true })
  }
}
