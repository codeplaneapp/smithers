import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
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
  for (const version of ["jj 0.9.0", "jj 0.38.9", "unrecognized version"]) {
    it.live(`rejects ${version} while constructing the layer`, () =>
      withVersion(version, (root) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(Effect.provide(Jj, NodeJj.layerAt(root)))
          expect(error).toMatchObject({ code: "unsupported_version", method: "version", command: "jj --version" })
          expect(error.message).toContain("0.39.0")
          expect(error.message).toContain(version)
        })))
  }

  for (const version of ["jj 0.39.0", "jj 0.39.1", "jj 0.40.0", "jj 1.0.0"]) {
    it.live(`accepts ${version} and probes only once per layer build`, () =>
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
