import { build } from "esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it("bundles the root entry without Node built-ins", async () => {
    const result = await build({
      entryPoints: ["./src/index.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent"
    })
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/node:(assert|buffer|child_process|fs|path|url)/)
    expect(output).not.toMatch(/require\(["']node:/)
  })
})
