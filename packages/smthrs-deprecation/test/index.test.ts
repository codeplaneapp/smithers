import { describe, expect, it } from "vitest"

describe("smthrs", () => {
  it("throws the migration notice on import", async () => {
    await expect(import("../src/index.ts")).rejects.toThrow(
      "smthrs 1.0 is a migration notice, not a runtime."
    )
  })

  it("names the replacement packages, the command, and the guide", async () => {
    const failure = await import("../src/index.ts").then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toContain("@smthrs/flows")
    expect(failure?.message).toContain("@smthrs/cli")
    expect(failure?.message).toContain("smthrs migrate")
    expect(failure?.message).toContain("https://smithers.sh/migration/1.0")
  })
})
