import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "flows-jj-lock-"))
      await mkdir(join(root, ".jj"))
      await mkdir(join(root, "nested"))
      const binary = join(root, "jj-shim")
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
printf '%s\\n' "$*" >> calls
: > started
while [ -f hold ]; do /bin/sleep 0.01; done
echo snapshotid
`
      )
      await chmod(binary, 0o755)
      const previous = process.env.SMITHERS_JJ_PATH
      process.env.SMITHERS_JJ_PATH = binary
      return { root, previous }
    }),
    ({ root }) => use(root),
    ({ root, previous }) =>
      Effect.promise(async () => {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previous
        await rm(root, { recursive: true, force: true })
      })
  )

const until = (predicate: () => Promise<boolean>) =>
  Effect.retry(Effect.promise(predicate).pipe(Effect.filterOrFail((ready) => ready)), {
    times: 3_000,
    schedule: Schedule.spaced(10)
  })

describe("NodeJj repository locks", () => {
  it.live("releases the lock after cancelling an active snapshot", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const pending = yield* Effect.forkChild(jj.snapshot("cancelled"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        yield* Fiber.interrupt(pending)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        yield* Effect.promise(() => rm(join(root, "hold")))
        expect((yield* jj.snapshot()).changeId).toBe("snapshotid")
      })
    ))

  it.live("cancels a waiter without deleting another live owner's lock", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, `${process.pid}-other-owner`), "")
        })
        const pending = yield* Effect.forkChild(
          Effect.flatMap(Jj, (jj) => jj.restore("saved")).pipe(Effect.provide(NodeJj.layerAt(root)))
        )
        yield* until(async () => (await readdir(join(root, ".jj"))).some((name) => name.startsWith(".smithers-lock-")))
        yield* Fiber.interrupt(pending)
        expect((yield* Effect.promise(() => readdir(lock))).sort()).toEqual([`${process.pid}-other-owner`])
        expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["smithers.lock"])
        expect(existsSync(join(root, "started"))).toBe(false)
      })
    ))

  it.live("holds snapshot, restore and diff together across separately built layers", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const first = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const second = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const snapshot = yield* Effect.forkChild(first.snapshot("held"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        const followers = yield* Effect.forkChild(Effect.all([second.restore("saved"), second.diff("saved", "@")], {
          concurrency: "unbounded"
        }))
        yield* Effect.sleep("100 millis")
        expect((yield* Effect.promise(() => readFile(join(root, "calls"), "utf8"))).trim().split("\n")).toHaveLength(1)
        yield* Effect.promise(() => rm(join(root, "hold")))
        yield* Fiber.join(snapshot)
        yield* Fiber.join(followers)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
      })
    ))
})
