import { expect, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Artifact, verify } from "./soakArtifact.ts"

it("writes explicit failed evidence and releases resources after a real SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-soak-interruption-"))
  const artifactPath = join(directory, "interrupted.json")
  const child = spawn(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./fixtures/long-soak-child.ts", import.meta.url))
  ], {
    env: { ...process.env, SMITHERS_SOAK_MINUTES: "1", SMITHERS_SOAK_ARTIFACT: artifactPath }
  })
  let stdout = ""
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const ready = await new Promise<{ directory: string; phase: string }>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk)
        if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))))
      })
      child.once("error", reject)
      child.once("exit", () => reject(new Error(`No ready barrier: ${stderr}`)))
    })
    expect(ready.phase).toBe("ready")
    child.kill("SIGTERM")
    expect(await exited, stderr).toBe(1)
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Artifact
    expect(artifact.status).toBe("failed")
    expect(artifact.failure).toBeTruthy()
    expect(artifact.cleanup).toEqual({ activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 })
    expect(() => verify(artifact, 1)).toThrow()
    await expect(access(ready.directory)).rejects.toThrow()
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
