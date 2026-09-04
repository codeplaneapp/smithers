import { describe, expect, it } from "vitest"
import * as Fetch from "../src/Fetch.ts"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"

/** The force `//data:schemaPinned` declaration, verbatim. */
const pinned = {
  url: "https://raw.githubusercontent.com/artsy/metaphysics/e97558687736902fef8e037ffabc98dba33a3e0f/_schemaV2.graphql",
  sha256: "7f60276646f651505e048961954fa97c7ad8501b284ac3db362c04f1d23c72e0",
  out: "schema.upstream.graphql"
}

describe("S.Fetch", () => {
  it("constructs a build-kind target whose declared output is the out path", () => {
    const target = Fetch.Fetch(pinned)
    const metadata = Target.metadata(target)
    expect(Target.isTarget(target)).toBe(true)
    expect(Fetch.isFetch(target)).toBe(true)
    expect(Fetch.isFetch(Shell.Run({ command: "echo hi" }))).toBe(false)
    expect(metadata.target).toBe("Fetch")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["schema.upstream.graphql"] })
    expect(metadata.inputs).toEqual([])
    expect(metadata.dependencies).toEqual([])
    // Not cacheable until the download lane lands a deterministic contract.
    expect(metadata.cacheable).toBe(false)
    expect(Fetch.fetchAttrsOf(target)).toEqual(pinned)
  })

  it("is reachable through the namespace as S.Fetch", () => {
    expect(Smithers.Fetch).toBe(Fetch.Fetch)
  })

  it("becomes a dependency edge when a consumer names it in data", () => {
    const schemaPinned = Fetch.Fetch(pinned)
    const consumer = Shell.Test({
      command: "diff -q schema.graphql schema.upstream.graphql",
      data: [schemaPinned, Input.file("schema.graphql")]
    })
    const metadata = Target.metadata(consumer)
    expect(metadata.dependencies).toEqual([schemaPinned])
    expect(metadata.inputs).toEqual([Input.file("schema.graphql")])
  })

  it("rejects a malformed digest, a non-http url, and an unknown key", () => {
    expect(() => Fetch.Fetch({ ...pinned, sha256: "abc" })).toThrow(/sha256/)
    expect(() => Fetch.Fetch({ ...pinned, sha256: pinned.sha256.toUpperCase() })).toThrow(/sha256/)
    expect(() => Fetch.Fetch({ ...pinned, url: "ftp://example.test/file" })).toThrow(/url/)
    expect(() => Fetch.Fetch({ ...pinned, url: "https://example.test/with space" })).toThrow(/url/)
    expect(() => Fetch.Fetch({ ...pinned, outs: "x" } as never)).toThrow(/excess property[\s\S]*outs/)
    expect(() => Fetch.Fetch(42 as never)).toThrow(/must be an object/)
  })

  it("holds out to the shared declared-output law", () => {
    expect(() => Fetch.Fetch({ ...pinned, out: "../outside" })).toThrow(/leaves the directory/)
    expect(() => Fetch.Fetch({ ...pinned, out: "/absolute" })).toThrow(/absolute/)
    expect(() => Fetch.Fetch({ ...pinned, out: ".flows/x" })).toThrow(/reserved/)
    expect(() => Fetch.Fetch({ ...pinned, out: "." })).toThrow(/names its own directory/)
  })

  it("refuses to read attrs from a target of another rule", () => {
    expect(() => Fetch.fetchAttrsOf(Shell.Run({ command: "echo hi" }))).toThrow(/expected a Fetch target/)
  })
})
