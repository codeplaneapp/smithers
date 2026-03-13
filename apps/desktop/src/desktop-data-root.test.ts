import { describe, expect, it } from "bun:test"

import { resolveDesktopDataRoot } from "./desktop-data-root"

describe("desktop data root resolution", () => {
  it("uses a macOS application support directory by default", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "/Users/tester",
        platform: "darwin",
        env: {},
      })
    ).toBe("/Users/tester/Library/Application Support/Burns")
  })

  it("uses APPDATA on Windows when available", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "C:\\Users\\tester",
        platform: "win32",
        env: {
          APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        },
      })
    ).toBe("C:\\Users\\tester\\AppData\\Roaming/Burns")
  })

  it("supports an explicit desktop data root override", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "/Users/tester",
        platform: "darwin",
        env: {
          BURNS_DESKTOP_DATA_ROOT: "/tmp/burns-desktop",
        },
      })
    ).toBe("/tmp/burns-desktop")
  })
})
