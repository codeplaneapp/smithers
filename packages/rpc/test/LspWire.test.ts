import { describe, expect, test } from "vitest"
import { LSP_HOVER_CAP_CHARS } from "../src/LocalApp.ts"
import {
  hoverContents,
  LSP_CLIENT_CAPABILITIES,
  redactHostPaths,
  relativeToRoot,
  toDiagnostic,
  toWireRange
} from "../src/LspWire.ts"

/*
 * The one conversion of the LSP wire into the typed answers, shared by the
 * Bun stdio session and the renderer's cloud client: ranges become 1-based,
 * a hover becomes one markdown string cut at the cap, a severity becomes its
 * word, a file URI under the root becomes a relative path and one outside it
 * becomes null (counted, never listed).
 */
describe("the LSP wire conversion", () => {
  test("a 0-based, end-exclusive range becomes 1-based on both ends", () => {
    expect(toWireRange({ start: { line: 2, character: 6 }, end: { line: 2, character: 13 } }))
      .toEqual({ line: 3, character: 7, endLine: 3, endCharacter: 14 })
  })

  test("a hover's contents — markup, a marked string, or a list — become one markdown string, cut at the cap and saying so", () => {
    expect(hoverContents({ kind: "markdown", value: "```typescript\nconst message: string\n```" }))
      .toEqual({ contents: "```typescript\nconst message: string\n```", truncated: false })
    expect(hoverContents({ language: "typescript", value: "const x: number" }))
      .toEqual({ contents: "```typescript\nconst x: number\n```", truncated: false })
    expect(hoverContents(["plain", { language: "ts", value: "v" }]))
      .toEqual({ contents: "plain\n\n```ts\nv\n```", truncated: false })
    const long = hoverContents("x".repeat(LSP_HOVER_CAP_CHARS + 10))
    expect(long.contents).toHaveLength(LSP_HOVER_CAP_CHARS)
    expect(long.truncated).toBe(true)
    // The redaction runs before the cut, so a path never straddles it.
    expect(
      hoverContents(
        "module \"/home/developer/workspace/src/greet\"",
        (text) => redactHostPaths(text, "/home/developer/workspace")
      )
    )
      .toEqual({ contents: "module \"src/greet\"", truncated: false })
  })

  test("a diagnostic's numeric severity becomes its word, an unknown or absent one is an error, and the code is a string", () => {
    const range = { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } }
    expect(
      toDiagnostic({
        range,
        message: "Property 'lenght' does not exist",
        severity: 1,
        code: 2551,
        source: "typescript"
      })
    )
      .toEqual({
        line: 4,
        character: 24,
        endLine: 4,
        endCharacter: 30,
        severity: "error",
        message: "Property 'lenght' does not exist",
        source: "typescript",
        code: "2551"
      })
    expect(toDiagnostic({ range, message: "unused", severity: 4 }).severity).toBe("hint")
    expect(toDiagnostic({ range, message: "?", severity: 9 }).severity).toBe("error")
    expect(toDiagnostic({ range, message: "?" })).toEqual({
      line: 4,
      character: 24,
      endLine: 4,
      endCharacter: 30,
      severity: "error",
      message: "?"
    })
  })

  test("free text loses the machine's paths: under the root relative, elsewhere the last segment behind …/", () => {
    const root = "/home/developer/workspace"
    expect(redactHostPaths(`File '${root}/src/a.ts' is not under 'rootDir' '${root}'.`, root)).toBe(
      "File 'src/a.ts' is not under 'rootDir' '.'."
    )
    expect(redactHostPaths("at /nix/store/abc-typescript/lib/lib.es5.d.ts:12:3", root)).toBe("at …/lib.es5.d.ts:12:3")
    expect(redactHostPaths("see https://example.com/a/b and src/x.ts", root)).toBe(
      "see https://example.com/a/b and src/x.ts"
    )
  })

  test("a file URI under the root is root-relative; one elsewhere, or not a file URI, is null", () => {
    const root = "file:///home/developer/workspace"
    expect(relativeToRoot(`${root}/src/greet.ts`, root)).toBe("src/greet.ts")
    expect(relativeToRoot(`${root}/src/greet.ts`, `${root}/`)).toBe("src/greet.ts")
    expect(relativeToRoot(`${root}/a%20b/c.ts`, root)).toBe("a b/c.ts")
    expect(relativeToRoot("file:///nix/store/x/lib.es5.d.ts", root)).toBeNull()
    expect(relativeToRoot("file:///home/developer/workspace-2/x.ts", root)).toBeNull()
    expect(relativeToRoot("untitled:Untitled-1", root)).toBeNull()
  })

  test("both adapters announce the same client capabilities: markdown hovers, no related information, full-text sync", () => {
    expect(LSP_CLIENT_CAPABILITIES.textDocument.hover.contentFormat).toEqual(["markdown", "plaintext"])
    expect(LSP_CLIENT_CAPABILITIES.textDocument.publishDiagnostics.relatedInformation).toBe(false)
    expect(LSP_CLIENT_CAPABILITIES.textDocument.publishDiagnostics.versionSupport).toBe(true)
    expect(LSP_CLIENT_CAPABILITIES.workspace).toEqual({ configuration: true, workspaceFolders: true })
  })
})
