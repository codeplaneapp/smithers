/**
 * The package's root entry.
 *
 * `@smthrs/mcp` is published, and `exports["."]` names `src/index.ts`, so a
 * missing barrel makes `import "@smthrs/mcp"` fail in every consumer while
 * every subpath keeps working. The release smoke caught exactly that.
 */
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/index.ts"

describe("@smthrs/mcp", () => {
  it("re-exports every public module as a namespace", () => {
    expect(Object.keys(Mcp).sort()).toEqual(["McpClient", "McpError", "McpFlows"])
  })

  it("exposes the flow-binding projection the CLI composes", () => {
    expect(typeof Mcp.McpFlows).toBe("object")
    expect(typeof Mcp.McpClient).toBe("object")
  })
})
