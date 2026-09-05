/**
 * The atomic write every durable JSON file goes through: the old bytes or
 * the new ones, never half of each, and no temporary file left behind —
 * including when the write itself fails.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Fs from "../src/internal/Fs.ts"
import { nodeLayer } from "./fixtures/helpers.ts"

const temporaries: Array<string> = []
const scratch = (): string => {
  const target = mkdtempSync(join(tmpdir(), "migrate-fs-"))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

const write = (file: string, text: string) => Fs.writeAtomic(file, text).pipe(Effect.provide(nodeLayer))

describe("Fs.writeAtomic", () => {
  it.effect("writes the file and leaves no temporary behind", () =>
    Effect.gen(function*() {
      const root = scratch()
      const file = join(root, "report.json")

      yield* write(file, "{\"one\":1}\n")

      expect(readFileSync(file, "utf8")).toBe("{\"one\":1}\n")
      expect(readdirSync(root)).toEqual(["report.json"])
    }))

  it.effect("replaces an existing file whole", () =>
    Effect.gen(function*() {
      const root = scratch()
      const file = join(root, "pending-unit.json")
      writeFileSync(file, "{\"old\":true}\n")

      yield* write(file, "{\"new\":true}\n")

      expect(readFileSync(file, "utf8")).toBe("{\"new\":true}\n")
      expect(readdirSync(root)).toEqual(["pending-unit.json"])
    }))

  it.effect("cleans its temporary up when the rename cannot land", () =>
    Effect.gen(function*() {
      const root = scratch()
      // A rename of a file over an existing directory fails, so the write
      // fails after the temporary file has landed — the one moment cleanup
      // matters.
      const file = join(root, "occupied")
      mkdirSync(file)

      const failure = yield* Effect.flip(write(file, "never\n"))

      expect(String(failure)).toContain("occupied")
      expect(readdirSync(root)).toEqual(["occupied"])
      expect(existsSync(file)).toBe(true)
    }))
})

describe("Fs.isStaleTemporary", () => {
  it("recognizes a leftover of a crashed atomic write and nothing else", () => {
    expect(Fs.isStaleTemporary(".report.json.tmp-1234-0")).toBe(true)
    expect(Fs.isStaleTemporary(".pending-unit.json.tmp-1-12")).toBe(true)
    expect(Fs.isStaleTemporary("report.json")).toBe(false)
    expect(Fs.isStaleTemporary("apply.lock")).toBe(false)
    expect(Fs.isStaleTemporary("units")).toBe(false)
  })
})
