/**
 * Windows has neither `O_NOFOLLOW` nor `O_NONBLOCK`. The read path opens
 * state without them there, so this suite removes the two constants and
 * proves a redaction still completes. It stands apart from the ordinary cases
 * because the substitution is module-wide.
 */
import type * as NodeFs from "node:fs"
import type * as FsPromises from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  const { O_NOFOLLOW: _noFollow, O_NONBLOCK: _nonBlock, ...constants } = original.constants
  return { ...original, default: original, constants }
})

const Fs = await vi.importActual<typeof FsPromises>("node:fs/promises")
const { redactAlchemyState } = await import("./redact-state.ts")

describe("Alchemy state reads without the optional open flags", () => {
  it("scrubs state on a host that lacks O_NOFOLLOW and O_NONBLOCK", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-flags-")))
    try {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw-token" } } } }))

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      expect(await Fs.readFile(file, "utf8")).not.toContain("raw-token")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
