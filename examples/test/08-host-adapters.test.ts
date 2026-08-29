import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/08-host-adapters.ts"

it.effect("runs one host program on the test and Node adapters", () =>
  Effect.gen(function*() {
    const summary = yield* main
    expect(summary.scriptedRead).toBe("hello from memory")
    expect(summary.scriptedExec).toBe("hello from script")
    expect(summary.nodeExec).toBe("hello from node")
  }))
