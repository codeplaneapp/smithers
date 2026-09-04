import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHost from "../src/NodeHost.ts"

describe("NodeHost startup", () => {
  it.live("propagates an unsupported jj version as a typed construction failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-host-version-"))),
      (root) =>
        Effect.gen(function*() {
          const binary = join(root, "jj")
          yield* Effect.promise(async () => {
            await writeFile(binary, "#!/bin/sh\necho \"jj 0.38.0\"\n")
            await chmod(binary, 0o755)
          })
          const previous = process.env.SMITHERS_JJ_PATH
          process.env.SMITHERS_JJ_PATH = binary
          try {
            const error = yield* Effect.flip(Effect.provide(Jj, NodeHost.layerAt(root)))
            expect(error).toMatchObject({ code: "unsupported_version", method: "version" })
            expect(error.message).toContain("0.39.0")
          } finally {
            if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
            else process.env.SMITHERS_JJ_PATH = previous
          }
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})
