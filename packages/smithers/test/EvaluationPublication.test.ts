import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const collision = vi.hoisted(() => "00000000-0000-4000-8000-000000000000")
const faults = vi.hoisted(() => ({ write: false, close: false, cleanup: false, closed: 0 }))
vi.mock("node:crypto", async (load) => ({
  ...await load<typeof import("node:crypto")>(),
  randomUUID: () => collision
}))
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>()
  const isTemporary = (path: unknown) => String(path).endsWith(`.${collision}.tmp`)
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      if (isTemporary(args[0])) {
        const write = handle.writeFile.bind(handle)
        const close = handle.close.bind(handle)
        if (faults.write) {
          vi.spyOn(handle, "writeFile").mockImplementation(async () => {
            await write("partial JSON")
            throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" })
          })
        }
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close()
          faults.closed++
          if (faults.close) throw Object.assign(new Error("fixture close failed"), { code: "EIO" })
        })
      }
      return handle
    },
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      if (faults.cleanup && isTemporary(path)) {
        throw Object.assign(new Error("fixture cleanup denied"), { code: "EACCES" })
      }
      return actual.unlink(path)
    }
  }
})

import * as Evaluation from "../src/evaluation/Evaluation.ts"

const roots: Array<string> = []
afterEach(async () => {
  Object.assign(faults, { write: false, close: false, cleanup: false, closed: 0 })
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-evaluation-publication-"))
  roots.push(root)
  return root
}

describe("evaluation artifact publication ownership", () => {
  it.each(["write", "close"] as const)("closes its handle and never publishes after a %s failure", async (phase) => {
    const root = await fixture()
    const destination = join(root, "result.json")
    faults[phase] = true

    await expect(Evaluation.writeJson(destination, "{\"complete\":true}")).rejects.toMatchObject({
      code: phase === "write" ? "ENOSPC" : "EIO"
    })

    expect(faults.closed).toBe(1)
    expect(await readdir(root)).toEqual([])
  })

  it("reports cleanup failure without damaging the completely published artifact", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const source = "{\"complete\":true}"
    faults.cleanup = true

    await expect(Evaluation.writeJson(destination, source)).rejects.toMatchObject({ code: "EACCES" })

    expect(faults.closed).toBe(1)
    expect(await readFile(destination, "utf8")).toBe(source)
    expect(await readFile(`${destination}.${collision}.tmp`, "utf8")).toBe(source)
  })

  it("never removes a pre-existing temporary file after exclusive creation fails", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const temporary = `${destination}.${collision}.tmp`
    await writeFile(temporary, "another writer owns these bytes")

    await expect(Evaluation.writeJson(destination, "new result")).rejects.toMatchObject({ code: "EEXIST" })

    expect(await readFile(temporary, "utf8")).toBe("another writer owns these bytes")
    expect(await readdir(root)).toEqual([`result.json.${collision}.tmp`])
  })

  it("does not unlink a pre-existing symbolic temporary path or alter its target", async () => {
    const root = await fixture()
    const original = join(root, "original.json")
    const destination = join(root, "result.json")
    const temporary = `${destination}.${collision}.tmp`
    await writeFile(original, "original")
    await symlink(original, temporary)

    await expect(Evaluation.writeJson(destination, "replacement", true)).rejects.toMatchObject({ code: "EEXIST" })

    expect(await readFile(temporary, "utf8")).toBe("original")
    expect(await readFile(original, "utf8")).toBe("original")
  })

  it("cleans its own temporary file when publication fails", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    await mkdir(destination)
    await expect(Evaluation.writeJson(destination, "new result", true)).rejects.toBeDefined()
    expect(await readdir(root)).toEqual(["result.json"])
    expect(await readdir(destination)).toEqual([])
  })

  it("keeps a complete winner when two writers contend for the same artifact", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const sources = [JSON.stringify({ writer: 1, data: "a".repeat(65_536) }), JSON.stringify({ writer: 2 })]
    const results = await Promise.allSettled(sources.map((source) => Evaluation.writeJson(destination, source)))
    const winner = results.findIndex((result) => result.status === "fulfilled")
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "EEXIST" }
    })
    expect(await readFile(destination, "utf8")).toBe(sources[winner])
    expect(await readdir(root)).toEqual(["result.json"])
  })

  it("refuses symlink replacement by default and replaces only the link when explicitly forced", async () => {
    const root = await fixture()
    const original = join(root, "original.json")
    const destination = join(root, "result.json")
    await writeFile(original, "original")
    await symlink(original, destination)

    await expect(Evaluation.writeJson(destination, "new result")).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(original, "utf8")).toBe("original")
    await Evaluation.writeJson(destination, "new result", true)
    expect(await readFile(destination, "utf8")).toBe("new result")
    expect(await readFile(original, "utf8")).toBe("original")
    expect((await readdir(root)).sort()).toEqual(["original.json", "result.json"])
  })
})
