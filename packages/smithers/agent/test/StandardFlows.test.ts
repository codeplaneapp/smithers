/**
 * What each standard helper actually binds.
 *
 * A host composes `StandardFlows.filesystem(services)`, not the seven bindings
 * inside it, so the catalog a helper produces is this package's contract with
 * the model and with `docs/guides/capabilities.md`. Losing one line from a
 * binding array is invisible until a run reaches for the capability and finds
 * nothing there, which is the failure the filesystem list was written to end:
 * with only `read` and `write` bound, the built-in harness emitted
 * `apply_patch` heredocs into `bash`, watched the shell report
 * `apply_patch: command not found`, and finished runs claiming fixes it never
 * applied. These tests read the catalog each source produces and compare it
 * with the documented set, and run the two search bindings to prove they are
 * handed the `Search` the host supplied rather than the bare filesystem
 * context.
 */
import type { FlowRuntime } from "@smthrs/flow"
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Search from "@smthrs/std/Search"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Context, Effect, FileSystem, Option, Path } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as StandardFlows from "../src/StandardFlows.ts"

/** The posix path service, materialized once so bindings can be given a context. */
const pathServices: Context.Context<Path.Path> = Effect.runSync(
  Effect.provide(Effect.context<Path.Path>(), Path.layer)
)

/**
 * The host slices each helper takes. A catalog is the binding list a source
 * declares, so the services behind it never run here and a refusing stub is
 * the honest stand-in for every one of them.
 */
const filesystemServices = Context.merge(
  Context.make(FileSystem.FileSystem, FileSystem.makeNoop({})),
  pathServices
)

const shellServices = Context.merge(
  Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()),
  pathServices
)

const testServices = Context.make(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.makeNoop()
).pipe(Context.add(TestRunner.TestRunner, TestRunner.makeNoop()))

const memoryServices = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
  Context.add(Recall.Recall, Recall.makeNoop())
)

const clockServices = Context.empty() as Context.Context<
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
>

/** The catalog `docs/guides/capabilities.md` promises, helper by helper. */
const promised: ReadonlyArray<{
  readonly source: FlowBinding.Source
  readonly flows: ReadonlyArray<string>
}> = [
  {
    source: StandardFlows.filesystem(filesystemServices),
    flows: ["read", "write", "edit", "apply_patch", "ls", "glob", "grep"]
  },
  { source: StandardFlows.shell(shellServices), flows: ["bash"] },
  { source: StandardFlows.tests(testServices), flows: ["test"] },
  { source: StandardFlows.memory(memoryServices), flows: ["remember", "recall"] },
  { source: StandardFlows.clock(clockServices), flows: ["wait"] },
  { source: StandardFlows.approval(StandardFlows.askerNoop()), flows: ["ask"] }
]

/** One synthetic call, so a binding runs without the controller around it. */
const callOf = (flowName: string, input: unknown): Cell.Call =>
  ({
    flowName,
    input,
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    identity: {
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: `${flowName}-declaration`,
      layers: []
    }
  }) as unknown as Cell.Call

describe("the standard capability catalog", () => {
  for (const entry of promised) {
    it(`binds exactly the flows ${entry.source.name} promises`, async () => {
      const bindings = await Effect.runPromise(entry.source.bindings())
      expect(bindings.map((binding) => binding.descriptor.name)).toEqual(entry.flows)
    })
  }

  it("names its sources so a composed catalog says where each flow came from", () => {
    expect(promised.map((entry) => entry.source.name)).toEqual([
      "std/filesystem",
      "std/shell",
      "std/tests",
      "memory",
      "engine/clock",
      "host/approval"
    ])
  })

  it("hands glob and grep the search the host supplied, not the bare filesystem context", async () => {
    const asked: Array<string> = []
    const search = Search.make({
      glob: (input) =>
        Effect.sync(() => {
          asked.push(`glob ${input.pattern} in ${input.root}`)
          return { paths: ["/repo/alpha.md"], total: 1, truncated: false }
        }),
      grep: (input) =>
        Effect.sync(() => {
          asked.push(`grep ${input.pattern} in ${input.root}`)
          return { matches: [], files: [], filesSearched: 1, skippedBinary: 0, truncated: false }
        })
    })
    const bindings = await Effect.runPromise(
      StandardFlows.filesystem(filesystemServices, search).bindings()
    )
    const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]))

    const globbed = await Effect.runPromise(
      byName.get("glob")!.run(callOf("glob", { pattern: "*.md", root: "/repo" }))
    )
    const grepped = await Effect.runPromise(
      byName.get("grep")!.run(callOf("grep", { pattern: "second", root: "/repo" }))
    )

    // The filesystem context alone cannot answer either call: both handlers
    // require `Search`, and only the search context carries it.
    expect(globbed).toMatchObject({
      outcome: "success",
      value: { paths: ["/repo/alpha.md"], total: 1, truncated: false }
    })
    expect(grepped).toMatchObject({ outcome: "success", value: { filesSearched: 1 } })
    expect(asked).toEqual(["glob *.md in /repo", "grep second in /repo"])
  })
})
