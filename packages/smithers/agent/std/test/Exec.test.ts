/**
 * What a command's output costs to capture.
 *
 * `Exec` buffers, and a buffer with no bound is the whole of what a process
 * decided to print. The shell flows then display thirty kilobytes of it, so an
 * unbounded capture pays for gigabytes to show a page. `maxCaptureBytes` is the
 * bound, and these cases run a real process through the real spawner because a
 * fake one would record the option rather than produce the bytes.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Exec from "../src/internal/Exec.ts"

const host = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

/** Prints `text` with no trailing newline, whatever characters it holds. */
const print = (text: string): string => `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(text)})`)}`

describe.skipIf(process.platform === "win32")("Exec capture", () => {
  it.live("inherits only bootstrap variables and explicitly declared names", () =>
    Effect.gen(function*() {
      const inherited = {
        ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
        GH_TOKEN: process.env["GH_TOKEN"],
        OPENAI_API_KEY: process.env["OPENAI_API_KEY"]
      }
      process.env["ANTHROPIC_API_KEY"] = "ambient-anthropic"
      process.env["GH_TOKEN"] = "ambient-github"
      process.env["OPENAI_API_KEY"] = "ambient-openai"
      const result = yield* Exec.exec(process.execPath, {
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({" +
          "anthropic: process.env.ANTHROPIC_API_KEY," +
          "github: process.env.GH_TOKEN," +
          "openai: process.env.OPENAI_API_KEY," +
          "path: process.env.PATH," +
          "declared: process.env.SMITHERS_EXPLICIT" +
          "}))"
        ],
        env: { SMITHERS_EXPLICIT: "visible" }
      }).pipe(Effect.ensuring(Effect.sync(() => {
        for (const [name, value] of Object.entries(inherited)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      })))

      expect(JSON.parse(result.stdout)).toEqual({
        path: process.env.PATH,
        declared: "visible"
      })
    }).pipe(Effect.provide(host)), 30_000)

  it.live("keeps every byte and drops none when no bound is given", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghij"))
      expect(result.stdout).toBe("abcdefghij")
      expect(result.stdoutDroppedBytes).toBe(0)
      expect(result.stderrDroppedBytes).toBe(0)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("keeps the tail and reports the bytes it dropped", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghijklmnop"), { maxCaptureBytes: 10 })
      expect(result.stdout).toBe("ghijklmnop")
      expect(result.stdoutDroppedBytes).toBe(6)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("bounds a stream far larger than the bound", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stdout.write('x'.repeat(2000000) + 'END')"`,
        { maxCaptureBytes: 64 }
      )
      expect(result.stdout.length).toBe(64)
      expect(result.stdout.endsWith("END")).toBe(true)
      expect(result.stdoutDroppedBytes).toBe(2_000_003 - 64)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("never decodes a cut code point into a replacement character", () =>
    Effect.gen(function*() {
      // Nine two-byte characters, cut at an odd byte count: the retained head
      // of the tail is one continuation byte, which is skipped rather than
      // decoded as U+FFFD, so the count says 12 dropped bytes and not 11.
      const result = yield* Exec.exec(print("é".repeat(9)), { maxCaptureBytes: 7 })
      expect(result.stdout).toBe("ééé")
      expect(result.stdout).not.toContain("�")
      expect(result.stdoutDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("bounds stderr on the same terms as stdout", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stderr.write('abcdefghijklmnop')"`,
        { maxCaptureBytes: 4 }
      )
      expect(result.stderr).toBe("mnop")
      expect(result.stderrDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)
})
