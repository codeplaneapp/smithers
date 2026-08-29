import { describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"

describe("Diagnostic", () => {
  it("renders data without invoking accessors, proxies, or object conversion", () => {
    let calls = 0
    const getter = Object.defineProperty({}, "message", {
      get: () => {
        calls += 1
        return "getter message"
      }
    })
    const converted = {
      toString: () => {
        calls += 1
        return "converted message"
      }
    }
    const proxy = new Proxy(new Error("proxy message"), {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })

    expect(Diagnostic.message(getter, "fallback")).toBe("fallback")
    expect(Diagnostic.message(converted, "fallback")).toBe("fallback")
    expect(Diagnostic.message(proxy, "fallback")).toBe("fallback")
    expect(calls).toBe(0)
  })

  it("preserves a safe native Error and wraps every other rejection", () => {
    const native = new Error("native")
    expect(Diagnostic.error(native)).toBe(native)
    expect(Diagnostic.error("text").message).toBe("text")
    expect(Diagnostic.error({}).message).toBe("operation failed")
  })

  it("renders primitives through String and empty text through the fallback", () => {
    expect(Diagnostic.message(42)).toBe("42")
    expect(Diagnostic.message(10n)).toBe("10")
    expect(Diagnostic.message(false)).toBe("false")
    expect(Diagnostic.message(Symbol("tag"))).toBe("Symbol(tag)")
    expect(Diagnostic.message(undefined, "fallback")).toBe("fallback")
    expect(Diagnostic.message(null, "fallback")).toBe("fallback")
    expect(Diagnostic.message("", "fallback")).toBe("fallback")
  })

  it("reads an own data message from objects and functions only", () => {
    expect(Diagnostic.message({ message: "plain" })).toBe("plain")
    expect(Diagnostic.message(Object.assign(() => undefined, { message: "callable" }))).toBe("callable")
    expect(Diagnostic.message({ message: 42 }, "fallback")).toBe("fallback")
    expect(Diagnostic.message({}, "fallback")).toBe("fallback")
    expect(Diagnostic.message(Object.create({ message: "inherited" }), "fallback")).toBe("fallback")
  })

  it("wraps native Errors whose message is empty, malformed, oversized, or accessor-backed", () => {
    const empty = new Error("")
    const wrapped = Diagnostic.error(empty)
    expect(wrapped).not.toBe(empty)
    expect(wrapped.message).toBe("operation failed")
    expect(wrapped.cause).toBe(empty)
    expect(Diagnostic.error(new Error("bad\ud800text")).message).toBe("bad\ufffdtext")
    expect(Diagnostic.error(new Error("x".repeat(Diagnostic.maximumMessageCodeUnits + 1))).message).toHaveLength(
      Diagnostic.maximumMessageCodeUnits
    )
    const getter = Object.defineProperty(new Error("own"), "message", { get: () => "getter" })
    expect(Diagnostic.error(getter, "fallback").message).toBe("fallback")
    expect(Diagnostic.error({ message: "plain" }).message).toBe("plain")
    expect(Diagnostic.error(new Proxy(new Error("proxied"), {}), "fallback").message).toBe("fallback")
    expect(Diagnostic.error(7).message).toBe("7")
    expect(Diagnostic.error(null, "fallback").message).toBe("fallback")
  })

  it("bounds and well-forms messages", () => {
    expect(Diagnostic.message("bad\ud800text")).toBe("bad\ufffdtext")
    expect(Diagnostic.message("x".repeat(Diagnostic.maximumMessageCodeUnits + 1))).toHaveLength(
      Diagnostic.maximumMessageCodeUnits
    )
  })
})
