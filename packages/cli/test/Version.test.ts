/**
 * The version the entrypoint reports.
 *
 * `--version` is the one answer a packaging mistake can silently corrupt, so
 * the module refuses to load metadata that does not declare a string version
 * rather than printing `undefined` to an operator.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("@smthrs/cli/package.json", () => ({ default: { name: "@smthrs/cli" } }))

describe("Version.packageVersion", () => {
  it("refuses package metadata that declares no version string", async () => {
    await expect(import("../src/Version.ts")).rejects.toThrow(
      "@smthrs/cli package metadata does not declare a version"
    )
  })
})
