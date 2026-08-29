import * as Digest from "@smthrs/core/Digest"
import { describe, expect, it } from "vitest"
import * as Script from "../src/Script.ts"
import { flow } from "./harness.ts"

describe("Script", () => {
  it("digests the script text", () => {
    const script = Script.make("return done(null)")
    expect(script.text).toBe("return done(null)")
    expect(script.digest).toBe(Digest.digest("return done(null)"))
  })

  it("re-keys on any text change", () => {
    expect(Script.make("a").digest).not.toBe(Script.make("b").digest)
  })

  it("extracts the body of exactly one flow block", () => {
    const raw = ["Some prose.", flow("return done(1)"), "Trailing prose."].join("\n")
    const extraction = Script.extract(raw)
    expect(extraction._tag).toBe("Extracted")
    if (extraction._tag === "Extracted") {
      expect(extraction.script.text).toBe("return done(1)")
      expect(extraction.script.digest).toBe(Digest.digest("return done(1)"))
    }
  })

  it("rejects output with no flow block", () => {
    const extraction = Script.extract("just prose")
    expect(extraction).toEqual({ _tag: "Rejected", reason: "the author output contains no ```flow block" })
  })

  it("rejects a differently tagged fence", () => {
    const extraction = Script.extract("```js\nreturn done(1)\n```")
    expect(extraction._tag).toBe("Rejected")
  })

  it("rejects output with more than one flow block", () => {
    const raw = [flow("return done(1)"), flow("return done(2)")].join("\n")
    const extraction = Script.extract(raw)
    expect(extraction._tag).toBe("Rejected")
    if (extraction._tag === "Rejected") {
      expect(extraction.reason).toContain("2")
    }
  })
})
