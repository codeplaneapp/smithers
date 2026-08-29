/**
 * The in-memory `ControlRuntime` against the shared `ControlLive` contract,
 * plus the checks that are specific to this repo's ownership of the modules.
 */
import type { Layer } from "effect"
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"
import * as TestControl from "../src/test/TestControl.ts"
import { contract, type Stack } from "./ControlContract.ts"

contract("memory", (executor) => TestControl.layer(undefined, executor) as unknown as Layer.Layer<Stack>)

describe("ControlLive", () => {
  it("owned modules contain no Node or platform-node imports", () => {
    const files = [
      "src/Control.ts",
      "src/ControlRuntime.ts",
      "src/ControlLive.ts",
      "src/SqlControlRuntime.ts",
      "src/internal/planning.ts",
      "src/test/TestControl.ts",
      "test/ControlContract.ts"
    ]
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      expect(source, file).not.toMatch(/(?:from|import\s*)\s*["']node:/)
      expect(source, file).not.toContain(["@effect", "platform-node"].join("/"))
    }
  })
})
