import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Effect } from "effect"
import { Cli } from "incur"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryCli, withMemory } from "../src/operator/Memory.ts"
import { localRoot } from "../src/operator/Store.ts"

const roots: Array<string> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-operator-memory-"))
  roots.push(root)
  return root
}
const invoke = async (root: string, args: Array<string>) => {
  let output = ""
  let code = 0
  await Cli.create("smthrs").command(createMemoryCli()).serve(["memory", ...args, "--root", root, "--json"], {
    stdout: (value) => {
      output += value
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, data: JSON.parse(output) as any, output }
}

beforeEach(() => {
  vi.stubEnv("SMITHERS_REMOTE", undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("operator memory", () => {
  it("keeps facts durable, uses the legacy user:cli namespace, and auto-decodes JSON", async () => {
    const root = fixture()
    expect((await invoke(root, ["set", "settings", "{\"fast\":true}"])).code).toBe(0)
    const read = await invoke(root, ["get", "settings"])
    expect(read.data).toMatchObject({ value: { fast: true }, namespace: { kind: "user", id: "cli" } })
    expect((await invoke(root, ["set", "plain", "hello there"])).code).toBe(0)
    expect((await invoke(root, ["get", "plain"])).data.value).toBe("hello there")
    expect((await invoke(root, ["set", "flag", "false"])).code).toBe(0)
    expect((await invoke(root, ["get", "flag"])).data.value).toBe(false)
    expect((await invoke(root, ["set", "special", "17", "--namespace", "flow:review"])).code).toBe(0)
    expect((await invoke(root, ["get", "special", "--namespace", "flow", "--id", "review"])).data.value).toBe(17)
    expect((await invoke(root, ["get", "special"])).code).toBe(1)
    const direct = await withMemory(
      { root },
      Effect.gen(function*() {
        return yield* (yield* MemoryStore.MemoryStore).getFact({
          namespace: { kind: "user", id: "cli" },
          key: "settings"
        })
      })
    )
    expect(direct?.value).toEqual({ fast: true })
    expect((await invoke(root, ["rm", "plain"])).data.deleted).toBe(true)
    expect((await invoke(root, ["list", "--prefix", "set"])).data).toHaveLength(1)
  })

  it("recalls accepted notes with keyword and FTS while honoring supersession", async () => {
    const root = fixture()
    expect((await invoke(root, ["notes", "add", "amber deployment guide", "--note-id", "guide"])).code).toBe(0)
    expect((await invoke(root, ["notes", "add", "amber draft", "--note-id", "draft", "--status", "pending"])).code)
      .toBe(0)
    const keyword = await invoke(root, ["recall", "amber"])
    expect(keyword.data.map((row: { key: string }) => row.key)).toEqual(["guide"])
    expect((await invoke(root, ["recall", "amber", "--method", "fts"])).data.map((row: { key: string }) => row.key))
      .toEqual(["guide"])
    expect(
      (await invoke(root, ["notes", "add", "amber new guide", "--note-id", "guide-v2", "--supersedes", "guide"])).code
    ).toBe(0)
    expect((await invoke(root, ["recall", "amber"])).data.map((row: { key: string }) => row.key)).toEqual(["guide-v2"])
    expect((await invoke(root, ["notes", "status", "draft", "accepted"])).code).toBe(0)
    expect((await invoke(root, ["notes", "get", "draft"])).data.status).toBe("accepted")
    expect((await invoke(root, ["notes", "list", "--include-superseded"])).data).toHaveLength(3)
    expect((await invoke(root, ["notes", "add", "bad tags", "--tag", "invalid"])).code).toBe(1)
  })

  it("compacts persisted history atomically while preserving retained messages", async () => {
    const root = fixture()
    expect((await invoke(root, ["threads", "create", "--thread-id", "history", "--title", "Review"])).code).toBe(0)
    for (let index = 1; index <= 5; index++) {
      expect(
        (await invoke(root, [
          "messages",
          "add",
          "history",
          `message ${index}`,
          "--message-id",
          `m${index}`,
          "--at",
          String(index * 100)
        ])).code
      ).toBe(0)
    }
    const dry = await invoke(root, [
      "compact",
      "history",
      "--summary",
      "The first three messages",
      "--before",
      "1000",
      "--keep",
      "2",
      "--dry-run"
    ])
    expect(dry.data).toMatchObject({ eligible: 3, removed: 0, dryRun: true })
    expect((await invoke(root, ["messages", "list", "history"])).data).toHaveLength(5)
    const result = await invoke(root, [
      "compact",
      "history",
      "--summary",
      "The first three messages",
      "--before",
      "1000",
      "--keep",
      "2"
    ])
    expect(result.data.removed).toBe(3)
    const messages = (await invoke(root, ["threads", "show", "history"])).data.messages
    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      "The first three messages",
      "message 4",
      "message 5"
    ])
    const page = await invoke(root, ["messages", "list", "history", "--after-id", "m4", "--after-at", "400"])
    expect(page.data.map((message: { id: string }) => message.id)).toEqual(["m5"])
    expect((await invoke(root, ["messages", "list", "history", "--after-id", "m4"])).code).toBe(1)
    expect((await invoke(root, ["compact", "absent", "--summary", "x", "--before", "1"])).code).toBe(1)
    expect((await invoke(root, ["threads", "rm", "history"])).data.deleted).toBe(true)
    expect((await invoke(root, ["threads", "list"])).data).toEqual([])
  })

  it("refuses remote access without opening a local database and discovers ancestor roots", async () => {
    const root = fixture()
    expect((await invoke(root, ["list", "--remote", "http://localhost:3000"])).code).toBe(1)
    expect(existsSync(join(root, ".flows"))).toBe(false)
    mkdirSync(join(root, ".flows"))
    const nested = join(root, "src", "nested")
    mkdirSync(nested, { recursive: true })
    vi.spyOn(process, "cwd").mockReturnValue(nested)
    expect(localRoot({})).toBe(root)
    vi.stubEnv("SMITHERS_REMOTE", "")
    expect(localRoot({})).toBe(root)
  })
})
