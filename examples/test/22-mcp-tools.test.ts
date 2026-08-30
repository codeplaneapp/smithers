import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, serverName } from "../src/22-mcp-tools.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("calls a real MCP server's tools from inside a cell", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "titles.sqlite"))

    // The catalog came off the wire at connect time, not from a local list.
    expect(summary.tools).toEqual(["word_count", "slugify", "explode"])
    // Every tool is projected as one flow, scoped by server so two servers may
    // offer the same tool name.
    expect(summary.flowNames).toEqual([
      `mcp/${serverName}/word_count`,
      `mcp/${serverName}/slugify`,
      `mcp/${serverName}/explode`
    ])
    // And the model was shown that catalog rather than being told about it.
    expect(summary.disclosed).toBe(true)

    expect(summary.reading.words).toBe(4)
    expect(summary.reading.slug).toBe("durable-flows-release-notes")
    // A tool that reported a problem is a SUCCESSFUL call carrying isError, not
    // a failed step.
    expect(summary.reading.refused).toBe(true)
  }), { timeout: 60_000 })

it.live("pins what an undeclarable authority does at the cell boundary", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "pinned.sqlite"))

    // An MCP tool is opaque code the adapter cannot describe, so it declares
    // everything the tool could reach. It says so one exact
    // `namespace:operation:resource` at a time, because the cell boundary
    // reads a declared capability with `Capability.parse` and answers `None`
    // for a bare `"*"` — which used to refuse every MCP tool before it ran,
    // under every envelope including an unrestricted one.
    expect(summary.declaredCapabilities).toContain("proc:spawn:**")
    expect(summary.declaredCapabilities).toContain("fs:read:**")
    expect(summary.declaredCapabilities.every((capability) => capability.split(":").length === 3)).toBe(true)

    // A host that granted something else still admits none of it, and the
    // refusal names what the tool would have needed.
    expect(summary.ungranted).toContain("capability_refused")
    expect(summary.ungranted).toContain(`mcp/${serverName}/word_count needs`)
  }), { timeout: 60_000 })
