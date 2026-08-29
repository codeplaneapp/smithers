import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkGeneratedFile,
  failureMessage,
  maximumFailureMessageCodeUnits,
  maximumGeneratedFileBytes,
  resolveOutputPath,
  writeGeneratedFile
} from "../src/GeneratedFile.ts"

let root: string
const outside: Array<string> = []

const scratchOutside = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-generated-outside-"))
  outside.push(directory)
  return directory
}

const write = (path: string, contents: string): Promise<void> =>
  Effect.runPromise(writeGeneratedFile(root, { path, contents }))

const check = (path: string, contents: string): Promise<void> =>
  Effect.runPromise(checkGeneratedFile(root, { path, contents }))

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-generated-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  for (const directory of outside.splice(0)) await Fs.rm(directory, { recursive: true, force: true })
})

describe("failureMessage", () => {
  it("does not invoke accessors, proxy traps, or user string conversion", () => {
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
    const proxied = new Proxy(new Error("proxied message"), {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })

    expect(failureMessage(getter)).toBe("unknown failure")
    expect(failureMessage(converted)).toBe("unknown failure")
    expect(failureMessage(proxied)).toBe("unknown failure")
    expect(calls).toBe(0)
  })

  it("bounds and well-forms diagnostic text", () => {
    expect(failureMessage("bad\ud800text")).toBe("bad\ufffdtext")
    expect(failureMessage("x".repeat(maximumFailureMessageCodeUnits + 1))).toHaveLength(
      maximumFailureMessageCodeUnits
    )
  })
})

describe("generated file paths", () => {
  it("normalizes workspace-root notation", () => {
    expect(resolveOutputPath("//generated/config.json")).toBe("generated/config.json")
  })

  it.each(["", ".", "../outside", "/tmp/outside", "C:\\outside", "bad\0name"])(
    "refuses %j",
    (path) => expect(() => resolveOutputPath(path)).toThrow()
  )

  it("revalidates a forged public action payload", async () => {
    const directory = await scratchOutside()
    const escaped = NodePath.join(directory, "escaped.txt")
    const path = NodePath.relative(root, escaped)

    await expect(write(path, "must not escape\n")).rejects.toThrow(/stay inside|leave|escapes the workspace/)
    await expect(Fs.stat(escaped)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("atomic generated-file writes", () => {
  it("creates nested parents and publishes the whole file", async () => {
    await write("generated/nested/config.json", "{\"ok\":true}\n")
    expect(await Fs.readFile(NodePath.join(root, "generated/nested/config.json"), "utf8"))
      .toBe("{\"ok\":true}\n")
    expect(await Fs.readdir(NodePath.join(root, "generated/nested"))).toEqual(["config.json"])
  })

  it("preserves the permission bits of an existing file", async () => {
    const path = NodePath.join(root, "config.json")
    await Fs.writeFile(path, "old\n", { mode: 0o640 })
    await Fs.chmod(path, 0o640)

    await write("config.json", "new\n")
    expect((await Fs.lstat(path)).mode & 0o7777).toBe(0o640)
    expect(await Fs.readFile(path, "utf8")).toBe("new\n")
  })

  it.skipIf(process.platform === "win32")("refuses a parent symlink that leaves the workspace", async () => {
    const directory = await scratchOutside()
    await Fs.symlink(directory, NodePath.join(root, "linked"))

    await expect(write("linked/config.json", "outside\n")).rejects.toThrow(/parent is a symbolic link/)
    expect(await Fs.readdir(directory)).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses a parent symlink even when it points inside", async () => {
    await Fs.mkdir(NodePath.join(root, "real"))
    await Fs.symlink(NodePath.join(root, "real"), NodePath.join(root, "linked"))

    await expect(write("linked/config.json", "ambiguous\n")).rejects.toThrow(/parent is a symbolic link/)
    expect(await Fs.readdir(NodePath.join(root, "real"))).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses to replace a generated-file symlink", async () => {
    const directory = await scratchOutside()
    const target = NodePath.join(directory, "target.json")
    await Fs.writeFile(target, "outside\n", "utf8")
    await Fs.symlink(target, NodePath.join(root, "config.json"))

    await expect(write("config.json", "replacement\n")).rejects.toThrow(/is a symbolic link/)
    expect(await Fs.readFile(target, "utf8")).toBe("outside\n")
  })

  it("refuses a directory at the output path", async () => {
    await Fs.mkdir(NodePath.join(root, "config.json"))
    await expect(write("config.json", "not a directory\n")).rejects.toThrow(/not a regular file/)
  })

  it("refuses contents that UTF-8 would encode lossily", async () => {
    await expect(write("config.json", "bad\ud800text")).rejects.toThrow(/unpaired UTF-16 surrogate/)
    await expect(Fs.stat(NodePath.join(root, "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses oversize contents before creating output parents", async () => {
    await expect(write("generated/config.json", "x".repeat(maximumGeneratedFileBytes + 1)))
      .rejects.toThrow(/generated contents exceed/)
    await expect(Fs.stat(NodePath.join(root, "generated"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("honors cancellation before filesystem work starts", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled generated write"))
    await expect(Effect.runPromise(
      writeGeneratedFile(root, { path: "config.json", contents: "cancelled\n" }),
      { signal: controller.signal }
    )).rejects.toThrow()
    await expect(Fs.stat(NodePath.join(root, "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("generated-file checks", () => {
  it("accepts an exact file and reports missing and drifted files", async () => {
    await Fs.writeFile(NodePath.join(root, "config.json"), "expected\n", "utf8")
    await expect(check("config.json", "expected\n")).resolves.toBeUndefined()
    await expect(check("config.json", "different\n")).rejects.toThrow(/drifted/)
    await expect(check("missing.json", "expected\n")).rejects.toThrow(/missing/)
  })

  it.skipIf(process.platform === "win32")("refuses a checked-in symlink", async () => {
    await Fs.writeFile(NodePath.join(root, "target.json"), "expected\n", "utf8")
    await Fs.symlink("target.json", NodePath.join(root, "config.json"))
    await expect(check("config.json", "expected\n")).rejects.toThrow(/symbolic link/)
  })

  it("refuses invalid UTF-8", async () => {
    await Fs.writeFile(NodePath.join(root, "config.json"), Buffer.from([0xc3, 0x28]))
    await expect(check("config.json", "expected\n")).rejects.toThrow(/not valid UTF-8/)
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting for a writer", async () => {
    execFileSync("mkfifo", [NodePath.join(root, "config.json")])
    await expect(check("config.json", "expected\n")).rejects.toThrow(/not a regular file/)
  })
})
