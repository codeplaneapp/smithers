import * as Fetch from "@smthrs/targets/Fetch"
import { describe, expect, it } from "vitest"
import * as FetchExec from "../src/FetchExec.ts"

// SHA-256 of an empty file. Planning needs neither the file nor an HTTP server.
const attrs = {
  url: "https://example.invalid/empty.bin",
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  out: "nested/empty.bin"
}

describe("public Fetch planning adapters", () => {
  it.each([
    [".", "nested/empty.bin"],
    ["data", "data/nested/empty.bin"]
  ])("resolves validated attrs relative to package %j", (packagePath, output) => {
    expect(FetchExec.planAttrs({ packagePath, attrs })).toEqual({
      outFiles: [output],
      sandbox: { network: true }
    })
  })

  it.each([
    [".", "nested/empty.bin"],
    ["data", "data/nested/empty.bin"]
  ])("resolves a declaration relative to package %j", (packagePath, output) => {
    expect(FetchExec.plan({ packagePath, target: Fetch.Fetch(attrs) })).toEqual({
      outFiles: [output],
      sandbox: { network: true }
    })
  })

  it("retains the existing refusal for an empty output cwd", () => {
    const refused = {
      outFiles: [],
      sandbox: { network: true },
      refusal: "Fetch the output cwd \"\" is empty"
    }
    expect(FetchExec.planAttrs({ packagePath: "", attrs })).toEqual(refused)
    expect(FetchExec.plan({ packagePath: "", target: Fetch.Fetch(attrs) })).toEqual(refused)
  })
})
