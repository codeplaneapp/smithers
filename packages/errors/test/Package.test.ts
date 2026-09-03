import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Manifest } from "../docs/Manifest.ts"
import { ERROR_REFERENCE_URL } from "../src/ErrorCode.ts"

// The docsPages target drift-checks page content, so these tests never open docs/pages.
describe("Manifest", () => {
  it("ties the error reference URL to the package-owned page", () => {
    const url = new URL(ERROR_REFERENCE_URL)
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      readonly name?: unknown
    }

    expect(url.origin).toBe("https://smithers.sh")
    expect(url.pathname).toBe("/reference/errors")
    expect(Manifest.api.target).toBe(`docs/pages${url.pathname}.md`)
    expect(Manifest.name).toBe("@smthrs/errors")
    expect(manifest.name).toBe(Manifest.name)
  })
})
