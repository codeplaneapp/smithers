import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  cacheTokenDigest,
  cacheTokenVerifier,
  maxCacheTokenBytes,
  minCacheTokenBytes,
  workerStageOptions
} from "../../deployment.ts"

const readToken = "SMITHERS_CACHE_READ_TOKEN"

const configured = (value: string): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      Effect.map(cacheTokenVerifier(readToken), Redacted.value),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: value }))
    )
  )

describe("cache credential verification", () => {
  it("hands the Worker a digest rather than the credential", async () => {
    const token = "x".repeat(minCacheTokenBytes)

    expect(cacheTokenDigest(readToken, token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"))
    await expect(configured(token)).resolves.toBe(createHash("sha256").update(token, "utf8").digest("hex"))
  })

  it("refuses a credential that is too short, too long, or not printable ASCII", () => {
    const cases = [
      "x".repeat(minCacheTokenBytes - 1),
      "x".repeat(maxCacheTokenBytes + 1),
      `${"x".repeat(minCacheTokenBytes)} withspace`,
      `${"x".repeat(minCacheTokenBytes)}\u0000`,
      `${"x".repeat(minCacheTokenBytes)}é`,
      ""
    ]

    for (const value of cases) {
      expect(() => cacheTokenDigest(readToken, value)).toThrow(readToken)
    }
  })

  it("fails the deployment rather than deploying with one credential", async () => {
    // A Worker that received only one secret would answer every request from
    // whichever half was configured, which is the posture the split ends.
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier("SMITHERS_CACHE_WRITE_TOKEN"),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: "x".repeat(minCacheTokenBytes) }))
        )
      )
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier(readToken),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: "short" }))
        )
      )
    ).rejects.toThrow(readToken)
  })

  it("gives production the custom domain and every other stage a workers.dev URL", () => {
    expect(workerStageOptions("prod")).toEqual({ domain: "build.smithers.sh", workersDev: false })
    expect(workerStageOptions("dev_alice")).toEqual({ workersDev: true })
    expect(workerStageOptions("production")).toEqual({ workersDev: true })
  })

  it("exposes the credential as a Config so a deployment reads it from the environment", () => {
    expect(Config.isConfig(cacheTokenVerifier(readToken))).toBe(true)
  })
})
