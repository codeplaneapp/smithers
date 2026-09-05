import { performance } from "node:perf_hooks"
import { afterEach, expect, it, vi } from "vitest"

const timer = vi.hoisted(() => ({ wake: () => {} }))
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof import("node:timers/promises")>(),
  setTimeout: () =>
    new Promise<void>((resolve) => {
      timer.wake = resolve
    })
}))
import { stopGroup } from "../src/internal/ContainedProcess.ts"

afterEach(() => vi.restoreAllMocks())
const tick = async () => {
  timer.wake()
  // Flush the async send/poll continuations without advancing the independent clock.
  for (let step = 0; step < 8; step++) await Promise.resolve()
}

it("escalates at 5000ms, never at 4999ms, and waits for absence after 5001ms", async () => {
  let now = 0
  let present = true
  let released = false
  const signals: Array<readonly [number, string | number | undefined]> = []
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-12345)
    if (!present) throw Object.assign(new Error("gone"), { code: "ESRCH" })
    if (signal !== 0) signals.push([now, signal])
    return true
  })
  const pending = stopGroup(12345).then(() => {
    released = true
  })
  await tick()
  now = 4999
  await tick()
  expect(signals).toEqual([[0, "SIGTERM"]])
  expect(released).toBe(false)
  now = 5000
  await tick()
  expect(signals).toEqual([[0, "SIGTERM"], [5000, "SIGKILL"]])
  now = 5001
  await tick()
  expect(released).toBe(false)
  present = false
  await tick()
  await pending
  expect(released).toBe(true)
})

it("does not signal KILL after the group has already disappeared", async () => {
  let present = true
  const signals: Array<string | number | undefined> = []
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (!present) throw Object.assign(new Error("gone"), { code: "ESRCH" })
    if (signal !== 0) signals.push(signal)
    return true
  })
  const pending = stopGroup(12345)
  await tick()
  present = false
  await tick()
  await pending
  expect(signals).toEqual(["SIGTERM"])
})

it("fails closed at the post-KILL bound and preserves denied-signal evidence", async () => {
  let now = 0
  const denied = Object.assign(new Error("not signalable"), { code: "EPERM" })
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw denied
  })
  let settled = false
  const pending = stopGroup(12345)
  const assertion = expect(pending).rejects.toMatchObject({
    _tag: "ProcessError",
    code: "cleanup_failed",
    cause: { cause: denied }
  }).then(() => {
    settled = true
  })
  await tick()
  now = 5000
  await tick()
  await tick()
  now = 9999
  await tick()
  expect(settled).toBe(false)
  now = 10000
  await tick()
  await assertion
  expect(settled).toBe(true)
})
