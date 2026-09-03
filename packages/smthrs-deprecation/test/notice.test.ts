import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { fences, notice } from "./golden.ts"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("the notice this package throws", () => {
  it("is the frozen four-line text, not a message that merely mentions the parts", async () => {
    const failure = await import("../src/index.ts").then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toBe(notice)
  })

  it("is quoted verbatim by the README npm publishes", () => {
    expect(fences(read("../README.md"))[0]).toBe(notice)
  })

  it("is quoted verbatim by the package-owned documentation fragment", () => {
    expect(fences(read("../docs/notice.md"))[0]).toBe(notice)
  })

  it("is quoted verbatim by the upgrade guide the notice links to", () => {
    expect(read("../../../docs/pages/migration/1.0.md")).toContain(notice)
  })

  it("projects the entire package-owned fragment into the upgrade guide", () => {
    const fragment = read("../docs/notice.md").trim()

    expect(read("../../../docs/pages/migration/1.0.md")).toContain(fragment)
  })
})
