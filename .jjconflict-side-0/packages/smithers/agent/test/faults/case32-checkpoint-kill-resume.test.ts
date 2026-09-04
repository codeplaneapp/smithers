/**
 * Case 32 — a checkpoint outlives the process that took it, and a reading taken
 * at one sees the pinned tree rather than the live one.
 *
 * `ctx.checkpoint` is the authoring name for this: a call that names a
 * checkpoint reads the tree as it was, so a "fails before, passes after" claim
 * is about two trees and not about whatever the working copy happened to hold
 * when the check ran. The pin is durable — it is a git ref, not a handle in a
 * process — which is what makes the kill below meaningful.
 *
 * The refusals are part of the same contract: a path that is absolute, or that
 * climbs out of the checkout with `..`, would silently read the live tree while
 * the caller believed it was reading a pinned one. Both are refused with a
 * typed reason and nothing runs.
 */
import { Checkpointed } from "@smthrs/agent"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Checkpoints } from "@smthrs/std"
import { isAlive, killProcess } from "@smthrs/testing/Faults"
import * as Effect from "effect/Effect"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const runner = fileURLToPath(new URL("./fixtures/checkpointChild.ts", import.meta.url))
const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case32-"))
const ledger = join(directory, "ledger.txt")
const checkpointId = "pinned"

beforeAll(() => {
  execFileSync("git", ["init", "-q", "-b", "main", directory])
  execFileSync("git", ["-C", directory, "config", "user.email", "e2e@local"])
  execFileSync("git", ["-C", directory, "config", "user.name", "e2e"])
  writeFileSync(ledger, "one\n")
  execFileSync("git", ["-C", directory, "add", "."])
  execFileSync("git", ["-C", directory, "commit", "-qm", "baseline"])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const captureInDoomedProcess = (): Promise<{ readonly ref: string; readonly pid: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, directory, checkpointId], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      out += chunk
      const match = /CAPTURED=(.+)\n/.exec(out)
      if (match !== null) resolve({ ref: match[1] as string, pid: child.pid as number })
    })
    child.stderr.on("data", (chunk: string) => {
      err += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`checkpoint child exited with ${String(code)}\n${err}`)))
  })

const readAtCheckpoint = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const checkpoints = yield* Checkpoints.Checkpoints
      return yield* checkpoints.materialize(checkpointId, (materialized) =>
        Effect.sync(() => readFileSync(join(materialized.host, "ledger.txt"), "utf8")))
    }).pipe(
      Effect.provide(Checkpoints.layerGit({ root: directory })),
      Effect.provide(NodeHost.layer),
      Effect.scoped,
      Effect.orDie
    ) as Effect.Effect<string>
  )

describe("case32 a checkpoint is a pinned tree", () => {
  it("survives the process that took it and still reads the tree it pinned", async () => {
    const captured = await captureInDoomedProcess()
    expect(captured.ref).toMatch(/\S/)

    // The process that pinned the tree is gone.
    await killProcess({ pid: captured.pid })
    expect(isAlive(captured.pid)).toBe(false)

    // And the live tree has moved on since.
    writeFileSync(ledger, "two\n")
    expect(readFileSync(ledger, "utf8")).toBe("two\n")

    // A reading taken at the checkpoint is of the pinned tree, in a fresh
    // process that learned nothing but the checkpoint's name.
    expect(await readAtCheckpoint()).toBe("one\n")
    // Materializing did not disturb the live tree.
    expect(readFileSync(ledger, "utf8")).toBe("two\n")
  }, 120_000)

  it("refuses a path that would read the live tree while claiming the pinned one", () => {
    const materialized = {
      id: checkpointId,
      host: join(directory, ".flows-checkpoints", checkpointId),
      guest: join(directory, ".flows-checkpoints", checkpointId),
      root: directory,
      guestRoot: directory
    }

    expect(Checkpoints.relocate("read", { path: "/etc/hosts" }, materialized)).toMatchObject({
      _tag: "AbsolutePath"
    })
    expect(Checkpoints.relocate("read", { path: "../outside.txt" }, materialized)).toMatchObject({
      _tag: "OutsideTree"
    })
    // A flow whose input names no location cannot be pinned at all, and says so
    // rather than running against the live tree.
    expect(Checkpoints.relocate("memory", { note: "anything" }, materialized)).toMatchObject({
      _tag: "UnsupportedFlow"
    })
    // The decorated runner is the seam that turns those into refusals.
    expect(typeof Checkpointed.checkpointed).toBe("function")
  })
})
