import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)

describe("CommonJS build", () => {
  beforeAll(
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd: new URL("..", import.meta.url),
        stdio: "pipe"
      })
    },
    30_000
  )

  it("shares ModelError identity across independently imported subpaths", () => {
    const anthropic = require("../dist/cjs/AnthropicMessages.js") as {
      readonly protocol: {
        readonly classifyError: (status: number, body: string) => unknown
      }
    }
    const errors = require("../dist/cjs/ModelError.js") as {
      readonly ModelError: new(...args: ReadonlyArray<never>) => Error
    }
    const error = anthropic.protocol.classifyError(
      429,
      "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"limited\"}}"
    )

    expect(error).toBeInstanceOf(errors.ModelError)
  })
})
