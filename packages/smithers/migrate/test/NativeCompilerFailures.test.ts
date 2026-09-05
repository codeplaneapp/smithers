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
      if (state.failure === "snapshot") throw new Error("compiler failed")
      return {
        getProject: () => state.failure === "project" ? undefined : { program: { getSourceFile: () => undefined } }
      }
    }
    close() {
      state.closes++
    }
  }
}))
import * as Ts from "../src/internal/Ts.ts"

beforeEach(() => {
  state.options = undefined
  state.closes = 0
  state.failure = "project"
})

describe("compiler isolation and cleanup", () => {
  it.each(["project", "source", "snapshot"] as const)("closes the compiler on %s failure", (failure) => {
    state.failure = failure
    expect(() => Ts.parse("flow.ts", "")).toThrow(
      failure === "snapshot" ? "compiler failed" : "did not return a syntax tree"
    )
    expect(state.closes).toBe(1)
  })

  it("supplies only source text and a closed configuration, never filesystem fallback", () => {
    expect(() => Ts.parse("../../outside.tsx", "const view = <Task />")).toThrow()
    const { cwd, fs } = state.options!
    expect(fs!.readFile!(`${cwd}/input.tsx`)).toBe("const view = <Task />")
    expect(fs!.fileExists!(`${cwd}/input.tsx`)).toBe(true)
    expect(fs!.directoryExists!(cwd!)).toBe(true)
    expect(JSON.parse(fs!.readFile!(`${cwd}/tsconfig.json`)!)).toEqual({
      files: ["input.tsx"],
      compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [] }
    })
    for (const path of ["/tsconfig.json", "/private/source", `${cwd}/node_modules/lib.d.ts`]) {
      expect(fs!.readFile!(path)).toBeNull()
      expect(fs!.fileExists!(path)).toBe(false)
      expect(fs!.directoryExists!(path)).toBe(false)
      expect(fs!.getAccessibleEntries!(path)).toEqual({ files: [], directories: [] })
      expect(fs!.realpath!(path)).toBe(path)
    }
    expect(state.closes).toBe(1)
  })
})
