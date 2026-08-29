import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Edit from "../src/Edit.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** Applies one edit and returns the file as the same host then reads it. */
const editThenRead = (
  files: Readonly<Record<string, string>>,
  input: Parameters<typeof Edit.run>[0]
) =>
  execute(Effect.provide(
    Effect.gen(function*() {
      const result = yield* Edit.run(input)
      const fileSystem = yield* FileSystem.FileSystem
      const content = yield* fileSystem.readFileString(input.path)
      return { result, content }
    }),
    layer({ files })
  ))

const refusal = (
  files: Readonly<Record<string, string>>,
  input: Parameters<typeof Edit.run>[0]
) =>
  execute(Effect.provide(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Edit.run(input))
      const fileSystem = yield* FileSystem.FileSystem
      const content = yield* fileSystem.readFileString(input.path)
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      return { content, failure: Option.getOrUndefined(failure) }
    }),
    layer({ files })
  ))

describe("Edit anchoring", () => {
  it("replaces a byte-exact block and returns the applied hunk", async () => {
    const { content, result } = await editThenRead(
      { "/a.py": "def add(a, b):\n    return a - b\n" },
      { path: "/a.py", oldString: "return a - b", newString: "return a + b" }
    )
    expect(result).toMatchObject({ replacements: 1, startLine: 1, endLine: 2 })
    expect(result.hunk).toBe("def add(a, b):\n    return a + b")
    expect(content).toBe("def add(a, b):\n    return a + b\n")
  })

  it("refuses a block whose file copy differs, and quotes the file's own bytes", async () => {
    // The tolerant cascade used to relocate this edit silently. A whitespace
    // difference the caller cannot see is a file the caller has not read.
    const { content, failure } = await refusal(
      { "/c.py": "value = 1  \nother = 2\n" },
      { path: "/c.py", oldString: "value = 1\nother = 2", newString: "value = 3" }
    )
    expect(failure).toMatchObject({ code: "no_match", path: "/c.py" })
    expect(failure?.message).toContain("Lines 1-2 actually hold this")
    expect(failure?.message).toContain("value = 1  ")
    expect(content).toBe("value = 1  \nother = 2\n")
  })

  it("refuses an indentation-collapsed anchor rather than dedenting a guard", async () => {
    const { failure } = await refusal(
      { "/b.py": "result  =  compute( a ,  b )\n" },
      { path: "/b.py", oldString: "result = compute( a , b )", newString: "result = compute(a, b)" }
    )
    expect(failure?.code).toBe("no_match")
    expect(failure?.message).toContain("result  =  compute( a ,  b )")
  })

  it("says the file is the wrong one when no line of the anchor occurs in it", async () => {
    const { failure } = await refusal(
      { "/d.py": "before = 0\n" },
      { path: "/d.py", oldString: "def target():\n    return 9", newString: "x" }
    )
    expect(failure?.message).toContain("this is the wrong file")
  })

  it("names every line an ambiguous anchor sits on", async () => {
    const { failure } = await refusal(
      { "/e.py": "x = 1\ny = 0\nx = 1\n" },
      { path: "/e.py", oldString: "x = 1", newString: "x = 2" }
    )
    expect(failure?.code).toBe("invalid_input")
    expect(failure?.message).toContain("occurs 2 times")
    expect(failure?.message).toContain("lines 1, 3")
  })

  it("replaces every occurrence when the caller asks for it", async () => {
    const { content, result } = await editThenRead(
      { "/e.py": "x = 1\nx = 1\n" },
      { path: "/e.py", oldString: "x = 1", newString: "x = 2", replaceAll: true }
    )
    expect(result.replacements).toBe(2)
    expect(content).toBe("x = 2\nx = 2\n")
  })

  it("anchors on the line range of a prior hit", async () => {
    const { content, result } = await editThenRead(
      { "/f.py": "one\ntwo\nthree\n" },
      { path: "/f.py", startLine: 2, endLine: 2, expect: "two", newString: "TWO" }
    )
    expect(result).toMatchObject({ replacements: 1 })
    expect(content).toBe("one\nTWO\nthree\n")
  })

  it("refuses a line range whose contents moved, and shows what is there now", async () => {
    const { content, failure } = await refusal(
      { "/g.py": "one\ntwo\nthree\n" },
      { path: "/g.py", startLine: 2, endLine: 2, expect: "TWO", newString: "x" }
    )
    expect(failure?.code).toBe("no_match")
    expect(failure?.message).toContain("do not hold expect")
    expect(failure?.message).toContain("two")
    expect(content).toBe("one\ntwo\nthree\n")
  })

  it("refuses a line range outside the file", async () => {
    const { failure } = await refusal(
      { "/h.py": "one\n" },
      { path: "/h.py", startLine: 40, endLine: 41, newString: "x" }
    )
    expect(failure?.code).toBe("offset_out_of_range")
  })

  it("refuses inverted, doubled, and missing anchors", async () => {
    const inverted = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", startLine: 2, endLine: 1, newString: "x" }
    )
    const both = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", oldString: "one", startLine: 1, endLine: 1, newString: "x" }
    )
    const half = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", startLine: 1, newString: "x" }
    )
    const neither = await refusal({ "/i.py": "one\ntwo\n" }, { path: "/i.py", newString: "x" })
    const blank = await refusal({ "/i.py": "one\ntwo\n" }, { path: "/i.py", oldString: "", newString: "x" })
    expect(inverted.failure?.message).toContain("before startLine")
    expect(both.failure?.message).toContain("not by both")
    expect(half.failure?.message).toContain("both startLine and endLine")
    expect(neither.failure?.message).toContain("write flow")
    expect(blank.failure?.message).toContain("must not be empty")
  })

  it("fails with not_found on a file that is not there", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({ path: "/absent.py", oldString: "a", newString: "b" })),
      layer({ files: {} })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code).toBe("not_found")
    }
  })

  it("puts back permission bits the host's write moved", async () => {
    // Five graded SWE-bench patches shipped spurious 100644 -> 100755 sections
    // around their real edits. A patch is content; mode is not this library's
    // to change.
    const chmods: Array<{ readonly path: string; readonly mode: number }> = []
    let mode = 0o100644
    const info = (value: number): FileSystem.File.Info => ({
      type: "File",
      mtime: Option.none(),
      atime: Option.none(),
      birthtime: Option.none(),
      dev: 0,
      ino: Option.none(),
      mode: value,
      nlink: Option.none(),
      uid: Option.none(),
      gid: Option.none(),
      rdev: Option.none(),
      size: FileSystem.Size(0),
      blksize: Option.none(),
      blocks: Option.none()
    })
    const host = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
      stat: () => Effect.succeed(info(mode)),
      readFileString: () => Effect.succeed("value = 1\n"),
      writeFileString: () =>
        Effect.sync(() => {
          // A host that writes by replacing the file loses its bits.
          mode = 0o100755
        }),
      chmod: (path, value) =>
        Effect.sync(() => {
          chmods.push({ path, mode: value })
          mode = 0o100000 | value
        })
    }))
    await execute(Effect.provide(
      Edit.run({ path: "/a.py", oldString: "value = 1", newString: "value = 2" }),
      host
    ))
    expect(chmods).toEqual([{ path: "/a.py", mode: 0o644 }])
  })

  it("declares compensable hermetic effects and narrows each invocation", () => {
    expect(Edit.effects).toMatchObject({ tier: "compensable", mode: "hermetic" })
    expect(Edit.effectsFor({ path: "/a.py", newString: "x", oldString: "y" }).writes).toEqual(["/a.py"])
  })
})
