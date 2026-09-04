/**
 * The escalation inside `Detached.terminate`'s handle arm: SIGTERM first,
 * SIGKILL when the child ignored it.
 *
 * `test/Detached.test.ts` reaches that arm with a child that dies on the
 * first signal, so the second half of the escalation — the one a Windows host
 * depends on, because a handle is the only thing that can be signalled there —
 * has never been run by anything. This file runs it, with a child that traps
 * SIGTERM and keeps going, and asserts both halves of the claim: the process
 * is actually gone afterwards, and `terminate` says so.
 *
 * `platform` is passed rather than read for the reason the sibling suite
 * gives: this host has process groups and would take the other arm.
 */
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"

const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as { readonly code?: string } | null)?.code === "ESRCH") return true
    throw error
  }
}

const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * A child that has installed its SIGTERM handler before the parent signals.
 * Announced rather than slept on: the grace window is short on purpose, and a
 * loaded machine must not be able to turn "the handler was not installed yet"
 * into a passing case.
 */
const trapping = async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n')"
  ], { stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("ready")) resolve()
    })
    child.once("error", reject)
    child.once("exit", () => reject(new Error("the fixture child exited before it was ready")))
  })
  return child
}

describe("terminating a SIGTERM-trapping child on a host that has no process groups", () => {
  it("escalates to SIGKILL and confirms the leader is gone", async () => {
    const child = await trapping()
    const pid = child.pid
    if (pid === undefined) throw new Error("the fixture child did not start")

    // SIGTERM is swallowed, so the first reap window expires and the second
    // signal is the one that ends it. A `false` here is the failure this case
    // exists for: the caller would report an orphan-prone launch as contained.
    expect(await Detached.terminate(child, 500, "win32")).toBe(true)
    expect(await until(() => processGone(pid), 5_000)).toBe(true)
  }, 30_000)
})
