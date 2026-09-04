import { describe, expect, it } from "vitest"
import { failureMessage } from "./failure-message.ts"

describe("failureMessage", () => {
  it("renders a plain error message", () => {
    expect(failureMessage(new Error("state directory is read-only"))).toBe("state directory is read-only")
  })

  it("does not render anything that is not an error", () => {
    expect(failureMessage("a thrown string")).toBe("unrenderable failure")
    expect(failureMessage(undefined)).toBe("unrenderable failure")
  })

  it("does not run a message accessor on the way to the terminal", () => {
    let reads = 0
    const hostile = Object.defineProperty(new Error("hidden"), "message", {
      get: () => {
        reads += 1
        return "computed"
      }
    })

    expect(failureMessage(hostile)).toBe("unrenderable failure")
    expect(reads).toBe(0)
  })

  it("survives a failure that throws when it is inspected", () => {
    const revocable = Proxy.revocable(new Error("revoked"), {})
    revocable.revoke()

    expect(failureMessage(revocable.proxy)).toBe("unrenderable failure")
  })
})
