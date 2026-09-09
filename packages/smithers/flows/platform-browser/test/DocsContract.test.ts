import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const readDoc = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

describe("documented filesystem refusal contract", () => {
  it.each(["README.md", "docs/contract.md"])("%s distinguishes refusal from absence", (path) => {
    const doc = readDoc(path)
    expect(doc).not.toContain("fail with a `NotFound`")
    expect(doc).toContain("fail with a `PermissionDenied` `PlatformError` naming the method")
    expect(doc).toContain("`NotFound` is reserved for a path the backend reports absent")
  })

  it.each(["README.md", "docs/contract.md"])("%s documents optional backend operations", (path) => {
    expect(readDoc(path)).toContain("`rename` and `utimes` are served when the backend supplies them")
  })

  it.each(["README.md", "docs/contract.md", "docs/testing.md", "CHANGELOG.md"])(
    "%s refuses realPath without backend canonicalization",
    (path) => {
      const doc = readDoc(path)
      // Lexical handling of recursive directory identities and symlink/.. is distinct from a realPath fallback.
      expect(doc).not.toMatch(
        /`realPath` answers lexically|lexical canonicalization in `realPath`|without that member the answer is lexical/
      )
      expect(doc).toContain("Without `realpath`, `realPath` fails with a `PermissionDenied` `PlatformError`")
    }
  )
})
