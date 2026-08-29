/**
 * The helper end to end, on a flow that exists only here.
 *
 * The two halves have to be tested together: a recording that replay cannot
 * read is worse than no recording, and the mismatch only shows up when the same
 * request is digested twice. So the first case records a fixture against a
 * scripted model, and the second replays that exact file with the recorder
 * switched off, the way CI runs it.
 *
 * `routes` is overridden where the suite owns its flow; the default loader —
 * the router plus four dynamic imports — is exercised against a throwaway app
 * tree, because that path is what every real app takes.
 */
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { defineAgent, defineFlow, defineSandbox, defineTools } from "../src/index.ts"
import { cachedModelTest, preparedRequest, recording, type RoutedFlow, runCachedModelTest } from "../src/testing.ts"

const Output = Schema.Struct({ answer: Schema.String })
type Output = typeof Output.Type

const answerText = "Durable runs resume instead of repeating."

const Flow = defineFlow({
  description: "Answers a topic in one line.",
  payload: { topic: Schema.String },
  output: Output,
  prompt: ({ topic }) => `Answer in one line: ${topic}`
})

const Agent = defineAgent({
  seat: "test:scripted",
  system: ["You are a test agent. Answer with the declared JSON shape."],
  limits: { calls: 4 },
  maxFrames: 3
})

const Sandbox = defineSandbox({ limits: { heapBytes: 32 * 1024 * 1024, wallClockMs: 10_000 } })

const Tools = defineTools([])

const routed: ReadonlyArray<RoutedFlow> = [{
  id: "echo",
  file: "flows/echo/flow.ts",
  spec: Flow,
  agent: Agent,
  sandbox: Sandbox,
  tools: Tools
}]

/** Answers every request with one cell that settles the run through `ctx.done`. */
const scripted = (): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        const cell = `await ctx.done(${JSON.stringify({ answer: answerText })})`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const scratch: Array<string> = []

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-cached-"))
  scratch.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

const dir = mkdtempSync(join(tmpdir(), "smthrs-cached-fixture-"))
scratch.push(dir)
const fixturePath = join(dir, "echo.json")
const fixture = pathToFileURL(fixturePath)

afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

// `recording()` reads the environment inside the test body, so the mode is set
// per test rather than for the whole file.
beforeEach((context) => {
  if (context.task.name.startsWith("records")) process.env["SMTHRS_RECORD"] = "1"
  else delete process.env["SMTHRS_RECORD"]
})

const expectAnswer = (output: Output): void => {
  expect(output.answer).toBe(answerText)
}

describe("cachedModelTest", () => {
  cachedModelTest<{ topic: string }, Output>("records a fixture against the live seat", {
    fixture,
    flow: "echo",
    payload: { topic: "durable workflows" },
    live: scripted,
    routes: async () => routed,
    expect: expectAnswer
  })

  it("wrote the recorded fixture to disk in a form the decoder accepts", () => {
    expect(existsSync(fixturePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as { calls: ReadonlyArray<unknown> }
    expect(parsed.calls.length).toBeGreaterThan(0)
  })

  cachedModelTest<{ topic: string }, Output>("replays that fixture with no live model", {
    fixture,
    flow: "echo",
    payload: { topic: "durable workflows" },
    routes: async () => routed,
    expect: expectAnswer
  })
})

describe("the default routes loader", () => {
  // The layer files export plain objects with the right shape rather than
  // calling the constructors, so the throwaway tree needs no resolvable
  // imports of its own.
  const app = (extra: Record<string, string> = {}) => ({
    "AGENT.ts": `export const Agent = ${JSON.stringify(Agent)}\n`,
    "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
    "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
    ...extra
  })

  it("routes a flow, imports its layer files, and runs it", async () => {
    const root = tree(app({
      "flows/echo/flow.ts":
        `export const Flow = { _tag: "FlowSpec", description: "d", payload: {}, output: {}, prompt: () => "" }\n`
    }))
    // The flow module is imported for its `Flow` export; the spec that
    // actually runs comes from this file, so the schemas stay real.
    const loaded = await import(pathToFileURL(join(root, "flows/echo/flow.ts")).href) as {
      readonly Flow: { readonly _tag: string }
    }
    expect(loaded.Flow._tag).toBe("FlowSpec")

    await runCachedModelTest<{ topic: string }, Output>("routed", {
      fixture,
      flow: "echo",
      payload: { topic: "durable workflows" },
      root,
      routes: async () => routed,
      expect: expectAnswer
    })
  })

  it("names the known flows when the requested flow is not routed", async () => {
    const root = tree(app({ "flows/echo/flow.ts": "export const Flow = {}\n" }))
    await expect(
      runCachedModelTest("unrouted", {
        fixture,
        flow: "missing",
        payload: {},
        root,
        expect: () => {}
      })
    ).rejects.toThrow("flow \"missing\" is not routed. Known flows: echo")
  })

  it("refuses a markdown flow, which has no loader", async () => {
    const root = tree(app({ "flows/notes/flow.mdx": "# notes\n" }))
    await expect(
      runCachedModelTest("markdown flow", { fixture, flow: "notes", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("markdown flow has no loader")
  })

  it("refuses a layer file that exports nothing under the expected name", async () => {
    const root = tree({
      "AGENT.ts": "export const NotAgent = {}\n",
      "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
      "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
      "flows/echo/flow.ts": `export const Flow = { _tag: "FlowSpec" }\n`
    })
    await expect(
      runCachedModelTest("missing export", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("AGENT.ts must export `Agent`")
  })

  it("loads the flow, agent, sandbox, and tools a routed tree declares", async () => {
    const root = tree(app({
      "flows/echo/flow.ts":
        `export const Flow = { _tag: "FlowSpec", description: "d", payload: {}, output: {}, prompt: () => "" }\n`
    }))
    // A payload of `{}` and an output of `{}` are not usable schemas, so the
    // run is expected to fail — what matters is that it failed AFTER the four
    // modules resolved, not while resolving them.
    await expect(
      runCachedModelTest("resolved layers", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow()
  })
})

describe("refusals", () => {
  it("refuses to replay a fixture that does not exist", async () => {
    await expect(
      runCachedModelTest("absent fixture", {
        fixture: pathToFileURL(join(dir, "absent.json")),
        flow: "echo",
        payload: {},
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow("Record one with `pnpm test:record`")
  })

  it("refuses to record without a live model", async () => {
    process.env["SMTHRS_RECORD"] = "1"
    try {
      await expect(
        runCachedModelTest("no live seat", {
          fixture: pathToFileURL(join(dir, "absent.json")),
          flow: "echo",
          payload: {},
          routes: async () => routed,
          expect: () => {}
        })
      ).rejects.toThrow("SMTHRS_RECORD=1 needs a live model")
    } finally {
      delete process.env["SMTHRS_RECORD"]
    }
  })

  it("names the flows a supplied routes loader returned", async () => {
    await expect(
      runCachedModelTest("wrong id", {
        fixture,
        flow: "absent",
        payload: {},
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow("flow \"absent\" is not routed. Known flows: echo")
  })

  it("narrows a recorded provider failure onto the production model seam", async () => {
    // The recorded failure is the one thing a replay puts on the error channel:
    // an unscripted request and a harness mismatch are defects that
    // `@smthrs/testing` dies on. Editing a recorded fixture is how the failure
    // is produced without a provider, and the events are cleared so the stream
    // fails at the first call rather than after a settled turn.
    //
    // The assertion is the rejection itself, not its text. `asModel` maps the
    // recorded failure to a `ModelError`, and the engine then re-encodes that
    // failure for the journal, so the message the caller sees is the engine's.
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      calls: Array<{ events: ReadonlyArray<unknown>; failure?: unknown }>
    }
    const failingPath = join(dir, "failing.json")
    writeFileSync(
      failingPath,
      JSON.stringify({
        calls: recorded.calls.map((call) => ({
          ...call,
          events: [],
          failure: { code: "rate_limited", message: "slow down" }
        }))
      })
    )

    await expect(
      runCachedModelTest("recorded failure", {
        fixture: pathToFileURL(failingPath),
        flow: "echo",
        payload: { topic: "durable workflows" },
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow()
  })

  it("surfaces a replay of a request the fixture never recorded", async () => {
    await expect(
      runCachedModelTest("unscripted request", {
        fixture,
        flow: "echo",
        // A payload the recording never saw digests to a request the replay
        // has no answer for.
        payload: { topic: "never recorded" },
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow()
  })
})

describe("the test seat", () => {
  it("reads SMTHRS_RECORD from the environment at call time", () => {
    delete process.env["SMTHRS_RECORD"]
    expect(recording()).toBe(false)
    process.env["SMTHRS_RECORD"] = "1"
    expect(recording()).toBe(true)
    delete process.env["SMTHRS_RECORD"]
  })

  it("carries a credential-free placeholder request", () => {
    expect(preparedRequest.url).toBe("https://example.invalid/v1/messages")
    expect(preparedRequest.bodyText).toBe("{}")
  })
})
