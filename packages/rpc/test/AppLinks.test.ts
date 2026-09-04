import { describe, expect, test } from "vitest"
import { DOWNLOAD_URL } from "../src/AppLinks.ts"

describe("app links", () => {
  test("there is no download link until a native release carries an asset", () => {
    // 2026-09-02: v0.35.0 is the latest release and carries no assets; no apps-v* release exists.
    expect(DOWNLOAD_URL).toBeNull()
  })
})
