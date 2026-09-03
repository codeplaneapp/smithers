import { build } from "esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it("resolves the complete root dependency graph without Node built-ins", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
      external: [
        "effect",
        "effect/*"
      ],
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      write: false
    })
    const source = result.outputFiles[0]?.text ?? ""
    expect(source).not.toMatch(/node:(?:child_process|fs|path|process)/)
  })
})
