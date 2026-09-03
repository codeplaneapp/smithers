import { Effect } from "effect"
import type { ExecutePendingJobsResult } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as QuickJsJobs from "../src/internal/QuickJsJobs.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import type * as ScriptRunner from "../src/ScriptRunner.ts"

describe("QuickJsRunner load machinery", () => {
  it("caches a successful load and shares it", async () => {
    let loads = 0
    const load = QuickJsRunner.cachedLoad(() => {
      loads = loads + 1
      return Promise.resolve("module")
    })
    expect(await load()).toBe("module")
    expect(await load()).toBe("module")
    expect(loads).toBe(1)
  })

  it("retries after a rejected load instead of caching the failure", async () => {
    let loads = 0
    const load = QuickJsRunner.cachedLoad(() => {
      loads = loads + 1
      return loads === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("module")
    })
    await expect(load()).rejects.toThrow("transient")
    expect(await load()).toBe("module")
    expect(loads).toBe(2)
  })

  it("fails typed — never a defect — when the module cannot load", async () => {
    const error = await Effect.runPromise(
      Effect.flip(QuickJsRunner.make({}, () => Promise.reject(new Error("csp blocked wasm"))))
    ) as ScriptRunner.ScriptFailure
    expect(error._tag).toBe("/chain/ScriptFailure")
    expect(error.code).toBe("runner_unavailable")
    expect(error.message).toBe("csp blocked wasm")
  })
})

describe("QuickJS pending jobs", () => {
  it("dumps and disposes a failed job result", () => {
    let disposed = false
    const error = {
      context: { dump: () => ({ message: "job interrupted" }) }
    }
    const result = {
      error,
      dispose: () => {
        disposed = true
      }
    } as unknown as ExecutePendingJobsResult
    expect(Effect.runSync(Effect.flip(QuickJsJobs.check(result))))
      .toMatchObject({ code: "runtime", message: "job interrupted" })
    expect(disposed).toBe(true)
  })
})
