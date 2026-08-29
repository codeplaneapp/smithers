/**
 * Cache-key encoding and implementation identity.
 *
 * The planner's content key is what the local and remote caches address on, so
 * two properties are correctness properties rather than niceties:
 *
 * 1. It is INJECTIVE. Two different pieces of key material must never hash to
 *    one key, or one action answers for another.
 * 2. It is HOST STABLE. Two machines with the same sources and the same tree
 *    must agree on the key, or they cannot share a cache.
 */
import * as SafeFs from "@smthrs/targets/SafeFs"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  encodeKeyMaterial,
  fingerprintSources,
  implementationFingerprint,
  type KeyMaterial,
  KeyMaterialError,
  keyOf,
  maximumSourceFileBytes,
  productionSourceRoots
} from "../src/Planner.ts"

const material = (body: unknown): KeyMaterial => ({ body, inputs: null, layers: [], capabilities: [] })

const temporaries: Array<string> = []

const scratch = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-fingerprint-"))
  temporaries.push(directory)
  return directory
}

/** Copies one source tree, so a test can mutate a copy of the real thing. */
const copyTree = async (from: string, to: string): Promise<void> => {
  await Fs.cp(from, to, { recursive: true, dereference: false })
}

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await Fs.rm(directory, { recursive: true, force: true })
  }
})

describe("keyOf", () => {
  it("hashes object keys in code-unit order, independent of the host locale", () => {
    // `localeCompare` answers differently under different host locales and ICU
    // versions: in an English locale `a` sorts before `Z`, by code unit `Z`
    // (0x5A) sorts before `a` (0x61). Equal material used to hash to different
    // keys on different machines.
    expect(encodeKeyMaterial(material({ a: 1, Z: 2 }))).toContain("s1:Zd2;s1:ad1;")
    expect(keyOf(material({ a: 1, Z: 2 }))).toBe(keyOf(material({ Z: 2, a: 1 })))
  })

  it("hashes equal material identically regardless of declaration order", () => {
    expect(keyOf({ body: { a: 1, Z: 2 }, inputs: null, layers: [], capabilities: [] }))
      .toBe(keyOf({ inputs: null, capabilities: [], layers: [], body: { Z: 2, a: 1 } }))
  })

  it("hashes the documented encoding, not a JSON rendering", () => {
    expect(keyOf(material(null))).toBe(
      createHash("sha256")
        .update("smithers-build-key/1\u0000o4:s4:bodyns12:capabilitiesa0:s6:inputsns6:layersa0:", "utf8")
        .digest("hex")
    )
  })

  /**
   * Every pair here collapsed to one key under `JSON.stringify` of the old
   * canonical form, or under the sentinel strings it substituted. Each is a
   * real confusion: a target attr that is the string `"1"` is not the number 1,
   * and an attr that literally holds `"@smthrs:undefined@"` is not an absent
   * one.
   */
  it.each([
    ["a number and its decimal string", 1, "1"],
    ["true and its string", true, "true"],
    ["null and its string", null, "null"],
    ["null and undefined", null, undefined],
    ["undefined and the old undefined sentinel", undefined, "@smthrs:undefined@"],
    ["an empty array and an empty object", [], {}],
    ["zero and negative zero", 0, -0],
    ["a nested array and its flattening", [["a"], ["b"]], [["a", "b"]]],
    ["two string splits", ["ab", "c"], ["a", "bc"]],
    ["an absent member and an undefined one", {}, { value: undefined }],
    ["an object and an array of its entries", { 0: "a" }, ["a"]]
  ])("keeps %s distinct", (_name, left, right) => {
    expect(keyOf(material(left))).not.toBe(keyOf(material(right)))
  })

  it("keeps a value that legitimately appears twice from reading as a cycle", () => {
    const shared = { path: "src/index.ts" }
    expect(() => keyOf(material({ first: shared, second: shared }))).not.toThrow()
    expect(keyOf(material({ first: shared, second: shared })))
      .toBe(keyOf(material({ first: { path: "src/index.ts" }, second: { path: "src/index.ts" } })))
  })

  /**
   * Fail closed. Every one of these used to hash to something: a cycle became
   * the string `"<cycle>"`, `NaN` and `Infinity` became `null`, and a class
   * instance became whatever its enumerable properties happened to be. A key
   * that two different actions can share is worse than no key at all, so the
   * plan fails instead.
   */
  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }],
    ["NaN", () => ({ value: Number.NaN })],
    ["Infinity", () => ({ value: Number.POSITIVE_INFINITY })],
    ["a bigint", () => ({ value: 1n })],
    ["a symbol", () => ({ value: Symbol("s") })],
    ["a function", () => ({ value: () => 1 })],
    ["a Date", () => ({ value: new Date(0) })],
    ["a Map", () => ({ value: new Map() })],
    ["a class instance", () => ({
      value: new (class Holder {
        readonly a = 1
      })()
    })],
    ["a null-prototype value nested under an accessor", () => {
      const holder = {}
      Object.defineProperty(holder, "value", { get: () => 1, enumerable: true, configurable: true })
      return holder
    }],
    ["a sparse array", () => ({ value: [1, , 3] })],
    ["an array with an extra own property", () => {
      const list = [1]
      Object.assign(list, { extra: 2 })
      return list
    }],
    ["an array accessor", () => {
      const list = [1]
      Object.defineProperty(list, "0", { get: () => 1, enumerable: true, configurable: true })
      return list
    }],
    ["a sparse array whose extra property hides the hole by count", () => {
      const list = [1, 2]
      delete list[0]
      Object.assign(list, { extra: 3 })
      return list
    }],
    ["a symbol-keyed own property", () => ({ [Symbol.for("smthrs/test")]: 1 })],
    ["a non-enumerable own property", () => {
      const holder = { visible: 1 }
      Object.defineProperty(holder, "hidden", { value: 2, enumerable: false })
      return holder
    }],
    ["a Proxy", () => new Proxy({ value: 1 }, {})],
    ["an unpaired high surrogate", () => "\uD800"],
    ["an unpaired low surrogate", () => "\uDC00"],
    ["an unpaired surrogate in an object key", () => ({ ["\uD800"]: 1 })]
  ])("refuses %s", (_name, build) => {
    expect(() => keyOf(material(build()))).toThrow(KeyMaterialError)
  })

  it("accepts a null-prototype object as a plain one", () => {
    const holder = Object.create(null) as Record<string, unknown>
    holder["a"] = 1
    expect(keyOf(material(holder))).toBe(keyOf(material({ a: 1 })))
  })
})

describe("implementationFingerprint", () => {
  it("digests the production source trees", async () => {
    await expect(implementationFingerprint()).resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * The regression this closes: `Target.make` digests only `String(implementation)`,
   * the text of the function a target declaration passes it. Every helper that
   * function calls, every action layer that implements the nodes it plans, and
   * the executor's own admission logic are invisible to it. Editing
   * `measureOutput` therefore left every stored entry addressable under an
   * unchanged key, and the next run answered from results the old
   * implementation produced. Nothing about attrs, the lockfile, or the
   * function text changes below — only a helper's bytes.
   */
  it("changes when a helper source changes, with no salt to remember", async () => {
    const roots = productionSourceRoots()
    const copies = await scratch()
    for (const root of roots) {
      await copyTree(root.directory, NodePath.join(copies, root.name)).catch(() => undefined)
    }
    const copied = roots.map((root) => ({ name: root.name, directory: NodePath.join(copies, root.name) }))

    // A faithful copy at a different absolute path fingerprints identically:
    // only logical names and bytes are digested, so two checkouts share a cache.
    const before = await fingerprintSources(copied)
    expect(before).toBe(await implementationFingerprint())

    const helper = NodePath.join(copies, "targets/Input.ts")
    const source = await Fs.readFile(helper, "utf8")
    await Fs.writeFile(helper, `${source}\n// one changed byte of a helper\n`, "utf8")

    expect(await fingerprintSources(copied)).not.toBe(before)
  })

  it("distinguishes an absent tree from an empty one", async () => {
    const present = await scratch()
    await Fs.mkdir(NodePath.join(present, "empty"), { recursive: true })
    const absent = await fingerprintSources([{ name: "x", directory: NodePath.join(present, "missing") }])
    const empty = await fingerprintSources([{ name: "x", directory: NodePath.join(present, "empty") }])
    expect(absent).not.toBe(empty)
  })

  it("digests file bytes, not names alone", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "a.ts"), "export const a = 1\n", "utf8")
    const before = await fingerprintSources([{ name: "x", directory }])
    await Fs.writeFile(NodePath.join(directory, "a.ts"), "export const a = 2\n", "utf8")
    expect(await fingerprintSources([{ name: "x", directory }])).not.toBe(before)
  })

  it("refuses an implementation source file over the scan ceiling", async () => {
    const directory = await scratch()
    const source = NodePath.join(directory, "oversized.ts")
    await Fs.writeFile(source, "x", "utf8")
    await Fs.truncate(source, maximumSourceFileBytes + 1)
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow(/implementation source file is larger/)
  })

  it("rejects a source root over its cumulative ceiling before reading source bytes", async () => {
    const directory = await scratch()
    // Sparse files give the inspection pass real, adversarial file metadata
    // without allocating 512 MiB. The spy makes the proof about reads rather
    // than timing: no digest may start once the cumulative admission fails.
    for (let index = 0; index <= 32; index += 1) {
      const source = NodePath.join(directory, `${String(index).padStart(3, "0")}.ts`)
      await Fs.writeFile(source, "x", "utf8")
      await Fs.truncate(source, maximumSourceFileBytes)
    }
    const digest = vi.spyOn(SafeFs, "digestEntry")
    try {
      await expect(fingerprintSources([{ name: "x", directory }]))
        .rejects.toThrow(/implementation source root exceeds/)
      expect(digest).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
  })

  it("rejects aggregate source bytes across roots before hashing any root", async () => {
    const roots = await Promise.all([scratch(), scratch(), scratch()])
    for (const directory of roots) {
      for (let index = 0; index < 22; index += 1) {
        const source = NodePath.join(directory, `${String(index).padStart(3, "0")}.ts`)
        await Fs.writeFile(source, "x", "utf8")
        await Fs.truncate(source, maximumSourceFileBytes)
      }
    }
    const digest = vi.spyOn(SafeFs, "digestEntry")
    try {
      await expect(fingerprintSources(roots.map((directory, index) => ({ name: `x${index}`, directory }))))
        .rejects.toThrow(/implementation sources exceed/)
      expect(digest).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
  })

  it("rejects a source that grows after admission before hashing it", async () => {
    const directory = await scratch()
    const source = NodePath.join(directory, "admitted.ts")
    await Fs.writeFile(source, "export const admitted = 1\n", "utf8")
    const digestEntry = SafeFs.digestEntry
    const digest = vi.spyOn(SafeFs, "digestEntry").mockImplementationOnce(async (entry, options) => {
      await Fs.appendFile(source, "// grew after admission\n", "utf8")
      return digestEntry(entry, options)
    })
    try {
      await expect(fingerprintSources([{ name: "x", directory }]))
        .rejects.toThrow(/changed while it was being opened/)
    } finally {
      digest.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("does not follow symbolic links in a source tree", async () => {
    const directory = await scratch()
    const outside = await scratch()
    await Fs.writeFile(NodePath.join(outside, "secret.ts"), "export const secret = 1\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "secret.ts"), NodePath.join(directory, "linked.ts"))

    const linked = await fingerprintSources([{ name: "x", directory }])
    await Fs.unlink(NodePath.join(directory, "linked.ts"))
    expect(linked).toBe(await fingerprintSources([{ name: "x", directory }]))
  })

  it("refuses a filename that may be the lossy decoding of invalid host bytes", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "bad\ufffd.ts"), "export const value = 1\n", "utf8")
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow(/invalid entry name/)
  })

  it("honors cancellation before walking source trees", async () => {
    const controller = new AbortController()
    controller.abort(new Error("fingerprint cancelled"))
    await expect(fingerprintSources([{ name: "x", directory: await scratch() }], {
      signal: controller.signal
    })).rejects.toThrow("fingerprint cancelled")
  })
})
