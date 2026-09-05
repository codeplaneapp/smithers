import type { APIOptions } from "typescript/unstable/sync"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  options: undefined as APIOptions | undefined,
  failure: "project" as "project" | "source" | "snapshot",
  closes: 0
}))

vi.mock("typescript/unstable/sync", () => ({
  API: class {
    constructor(options: APIOptions) {
      state.options = options
    }
    updateSnapshot() {
      if (state.failure === "snapshot") throw new Error("native compiler failure")
      return {
        getProject: () => state.failure === "project" ? undefined : { program: { getSourceFile: () => undefined } }
      }
    }
    close() {
      state.closes++
    }
  }
}))

import { parseModule } from "../src/internal/ParseModule.ts"

beforeEach(() => {
  state.options = undefined
  state.closes = 0
})

describe("compiler isolation and failure cleanup", () => {
  it.each(["project", "source", "snapshot"] as const)("closes its session on %s failure", (failure) => {
    state.failure = failure
    expect(() => parseModule("entry.ts", "const value = 1")).toThrow(
      failure === "snapshot" ? "native compiler failure" : "did not return a syntax tree"
    )
    expect(state.closes).toBe(1)
  })

  it("never falls back to the real filesystem or loads libraries and imports", () => {
    expect(() => parseModule("../../outside.ts", "import '/private/source'")).toThrow()
    const { cwd, fs } = state.options!
    const file = `${cwd}/input.ts`
    expect(fs!.readFile!(file)).toBe("import '/private/source'")
    expect(fs!.fileExists!(file)).toBe(true)
    expect(fs!.directoryExists!(cwd!)).toBe(true)
    for (const outside of ["/private/source", "/tsconfig.json", `${cwd}/node_modules/typescript/lib/lib.d.ts`]) {
      expect(fs!.readFile!(outside)).toBeNull()
      expect(fs!.fileExists!(outside)).toBe(false)
      expect(fs!.directoryExists!(outside)).toBe(false)
      expect(fs!.getAccessibleEntries!(outside)).toEqual({ files: [], directories: [] })
      expect(fs!.realpath!(outside)).toBe(outside)
    }
    expect(JSON.parse(fs!.readFile!(`${cwd}/tsconfig.json`)!)).toEqual({
      files: ["input.ts"],
      compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [] }
    })
  })
})
