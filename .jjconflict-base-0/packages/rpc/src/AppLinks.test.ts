import { describe, expect, test } from "bun:test"
import { DOWNLOAD_URL } from "./AppLinks"

describe("app links", () => {
  test("there is no download link until a native release carries an asset", () => {
    // 2026-09-02: v0.35.0 is the latest release and carries no assets; no apps-v* release exists.
    expect(DOWNLOAD_URL).toBeNull()
  })
})
