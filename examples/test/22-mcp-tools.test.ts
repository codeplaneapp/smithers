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

    // The adapter's own declaration is the conservative wildcard, because an
    // MCP tool is opaque code it cannot describe.
    expect(summary.declaredCapabilities).toEqual(["*"])

    // A declared capability is checked as an exact `namespace:operation:resource`
    // triple, and `"*"` is a pattern, so it parses as nothing and no envelope
    // admits it. This assertion is a pin, not an endorsement: a cell can reach
    // an MCP tool only because the host re-declared the grant in `granting`.
    // If `McpFlows` or the cell boundary later reconciles the two spellings,
    // this expectation is the thing that says so.
    expect(summary.ungranted).toContain("capability_refused")
    expect(summary.ungranted).toContain(`mcp/${serverName}/word_count needs *`)
  }), { timeout: 60_000 })
