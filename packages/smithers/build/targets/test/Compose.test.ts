/**
 * Composition declarations and the executable file-set plans they produce.
 *
 * These cases pin the distinct-node contracts of aliases and materialization,
 * the resolver inputs exposed by import closures, and every refusal by which
 * file algebra avoids silently treating an unsupported target as an empty set.
 */
import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const command = Shell.Test({ shell: "true" })

describe("composition wrappers", () => {
  it("gives an alias its own node while preserving the target kinds and dependency", () => {
    const alias = Compose.Alias(command)

    expect(alias).not.toBe(command)
    expect(Target.metadata(alias).kinds).toEqual(Target.metadata(command).kinds)
    expect(Target.metadata(alias).dependencies).toEqual([command])
    expect(plannedCalls(alias)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Alias" } }
    ])
  })

  it("materializes only the target it names", () => {
    const materialized = Compose.Materialize(command)

    expect(Target.metadata(materialized).dependencies).toEqual([command])
    expect(plannedCalls(materialized)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Materialize" } }
    ])
  })

  it("keeps suite members and clean targets as dependency edges", () => {
    const suite = Compose.Suite({ tests: [command] })
    const clean = Compose.Clean({ targets: [command], paths: ["dist"] })

    expect(Target.metadata(suite).dependencies).toEqual([command])
    expect(plannedCalls(suite)[0]?.payload).toEqual({ target: "Suite" })
    expect(Target.metadata(clean).dependencies).toEqual([command])
    expect(plannedCalls(clean)[0]?.payload).toEqual({ target: "Clean" })
  })

  it.each([
    ["Alias", () => Compose.Alias(42 as never), "Alias requires a target"],
    ["Materialize", () => Compose.Materialize(42 as never), "Materialize requires a target"]
  ])("refuses a non-target passed to %s", (_name, operation, message) => {
    expect(operation).toThrow(TypeError)
    expect(operation).toThrow(message)
  })
})

describe("Generate plans", () => {
  it("plans bin and command forms while refusing an executor-owned emit form", () => {
    const bin = Reference.NodeModule.Bin("formatter", "format")
    const binCall = plannedCalls(Compose.Generate({ bin, args: ["--write"], changes: ["out.txt"] }))[0]
    expect(binCall?.action).toBe("smithers-build/exec")
    expect(binCall?.payload["argv"]).toEqual([Shell.toolToken(bin), "--write"])

    const commandCall = plannedCalls(Compose.Generate({ command: "printf generated", changes: ["out.txt"] }))[0]
    expect(commandCall?.action).toBe("smithers-build/exec")
    expect(commandCall?.payload["argv"]).toEqual(["/bin/sh", "-c", "printf generated"])

    expect(plannedCalls(Compose.Generate({ emit: { "out.txt": "generated" } }))).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Generate" } }
    ])
  })
})

describe("Files declarations", () => {
  it.each([
    [42, command],
    [command, { _tag: "TargetFiles", target: 42 }]
  ])("refuses a difference with an invalid operand", (left, right) => {
    expect(() => Compose.Files.difference(left as never, right as never)).toThrow(TypeError)
    expect(() => Compose.Files.difference(left as never, right as never))
      .toThrow("Files.difference operands must be targets or target .files references")
  })

  it("exposes an import closure through a non-enumerable immutable files reference", () => {
    const closure = Compose.ImportClosure({ entries: Input.file("src/index.ts") })
    const descriptor = Object.getOwnPropertyDescriptor(closure, "files")

    expect(descriptor).toMatchObject({ configurable: false, enumerable: false, writable: false })
    expect(closure.files).toEqual({ _tag: "TargetFiles", target: closure })
    expect(Object.isFrozen(closure.files)).toBe(true)
    expect(Compose.isImportClosure(closure)).toBe(true)
    expect(Compose.isImportClosure(command)).toBe(false)
  })
})

describe("ImportClosure", () => {
  it("resolves files and globs against an explicit filegroup cwd", () => {
    const entries = Filegroup.Filegroup({
      cwd: "packages/app",
      srcs: [
        Input.file("src/index.ts"),
        Input.glob("src/**/*.ts", { exclude: ["src/**/*.test.ts"] })
      ]
    })
    const closure = Compose.ImportClosure({ entries })

    expect(plannedCalls(closure)).toEqual([
      {
        action: "smithers-build/import-closure",
        payload: {
          entries: [
            { base: "", source: { _tag: "File", path: "packages/app/src/index.ts" } },
            {
              base: "",
              source: {
                _tag: "Glob",
                pattern: "packages/app/src/**/*.ts",
                exclude: ["packages/app/src/**/*.test.ts"]
              }
            }
          ]
        }
      }
    ])
  })

  it("refuses a target that cannot expose entry files", () => {
    const closure = Compose.ImportClosure({ entries: command })

    expect(plannedCalls(closure)).toEqual([
      {
        action: "smithers-build/not-implemented",
        payload: { target: "ImportClosure: target Shell.Test cannot provide entry files yet" }
      }
    ])
  })

  it("anchors direct sources at the declaration context supplied by the caller", () => {
    expect(Compose.closureEntrySources(
      [Input.file("index.ts"), Input.glob("src/**/*.ts")],
      { sourceFile: "/workspace/packages/app/legacy declaration", packageDirectory: "/workspace/packages/app" }
    )).toEqual([
      { base: "/workspace/packages/app", source: Input.file("index.ts") },
      { base: "/workspace/packages/app", source: Input.glob("src/**/*.ts") }
    ])
  })
})

describe("file-set checks", () => {
  const left = Filegroup.Filegroup({ cwd: "packages/app", srcs: [Input.glob("src/**/*.ts")] })
  const right = Filegroup.Filegroup({ cwd: "packages/app", srcs: [Input.glob("src/**/*.test.ts")] })

  it("plans the difference action for two resolvable source sets", () => {
    const target = Compose.Test({ expect: Compose.Files.difference(left, right), toBe: "empty" })

    expect(plannedCalls(target)).toEqual([
      {
        action: "smithers-build/files-difference",
        payload: {
          left: {
            _tag: "SourceSet",
            sources: [{ base: "", source: Input.glob("packages/app/src/**/*.ts") }]
          },
          right: {
            _tag: "SourceSet",
            sources: [{ base: "", source: Input.glob("packages/app/src/**/*.test.ts") }]
          },
          toBe: "empty"
        }
      }
    ])
  })

  it("reduces both an import closure and its .files reference to closure entries", () => {
    const closure = Compose.ImportClosure({ entries: left })
    const expected = {
      _tag: "Closure",
      entries: [{ base: "", source: Input.glob("packages/app/src/**/*.ts") }]
    }

    expect(Compose.checkOperand(closure)).toEqual(expected)
    expect(Compose.checkOperand(closure.files)).toEqual(expected)
  })

  it("names unsupported operands instead of treating them as empty", () => {
    expect(Compose.checkOperand(command)).toBe("target Shell.Test does not expose a resolvable file set yet")

    const leftUnsupported = Compose.Test({
      expect: Compose.Files.difference(command, right),
      toBe: "empty"
    })
    expect(plannedCalls(leftUnsupported)[0]?.payload).toEqual({
      target: "Test: target Shell.Test does not expose a resolvable file set yet"
    })

    const rightUnsupported = Compose.Test({
      expect: Compose.Files.difference(left, command),
      toBe: "empty"
    })
    expect(plannedCalls(rightUnsupported)[0]?.payload).toEqual({
      target: "Test: target Shell.Test does not expose a resolvable file set yet"
    })
  })

  it("leaves digest and manifest comparisons to the build system", () => {
    const digest = Compose.Test({ expect: Compose.Files.digest(left), toBe: "empty" })
    const manifest = Compose.Test({
      expect: Compose.Files.difference(left, right),
      toBe: Input.file("expected-files.json")
    })

    expect(plannedCalls(digest)[0]?.payload).toEqual({
      target: "Test: Files.digest comparison is executed by the build system"
    })
    expect(plannedCalls(manifest)[0]?.payload).toEqual({
      target: "Test: a file-set difference can only compare to empty"
    })
  })
})
