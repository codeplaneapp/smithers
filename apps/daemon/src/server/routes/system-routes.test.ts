import { describe, expect, it } from "bun:test"

import { handleSystemRoutes } from "@/server/routes/system-routes"

describe("handleSystemRoutes", () => {
  it("returns selected path for localhost requests", async () => {
    const response = handleSystemRoutes(
      new Request("http://localhost:7332/api/system/folder-picker", { method: "POST" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ path: "/Users/alex/code/repo" })
  })

  it("blocks non-localhost requests", async () => {
    const response = handleSystemRoutes(
      new Request("http://example.com/api/system/folder-picker", { method: "POST" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "Native folder picker is only available on localhost daemon URLs",
      details: null,
    })
  })

  it("returns null for non-matching routes or methods", () => {
    const methodMismatch = handleSystemRoutes(
      new Request("http://localhost:7332/api/system/folder-picker", { method: "GET" }),
      "/api/system/folder-picker",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )
    expect(methodMismatch).toBeNull()

    const pathMismatch = handleSystemRoutes(
      new Request("http://localhost:7332/api/system/unknown", { method: "POST" }),
      "/api/system/unknown",
      { pickDirectory: () => "/Users/alex/code/repo" }
    )
    expect(pathMismatch).toBeNull()
  })
})
