// Deep reviewed and polished by a human on 2026-08-10.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Canonical } from "../src/index.ts"

const serialize = (value: unknown): Canonical => Effect.runSync(Schema.decodeUnknownEffect(Canonical)(value))

const failure = (value: unknown) => Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Canonical)(value)))

const failureMessage = (value: unknown): string => failure(value).message

describe("Canonical", () => {
  it("canonicalizes through schema decoding", () => {
    expect(Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })).toBe("{\"a\":1,\"b\":2}")
  })

  it("produces valid JSON", () => {
    const document = serialize({ b: 2, a: [true, null] })
    expect(JSON.parse(document)).toEqual({ a: [true, null], b: 2 })
  })

  it("decodes a canonical document back into its JSON value", () => {
    const document = serialize({ b: 2, a: [true, null] })
    expect(Schema.encodeUnknownSync(Canonical)(document)).toEqual({ a: [true, null], b: 2 })
  })
})

describe("arrays", () => {
  it.each([
    ["empty array", [], "[]"],
    ["one element array", [123], "[123]"],
    ["multiple element array", [123, 456, "hello"], "[123,456,\"hello\"]"],
    ["null and undefined values", [null, undefined, "hello"], "[null,null,\"hello\"]"],
    ["object in array", [{ b: 123, a: "string" }], "[{\"a\":\"string\",\"b\":123}]"]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("objects", () => {
  it.each([
    ["empty object", {}, "{}"],
    ["undefined value", { test: undefined }, "{}"],
    ["null value", { test: null }, "{\"test\":null}"],
    ["one property", { hello: "world" }, "{\"hello\":\"world\"}"],
    ["multiple properties", { hello: "world", number: 123 }, "{\"hello\":\"world\",\"number\":123}"],
    ["numeric key", { 42: "foo" }, "{\"42\":\"foo\"}"],
    ["symbol value", { test: Symbol("hello world") }, "{}"],
    ["symbol key", { [Symbol("hello world")]: "foo" }, "{}"]
  ])("serializes an object with %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("primitive values", () => {
  it("serializes null", () => {
    expect(serialize(null)).toBe("null")
  })

  it.each([
    ["undefined", undefined],
    ["symbol", Symbol("hello world")]
  ])("rejects a top-level %s because the wrapper requires string output", (_name, input) => {
    expect(failureMessage(input)).toContain("The value is not valid JSON")
  })
})

describe("non-finite numbers", () => {
  it.each([
    ["NaN in an array", [Number.NaN], "NaN is not allowed"],
    ["NaN in an object", { key: Number.NaN }, "NaN is not allowed"],
    ["top-level NaN", Number.NaN, "NaN is not allowed"],
    ["Infinity in an array", [Number.POSITIVE_INFINITY], "Infinity is not allowed"],
    ["Infinity in an object", { key: Number.POSITIVE_INFINITY }, "Infinity is not allowed"],
    ["top-level -Infinity", Number.NEGATIVE_INFINITY, "Infinity is not allowed"]
  ])("rejects %s", (_name, input, message) => {
    expect(failureMessage(input)).toContain(message)
  })
})

describe("Unicode", () => {
  it.each([
    ["lone high surrogate in a value", { key: "\uD800" }],
    ["lone low surrogate in a value", { key: "\uDEAD" }],
    ["high surrogate before a non-low-surrogate", { key: "\uD800a" }],
    ["lone surrogate in an object key", { ["\uD800"]: "value" }]
  ])("rejects a %s", (_name, input) => {
    expect(failure(input)).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })

  it("allows a valid surrogate pair", () => {
    expect(serialize({ key: "\uD83D\uDE00" })).toBe("{\"key\":\"😀\"}")
  })
})

describe("toJSON", () => {
  it("uses an object's toJSON result", () => {
    const input = {
      a: 123,
      b: 456,
      toJSON() {
        return { b: this.b, a: this.a }
      }
    }
    expect(serialize(input)).toBe("{\"a\":123,\"b\":456}")
  })

  it("serializes nested toJSON results recursively", () => {
    expect(serialize({ x: { toJSON: () => ({ z: 1, a: 2 }) } })).toBe("{\"x\":{\"a\":2,\"z\":1}}")
  })

  it("rejects NaN returned by toJSON", () => {
    expect(failureMessage({ toJSON: () => Number.NaN })).toContain("NaN is not allowed")
  })

  it("reports a non-Error thrown by toJSON", () => {
    expect(failureMessage({
      toJSON: () => {
        throw "broken"
      }
    })).toContain("broken")
  })

  it("rejects toJSON returning its object", () => {
    const input: { toJSON?: () => unknown } = {}
    input.toJSON = () => input
    expect(failureMessage(input)).toContain("Circular reference detected")
  })
})

describe("values JSON.stringify coerces", () => {
  // JSON.stringify parity: a value with no JSON representation (a function, a
  // symbol, undefined, or a toJSON that returns undefined) serializes as null
  // inside an array and is omitted from an object. The pre-fix serializer
  // interpolated the recursive undefined instead, emitting invalid documents
  // such as `{"x":undefined}` and `[,]`.
  it.each([
    ["a function element", [(): number => 1], "[null]"],
    ["a function between elements", [123, (): number => 1, "hello"], "[123,null,\"hello\"]"],
    ["a toJSON returning undefined, in an array", [{ toJSON: (): undefined => undefined }], "[null]"],
    ["a function property", { x: (): number => 1 }, "{}"],
    ["a function property beside a kept one", { x: (): number => 1, y: 2 }, "{\"y\":2}"],
    ["a toJSON returning undefined, as a property", { x: { toJSON: (): undefined => undefined } }, "{}"],
    // An array hole has no JSON representation either, and `JSON.stringify`
    // renders it null like the rest. `Array.prototype.map` skips holes instead
    // of visiting them, so joining its result emitted `[,1]`, which no parser
    // accepts.
    ["a hole", [, 1], "[null,1]"],
    ["a trailing hole", [1, ,], "[1,null]"],
    ["only holes", [, ,], "[null,null]"]
  ])("serializes %s the way JSON.stringify does", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
    expect(serialize(input)).toBe(JSON.stringify(input))
  })

  it("canonicalizes the toJSON result of a function, which JSON.stringify also consults", () => {
    const fn = Object.assign(() => 1, { toJSON: () => ({ b: 1, a: 2 }) })
    // JSON.stringify(fn) is `{"b":1,"a":2}`; the canonical form sorts the keys.
    expect(serialize({ x: fn })).toBe("{\"x\":{\"a\":2,\"b\":1}}")
  })

  it("rejects a function whose toJSON returns itself", () => {
    const fn: { (): number; toJSON?: () => unknown } = (): number => 1
    fn.toJSON = (): unknown => fn
    expect(failureMessage({ x: fn })).toContain("Circular reference detected")
  })
})

describe("toJSON well-formedness", () => {
  it("has no canonical form for a lone surrogate returned by toJSON", () => {
    // The module docblock promises a value carrying a lone surrogate has no
    // canonical form and decoding fails rather than approximates. `toJSON` is
    // a door into the serializer that no pre-pass over the input value can
    // guard, so the well-formedness check lives in the serializer itself and
    // fires on the minted string.
    expect(failure({ toJSON: () => "\ud800" })).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })

  // The same guard on the key side: `toJSON` returning `{ "\ud800": 1 }` is refused, not emitted.
  it("has no canonical form for a lone surrogate key returned by toJSON", () => {
    expect(failure({ toJSON: () => ({ ["\ud800"]: 1 }) })).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })
})

describe("boxed primitives", () => {
  // RFC 8785 defers number and string serialization to ECMAScript, and
  // `JSON.stringify` unwraps a wrapper object through `valueOf`
  // (`JSON.stringify(new Number(1))` is `"1"`). This serializer has no
  // unwrapping step: it sees an object with no `toJSON` and walks its own
  // enumerable keys. The results below therefore diverge from both RFC 8785
  // and `JSON.stringify`. Pinned as current behavior, not endorsed.
  it.each([
    ["new Number(1) loses its value entirely", new Number(1), "{}"],
    ["new String(\"ab\") becomes an index-keyed object", new String("ab"), "{\"0\":\"a\",\"1\":\"b\"}"]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("host object shapes", () => {
  it("uses Date's toJSON, so a Date becomes an ISO string", () => {
    expect(serialize(new Date(0))).toBe("\"1970-01-01T00:00:00.000Z\"")
  })

  it("serializes a Uint8Array as an index-keyed object, not an array", () => {
    expect(serialize(new Uint8Array([1, 2, 255]))).toBe("{\"0\":1,\"1\":2,\"2\":255}")
  })

  it.each([
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1, 2])]
  ])("silently loses every entry of a %s", (_name, input) => {
    // Entries live in internal slots, not own enumerable properties, so a
    // populated collection and an empty one produce the same document and the
    // same digest. Callers must convert to a plain value before keying.
    expect(serialize(input)).toBe("{}")
  })

  it("walks a null-prototype object and honors only an own toJSON", () => {
    // `hasToJson` probes with `in`, which is safe on a null-prototype object
    // and finds nothing inherited, so the object is walked as plain data.
    const plain = Object.create(null) as Record<string, unknown>
    plain.a = 1
    expect(serialize(plain)).toBe("{\"a\":1}")

    // An own `toJSON` on a null-prototype object is still found and used.
    const withToJson = Object.create(null) as Record<string, unknown>
    withToJson.toJSON = () => ({ z: 9 })
    expect(serialize(withToJson)).toBe("{\"z\":9}")
  })
})

describe("prototype-pollution property names", () => {
  it("treats __proto__ as an ordinary member name however it was created", () => {
    // A digest must not depend on how the caller built the object. A parsed
    // document and a computed-key literal both carry an own `__proto__`
    // property, so both must canonicalize to the same bytes.
    const parsed = JSON.parse("{\"__proto__\":1}") as unknown
    expect(serialize(parsed)).toBe("{\"__proto__\":1}")
    expect(serialize({ ["__proto__"]: 1 })).toBe(serialize(parsed))
  })

  it("round trips __proto__, constructor and prototype with every property intact", () => {
    const input = JSON.parse("{\"__proto__\":1,\"constructor\":2,\"prototype\":3}") as unknown
    const document = serialize(input)
    expect(document).toBe("{\"__proto__\":1,\"constructor\":2,\"prototype\":3}")

    const decoded = Schema.encodeUnknownSync(Canonical)(document) as object
    expect(Object.keys(decoded)).toEqual(["__proto__", "constructor", "prototype"])
    // Read through descriptors: plain member access on `constructor` would
    // find the inherited one and hide a lost own property.
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe(1)
    expect(Object.getOwnPropertyDescriptor(decoded, "constructor")?.value).toBe(2)
    expect(Object.getOwnPropertyDescriptor(decoded, "prototype")?.value).toBe(3)
  })
})

describe("recursion depth", () => {
  it("surfaces stack exhaustion as a schema error rather than a raw RangeError", () => {
    // Open contract question: the docblock names lone surrogates, non-finite
    // numbers and cycles as the values with no canonical form. Nesting depth is
    // not on that list, yet `canonicalize` recurses once per level and a deep
    // enough document exhausts the host stack. `Effect.try` catches the
    // RangeError, so the failure is at least typed - but its message is a host
    // stack-size artifact and the depth at which it starts is unspecified, so
    // two hosts can disagree on whether a document is representable.
    let input: unknown = "leaf"
    for (let index = 0; index < 100_000; index++) input = { child: input }

    let thrown: unknown
    try {
      Effect.runSync(Schema.decodeUnknownEffect(Canonical)(input))
    } catch (error) {
      thrown = error
    }

    // Assert on the class and the message only: the offending value is 100k
    // levels deep and must never reach a diff.
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(RangeError)
    expect((thrown as { readonly _tag?: string })._tag).toBe("SchemaError")
    expect((thrown as Error).message).toContain("Maximum call stack size exceeded")
  })
})

describe("Unicode normalization of property names", () => {
  // Canonicalization must not normalize. Precomposed U+00E9 and decomposed
  // `e` + U+0301 are different key strings. Written as escapes throughout: the
  // two spellings render identically as literal source text, and an editor or
  // a filesystem may silently fold one into the other.
  it("keeps NFC and NFD spellings of a key distinct", () => {
    expect(serialize({ ["\u00e9"]: 1 })).not.toBe(serialize({ ["e\u0301"]: 1 }))
  })

  it("orders NFC and NFD keys by UTF-16 code unit", () => {
    // Both spellings in one document stay two separate members, ordered by
    // code unit: `e` is U+0065 and sorts before the precomposed U+00E9.
    expect(serialize({ ["\u00e9"]: 1, ["e\u0301"]: 2 })).toBe("{\"e\u0301\":2,\"\u00e9\":1}")
  })
})

describe("circular references", () => {
  it("rejects an object referencing itself", () => {
    const input: Record<string, unknown> = {}
    input.self = input
    expect(failureMessage(input)).toContain("Circular reference detected")
  })

  it("rejects an array referencing itself", () => {
    const input: Array<unknown> = []
    input.push(input)
    expect(failureMessage(input)).toContain("Circular reference detected")
  })

  it("rejects a nested circular reference", () => {
    const a: Record<string, unknown> = {}
    const b = { a }
    a.b = b
    expect(failureMessage(a)).toContain("Circular reference detected")
  })

  it("allows the same non-circular object twice", () => {
    const shared = { z: 1 }
    expect(serialize({ x: shared, y: shared })).toBe("{\"x\":{\"z\":1},\"y\":{\"z\":1}}")
  })
})

describe("upstream RFC fixtures", () => {
  it.each([
    ["arrays", [56, { d: true, 10: null, 1: [] }], "[56,{\"1\":[],\"10\":null,\"d\":true}]"],
    [
      "French sorting",
      {
        peach: "This sorting order",
        "péché": "is wrong according to French",
        "pêche": "but canonicalization MUST",
        sin: "ignore locale"
      },
      "{\"peach\":\"This sorting order\",\"péché\":\"is wrong according to French\",\"pêche\":\"but canonicalization MUST\",\"sin\":\"ignore locale\"}"
    ],
    [
      "structures",
      {
        1: { f: { f: "hi", F: 5 }, "\n": 56 },
        10: {},
        "": "empty",
        a: {},
        111: [{ e: "yes", E: "no" }],
        A: { b: "123" }
      },
      "{\"\":\"empty\",\"1\":{\"\\n\":56,\"f\":{\"F\":5,\"f\":\"hi\"}},\"10\":{},\"111\":[{\"E\":\"no\",\"e\":\"yes\"}],\"A\":{\"b\":\"123\"},\"a\":{}}"
    ],
    [
      "values",
      {
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
        string: "€$\u000F\nA'B\"\\\\\"/",
        literals: [null, true, false]
      },
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
    ],
    [
      "weird property names",
      {
        "€": "Euro Sign",
        1: "One",
        "\u0080": "Control",
        "😂": "Smiley",
        "ö": "Latin Small Letter O With Diaeresis",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "</script>": "Browser Challenge"
      },
      "{\"1\":\"One\",\"</script>\":\"Browser Challenge\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😂\":\"Smiley\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}"
    ]
  ])("matches the %s fixture", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("numeric boundaries", () => {
  it.each([
    ["zero", 0, "0"],
    ["negative zero", -0, "0"],
    ["smallest positive subnormal", Number.MIN_VALUE, "5e-324"],
    ["largest finite number", Number.MAX_VALUE, "1.7976931348623157e+308"],
    ["largest safe integer", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["smallest safe integer", Number.MIN_SAFE_INTEGER, "-9007199254740991"],
    ["exponential lower boundary", 1e-7, "1e-7"],
    ["decimal lower boundary", 1e-6, "0.000001"],
    ["decimal upper boundary", 1e20, "100000000000000000000"],
    ["exponential upper boundary", 1e21, "1e+21"]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })

  it("rejects bigint", () => {
    expect(failure(1n)).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })
})

describe("string boundaries", () => {
  it.each([
    ["empty string", "", "\"\""],
    ["quotation mark", "\"", "\"\\\"\""],
    ["reverse solidus", "\\", "\"\\\\\""],
    ["backspace", "\b", "\"\\b\""],
    ["form feed", "\f", "\"\\f\""],
    ["line feed", "\n", "\"\\n\""],
    ["carriage return", "\r", "\"\\r\""],
    ["tab", "\t", "\"\\t\""],
    ["lowest control character", "\u0000", "\"\\u0000\""],
    ["highest control character", "\u001f", "\"\\u001f\""],
    ["BMP boundary", "\uffff", "\"￿\""],
    ["highest Unicode scalar", "\uDBFF\uDFFF", "\"􏿿\""]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })

  it("preserves distinct NFC and NFD spellings", () => {
    expect(serialize("é")).not.toBe(serialize("e\u0301"))
  })

  it("serializes a one-megabyte string without truncation", () => {
    const value = "x".repeat(1024 * 1024)
    const output = serialize(value)
    expect(output.length).toBe(value.length + 2)
    expect(output).toBe(`"${value}"`)
  })
})

describe("collection boundaries", () => {
  it("uses UTF-16 code-unit order for property names", () => {
    expect(serialize({ "\uE000": 1, "😀": 2, a: 3, A: 4 })).toBe("{\"A\":4,\"a\":3,\"😀\":2,\"\":1}")
  })

  it("retains array order and duplicate values", () => {
    expect(serialize([3, 1, 3, 2])).toBe("[3,1,3,2]")
  })

  // Restated 2026-08-31. This cell pinned the pre-fix behavior: the serializer
  // skipped array holes, emitted `[,,"end"]`, and the schema's JSON.parse net
  // turned that invalid document into a decode failure. Rejection was the net
  // catching a defect, not the contract. The exported contract is
  // JSON.stringify parity, which renders a hole as null.
  it("serializes a sparse array's holes as null, as JSON.stringify does", () => {
    const sparse = new Array<unknown>(3)
    sparse[2] = "end"
    expect(serialize(sparse)).toBe("[null,null,\"end\"]")
    expect(serialize(sparse)).toBe(JSON.stringify(sparse))
  })

  it("serializes ten thousand array elements", () => {
    const input = Array.from({ length: 10_000 }, (_, index) => index)
    expect(serialize(input)).toBe(JSON.stringify(input))
  })

  it("sorts ten thousand object properties", () => {
    const input = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key-${10_000 - index}`, index]))
    const output = serialize(input)
    expect(Object.keys(JSON.parse(output) as object)).toEqual(Object.keys(input).sort())
  })

  it("serializes deeply nested JSON", () => {
    let input: unknown = "leaf"
    for (let index = 0; index < 200; index++) input = { child: input }
    expect(JSON.parse(serialize(input))).toEqual(input)
  })

  it("does not mistake many shared references for cycles", () => {
    const shared = { value: true }
    const input = Array.from({ length: 1_000 }, () => shared)
    expect(JSON.parse(serialize(input))).toEqual(input)
  })
})

describe("unsupported value boundaries", () => {
  it.each([
    ["function at the top level", () => undefined],
    ["symbol at the top level", Symbol("value")],
    ["undefined at the top level", undefined]
  ])("fails for %s", (_name, input) => {
    expect(failureMessage(input)).toContain("The value is not valid JSON")
  })

  // Restated 2026-08-31. These two cells used to pin the pre-fix behavior (a
  // decode failure born from the invalid `{"kept":true,"omitted":undefined}`
  // interpolation, and `[]` from joining a recursive undefined). The exported
  // contract is JSON.stringify parity: a function property is omitted and a
  // function element serializes as null.
  it("omits a function-valued object property, as JSON.stringify does", () => {
    expect(serialize({ kept: true, omitted: () => undefined })).toBe("{\"kept\":true}")
  })

  it("serializes a function-valued array element as null, as JSON.stringify does", () => {
    expect(serialize([() => undefined])).toBe("[null]")
  })
})

describe("Canonical repeated-reference validation", () => {
  it("validates both occurrences of an object that appears twice", () => {
    // The serializer's cycle tracking removes an object from `ancestors` once
    // its subtree is written, so a shared object is re-walked — and therefore
    // re-validated — at every occurrence. A future change that skipped repeated
    // objects would have to keep the guarantee these cells pin: a lone
    // surrogate is refused whichever occurrence reaches it, and a valid object
    // repeated is not rejected.
    const invalid = { text: "lone \ud800 surrogate" }

    // Reached first through `a`: the rejection comes from the first visit.
    expect(failure({ a: invalid, b: invalid })).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    // And the same object repeated inside an array, where the repeat is the
    // second element rather than a sibling key.
    expect(failure([invalid, invalid])).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    // A valid object repeated is not mistaken for a cycle or rejected.
    const shared = { text: "fine" }
    expect(serialize({ a: shared, b: shared })).toBe("{\"a\":{\"text\":\"fine\"},\"b\":{\"text\":\"fine\"}}")
  })

  it("rejects a value whose only invalid occurrence is the repeated one", () => {
    // The ordering half: the invalid object is visited first at `a`, nested a
    // level deeper, so visit order can never be what decides validity.
    const invalid = { text: "\udfff" }
    expect(failure({ a: { nested: invalid }, b: invalid })).toEqual(
      expect.objectContaining({ _tag: "SchemaError" })
    )
  })
})
