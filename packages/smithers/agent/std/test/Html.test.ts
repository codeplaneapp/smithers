import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { toText } from "../src/internal/Html.ts"

describe("Html", () => {
  it("renders many unclosed skipped elements within a bounded time", { timeout: 45_000 }, () => {
    const html = `${"<script>".repeat(20_000)}${"x".repeat(2_000_000)}`
    const started = performance.now()
    const output = toText(html)
    const elapsed = performance.now() - started

    expect(typeof output).toBe("string")
    expect(elapsed).toBeLessThan(2_000)
  })
})
