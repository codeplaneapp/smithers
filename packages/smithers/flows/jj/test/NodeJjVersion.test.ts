import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const withVersion = <A, E, R>(version: string, use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "flows-jj-version-"))
      const binary = join(root, "jj")
      await writeFile(join(root, "version"), version)
      await writeFile(
        binary,
        `#!/bin/sh
cd "\${0%/*}"
if [ "$1" = "--version" ]; then
  echo probe >> probes
  /bin/cat version
else
  echo operation >> operations
  echo ok
fi
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

describe("NodeJj version requirement", () => {
  it.live("does not reuse an unresolved command's failure after PATH changes", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const previousPath = process.env.PATH
        const previousJj = process.env.SMITHERS_JJ_PATH
        delete process.env.SMITHERS_JJ_PATH
        try {
          process.env.PATH = ""
          const missing = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
          expect(missing.code).toBe("not_installed")
          yield* Effect.promise(() => chmod(join(root, "jj"), 0o644))
          process.env.PATH = root
          const refused = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
          expect(refused.code).toBe("unknown")
        } finally {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
          if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousJj
        }
      })))

  it.live("retries an interrupted probe when another layer is built", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        const binary = join(root, "jj")
        const original = yield* Effect.promise(() => readFile(binary, "utf8"))
        yield* Effect.promise(() =>
          writeFile(binary, "#!/bin/sh\necho probe >> \"${0%/*}/probes\"\nexec /bin/sleep 300\n")
        )
        const building = yield* Effect.forkChild(Effect.provide(Jj, NodeJj.layerAt(root)), { startImmediately: true })
        yield* Effect.promise(() =>
          expect.poll(() => readFile(join(root, "probes"), "utf8"), { timeout: 10_000 }).toBe("probe\n")
        )
        yield* Fiber.interrupt(building)
        yield* Effect.promise(() => writeFile(binary, original))
        yield* Effect.provide(Jj, NodeJj.layerAt(root))
        expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\nprobe\n")
      })))

  it.live("shares a completed probe across concurrent and subsequent layer builds", () =>
    withVersion("jj 0.39.0", (root) =>
      Effect.gen(function*() {
        yield* Effect.all(
          Array.from({ length: 3 }, () => Effect.provide(Jj, NodeJj.layerAt(root))),
          { concurrency: "unbounded" }
        )
        yield* Effect.provide(Jj, NodeJj.layer)
        expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
      })))

  it.live("checks each executable selected by PATH independently", () =>
    withVersion("jj 0.39.0", (first) =>
      withVersion("jj 0.38.0", (second) =>
        Effect.gen(function*() {
          const previousPath = process.env.PATH
          const previousJj = process.env.SMITHERS_JJ_PATH
          delete process.env.SMITHERS_JJ_PATH
          try {
            process.env.PATH = first
            yield* Effect.provide(Jj, NodeJj.layer)
            process.env.PATH = second
            const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layer))
            expect(error.code).toBe("unsupported_version")
            process.env.PATH = first
            yield* Effect.provide(Jj, NodeJj.layer)
            expect(yield* Effect.promise(() => readFile(join(first, "probes"), "utf8"))).toBe("probe\n")
            expect(yield* Effect.promise(() => readFile(join(second, "probes"), "utf8"))).toBe("probe\n")
          } finally {
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
            if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
            else process.env.SMITHERS_JJ_PATH = previousJj
          }
        }))))

  for (const version of ["jj 0.9.0", "jj 0.38.9", "unrecognized version"]) {
    it.live(`rejects ${version} while constructing the layer`, () =>
      withVersion(version, (root) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root)))
          expect(error).toMatchObject({ code: "unsupported_version", method: "version", command: "jj --version" })
          expect(error.message).toContain("0.39.0")
          expect(error.message).toContain(version)
          const again = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root)))
          expect(again).toMatchObject({ code: "unsupported_version", message: error.message })
          expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
        })))
  }

  for (const version of ["jj 0.39.0", "jj 0.39.1", "jj 0.40.0", "jj 1.0.0"]) {
    it.live(`accepts ${version} before exposing repository operations`, () =>
      withVersion(version, (root) =>
        Effect.gen(function*() {
          yield* Effect.gen(function*() {
            const jj = yield* Jj
            expect(yield* jj.status()).toBe("ok\n")
            expect(yield* jj.status()).toBe("ok\n")
          }).pipe(Effect.provide(NodeJj.layerAt(root)))
          expect(yield* Effect.promise(() => readFile(join(root, "probes"), "utf8"))).toBe("probe\n")
          expect(yield* Effect.promise(() => readFile(join(root, "operations"), "utf8"))).toBe("operation\noperation\n")
        })))
  }
})
