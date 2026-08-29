/**
 * Where a saved flow's files land.
 *
 * These cases fix the store's contract: a write reports the paths it wrote in
 * the caller's own terms, a listing names the flows the store already holds,
 * and an id that is not a routable flow directory name is refused before any
 * path is built from it.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as FlowStore from "../src/FlowStore.ts"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const root = (): string => mkdtempSync(join(tmpdir(), "flows-store-"))

const files = (id: string): Record<string, string> => ({
  [`flows/${id}/flow.ts`]: `export default Flow.make({ name: "${id}" })`,
  [`flows/${id}/flow.e2e.ts`]: `it("runs ${id}", () => {})`,
  [`flows/${id}/fixtures/${id}.json`]: `{ "calls": [] }`
})

const onDisk = <A, E>(
  directory: string,
  use: (store: FlowStore.Service) => Effect.Effect<A, E>
): Promise<Exit.Exit<A, E>> =>
  Effect.flatMap(FlowStore.FlowStore, use).pipe(
    Effect.provide(FlowStore.layerFileSystem(directory).pipe(Layer.provide(platform))),
    Effect.runPromiseExit
  )

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect)

/** The refusal an exit carries, or a failing assertion when it succeeded. */
const refused = <A, E>(exit: Exit.Exit<A, E>): FlowStore.FlowStoreError => {
  if (Exit.isSuccess(exit)) {
    expect.unreachable("expected the store to refuse")
  }
  return Cause.squash(exit.cause) as FlowStore.FlowStoreError
}

describe("FlowStore.makeMemory", () => {
  it("keeps every file it is given and reports the paths it wrote", async () => {
    const written = new Map<string, string>()
    const store = FlowStore.makeMemory(written)

    const result = await run(store.write("weekly-digest", files("weekly-digest")))

    expect(result).toStrictEqual(Exit.succeed({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    }))
    expect(written.get("flows/weekly-digest/flow.ts")).toBe(`export default Flow.make({ name: "weekly-digest" })`)
  })

  it("lists one entry per saved flow, with the files it holds", async () => {
    const store = FlowStore.makeMemory()
    await run(store.write("triage", files("triage")))
    await run(store.write("digest", files("digest")))

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      {
        id: "digest",
        files: ["flows/digest/fixtures/digest.json", "flows/digest/flow.e2e.ts", "flows/digest/flow.ts"]
      },
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it("keeps one entry for a flow the model saves twice", async () => {
    const store = FlowStore.makeMemory()
    await run(store.write("triage", files("triage")))
    await run(store.write("triage", { "flows/triage/flow.ts": "the second draft" }))

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it("lists only what is laid out as a saved flow", async () => {
    // The map is the host's, so it may hold anything. Only `flows/<id>/<file>`
    // is a saved flow.
    const store = FlowStore.makeMemory(
      new Map([
        ["README.md", ""],
        ["flows/triage", ""],
        ["notes/triage/flow.ts", ""],
        ["flows/Triage/flow.ts", ""],
        ["flows/triage/flow.ts", "kept"]
      ])
    )

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/flow.ts"] }
    ]))
  })

  it("refuses an id no router could route", async () => {
    const written = new Map<string, string>()
    const store = FlowStore.makeMemory(written)

    expect(refused(await run(store.write("../escape", { "flows/../escape/flow.ts": "" }))).code).toBe("invalid_id")
    expect(written.size).toBe(0)
  })
})

describe("FlowStore.layerFileSystem", () => {
  it("writes the flow, its test, and its fixture under the root", async () => {
    const directory = root()

    const result = await onDisk(directory, (store) => store.write("weekly-digest", files("weekly-digest")))

    expect(result).toStrictEqual(Exit.succeed({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    }))
    expect(readFileSync(join(directory, "flows/weekly-digest/flow.ts"), "utf8")).toBe(
      `export default Flow.make({ name: "weekly-digest" })`
    )
    expect(readFileSync(join(directory, "flows/weekly-digest/fixtures/weekly-digest.json"), "utf8")).toBe(
      `{ "calls": [] }`
    )
  })

  it("lists the flows the root already holds", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it("reports nothing for a root that holds no flows yet", async () => {
    expect(await onDisk(root(), (store) => store.list())).toStrictEqual(Exit.succeed([]))
  })

  it("refuses an id that would write outside the flows directory", async () => {
    const directory = root()

    const result = await onDisk(directory, (store) => store.write("../escape", { "flows/../escape/flow.ts": "" }))

    expect(refused(result).code).toBe("invalid_id")
    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([]))
  })

  it("refuses a file path that climbs out of the root, before anything is written", async () => {
    const directory = root()

    const climbing = await onDisk(
      directory,
      (store) => store.write("triage", { "flows/triage/flow.ts": "kept", "../escape.ts": "" })
    )
    const absolute = await onDisk(directory, (store) => store.write("triage", { "/etc/escape.ts": "" }))

    expect(refused(climbing).code).toBe("invalid_path")
    expect(refused(absolute).code).toBe("invalid_path")
    expect(existsSync(join(directory, "flows/triage/flow.ts"))).toBe(false)
  })

  it("reports a directory it could not create rather than claiming the write", async () => {
    const directory = root()
    // A root that is a file: every directory the write needs is under it.
    const file = join(directory, "not-a-directory")
    writeFileSync(file, "")

    const result = await onDisk(file, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
  })

  it("reports a file it could not write rather than claiming the write", async () => {
    const directory = root()
    // The path the flow file has to take is already a directory.
    mkdirSync(join(directory, "flows/triage/flow.ts"), { recursive: true })

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
  })

  it("skips what is in the flows directory but is not a saved flow", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))
    // A name no router could route, a routable name that is a file rather than
    // a flow directory, and a dangling link inside a flow: none of them is a
    // saved flow this store holds.
    writeFileSync(join(directory, "flows/README.md"), "")
    writeFileSync(join(directory, "flows/notes"), "")
    symlinkSync(join(directory, "flows/triage/missing.ts"), join(directory, "flows/triage/link.ts"))

    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })
})

describe("FlowStore layers", () => {
  it("provides the in-memory store", async () => {
    const written = new Map<string, string>()

    const result = await run(
      Effect.flatMap(FlowStore.FlowStore, (store) => store.write("triage", files("triage"))).pipe(
        Effect.provide(FlowStore.layerMemory(written))
      )
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(written.size).toBe(3)
  })

  it("provides the store that saves nothing", async () => {
    const result = await run(
      Effect.flatMap(FlowStore.FlowStore, (store) => store.list()).pipe(
        Effect.provide(FlowStore.layerNoop())
      )
    )

    expect(refused(result).code).toBe("unsupported")
  })
})

describe("FlowStore.makeNoop", () => {
  it("refuses every call with a message that says no flow was saved", async () => {
    const store = FlowStore.makeNoop()

    const result = refused(await run(store.write("triage", files("triage"))))

    expect(result.code).toBe("unsupported")
    expect(result.message).toContain("no flow was saved")
    expect(refused(await run(store.list())).code).toBe("unsupported")
  })

  it("takes one operation at a time", async () => {
    const store = FlowStore.makeNoop({ list: () => Effect.succeed([{ id: "triage", files: [] }]) })

    expect(await run(store.list())).toStrictEqual(Exit.succeed([{ id: "triage", files: [] }]))
    expect(refused(await run(store.write("triage", files("triage")))).code).toBe("unsupported")
  })
})

describe("FlowStore.validateId", () => {
  it("accepts the ids a flow directory can be named", async () => {
    for (const id of ["a", "triage", "weekly-digest", "pr2md", "a-1-b"]) {
      expect(Exit.isSuccess(await run(FlowStore.validateId(id)))).toBe(true)
    }
  })

  it("refuses everything else with the rule the model has to follow", async () => {
    for (const id of ["", "Triage", "1triage", "-triage", "flows/triage", "../escape", "triage_two"]) {
      expect(refused(await run(FlowStore.validateId(id))).code).toBe("invalid_id")
    }
    expect(refused(await run(FlowStore.validateId("Triage"))).message).toContain("lowercase letters")
  })
})
