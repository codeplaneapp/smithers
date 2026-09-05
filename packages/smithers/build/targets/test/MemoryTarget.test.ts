/**
 * Memory target accessors and every optional Smithers Cloud payload shape.
 *
 * Optional fields are deliberately omitted rather than serialized as
 * undefined, while caller-owned arrays are copied before entering the inert
 * workspace declaration.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as MemoryTarget from "../src/MemoryTarget.ts"
import * as Reference from "../src/Reference.ts"
import * as Secret from "../src/Secret.ts"
import * as Shell from "../src/Shell.ts"

const script = Input.file("//scripts/memory-init.mjs")
const credential = Secret.HttpSecret(Secret.Secret("MEMORY_TOKEN"), ["https://memory.example.test"])

describe("Memory.Retain", () => {
  it("returns the validated source and tags of a retain target", () => {
    const source = Reference.gitCommit("HEAD")
    const target = MemoryTarget.Retain({ source, tags: ["release", "verified"] })

    expect(MemoryTarget.retainAttrsOf(target)).toEqual({ source, tags: ["release", "verified"] })
  })

  it("refuses to read retain attrs from another target kind", () => {
    const operation = () => MemoryTarget.retainAttrsOf(Shell.Test({ shell: "true" }))

    expect(operation).toThrow(TypeError)
    expect(operation).toThrow("expected a Memory.Retain target, received Shell.Test")
  })
})

describe("Memory.SmithersCloud", () => {
  it.each([
    {
      name: "bank only",
      options: { bank: ["engineering"] },
      expected: { _tag: "MemorySmithersCloud", bank: ["engineering"] }
    },
    {
      name: "automatic injection",
      options: { bank: ["engineering"], autoInject: 0 },
      expected: { _tag: "MemorySmithersCloud", bank: ["engineering"], autoInject: 0 }
    },
    {
      name: "initializer without credentials",
      options: { bank: ["engineering"], init: { script } },
      expected: { _tag: "MemorySmithersCloud", bank: ["engineering"], init: { script } }
    },
    {
      name: "initializer with credentials",
      options: { bank: ["engineering"], init: { script, secrets: [credential] } },
      expected: {
        _tag: "MemorySmithersCloud",
        bank: ["engineering"],
        init: { script, secrets: [credential] }
      }
    },
    {
      name: "automatic injection and initializer",
      options: { bank: ["engineering"], autoInject: 3, init: { script } },
      expected: {
        _tag: "MemorySmithersCloud",
        bank: ["engineering"],
        autoInject: 3,
        init: { script }
      }
    },
    {
      name: "every optional field",
      options: { bank: ["engineering"], autoInject: 3, init: { script, secrets: [credential] } },
      expected: {
        _tag: "MemorySmithersCloud",
        bank: ["engineering"],
        autoInject: 3,
        init: { script, secrets: [credential] }
      }
    }
  ])("builds the $name payload", ({ options, expected }) => {
    const declaration = MemoryTarget.SmithersCloud(options)

    expect(declaration).toEqual(expected)
    expect(MemoryTarget.isSmithersCloudDeclaration(declaration)).toBe(true)
  })

  it("copies caller-owned bank and credential arrays", () => {
    const bank = ["engineering"]
    const secrets = [credential]
    const declaration = MemoryTarget.SmithersCloud({ bank, init: { script, secrets } })

    expect(declaration.bank).not.toBe(bank)
    expect(declaration.init?.secrets).not.toBe(secrets)
  })
})
